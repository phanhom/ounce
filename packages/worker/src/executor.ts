import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { log } from "./logger.js";

type ExecuteFn = (ctx: AdapterExecutionContext) => Promise<AdapterExecutionResult>;

const EXECUTORS: Record<string, ExecuteFn> = {};

const ADAPTER_IMPORTS: Record<string, () => Promise<{ execute: ExecuteFn }>> = {
  claude_local: () => import("@paperclipai/adapter-claude-local/server"),
  codex_local: () => import("@paperclipai/adapter-codex-local/server"),
  cursor: () => import("@paperclipai/adapter-cursor-local/server"),
  gemini_local: () => import("@paperclipai/adapter-gemini-local/server"),
  opencode_local: () => import("@paperclipai/adapter-opencode-local/server"),
  openclaw_gateway: () => import("@paperclipai/adapter-openclaw-gateway/server"),
  pi_local: () => import("@paperclipai/adapter-pi-local/server"),
};

/**
 * Dynamically load adapter execute functions for the given capabilities.
 * Adapters that fail to import (not installed) are silently skipped.
 */
export async function registerCapabilities(capabilities: string[]): Promise<string[]> {
  const registered: string[] = [];

  for (const type of capabilities) {
    if (EXECUTORS[type]) {
      registered.push(type);
      continue;
    }

    const loader = ADAPTER_IMPORTS[type];
    if (!loader) continue;

    try {
      const mod = await loader();
      EXECUTORS[type] = mod.execute;
      registered.push(type);
      log.info("exec", `Loaded adapter: ${type}`);
    } catch (err) {
      log.debug("exec", `Adapter not available: ${type}`, err instanceof Error ? err.message : "");
    }
  }

  return registered;
}

export async function executeOnWorker(
  adapterType: string,
  ctx: AdapterExecutionContext,
): Promise<AdapterExecutionResult> {
  const executor = EXECUTORS[adapterType];
  if (!executor) {
    log.exec("error", `No executor for adapter type: ${adapterType}`);
    return {
      exitCode: null,
      signal: null,
      timedOut: false,
      errorMessage: `Worker does not support adapter type: ${adapterType}`,
      errorCode: "unsupported_adapter",
    };
  }
  return executor(ctx);
}
