import { execFile } from "node:child_process";
import { readFile, access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
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
  checkCredentials?: () => Promise<boolean>;
}

// ── Credential checks ──────────────────────────────────────────────

async function fileExists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

async function cursorHasAuth(): Promise<boolean> {
  try {
    const raw = await readFile(join(homedir(), ".cursor", "cli-config.json"), "utf-8");
    const config = JSON.parse(raw);
    return !!(config.authInfo?.email || config.authInfo?.authId);
  } catch { return false; }
}

async function geminiHasAuth(): Promise<boolean> {
  return fileExists(join(homedir(), ".gemini", "antigravity", "user_settings.pb"));
}

// ── Probes ──────────────────────────────────────────────────────────

const PROBES: Record<string, Probe> = {
  claude_local: {
    command: "claude",
    args: ["--version"],
    label: "Claude Code",
    authEnvVars: ["ANTHROPIC_API_KEY"],
    installHint: "npm i -g @anthropic-ai/claude-code",
    authCheckCommand: {
      args: ["auth", "status"],
      successPattern: /logged\s+in|authenticated|active|valid|email|account/i,
      failPattern: /not\s+logged\s+in|not\s+authenticated|please\s+log\s+in|no\s+auth|unauthenticated/i,
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
    checkCredentials: cursorHasAuth,
  },
  gemini_local: {
    command: "gemini",
    args: ["--version"],
    label: "Gemini CLI",
    authEnvVars: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    installHint: "npm i -g @google/gemini-cli",
    checkCredentials: geminiHasAuth,
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

// ── Auth checking ───────────────────────────────────────────────────

async function checkAuth(
  probe: Probe,
  command: string,
  extraEnv: Record<string, string>,
): Promise<{ auth: AuthStatus; hint?: string }> {
  const mergedEnv = { ...process.env, ...extraEnv };

  // 1. Check env vars (most explicit signal)
  const hasEnvKey = probe.authEnvVars.some(
    (k) => typeof mergedEnv[k] === "string" && mergedEnv[k]!.trim().length > 0,
  );
  if (hasEnvKey) {
    return { auth: "ready" };
  }

  // 2. Check credential files (fast, no process spawn)
  if (probe.checkCredentials) {
    try {
      if (await probe.checkCredentials()) {
        return { auth: "ready" };
      }
    } catch {
      // credential check failed — continue to next method
    }
  }

  // 3. Try auth check command
  if (probe.authCheckCommand) {
    const { successPattern, failPattern } = probe.authCheckCommand;
    const needsAuthResult = {
      auth: "needs_auth" as AuthStatus,
      hint: `Run \`${command} auth login\` or set ${probe.authEnvVars.join("/")}`,
    };

    try {
      const { stdout, stderr } = await exec(command, probe.authCheckCommand.args, {
        timeout: 10_000,
        env: mergedEnv,
      });
      const combined = `${stdout}\n${stderr}`;
      if (failPattern?.test(combined)) return needsAuthResult;
      if (successPattern.test(combined)) return { auth: "ready" };
      // Exited 0 without matching fail pattern — assume authenticated
      return { auth: "ready" };
    } catch (err: unknown) {
      // exec rejects on non-zero exit, but the error still carries stdout/stderr
      const e = err as { stdout?: string; stderr?: string };
      const combined = `${e.stdout ?? ""}\n${e.stderr ?? ""}`;
      if (combined.trim()) {
        if (failPattern?.test(combined)) return needsAuthResult;
        if (successPattern.test(combined)) return { auth: "ready" };
      }
      // Command not found, unknown subcommand, or no useful output — fall through
    }
  }

  return {
    auth: "needs_auth",
    hint: `Set ${probe.authEnvVars.join(" or ")} in env, or run \`${command} auth login\``,
  };
}

// ── Detection ───────────────────────────────────────────────────────

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
