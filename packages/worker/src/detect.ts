import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

interface Probe {
  command: string;
  args: string[];
}

const PROBES: Record<string, Probe> = {
  claude_local: { command: "claude", args: ["--version"] },
  codex_local: { command: "codex", args: ["--version"] },
  cursor: { command: "cursor", args: ["--version"] },
  gemini_local: { command: "gemini", args: ["--version"] },
  opencode_local: { command: "opencode", args: ["version"] },
  pi_local: { command: "pi", args: ["--version"] },
};

const ALWAYS_AVAILABLE = ["openclaw_gateway", "process", "http"];

export async function detectCapabilities(): Promise<string[]> {
  const results = [...ALWAYS_AVAILABLE];

  const probes = Object.entries(PROBES).map(async ([adapterType, probe]) => {
    try {
      await exec(probe.command, probe.args, { timeout: 5_000 });
      return adapterType;
    } catch {
      return null;
    }
  });

  const resolved = await Promise.all(probes);
  for (const adapterType of resolved) {
    if (adapterType) results.push(adapterType);
  }

  return results;
}
