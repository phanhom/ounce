import http from "node:http";
import os from "node:os";
import crypto from "node:crypto";
import { signChallenge } from "./keygen.js";

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
  fingerprint: string;
  publicKey: string;
  paired: boolean;
}

export interface PairChallengeRequest {
  serverUrl: string;
  challenge: string;
  companyId?: string;
  workerName?: string;
}

export interface PairChallengeResponse {
  ok: boolean;
  signature?: string;
  publicKey?: string;
  error?: string;
}

export interface PairResult {
  ok: boolean;
  error?: string;
}

type OnPairCallback = (serverUrl: string, companyId?: string, workerName?: string) => Promise<PairResult>;

/**
 * Lightweight HTTP beacon on a fixed port for LAN discovery and pairing.
 *
 * - GET  /info       — public; returns capabilities + public key fingerprint
 * - POST /challenge  — server sends a random nonce; worker signs it with Ed25519 private key
 * - POST /pair       — after challenge verified, server tells worker to connect
 */
export class WorkerBeacon {
  private server: http.Server | null = null;
  private paired = false;

  constructor(
    private readonly privateKeyPem: string,
    private readonly publicKeyPem: string,
    private readonly fingerprint: string,
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
    if (req.method === "POST" && url.pathname === "/challenge") {
      return this.handleChallenge(req, res);
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
      fingerprint: this.fingerprint,
      publicKey: this.publicKeyPem,
      paired: this.paired,
    };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(info));
  }

  /**
   * Server sends { challenge } — worker signs with Ed25519 private key and
   * returns { signature, publicKey }. The private key never leaves this machine.
   */
  private async handleChallenge(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await readBody(req);
    let parsed: { challenge?: string };
    try {
      parsed = JSON.parse(body);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "invalid JSON" }));
      return;
    }

    if (!parsed.challenge || typeof parsed.challenge !== "string") {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "missing challenge" }));
      return;
    }

    const signature = signChallenge(this.privateKeyPem, parsed.challenge);

    const resp: PairChallengeResponse = {
      ok: true,
      signature,
      publicKey: this.publicKeyPem,
    };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(resp));
  }

  /**
   * After the server has verified the challenge signature against the public key
   * whose fingerprint the user confirmed, it tells the worker to connect.
   */
  private async handlePair(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await readBody(req);
    let parsed: { serverUrl?: string; proof?: string; companyId?: string; workerName?: string };
    try {
      parsed = JSON.parse(body);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "invalid JSON" }));
      return;
    }

    if (!parsed.serverUrl) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "missing serverUrl" }));
      return;
    }

    // proof is a server-signed token that confirms the challenge was verified.
    // For now we trust the server sending /pair after a successful /challenge.
    // A replay-resistant proof can be added later.

    try {
      const result = await this.onPair(parsed.serverUrl, parsed.companyId, parsed.workerName);
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
