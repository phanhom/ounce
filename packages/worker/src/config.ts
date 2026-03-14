import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export interface WorkerConfig {
  /** Paperclip server URL — empty when running in beacon-only (discovery) mode */
  server: string;
  /** Worker token issued by the server — empty before pairing */
  token: string;
  labels: Record<string, unknown>;
  capabilities: string[] | null;
  maxConcurrency: number;
  env: Record<string, string>;
  /** Fixed port for the discovery beacon HTTP server */
  beaconPort: number;
}

const CONFIG_FILE_CANDIDATES = [
  "./paperclip-worker.json",
  path.join(os.homedir(), ".paperclip", "worker.json"),
];

function loadConfigFile(): Partial<WorkerConfig> {
  for (const candidate of CONFIG_FILE_CANDIDATES) {
    const resolved = path.resolve(candidate);
    if (!fs.existsSync(resolved)) continue;
    try {
      const raw = fs.readFileSync(resolved, "utf-8");
      const parsed = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null) {
        console.log(`[worker] Loaded config from ${resolved}`);
        return parsed as Partial<WorkerConfig>;
      }
    } catch {
      console.warn(`[worker] Failed to parse config file ${resolved}`);
    }
  }
  return {};
}

function parseCliArgs(argv: string[]): Partial<WorkerConfig> {
  const result: Partial<WorkerConfig> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    switch (arg) {
      case "--server":
        if (next) { result.server = next; i++; }
        break;
      case "--token":
        if (next) { result.token = next; i++; }
        break;
      case "--labels":
        if (next) {
          try { result.labels = JSON.parse(next); } catch { /* skip */ }
          i++;
        }
        break;
      case "--capabilities":
        if (next) { result.capabilities = next.split(",").map((s) => s.trim()); i++; }
        break;
      case "--max-concurrency":
        if (next) { result.maxConcurrency = parseInt(next, 10) || 4; i++; }
        break;
      case "--port":
        if (next) { result.beaconPort = parseInt(next, 10) || 19820; i++; }
        break;
      case "--config":
        if (next) {
          try {
            const raw = fs.readFileSync(path.resolve(next), "utf-8");
            const parsed = JSON.parse(raw);
            if (typeof parsed === "object" && parsed !== null) {
              Object.assign(result, parsed);
            }
          } catch (err) {
            console.error(`[worker] Failed to load config file: ${next}`, err);
          }
          i++;
        }
        break;
    }
  }
  return result;
}

export function resolveConfig(): WorkerConfig {
  const file = loadConfigFile();
  const cli = parseCliArgs(process.argv.slice(2));

  const server =
    cli.server ??
    process.env.PAPERCLIP_SERVER_URL ??
    process.env.PAPERCLIP_API_URL ??
    file.server ??
    "";

  const token =
    cli.token ??
    process.env.PAPERCLIP_WORKER_TOKEN ??
    file.token ??
    "";

  const labels = cli.labels ?? file.labels ?? {};
  const capabilities = cli.capabilities ?? file.capabilities ?? null;
  const maxConcurrency = cli.maxConcurrency ?? file.maxConcurrency ?? 4;
  const env = file.env ?? {};
  const beaconPort = cli.beaconPort ?? file.beaconPort ?? 19820;

  return { server, token, labels, capabilities, maxConcurrency, env, beaconPort };
}
