import os from "node:os";
import { resolveConfig, type WorkerConfig } from "./config.js";
import { detectCapabilities, type AdapterStatus } from "./detect.js";
import { registerCapabilities } from "./executor.js";
import { WorkerConnection } from "./connection.js";
import { WorkerBeacon, type PairResult } from "./beacon.js";
import { ensureKeyPair, getPublicKeyPath, getPrivateKeyPath } from "./keygen.js";
import { log, setLogLevel } from "./logger.js";

let activeConnection: WorkerConnection | null = null;

const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  bold: "\x1b[1m",
  magenta: "\x1b[35m",
};

function banner(
  fingerprint: string,
  port: number,
  _capabilities: string[],
  statuses: AdapterStatus[],
  config: WorkerConfig,
): void {
  const ips = getLocalIPs();
  const W = 70;
  const LW = 15;
  const B = C.cyan;

  const vlen = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").length;

  const hr = (l: string, r: string) =>
    `${B}${l}${"─".repeat(W)}${r}${C.reset}`;

  const row = (content: string) => {
    const pad = Math.max(0, W - vlen(content));
    console.log(`${B}│${C.reset}${content}${" ".repeat(pad)}${B}│${C.reset}`);
  };

  const blank = () => row("");

  const kv = (label: string, value: string, vc = "") => {
    const v = vc ? `${vc}${value}${C.reset}` : value;
    row(`  ${C.dim}${label.padEnd(LW)}${C.reset}${v}`);
  };

  const tilde = (p: string) => {
    const h = os.homedir();
    return p.startsWith(h) ? "~" + p.slice(h.length) : p;
  };

  // ── Title ──
  console.log("");
  console.log(hr("┌", "┐"));
  const title = "Paperclip Remote Worker";
  const lpad = Math.floor((W - title.length) / 2);
  row(`${" ".repeat(lpad)}${C.bold}${title}${C.reset}`);
  console.log(hr("├", "┤"));

  // ── System info ──
  kv("Platform", `${os.platform()} ${os.arch()} (Node ${process.version})`);
  kv("Hostname", os.hostname());
  kv("Concurrency", String(config.maxConcurrency));
  kv("Beacon Port", String(port));
  for (const ip of ips) {
    kv("LAN Address", `${ip}:${port}`, C.cyan);
  }

  // ── Adapters ──
  console.log(hr("├", "┤"));

  const installed = statuses.filter((s) => s.auth !== "not_installed");
  const notInstalled = statuses.filter((s) => s.auth === "not_installed");

  const NAME_W = 14;

  if (installed.length > 0) {
    row(`  ${C.bold}Adapters${C.reset}`);
    blank();
    for (const s of installed) {
      const icon = s.auth === "ready" ? `${C.green}✓` : `${C.yellow}!`;
      const tag = s.auth === "ready"
        ? `${C.green}ready${C.reset}`
        : `${C.yellow}needs auth${C.reset}`;
      const ver = s.version ? ` ${C.dim}(${s.version})${C.reset}` : "";
      const left = `  ${icon}${C.reset} ${s.label}${ver}`;
      const gap = Math.max(1, W - vlen(left) - vlen(tag) - 2);
      row(`${left}${" ".repeat(gap)}${tag}`);
      if (s.auth === "needs_auth" && s.authHint) {
        row(`      ${C.dim}→ ${s.authHint}${C.reset}`);
      }
    }
  } else {
    row(`  ${C.dim}No CLI tools detected${C.reset}`);
  }

  if (notInstalled.length > 0) {
    console.log(hr("├", "┤"));
    row(`  ${C.bold}Install CLI tools${C.reset}`);
    blank();
    for (const s of notInstalled) {
      if (!s.installHint) continue;
      row(`    ${C.dim}${s.label.padEnd(NAME_W)}${C.reset}${C.green}${s.installHint}${C.reset}`);
    }
  }

  // ── Status ──
  console.log(hr("├", "┤"));

  if (config.server) {
    kv("Server", config.server, C.green);
    kv("Status", "● connected", C.green);
  } else {
    kv("Status", "● awaiting pairing…", C.yellow);
  }

  // ── Identity ──
  console.log(hr("├", "┤"));

  kv("Fingerprint", fingerprint, C.magenta);
  kv("Private key", tilde(getPrivateKeyPath()));
  kv("Public key", tilde(getPublicKeyPath()));

  console.log(hr("└", "┘"));

  // ── Warnings below box ──
  const needsAuth = statuses.filter((s) => s.auth === "needs_auth");
  if (needsAuth.length > 0) {
    console.log("");
    console.log(`  ${C.yellow}⚠  ${needsAuth.length} adapter(s) need authentication:${C.reset}`);
    for (const s of needsAuth) {
      console.log(`  ${C.dim}   ${s.label}: ${s.authHint ?? "check auth config"}${C.reset}`);
    }
    console.log("");
    console.log(`  ${C.dim}Set API keys in ~/.paperclip/worker.json:${C.reset}`);
    console.log(`  ${C.dim}{ "env": { "ANTHROPIC_API_KEY": "sk-…", "OPENAI_API_KEY": "sk-…" } }${C.reset}`);
  }

  console.log("");
  console.log(`  ${C.dim}Tip: --verbose / -v for debug logging${C.reset}`);
  console.log("");
}

