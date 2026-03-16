import { randomBytes, createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";
import os from "node:os";
import { Router } from "express";
import { eq, and } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { workers } from "@paperclipai/db";
import { createWorkerSchema, updateWorkerSchema } from "@paperclipai/shared";
import { notFound } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { logActivity } from "../services/activity-log.js";
import { discoverWorkers, probeWorker } from "../services/worker-discovery.js";
import type { WorkerRegistry } from "../services/worker-registry.js";

const TOKEN_PREFIX = "pclip_wk_";

function generateWorkerToken(): string {
  return TOKEN_PREFIX + randomBytes(32).toString("hex");
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function verifyEd25519(publicKeyPem: string, challenge: string, signatureBase64: string): boolean {
  try {
    return cryptoVerify(null, Buffer.from(challenge), publicKeyPem, Buffer.from(signatureBase64, "base64"));
  } catch {
    return false;
  }
}

function computeFingerprint(publicKeyPem: string): string {
  const der = createPublicKey(publicKeyPem).export({ type: "spki", format: "der" });
  return `SHA256:${createHash("sha256").update(der).digest("base64")}`;
}

function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 10_000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

function resolveServerUrl(reqHost: string | undefined): string {
  if (process.env.PAPERCLIP_API_URL) return process.env.PAPERCLIP_API_URL;
  const port = process.env.PAPERCLIP_LISTEN_PORT ?? "3100";
  const host = reqHost?.split(":")[0];
  if (host && host !== "localhost" && host !== "127.0.0.1" && host !== "0.0.0.0") {
    return `http://${host}:${port}`;
  }
  const interfaces = os.networkInterfaces();
  for (const iface of Object.values(interfaces)) {
    if (!iface) continue;
    for (const addr of iface) {
      if (addr.family === "IPv4" && !addr.internal) return `http://${addr.address}:${port}`;
    }
  }
  return `http://localhost:${port}`;
}

function toWorkerResponse(
  row: typeof workers.$inferSelect,
  registry: WorkerRegistry,
) {
  const live = registry.get(row.id);
  return {
    id: row.id,
    companyId: row.companyId,
    name: row.name,
    platform: live?.platform || row.platform,
    arch: live?.arch || row.arch,
    nodeVersion: live?.nodeVersion || row.nodeVersion,
    capabilities: live?.capabilities ?? row.capabilities,
    labels: live?.labels ?? row.labels,
    maxConcurrency: live?.maxConcurrency ?? row.maxConcurrency,
    status: registry.isOnline(row.id) ? "online" : "offline",
    activeRuns: registry.getActiveRuns(row.id),
    lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function workerRoutes(db: Db, registry: WorkerRegistry) {
  const router = Router();

  router.get("/companies/:companyId/workers", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoard(req);
    assertCompanyAccess(req, companyId);

    const rows = await db
      .select()
      .from(workers)
      .where(eq(workers.companyId, companyId));

    res.json(rows.map((row) => toWorkerResponse(row, registry)));
  });

  router.post(
    "/companies/:companyId/workers",
    validate(createWorkerSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertBoard(req);
      assertCompanyAccess(req, companyId);

      const { name, labels, maxConcurrency } = req.body;
      const token = generateWorkerToken();
      const tokenHash = hashToken(token);

      const [row] = await db
        .insert(workers)
        .values({
          companyId,
          name,
          tokenHash,
          labels: labels ?? {},
          maxConcurrency: maxConcurrency ?? 4,
        })
        .returning();

      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.type === "board" ? (req.actor.userId ?? "board") : "system",
        action: "worker.created",
        entityType: "worker",
        entityId: row.id,
        details: { name },
      });

      res.status(201).json({
        worker: toWorkerResponse(row, registry),
        token,
      });
    },
  );

  router.get("/workers/:id", async (req, res) => {
    const id = req.params.id as string;
    assertBoard(req);

    const row = await db
      .select()
      .from(workers)
      .where(eq(workers.id, id))
      .then((rows) => rows[0] ?? null);

    if (!row) throw notFound("Worker not found");
    assertCompanyAccess(req, row.companyId);

    res.json(toWorkerResponse(row, registry));
  });

  router.patch(
    "/workers/:id",
    validate(updateWorkerSchema),
    async (req, res) => {
      const id = req.params.id as string;
      assertBoard(req);

      const row = await db
        .select()
        .from(workers)
        .where(eq(workers.id, id))
        .then((rows) => rows[0] ?? null);

      if (!row) throw notFound("Worker not found");
      assertCompanyAccess(req, row.companyId);

      const updates: Partial<typeof workers.$inferInsert> = { updatedAt: new Date() };
      if (req.body.name !== undefined) updates.name = req.body.name;
      if (req.body.labels !== undefined) updates.labels = req.body.labels;
      if (req.body.maxConcurrency !== undefined) updates.maxConcurrency = req.body.maxConcurrency;

      const [updated] = await db
        .update(workers)
        .set(updates)
        .where(eq(workers.id, id))
        .returning();

      res.json(toWorkerResponse(updated, registry));
    },
  );

  router.delete("/workers/:id", async (req, res) => {
    const id = req.params.id as string;
    assertBoard(req);

    const row = await db
      .select()
      .from(workers)
      .where(eq(workers.id, id))
      .then((rows) => rows[0] ?? null);

    if (!row) throw notFound("Worker not found");
    assertCompanyAccess(req, row.companyId);

    const live = registry.get(row.id);
    if (live) {
      live.ws.close(1000, "worker revoked");
      registry.unregister(row.id);
    }

    await db.delete(workers).where(eq(workers.id, id));

    await logActivity(db, {
      companyId: row.companyId,
      actorType: "user",
      actorId: req.actor.type === "board" ? (req.actor.userId ?? "board") : "system",
      action: "worker.deleted",
      entityType: "worker",
      entityId: row.id,
      details: { name: row.name },
    });

    res.json({ ok: true });
  });

  // ---------------------------------------------------------------------------
  // LAN discovery: scan local subnets for worker beacons
  // ---------------------------------------------------------------------------

  router.post("/companies/:companyId/workers/discover", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoard(req);
    assertCompanyAccess(req, companyId);

    const { subnets, extraHosts, port, limit } = req.body as {
      subnets?: string[];
      extraHosts?: string[];
      port?: number;
      limit?: number;
    };

    const result = await discoverWorkers({
      subnets,
      extraHosts,
      port,
      limit: typeof limit === "number" && limit > 0 ? limit : 10,
    });
    res.json(result);
  });

  // ---------------------------------------------------------------------------
  // Probe a single host (manual "add by IP" flow)
  // ---------------------------------------------------------------------------

  router.post("/companies/:companyId/workers/probe", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoard(req);
    assertCompanyAccess(req, companyId);

    const { host, port } = req.body as { host: string; port?: number };
    if (!host) {
      res.status(400).json({ error: "host is required" });
      return;
    }

    const info = await probeWorker(host, port);
    if (!info) {
      res.status(404).json({ error: "no worker beacon found at that address" });
      return;
    }

    res.json({ worker: info });
  });

  // ---------------------------------------------------------------------------
  // Pair with a discovered worker using Ed25519 challenge-response.
  //
  // Flow:
  //   1. Server sends random challenge to worker's /challenge endpoint
  //   2. Worker signs challenge with its Ed25519 private key, returns signature + public key
  //   3. Server verifies signature matches the public key
  //   4. User confirms the fingerprint matches what's shown on the worker terminal
  //   5. Server tells worker to connect via /pair endpoint
  //   6. Worker calls /pair-accept to register and get a WebSocket token
  // ---------------------------------------------------------------------------

  router.post("/companies/:companyId/workers/pair", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoard(req);
    assertCompanyAccess(req, companyId);

    const { host, port = 19820, fingerprint, name } = req.body as {
      host: string;
      port?: number;
      fingerprint: string;
      name?: string;
    };

    if (!host || !fingerprint) {
      res.status(400).json({ error: "host and fingerprint are required" });
      return;
    }

    const serverUrl = resolveServerUrl(req.headers.host);
    const challenge = randomBytes(32).toString("hex");
    const workerBase = `http://${host}:${port}`;

    try {
      // Step 1: Send challenge to worker
      const challengeRes = await fetchWithTimeout(
        `${workerBase}/challenge`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ challenge }) },
      );

      if (!challengeRes.ok) {
        res.status(502).json({ error: "worker did not respond to challenge" });
        return;
      }

      const challengeBody = (await challengeRes.json()) as {
        ok: boolean;
        signature?: string;
        publicKey?: string;
        error?: string;
      };

      if (!challengeBody.ok || !challengeBody.signature || !challengeBody.publicKey) {
        res.status(400).json({ error: challengeBody.error ?? "invalid challenge response" });
        return;
      }

      // Step 2: Verify the signature
      const signatureValid = verifyEd25519(challengeBody.publicKey, challenge, challengeBody.signature);
      if (!signatureValid) {
        res.status(403).json({ error: "signature verification failed — worker identity could not be confirmed" });
        return;
      }

      // Step 3: Verify the fingerprint matches what the user provided
      const actualFingerprint = computeFingerprint(challengeBody.publicKey);
      if (actualFingerprint !== fingerprint) {
        res.status(403).json({
          error: "fingerprint mismatch — the worker's key does not match the fingerprint you provided",
          expected: fingerprint,
          actual: actualFingerprint,
        });
        return;
      }

      // Step 4: Tell worker to connect back to this server
      const pairRes = await fetchWithTimeout(
        `${workerBase}/pair`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ serverUrl, companyId, workerName: name }) },
      );

      const pairBody = (await pairRes.json()) as { ok: boolean; error?: string };
      if (!pairBody.ok) {
        res.status(400).json({ error: pairBody.error ?? "worker rejected pairing" });
        return;
      }

      res.json({
        ok: true,
        fingerprint: actualFingerprint,
        message: "Worker identity verified and paired — connecting shortly",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const cause = err instanceof Error && err.cause instanceof Error ? ` (${err.cause.message})` : "";
      res.status(502).json({
        error: `Could not reach worker at ${host}:${port}: ${msg}${cause}`,
      });
    }
  });

  // ---------------------------------------------------------------------------
  // Pair by adapter code: user enters a PCLIP-XXXX code from the worker banner
  // ---------------------------------------------------------------------------

  router.post("/companies/:companyId/workers/pair-by-code", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoard(req);
    assertCompanyAccess(req, companyId);

    const { code } = req.body as { code: string };
    if (!code || typeof code !== "string") {
      res.status(400).json({ error: "code is required" });
      return;
    }

    const trimmedCode = code.trim().toUpperCase();

    // 1. Scan LAN for workers
    const { discovered } = await discoverWorkers({ limit: 20 });

    // 2. Find the worker whose adapter matches the code
    let matchedWorker: (typeof discovered)[number] | null = null;
    let matchedAdapter: { type: string; label: string; version: string } | null = null;

    for (const w of discovered) {
      for (const a of w.adapters) {
        if (a.pairCode && a.pairCode.toUpperCase() === trimmedCode) {
          matchedWorker = w;
          matchedAdapter = { type: a.type, label: a.label, version: a.version };
          break;
        }
      }
      if (matchedWorker) break;
    }

    if (!matchedWorker || !matchedAdapter) {
      res.status(404).json({ error: "No worker found with that pairing code. Make sure the worker is running on the same network." });
      return;
    }

    const { host, port, fingerprint } = matchedWorker;
    const serverUrl = resolveServerUrl(req.headers.host);
    const challenge = randomBytes(32).toString("hex");
    const workerBase = `http://${host}:${port}`;

    try {
      // 3. Challenge-response to verify worker identity
      const challengeRes = await fetchWithTimeout(
        `${workerBase}/challenge`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ challenge }) },
      );

      if (!challengeRes.ok) {
        res.status(502).json({ error: "worker did not respond to challenge" });
        return;
      }

      const challengeBody = (await challengeRes.json()) as {
        ok: boolean; signature?: string; publicKey?: string; error?: string;
      };

      if (!challengeBody.ok || !challengeBody.signature || !challengeBody.publicKey) {
        res.status(400).json({ error: challengeBody.error ?? "invalid challenge response" });
        return;
      }

      const signatureValid = verifyEd25519(challengeBody.publicKey, challenge, challengeBody.signature);
      if (!signatureValid) {
        res.status(403).json({ error: "signature verification failed" });
        return;
      }

      const actualFingerprint = computeFingerprint(challengeBody.publicKey);
      if (actualFingerprint !== fingerprint) {
        res.status(403).json({ error: "fingerprint mismatch" });
        return;
      }

      // 4. Tell worker to connect
      const pairRes = await fetchWithTimeout(
        `${workerBase}/pair`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ serverUrl, companyId, workerName: matchedWorker.hostname }) },
      );

      const pairBody = (await pairRes.json()) as { ok: boolean; error?: string };
      if (!pairBody.ok) {
        res.status(400).json({ error: pairBody.error ?? "worker rejected pairing" });
        return;
      }

      // 5. Wait briefly for the worker to call /pair-accept and register
      await new Promise((r) => setTimeout(r, 2000));

      // Find the worker that was just created by pair-accept
      const rows = await db
        .select()
        .from(workers)
        .where(eq(workers.companyId, companyId));

      const paired = rows.find((r) => {
        const live = registry.get(r.id);
        return live && registry.isOnline(r.id);
      });

      const workerResponse = paired ? toWorkerResponse(paired, registry) : null;

      res.json({
        ok: true,
        worker: workerResponse,
        adapter: matchedAdapter,
        hostname: matchedWorker.hostname,
        fingerprint: actualFingerprint,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const cause = err instanceof Error && err.cause instanceof Error ? ` (${err.cause.message})` : "";
      res.status(502).json({
        error: `Could not reach worker at ${host}:${port}: ${msg}${cause}`,
      });
    }
  });

  // ---------------------------------------------------------------------------
  // Accept a worker pairing callback (called by the worker daemon after /pair)
  // ---------------------------------------------------------------------------

  router.post("/workers/pair-accept", async (req, res) => {
    const {
      hostname,
      platform,
      arch,
      nodeVersion,
      capabilities,
      maxConcurrency,
      labels,
      publicKey,
      fingerprint: workerFingerprint,
      companyId,
      workerName,
    } = req.body as {
      hostname: string;
      platform: string;
      arch: string;
      nodeVersion: string;
      capabilities: string[];
      maxConcurrency: number;
      labels: Record<string, unknown>;
      publicKey: string;
      fingerprint: string;
      companyId?: string;
      workerName?: string;
    };

    if (!publicKey) {
      res.status(400).json({ error: "publicKey is required" });
      return;
    }

    const token = generateWorkerToken();
    const tokenHash = hashToken(token);

    const resolvedCompanyId = companyId ?? (req.actor.type === "board" ? req.actor.companyIds?.[0] : undefined);
    if (!resolvedCompanyId) {
      res.status(400).json({ error: "could not determine companyId for worker" });
      return;
    }

    const [row] = await db
      .insert(workers)
      .values({
        companyId: resolvedCompanyId,
        name: workerName || hostname || "Discovered Worker",
        tokenHash,
        platform,
        arch,
        nodeVersion,
        capabilities: capabilities ?? [],
        labels: labels ?? {},
        maxConcurrency: maxConcurrency ?? 4,
      })
      .returning();

    await logActivity(db, {
      companyId: resolvedCompanyId,
      actorType: "system",
      actorId: "worker-pairing",
      action: "worker.paired",
      entityType: "worker",
      entityId: row.id,
      details: { hostname, platform, capabilities, fingerprint: workerFingerprint },
    });

    res.status(201).json({ token, workerId: row.id });
  });

  return router;
}
