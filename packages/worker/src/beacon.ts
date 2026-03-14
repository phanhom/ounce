import http from "node:http";
import os from "node:os";
import crypto from "node:crypto";

export const WORKER_BEACON_PORT = 19820;
const PKG_VERSION = "0.3.0";

export interface BeaconInfo {
  service: "paperclip-worker";
  version: string;
  hostname: string;
  platform: string;
  arch: string;
  nodeVersion: string;
  capabilities: string[];
  maxConcurrency: number;
  labels: Record<string, unknown>;
  paired: boolean;
}

export interface PairRequest {
  serverUrl: string;
  key: string;
  companyId?: string;
  workerName?: string;
}

export interface PairResult {
  ok: boolean;
  error?: string;
}

type OnPairCallback = (req: PairRequest) => Promise<PairResult>;

/**
 * Lightweight HTTP beacon that the worker exposes on a fixed port.
 *
 * - GET  /info  — unauthenticated, returns capabilities for LAN discovery
 * - POST /pair  — accepts { serverUrl, key } to initiate outbound connection
 */
export class WorkerBeacon {
  private server: http.Server | null = null;
  private paired = false;

  constructor(
    private readonly workerKey: string,
    private readonly capabilities: string[],
    private readonly maxConcurrency: number,
    private readonly labels: Record<string, unknown>,
    private readonly onPair: OnPairCallback,
  ) {}

  async start(port = WORKER_BEACON_PORT): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        void this.handleRequest(req, res);
      });

      this.server.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") {
          console.warn(`[beacon] Port ${port} in use, trying ${port + 1}`);
          this.server!.listen(port + 1, "0.0.0.0");
          return;
        }
        reject(err);
      });

      this.server.on("listening", () => {
        const addr = this.server!.address();
        const actualPort = typeof addr === "object" && addr ? addr.port : port;
        resolve(actualPort);
      });

      this.server.listen(port, "0.0.0.0");
    });
  }

  stop(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (req.method === "GET" && url.pathname === "/info") {
      return this.handleInfo(res);
    }

    if (req.method === "POST" && url.pathname === "/pair") {
      return this.handlePair(req, res);
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  }

  private handleInfo(res: http.ServerResponse): void {
    const info: BeaconInfo = {
      service: "paperclip-worker",
      version: PKG_VERSION,
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
      nodeVersion: process.version,
      capabilities: this.capabilities,
      maxConcurrency: this.maxConcurrency,
      labels: this.labels,
      paired: this.paired,
    };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(info));
  }

  private async handlePair(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await readBody(req);
    let parsed: PairRequest;
    try {
      parsed = JSON.parse(body);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "invalid JSON" }));
      return;
    }

    if (!parsed.serverUrl || !parsed.key) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "missing serverUrl or key" }));
      return;
    }

    const keyValid = crypto.timingSafeEqual(
      Buffer.from(this.workerKey),
      Buffer.from(parsed.key.padEnd(this.workerKey.length).slice(0, this.workerKey.length)),
    ) && parsed.key === this.workerKey;

    if (!keyValid) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "invalid key" }));
      return;
    }

    try {
      const result = await this.onPair(parsed);
      this.paired = result.ok;
      const status = result.ok ? 200 : 400;
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ok: false,
        error: err instanceof Error ? err.message : "pairing failed",
      }));
    }
  }
}

function readBody(req: http.IncomingMessage, limit = 64 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) { req.destroy(); reject(new Error("body too large")); return; }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}