function getLocalIPs(): string[] {
  const interfaces = os.networkInterfaces();
  const ips: string[] = [];
  for (const iface of Object.values(interfaces)) {
    if (!iface) continue;
    for (const addr of iface) {
      if (addr.family === "IPv4" && !addr.internal) {
        ips.push(addr.address);
      }
    }
  }
  return ips;
}

async function handlePair(
  serverUrl: string,
  config: WorkerConfig,
  capabilities: string[],
  companyId?: string,
  workerName?: string,
): Promise<PairResult> {
  if (activeConnection) {
    log.pair("info", "Stopping existing connection for re-pairing");
    activeConnection.stop();
    activeConnection = null;
  }

  config.server = serverUrl;
  const url = serverUrl.replace(/\/+$/, "");
  const registerUrl = `${url}/api/workers/pair-accept`;
  const keyPair = ensureKeyPair();

  log.pair("info", `Registering with server at ${registerUrl}`);

  try {
    const response = await fetch(registerUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hostname: os.hostname(),
        platform: os.platform(),
        arch: os.arch(),
        nodeVersion: process.version,
        capabilities,
        maxConcurrency: config.maxConcurrency,
        labels: config.labels,
        publicKey: keyPair.publicKeyPem,
        fingerprint: keyPair.fingerprint,
        companyId,
        workerName,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      log.pair("error", `Server rejected registration: ${response.status}`, text);
      return { ok: false, error: `server rejected registration: ${response.status} ${text}` };
    }

    const data = (await response.json()) as { token: string; workerId: string };
    config.token = data.token;

    log.pair("info", `Paired successfully — worker ID: ${data.workerId}`);
    log.pair("info", "Starting WebSocket connection to server...");

    activeConnection = new WorkerConnection(config, capabilities);
    void activeConnection.start();

    return { ok: true };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : "registration failed";
    log.pair("error", `Registration failed: ${errMsg}`);
    return { ok: false, error: errMsg };
  }
}

export async function startWorker(): Promise<void> {
  const config = resolveConfig();
  setLogLevel(config.logLevel);

  const keyPair = ensureKeyPair();

  const { capabilities: detected, statuses } = config.capabilities
    ? { capabilities: config.capabilities, statuses: [] as AdapterStatus[] }
    : await detectCapabilities(config.env);

  const registered = await registerCapabilities(detected);

  if (registered.length === 0) {
    log.error("system", "No adapters available. Install at least one CLI tool (claude, codex, cursor, etc.).");
    process.exit(1);
  }

  const beacon = new WorkerBeacon(
    keyPair.privateKeyPem,
    keyPair.publicKeyPem,
    keyPair.fingerprint,
    registered,
    config.maxConcurrency,
    config.labels,
    (serverUrl, companyId, workerName) =>
      handlePair(serverUrl, config, registered, companyId, workerName),
  );

  const actualPort = await beacon.start(config.beaconPort);
  banner(keyPair.fingerprint, actualPort, registered, statuses, config);

  if (config.server && config.token) {
    log.info("system", "Server and token configured — starting outbound connection");
    activeConnection = new WorkerConnection(config, registered);
    void activeConnection.start();
  } else if (config.server && !config.token) {
    log.info("system", "Server URL set but no token — waiting for pairing via beacon");
  } else {
    log.info("system", "No server configured — running in discovery mode, waiting for pairing");
  }

  process.on("SIGINT", () => {
    log.info("system", "Shutting down (SIGINT)...");
    beacon.stop();
    activeConnection?.stop();
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    log.info("system", "Shutting down (SIGTERM)...");
    beacon.stop();
    activeConnection?.stop();
    process.exit(0);
  });
}

startWorker().catch((err) => {
  log.error("system", `Fatal error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
