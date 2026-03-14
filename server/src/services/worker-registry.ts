import { randomUUID } from "node:crypto";
import type { AdapterExecutionContext, AdapterExecutionResult, AdapterInvocationMeta } from "@paperclipai/adapter-utils";
import { logger } from "../middleware/logger.js";

// ---------------------------------------------------------------------------
// Protocol frame types (server ↔ worker)
// ---------------------------------------------------------------------------

export interface WorkerWelcomeFrame {
  type: "welcome";
  workerId: string;
  serverVersion: string;
}

export interface WorkerRegisteredFrame {
  type: "registered";
}

export interface WorkerExecuteFrame {
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

export interface WorkerCancelFrame {
  type: "cancel";
  requestId: string;
  reason: string;
}

export interface WorkerPingFrame {
  type: "ping";
}

// Frames sent by the worker
export interface WorkerRegisterFrame {
  type: "register";
  platform: string;
  arch: string;
  nodeVersion: string;
  capabilities: string[];
  labels: Record<string, unknown>;
  maxConcurrency: number;
  workerVersion: string;
}

export interface WorkerLogFrame {
  type: "log";
  requestId: string;
  stream: "stdout" | "stderr";
  chunk: string;
}

export interface WorkerMetaFrame {
  type: "meta";
  requestId: string;
  meta: AdapterInvocationMeta;
}

export interface WorkerResultFrame {
  type: "result";
  requestId: string;
  result: AdapterExecutionResult;
}

export interface WorkerPongFrame {
  type: "pong";
}

export type ServerToWorkerFrame =
  | WorkerWelcomeFrame
  | WorkerRegisteredFrame
  | WorkerExecuteFrame
  | WorkerCancelFrame
  | WorkerPingFrame;

export type WorkerToServerFrame =
  | WorkerRegisterFrame
  | WorkerLogFrame
  | WorkerMetaFrame
  | WorkerResultFrame
  | WorkerPongFrame;

// ---------------------------------------------------------------------------
// Registry types
// ---------------------------------------------------------------------------

export interface WorkerSocket {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
}

interface PendingDispatch {
  resolve: (result: AdapterExecutionResult) => void;
  reject: (err: Error) => void;
  onLog: AdapterExecutionContext["onLog"];
  onMeta?: AdapterExecutionContext["onMeta"];
  timer: ReturnType<typeof setTimeout> | null;
}

export interface ConnectedWorker {
  workerId: string;
  companyId: string;
  ws: WorkerSocket;
  platform: string;
  arch: string;
  nodeVersion: string;
  capabilities: string[];
  labels: Record<string, unknown>;
  maxConcurrency: number;
  activeRuns: number;
  connectedAt: Date;
  pending: Map<string, PendingDispatch>;
}

// ---------------------------------------------------------------------------
// WorkerRegistry
// ---------------------------------------------------------------------------

export class WorkerRegistry {
  private workers = new Map<string, ConnectedWorker>();

  register(worker: Omit<ConnectedWorker, "pending">): void {
    const existing = this.workers.get(worker.workerId);
    if (existing) {
      this.failAllPending(existing, new Error("worker reconnected"));
    }
    this.workers.set(worker.workerId, { ...worker, pending: new Map() });
    logger.info(
      { workerId: worker.workerId, companyId: worker.companyId, platform: worker.platform, capabilities: worker.capabilities },
      "worker registered",
    );
  }

  unregister(workerId: string): void {
    const worker = this.workers.get(workerId);
    if (!worker) return;
    this.failAllPending(worker, new Error("worker disconnected"));
    this.workers.delete(workerId);
    logger.info({ workerId }, "worker unregistered");
  }

  updateCapabilities(workerId: string, info: WorkerRegisterFrame): void {
    const worker = this.workers.get(workerId);
    if (!worker) return;
    worker.platform = info.platform;
    worker.arch = info.arch;
    worker.nodeVersion = info.nodeVersion;
    worker.capabilities = info.capabilities;
    worker.labels = info.labels;
    worker.maxConcurrency = info.maxConcurrency;
  }

  get(workerId: string): ConnectedWorker | undefined {
    return this.workers.get(workerId);
  }

