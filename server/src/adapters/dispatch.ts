import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { getServerAdapter } from "./registry.js";
import type { WorkerRegistry } from "../services/worker-registry.js";

// ---------------------------------------------------------------------------
// Module-level registry reference (set once at startup from index.ts)
// ---------------------------------------------------------------------------

let _registry: WorkerRegistry | null = null;

export function setWorkerRegistry(registry: WorkerRegistry): void {
  _registry = registry;
}

export function getWorkerRegistry(): WorkerRegistry | null {
  return _registry;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseObject(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  return fallback;
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * Route adapter execution to a remote worker or fall back to local execution.
 *
 * If `config.worker` is present, we attempt to find a matching online worker
 * from the registry. When no worker is available and `worker.requireRemote`
 * is true, an error result is returned immediately. Otherwise we transparently
 * fall back to running the adapter locally — preserving full backward
 * compatibility for agents that have no worker configuration.
 */
export function dispatchExecution(
  adapterType: string,
  ctx: AdapterExecutionContext,
): Promise<AdapterExecutionResult> {
  const registry = _registry;
  const workerTarget = parseObject(ctx.config.worker);
  const hasWorkerTarget = Object.keys(workerTarget).length > 0;

  if (hasWorkerTarget && registry) {
    const workerId = asString(workerTarget.workerId, "");
    const labels = parseObject(workerTarget.labels);
    const hasLabels = Object.keys(labels).length > 0;

    const worker = registry.findWorker(ctx.agent.companyId, {
      workerId: workerId || undefined,
      adapterType,
      labels: hasLabels ? labels : undefined,
    });

    if (worker) {
      return registry.dispatch(worker.workerId, adapterType, ctx);
    }

    if (asBoolean(workerTarget.requireRemote, false)) {
      return Promise.resolve({
        exitCode: null,
        signal: null,
        timedOut: false,
        errorMessage: workerId
          ? `Worker "${workerId}" is not online or at capacity`
          : "No matching online worker found",
        errorCode: "worker_unavailable",
      });
    }
  }

  const adapter = getServerAdapter(adapterType);
  return adapter.execute(ctx);
}
