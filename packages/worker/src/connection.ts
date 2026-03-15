import os from "node:os";
import WebSocket from "ws";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { executeOnWorker } from "./executor.js";
import type { WorkerConfig } from "./config.js";
import { log } from "./logger.js";

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 60_000;
const PING_INTERVAL_MS = 30_000;
const PKG_VERSION = "0.3.0";

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

export class WorkerConnection {
  private ws: WebSocket | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private alive = false;
  private activeExecutions = new Map<string, AbortController>();
  private stopping = false;
  private connectedAt: number | null = null;

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
    log.ws("info", "Connection stopped");
  }

  private connect(): void {
    if (this.stopping) return;

    const wsUrl = this.config.server.replace(/^http/, "ws") + "/api/ws/worker";
    const isTls = wsUrl.startsWith("wss://");
    const isLocalhost = /^wss?:\/\/(localhost|127\.0\.0\.1|::1)/.test(wsUrl);

    if (!isTls && !isLocalhost) {
      log.ws("warn", "Connecting over unencrypted ws:// to a non-localhost server", "use wss:// in production");
    }

    log.ws("info", `Connecting to ${wsUrl}`);

    this.ws = new WebSocket(wsUrl, {
      headers: { Authorization: `Bearer ${this.config.token}` },
      maxPayload: 25 * 1024 * 1024,
    });

    this.ws.on("open", () => {
      this.reconnectAttempt = 0;
      this.alive = true;
      this.connectedAt = Date.now();
      log.ws("info", "WebSocket open — awaiting welcome frame");
      this.startPingLoop();
    });

    this.ws.on("message", (data) => {
      this.handleMessage(data);
    });

    this.ws.on("close", (code, reason) => {
      const reasonText = typeof reason === "string" ? reason : reason?.toString("utf-8") ?? "";
      const uptime = this.connectedAt ? `uptime ${Math.round((Date.now() - this.connectedAt) / 1000)}s` : "";
      log.ws("warn", `Connection closed (code=${code})`, `${reasonText} ${uptime}`.trim());
      this.connectedAt = null;
      this.cleanup();
      this.scheduleReconnect();
    });

    this.ws.on("error", (err) => {
      log.ws("error", `WebSocket error: ${err.message}`);
    });

    this.ws.on("pong", () => {
      this.alive = true;
      log.frame("<<", "pong");
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
    log.ws("info", `Reconnecting in ${Math.round(delay / 1000)}s`, `attempt #${this.reconnectAttempt}`);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private startPingLoop(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      if (!this.alive) {
        log.ws("warn", "Server not responding to pings — reconnecting");
        this.ws.terminate();
        return;
      }
      this.alive = false;
      this.ws.ping();
      log.frame(">>", "ping");
    }, PING_INTERVAL_MS);
  }

  private send(payload: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const p = payload as { type?: string };
    if (p.type) log.frame(">>", p.type, p.type === "log" ? "(stream)" : undefined);
    this.ws.send(JSON.stringify(payload));
  }

  private handleMessage(raw: WebSocket.Data): void {
    let frame: ServerFrame;
    try {
      const text = typeof raw === "string" ? raw : (raw as Buffer).toString("utf-8");
      frame = JSON.parse(text);
    } catch {
      log.ws("error", "Failed to parse incoming frame");
      return;
    }

    log.frame("<<", frame.type ?? "unknown");

    switch (frame.type) {
      case "welcome":
        log.ws("info", "Received welcome — sending registration");
        this.sendRegister();
        break;

      case "registered":
        log.ws("info", "Registered with server successfully", `capabilities: [${this.capabilities.join(", ")}]`);
        log.separator();
        log.status("Server", this.config.server, true);
        log.status("Connection", "established", true);
        log.status("Capabilities", this.capabilities.join(", "), true);
        log.status("Active runs", `${this.activeExecutions.size}/${this.config.maxConcurrency}`, true);
        log.separator();
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

      case "error": {
        const errMsg = typeof frame.message === "string" ? frame.message : JSON.stringify(frame);
        log.ws("error", `Server error: ${errMsg}`);
        break;
      }
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

    const agentName = rawCtx.agent?.name ?? "unknown";
    log.exec("info",
      `Starting ${adapterType} execution`,
      `agent="${agentName}" run=${rawCtx.runId} active=${this.activeExecutions.size}/${this.config.maxConcurrency}`,
    );

    const startTime = Date.now();

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
        log.exec("debug", `Meta received for run ${rawCtx.runId}`, JSON.stringify(meta));
        this.send({ type: "meta", requestId, meta });
      },
    };

    let result: AdapterExecutionResult;
    try {
      result = await executeOnWorker(adapterType, ctx);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.exec("error", `Execution crashed: ${errMsg}`, `run=${rawCtx.runId}`);
      result = {
        exitCode: null,
        signal: null,
        timedOut: false,
        errorMessage: errMsg,
        errorCode: "worker_execution_error",
      };
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    this.activeExecutions.delete(requestId);

    const ok = result.exitCode === 0 && !result.errorMessage;
    if (ok) {
      log.exec("info",
        `Completed ${adapterType}`,
        `agent="${agentName}" run=${rawCtx.runId} exit=0 ${elapsed}s`,
      );
    } else {
      log.exec("warn",
        `Finished ${adapterType} with issues`,
        `agent="${agentName}" run=${rawCtx.runId} exit=${result.exitCode} signal=${result.signal} timedOut=${result.timedOut} ${elapsed}s${result.errorMessage ? " error=" + result.errorMessage : ""}`,
      );
    }

    this.send({ type: "result", requestId, result });
  }

  private handleCancel(frame: CancelFrame): void {
    const controller = this.activeExecutions.get(frame.requestId);
    if (controller) {
      controller.abort();
      this.activeExecutions.delete(frame.requestId);
      log.exec("warn", `Cancelled execution ${frame.requestId}`, frame.reason);
    } else {
      log.exec("debug", `Cancel for unknown request ${frame.requestId}`);
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