  findWorker(
    companyId: string,
    opts: { workerId?: string; adapterType?: string; labels?: Record<string, unknown> },
  ): ConnectedWorker | null {
    if (opts.workerId) {
      const w = this.workers.get(opts.workerId);
      if (!w || w.companyId !== companyId) return null;
      if (w.activeRuns >= w.maxConcurrency) return null;
      if (opts.adapterType && !w.capabilities.includes(opts.adapterType)) return null;
      return w;
    }

    let best: ConnectedWorker | null = null;
    for (const w of this.workers.values()) {
      if (w.companyId !== companyId) continue;
      if (w.activeRuns >= w.maxConcurrency) continue;
      if (opts.adapterType && !w.capabilities.includes(opts.adapterType)) continue;
      if (opts.labels && !matchLabels(w.labels, opts.labels)) continue;
      if (!best || w.activeRuns < best.activeRuns) best = w;
    }
    return best;
  }

  async dispatch(
    workerId: string,
    adapterType: string,
    ctx: AdapterExecutionContext,
    timeoutMs = 600_000,
  ): Promise<AdapterExecutionResult> {
    const worker = this.workers.get(workerId);
    if (!worker) {
      return { exitCode: null, signal: null, timedOut: false, errorMessage: "Worker not connected", errorCode: "worker_offline" };
    }

    const requestId = randomUUID();
    worker.activeRuns++;

    const frame: WorkerExecuteFrame = {
      type: "execute",
      requestId,
      adapterType,
      ctx: {
        runId: ctx.runId,
        agent: ctx.agent,
        runtime: ctx.runtime,
        config: ctx.config,
        context: ctx.context,
        authToken: ctx.authToken,
      },
    };

    return new Promise<AdapterExecutionResult>((resolve, reject) => {
      const timer = timeoutMs > 0
        ? setTimeout(() => {
            worker.pending.delete(requestId);
            worker.activeRuns = Math.max(0, worker.activeRuns - 1);
            resolve({
              exitCode: null,
              signal: null,
              timedOut: true,
              errorMessage: `Worker execution timed out after ${Math.round(timeoutMs / 1000)}s`,
              errorCode: "worker_timeout",
            });
          }, timeoutMs)
        : null;

      worker.pending.set(requestId, {
        resolve,
        reject,
        onLog: ctx.onLog,
        onMeta: ctx.onMeta,
        timer,
      });

      try {
        worker.ws.send(JSON.stringify(frame));
      } catch (err) {
        if (timer) clearTimeout(timer);
        worker.pending.delete(requestId);
        worker.activeRuns = Math.max(0, worker.activeRuns - 1);
        resolve({
          exitCode: null,
          signal: null,
          timedOut: false,
          errorMessage: `Failed to send to worker: ${err instanceof Error ? err.message : String(err)}`,
          errorCode: "worker_send_error",
        });
      }
    });
  }

  handleLog(workerId: string, frame: WorkerLogFrame): void {
    const worker = this.workers.get(workerId);
    if (!worker) return;
    const pending = worker.pending.get(frame.requestId);
    if (!pending) return;
    void pending.onLog(frame.stream, frame.chunk).catch(() => {});
  }

  handleMeta(workerId: string, frame: WorkerMetaFrame): void {
    const worker = this.workers.get(workerId);
    if (!worker) return;
    const pending = worker.pending.get(frame.requestId);
    if (!pending?.onMeta) return;
    void pending.onMeta(frame.meta).catch(() => {});
  }

  handleResult(workerId: string, frame: WorkerResultFrame): void {
    const worker = this.workers.get(workerId);
    if (!worker) return;
    const pending = worker.pending.get(frame.requestId);
    if (!pending) return;
    if (pending.timer) clearTimeout(pending.timer);
    worker.pending.delete(frame.requestId);
    worker.activeRuns = Math.max(0, worker.activeRuns - 1);
    pending.resolve(frame.result);
  }

  listOnline(companyId: string): ConnectedWorker[] {
    const result: ConnectedWorker[] = [];
    for (const w of this.workers.values()) {
      if (w.companyId === companyId) result.push(w);
    }
    return result;
  }

  isOnline(workerId: string): boolean {
    return this.workers.has(workerId);
  }

  getActiveRuns(workerId: string): number {
    return this.workers.get(workerId)?.activeRuns ?? 0;
  }

  private failAllPending(worker: ConnectedWorker, err: Error): void {
    for (const [, pending] of worker.pending) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.resolve({
        exitCode: null,
        signal: null,
        timedOut: false,
        errorMessage: err.message,
        errorCode: "worker_disconnected",
      });
    }
    worker.pending.clear();
    worker.activeRuns = 0;
  }
}

function matchLabels(
  workerLabels: Record<string, unknown>,
  required: Record<string, unknown>,
): boolean {
  for (const [key, value] of Object.entries(required)) {
    if (workerLabels[key] !== value) return false;
  }
  return true;
}
