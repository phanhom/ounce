import { randomBytes, createHash } from "node:crypto";
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
  // Pair with a discovered worker: send the worker's key to it, get it to
  // connect back to us, and persist it in the database.
  // ---------------------------------------------------------------------------

  router.post("/companies/:companyId/workers/pair", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoard(req);
    assertCompanyAccess(req, companyId);

    const { host, port = 19820, key, name } = req.body as {
      host: string;
      port?: number;
      key: string;
      name?: string;
    };

    if (!host || !key) {
      res.status(400).json({ error: "host and key are required" });
      return;
    }

    const serverUrl = process.env.PAPERCLIP_API_URL ?? `http://localhost:${process.env.PAPERCLIP_LISTEN_PORT ?? "3100"}`;

    try {
      const pairRes = await fetch(`http://${host}:${port}/pair`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serverUrl,
          key,
          companyId,
          workerName: name,
        }),
      });

      const pairBody = (await pairRes.json()) as { ok: boolean; error?: string };
      if (!pairBody.ok) {
        res.status(400).json({
          error: pairBody.error ?? "worker rejected pairing",
        });
        return;
      }

      res.json({ ok: true, message: "Worker paired and will connect shortly" });
    } catch (err) {
      res.status(502).json({
        error: `Could not reach worker at ${host}:${port}: ${err instanceof Error ? err.message : String(err)}`,
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
      workerKey,
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
      workerKey: string;
      companyId?: string;
      workerName?: string;
    };

    if (!workerKey) {
      res.status(400).json({ error: "workerKey is required" });
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
      details: { hostname, platform, capabilities },
    });

    res.status(201).json({ token, workerId: row.id });
  });

  return router;
}
