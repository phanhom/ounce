import os from "node:os";
import WebSocket from "ws";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { executeOnWorker } from "./executor.js";
import type { WorkerConfig } from "./config.js";

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 60_000;
const PING_INTERVAL_MS = 30_000;
const PKG_VERSION = "0.3.0";

// ---------------------------------------------------------------------------
// Frame types (mirrors server/src/services/worker-registry.ts)
// ---------------------------------------------------------------------------

interface ExecuteFrame {
  type: "execute";
  requestId: string;
  adapterType: string;
  ctx: {
    runId: string;
    agent: AdapterExecutionContext["agent"];
    runtime: AdapterExecutionContext["runtime"];
    config: Record<string, unknown>;
    context: Record<string, unknown>;
    authToken?: string;
  };
}

interface CancelFrame {
  type: "cancel";
  requestId: string;
  reason: string;
}

interface ServerFrame {
  type: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// WorkerConnection
// ---------------------------------------------------------------------------

export class WorkerConnection {
  private ws: WebSocket | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private alive = false;
  private activeExecutions = new Map<string, AbortController>();
  private stopping = false;

  constructor(
    private readonly config: WorkerConfig,
    private readonly capabilities: string[],
  ) {}

  async start(): Promise<void> {
    this.stopping = false;
    this.connect();
  }

  stop(): void {
    this.stopping = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.ws) {
      this.ws.close(1000, "worker-shutdown");
      this.ws = null;
    }
  }

  private connect(): void {
    if (this.stopping) return;

    const wsUrl = this.config.server.replace(/^http/, "ws") + "/api/ws/worker";
    const isTls = wsUrl.startsWith("wss://");
    const isLocalhost = /^wss?:\/\/(localhost|127\.0\.0\.1|::1)/.test(wsUrl);

    if (!isTls && !isLocalhost) {
      console.warn("[worker] WARNING: Connecting over unencrypted ws:// to a non-localhost server. Use wss:// in production.");
    }

    console.log(`[worker] Connecting to ${wsUrl}`);

    this.ws = new WebSocket(wsUrl, {
      headers: { Authorization: `Bearer ${this.config.token}` },
      maxPayload: 25 * 1024 * 1024,
    });

    this.ws.on("open", () => {
      this.reconnectAttempt = 0;
      this.alive = true;
      console.log("[worker] Connected to Paperclip server");
      this.startPingLoop();
    });

    this.ws.on("message", (data) => {
      this.handleMessage(data);
    });

    this.ws.on("close", (code, reason) => {
      const reasonText = typeof reason === "string" ? reason : reason?.toString("utf-8") ?? "";
      console.log(`[worker] Connection closed (${code}): ${reasonText}`);
      this.cleanup();
      this.scheduleReconnect();
    });

    this.ws.on("error", (err) => {
      console.error(`[worker] WebSocket error: ${err.message}`);
    });

    this.ws.on("pong", () => {
      this.alive = true;
    });
  }

  private cleanup(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    this.ws = null;
  }

  private scheduleReconnect(): void {
    if (this.stopping) return;
    const delay = Math.min(
      RECONNECT_BASE_MS * 2 ** this.reconnectAttempt,
      RECONNECT_MAX_MS,
    );
    this.reconnectAttempt++;
    console.log(`[worker] Reconnecting in ${Math.round(delay / 1000)}s (attempt ${this.reconnectAttempt})`);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private startPingLoop(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      if (!this.alive) {
        console.warn("[worker] Server not responding to pings; reconnecting");
        this.ws.terminate();
        return;
      }
      this.alive = false;
      this.ws.ping();
    }, PING_INTERVAL_MS);
  }

  private send(payload: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(payload));
  }

  private handleMessage(raw: WebSocket.Data): void {
    let frame: ServerFrame;
    try {
      const text = typeof raw === "string" ? raw : (raw as Buffer).toString("utf-8");
      frame = JSON.parse(text);
    } catch {
      return;
    }

    switch (frame.type) {
      case "welcome":
        this.sendRegister();
        break;

      case "registered":
        console.log(`[worker] Registered with capabilities: ${this.capabilities.join(", ")}`);
        break;

      case "execute":
        void this.handleExecute(frame as unknown as ExecuteFrame);
        break;

      case "cancel":
        this.handleCancel(frame as unknown as CancelFrame);
        break;

      case "ping":
        this.send({ type: "pong" });
        break;
    }
  }

  private sendRegister(): void {
    this.send({
      type: "register",
      platform: os.platform(),
      arch: os.arch(),
      nodeVersion: process.version,
      capabilities: this.capabilities,
      labels: this.config.labels,
      maxConcurrency: this.config.maxConcurrency,
      workerVersion: PKG_VERSION,
    });
  }

  private async handleExecute(frame: ExecuteFrame): Promise<void> {
    const { requestId, adapterType, ctx: rawCtx } = frame;
    const controller = new AbortController();
    this.activeExecutions.set(requestId, controller);

    console.log(`[worker] Executing ${adapterType} for run ${rawCtx.runId}`);

    const ctx: AdapterExecutionContext = {
      runId: rawCtx.runId,
      agent: rawCtx.agent,
      runtime: rawCtx.runtime,
      config: { ...rawCtx.config, ...this.buildEnvOverrides(rawCtx.config) },
      context: rawCtx.context,
      authToken: rawCtx.authToken,
      onLog: async (stream, chunk) => {
        this.send({ type: "log", requestId, stream, chunk });
      },
      onMeta: async (meta) => {
        this.send({ type: "meta", requestId, meta });
      },
    };

    let result: AdapterExecutionResult;
    try {
      result = await executeOnWorker(adapterType, ctx);
    } catch (err) {
      result = {
        exitCode: null,
        signal: null,
        timedOut: false,
        errorMessage: err instanceof Error ? err.message : String(err),
        errorCode: "worker_execution_error",
      };
    }

    this.activeExecutions.delete(requestId);
    this.send({ type: "result", requestId, result });
    console.log(`[worker] Completed ${adapterType} for run ${rawCtx.runId} (exit=${result.exitCode})`);
  }

  private handleCancel(frame: CancelFrame): void {
    const controller = this.activeExecutions.get(frame.requestId);
    if (controller) {
      controller.abort();
      this.activeExecutions.delete(frame.requestId);
      console.log(`[worker] Cancelled execution ${frame.requestId}: ${frame.reason}`);
    }
  }

  private buildEnvOverrides(config: Record<string, unknown>): Record<string, unknown> {
    if (Object.keys(this.config.env).length === 0) return {};
    const configEnv =
      typeof config.env === "object" && config.env !== null && !Array.isArray(config.env)
        ? (config.env as Record<string, unknown>)
        : {};
    return { env: { ...configEnv, ...this.config.env } };
  }
}
