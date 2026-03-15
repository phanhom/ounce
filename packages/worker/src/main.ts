import os from "node:os";
import { resolveConfig, type WorkerConfig } from "./config.js";
import { detectCapabilities } from "./detect.js";
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
  bold: "\x1b[1m",
  magenta: "\x1b[35m",
};

function banner(fingerprint: string, port: number, capabilities: string[], config: WorkerConfig): void {
  const ips = getLocalIPs();

  console.log("");
  console.log(`${C.cyan}┌─────────────────────────────────────────────────────────────┐${C.reset}`);
  console.log(`${C.cyan}│${C.reset}${C.bold}           Paperclip Remote Worker${C.reset}${C.cyan}                           │${C.reset}`);
  console.log(`${C.cyan}├─────────────────────────────────────────────────────────────┤${C.reset}`);

  const row = (label: string, value: string, color = "") => {
    const pad = 59 - label.length - value.length - 6;
    console.log(`${C.cyan}│${C.reset}  ${C.dim}${label}${C.reset} ${color}${value}${color ? C.reset : ""}${" ".repeat(Math.max(0, pad))}${C.cyan}│${C.reset}`);
  };

  row("Platform", `${os.platform()} ${os.arch()} (Node ${process.version})`);
  row("Hostname", os.hostname());
  row("Capabilities", capabilities.join(", ") || "(none)", C.green);
  row("Concurrency", String(config.maxConcurrency));
  row("Log Level", config.logLevel);
  row("Beacon Port", String(port));
  for (const ip of ips) {
    row("LAN Address", `${ip}:${port}`, C.cyan);
  }

  console.log(`${C.cyan}├─────────────────────────────────────────────────────────────┤${C.reset}`);

  if (config.server) {
    row("Server", config.server, C.green);
    row("Status", "outbound connection active", C.green);
  } else {
    row("Status", "awaiting pairing...", C.yellow);
  }

  console.log(`${C.cyan}├─────────────────────────────────────────────────────────────┤${C.reset}`);
  row("Fingerprint", fingerprint, C.magenta);
  console.log(`${C.cyan}│${C.reset}                                                            ${C.cyan}│${C.reset}`);
  console.log(`${C.cyan}│${C.reset}  ${C.dim}Use this fingerprint to verify the worker identity${C.reset}        ${C.cyan}│${C.reset}`);
  console.log(`${C.cyan}│${C.reset}  ${C.dim}when pairing from the Paperclip UI.${C.reset}                       ${C.cyan}│${C.reset}`);
  console.log(`${C.cyan}│${C.reset}                                                            ${C.cyan}│${C.reset}`);
  console.log(`${C.cyan}│${C.reset}  ${C.dim}Private key:${C.reset} ${getPrivateKeyPath()}`.padEnd(72) + `${C.cyan}│${C.reset}`);
  console.log(`${C.cyan}│${C.reset}  ${C.dim}Public key:${C.reset}  ${getPublicKeyPath()}`.padEnd(72) + `${C.cyan}│${C.reset}`);
  console.log(`${C.cyan}└─────────────────────────────────────────────────────────────┘${C.reset}`);
  console.log("");
  console.log(`${C.dim}  Tip: Use --verbose or -v for debug-level logging (frame tracing)${C.reset}`);
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

  const detected = config.capabilities ?? (await detectCapabilities());
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
  banner(keyPair.fingerprint, actualPort, registered, config);

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
