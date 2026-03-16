import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { log } from "./logger.js";

const exec = promisify(execFile);

export type AuthStatus = "ready" | "needs_auth" | "not_installed";

export interface AdapterStatus {
  adapterType: string;
  label: string;
  version: string;
  auth: AuthStatus;
  authHint?: string;
  installHint?: string;
}

interface Probe {
  command: string;
  args: string[];
  label: string;
  authEnvVars: string[];
  installHint: string;
  authCheckCommand?: { args: string[]; successPattern: RegExp; failPattern?: RegExp };
}

const PROBES: Record<string, Probe> = {
  claude_local: {
    command: "claude",
    args: ["--version"],
    label: "Claude Code",
    authEnvVars: ["ANTHROPIC_API_KEY"],
    installHint: "npm i -g @anthropic-ai/claude-code",
    authCheckCommand: {
      args: ["auth", "status"],
      successPattern: /logged\s+in|authenticated|active|valid/i,
      failPattern: /not\s+logged\s+in|not\s+authenticated|please\s+log\s+in|no\s+auth/i,
    },
  },
  codex_local: {
    command: "codex",
    args: ["--version"],
    label: "Codex",
    authEnvVars: ["OPENAI_API_KEY"],
    installHint: "npm i -g @openai/codex",
  },
  cursor: {
    command: "agent",
    args: ["--version"],
    label: "Cursor",
    authEnvVars: ["CURSOR_API_KEY"],
    installHint: "Install Cursor from https://cursor.com",
  },
  gemini_local: {
    command: "gemini",
    args: ["--version"],
    label: "Gemini CLI",
    authEnvVars: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    installHint: "npm i -g @google/gemini-cli",
  },
  opencode_local: {
    command: "opencode",
    args: ["version"],
    label: "OpenCode",
    authEnvVars: ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"],
    installHint: "go install github.com/opencode-ai/opencode@latest",
  },
  pi_local: {
    command: "pi",
    args: ["--version"],
    label: "Pi",
    authEnvVars: ["ANTHROPIC_API_KEY", "XAI_API_KEY", "OPENAI_API_KEY"],
    installHint: "npm i -g @mariozechner/pi-coding-agent",
  },
};

const ALWAYS_AVAILABLE = ["openclaw_gateway", "process", "http"];

async function checkAuth(
  probe: Probe,
  command: string,
  extraEnv: Record<string, string>,
): Promise<{ auth: AuthStatus; hint?: string }> {
  const mergedEnv = { ...process.env, ...extraEnv };

  const hasEnvKey = probe.authEnvVars.some(
    (k) => typeof mergedEnv[k] === "string" && mergedEnv[k]!.trim().length > 0,
  );
  if (hasEnvKey) {
    return { auth: "ready" };
  }

  if (probe.authCheckCommand) {
    try {
      const { stdout, stderr } = await exec(command, probe.authCheckCommand.args, {
        timeout: 10_000,
        env: mergedEnv,
      });
      const combined = `${stdout}\n${stderr}`;
      if (probe.authCheckCommand.successPattern.test(combined)) {
        return { auth: "ready" };
      }
      if (probe.authCheckCommand.failPattern?.test(combined)) {
        return {
          auth: "needs_auth",
          hint: `Run \`${command} auth login\` or set ${probe.authEnvVars.join("/")}`,
        };
      }
    } catch {
      // auth check command failed or doesn't exist — fall through
    }
  }

  return {
    auth: "needs_auth",
    hint: `Set ${probe.authEnvVars.join(" or ")} in env, or run \`${command} auth login\``,
  };
}

export async function detectCapabilities(
  extraEnv: Record<string, string> = {},
): Promise<{ capabilities: string[]; statuses: AdapterStatus[] }> {
  log.info("detect", "Scanning for installed CLI tools and auth status...");
  const capabilities = [...ALWAYS_AVAILABLE];
  const statuses: AdapterStatus[] = [];

  const probes = Object.entries(PROBES).map(async ([adapterType, probe]) => {
    try {
      const { stdout } = await exec(probe.command, probe.args, { timeout: 5_000 });
      const version = stdout.trim().split("\n")[0]?.trim() ?? "";

      const authResult = await checkAuth(probe, probe.command, extraEnv);

      const status: AdapterStatus = {
        adapterType,
        label: probe.label,
        version: version || "ok",
        auth: authResult.auth,
        authHint: authResult.hint,
      };

      if (authResult.auth === "ready") {
        log.info("detect", `${probe.label} ready`, `${probe.command} → ${version || "ok"}`);
      } else {
        log.warn("detect", `${probe.label} installed but needs auth`, authResult.hint ?? "");
      }

      return { adapterType, status };
    } catch {
      log.debug("detect", `Not found: ${probe.label}`, `${probe.command} not in PATH`);
      return {
        adapterType,
        status: {
          adapterType,
          label: probe.label,
          version: "",
          auth: "not_installed" as AuthStatus,
          installHint: probe.installHint,
        },
      };
    }
  });

  const resolved = await Promise.all(probes);
  for (const { adapterType, status } of resolved) {
    statuses.push(status);
    if (status.auth !== "not_installed") {
      capabilities.push(adapterType);
    }
  }

  const readyCount = statuses.filter((s) => s.auth === "ready").length;
  const needsAuthCount = statuses.filter((s) => s.auth === "needs_auth").length;
  log.info("detect",
    `Detection complete: ${capabilities.length} capabilities`,
    `${readyCount} ready, ${needsAuthCount} needs auth`,
  );

  return { capabilities, statuses };
}
