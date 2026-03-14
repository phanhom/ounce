import os from "node:os";
import { resolveConfig, type WorkerConfig } from "./config.js";
import { detectCapabilities } from "./detect.js";
import { registerCapabilities } from "./executor.js";
import { WorkerConnection } from "./connection.js";
import { WorkerBeacon, type PairResult } from "./beacon.js";
import { ensureKeyPair, getPublicKeyPath, getPrivateKeyPath } from "./keygen.js";

let activeConnection: WorkerConnection | null = null;

function banner(fingerprint: string, port: number, capabilities: string[], config: WorkerConfig): void {
  const ips = getLocalIPs();
  const w = 61;
  const line = (label: string, value: string) =>
    `│  ${label.padEnd(13)} │ ${value}`.padEnd(w) + "│";

  console.log("");
  console.log("┌" + "─".repeat(w - 2) + "┐");
  console.log("│" + "Paperclip Remote Worker".padStart(Math.floor((w - 2 + 23) / 2)).padEnd(w - 2) + "│");
  console.log("├" + "─".repeat(w - 2) + "┤");
  console.log(line("Platform", `${os.platform()} ${os.arch()} (Node ${process.version})`));
  console.log(line("Hostname", os.hostname()));
  console.log(line("Capabilities", capabilities.join(", ") || "(none)"));
  console.log(line("Concurrency", String(config.maxConcurrency)));
  console.log(line("Beacon Port", String(port)));
  for (const ip of ips) {
    console.log(line("LAN Address", `${ip}:${port}`));
  }
  console.log("├" + "─".repeat(w - 2) + "┤");
  if (config.server) {
    console.log(line("Server", config.server));
    console.log(line("Status", "outbound connection active"));
  } else {
    console.log(line("Status", "awaiting pairing..."));
  }
  console.log("├" + "─".repeat(w - 2) + "┤");
  console.log(line("Fingerprint", fingerprint));
  console.log("│".padEnd(w) + "│");
  console.log(`│  Use this fingerprint to verify the worker identity`.padEnd(w) + "│");
  console.log(`│  when pairing from the Paperclip UI.`.padEnd(w) + "│");
  console.log("│".padEnd(w) + "│");
  console.log(`│  Private key: ${getPrivateKeyPath()}`.padEnd(w) + "│");
  console.log(`│  Public key:  ${getPublicKeyPath()}`.padEnd(w) + "│");
  console.log("└" + "─".repeat(w - 2) + "┘");
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
    activeConnection.stop();
    activeConnection = null;
  }

  config.server = serverUrl;
  const url = serverUrl.replace(/\/+$/, "");
  const registerUrl = `${url}/api/workers/pair-accept`;
  const keyPair = ensureKeyPair();

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
      return { ok: false, error: `server rejected registration: ${response.status} ${text}` };
    }

    const data = (await response.json()) as { token: string; workerId: string };
    config.token = data.token;

    console.log(`[worker] Paired with server, assigned ID: ${data.workerId}`);

    activeConnection = new WorkerConnection(config, capabilities);
    void activeConnection.start();

    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "registration failed",
    };
  }
}

export async function startWorker(): Promise<void> {
  const config = resolveConfig();

  const keyPair = ensureKeyPair();

  const detected = config.capabilities ?? (await detectCapabilities());
  const registered = await registerCapabilities(detected);

  if (registered.length === 0) {
    console.error("[worker] No adapters available. Install at least one CLI tool (claude, codex, cursor, etc.).");
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
    console.log("[worker] Server and token configured — starting outbound connection");
    activeConnection = new WorkerConnection(config, registered);
    void activeConnection.start();
  } else if (config.server && !config.token) {
    console.log("[worker] Server URL set but no token — waiting for pairing via beacon");
  } else {
    console.log("[worker] No server configured — running in discovery mode, waiting for pairing");
  }

  process.on("SIGINT", () => {
    console.log("\n[worker] Shutting down (SIGINT)...");
    beacon.stop();
    activeConnection?.stop();
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    console.log("[worker] Shutting down (SIGTERM)...");
    beacon.stop();
    activeConnection?.stop();
    process.exit(0);
  });
}

startWorker().catch((err) => {
  console.error("[worker] Fatal error:", err);
  process.exit(1);
});
