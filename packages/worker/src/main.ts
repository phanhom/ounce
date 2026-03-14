import os from "node:os";
import { resolveConfig, type WorkerConfig } from "./config.js";
import { detectCapabilities } from "./detect.js";
import { registerCapabilities } from "./executor.js";
import { WorkerConnection } from "./connection.js";
import { WorkerBeacon, type PairRequest, type PairResult } from "./beacon.js";
import { ensureWorkerKey, getKeyFilePath } from "./keygen.js";

let activeConnection: WorkerConnection | null = null;

function banner(workerKey: string, port: number, capabilities: string[], config: WorkerConfig): void {
  const ips = getLocalIPs();
  console.log("");
  console.log("┌─────────────────────────────────────────────────────────┐");
  console.log("│              Paperclip Remote Worker                    │");
  console.log("├─────────────────────────────────────────────────────────┤");
  console.log(`│  Platform     │ ${os.platform()} ${os.arch()} (Node ${process.version})`.padEnd(59) + "│");
  console.log(`│  Hostname     │ ${os.hostname()}`.padEnd(59) + "│");
  console.log(`│  Capabilities │ ${capabilities.join(", ") || "(none)"}`.padEnd(59) + "│");
  console.log(`│  Concurrency  │ ${config.maxConcurrency}`.padEnd(59) + "│");
  console.log(`│  Beacon Port  │ ${port}`.padEnd(59) + "│");
  for (const ip of ips) {
    console.log(`│  LAN Address  │ ${ip}:${port}`.padEnd(59) + "│");
  }
  console.log("├─────────────────────────────────────────────────────────┤");
  if (config.server) {
    console.log(`│  Server       │ ${config.server}`.padEnd(59) + "│");
    console.log(`│  Status       │ outbound connection active`.padEnd(59) + "│");
  } else {
    console.log(`│  Status       │ awaiting pairing...`.padEnd(59) + "│");
  }
  console.log("├─────────────────────────────────────────────────────────┤");
  console.log("│  Worker Key (use this to pair from Paperclip UI):      │");
  console.log(`│  ${workerKey}`.padEnd(59) + "│");
  console.log(`│  Key file: ${getKeyFilePath()}`.padEnd(59) + "│");
  console.log("└─────────────────────────────────────────────────────────┘");
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
  req: PairRequest,
  config: WorkerConfig,
  capabilities: string[],
): Promise<PairResult> {
  if (activeConnection) {
    activeConnection.stop();
    activeConnection = null;
  }

  config.server = req.serverUrl;

  const serverUrl = req.serverUrl.replace(/\/+$/, "");
  const registerUrl = `${serverUrl}/api/workers/pair-accept`;
  const workerKey = ensureWorkerKey();

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
        workerKey,
        companyId: req.companyId,
        workerName: req.workerName,
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

  const workerKey = ensureWorkerKey();

  const detected = config.capabilities ?? (await detectCapabilities());
  const registered = await registerCapabilities(detected);

  if (registered.length === 0) {
    console.error("[worker] No adapters available. Install at least one CLI tool (claude, codex, cursor, etc.).");
    process.exit(1);
  }

  const beacon = new WorkerBeacon(
    workerKey,
    registered,
    config.maxConcurrency,
    config.labels,
    (req) => handlePair(req, config, registered),
  );

  const actualPort = await beacon.start(config.beaconPort);
  banner(workerKey, actualPort, registered, config);

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
