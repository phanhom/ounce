import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { log } from "./logger.js";

const exec = promisify(execFile);

interface Probe {
  command: string;
  args: string[];
  label: string;
}

const PROBES: Record<string, Probe> = {
  claude_local: { command: "claude", args: ["--version"], label: "Claude Code" },
  codex_local: { command: "codex", args: ["--version"], label: "Codex" },
  cursor: { command: "cursor", args: ["--version"], label: "Cursor" },
  gemini_local: { command: "gemini", args: ["--version"], label: "Gemini CLI" },
  opencode_local: { command: "opencode", args: ["version"], label: "OpenCode" },
  pi_local: { command: "pi", args: ["--version"], label: "Pi" },
};

const ALWAYS_AVAILABLE = ["openclaw_gateway", "process", "http"];

export async function detectCapabilities(): Promise<string[]> {
  log.info("detect", "Scanning for installed CLI tools...");
  const results = [...ALWAYS_AVAILABLE];

  const probes = Object.entries(PROBES).map(async ([adapterType, probe]) => {
    try {
      const { stdout } = await exec(probe.command, probe.args, { timeout: 5_000 });
      const version = stdout.trim().split("\n")[0]?.trim() ?? "";
      log.info("detect", `Found ${probe.label}`, `${probe.command} → ${version || "ok"}`);
      return adapterType;
    } catch {
      log.debug("detect", `Not found: ${probe.label}`, `${probe.command} not in PATH`);
      return null;
    }
  });

  const resolved = await Promise.all(probes);
  for (const adapterType of resolved) {
    if (adapterType) results.push(adapterType);
  }

  log.info("detect", `Detection complete: ${results.length} capabilities`, `[${results.join(", ")}]`);
  return results;
}
