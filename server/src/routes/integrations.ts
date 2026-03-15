import { Router } from "express";
import { eq, and } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companyIntegrations } from "@paperclipai/db";
import {
  upsertIntegrationSchema,
  integrationConfigSchemas,
  type IntegrationProvider,
} from "@paperclipai/shared";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import { logActivity } from "../services/activity-log.js";

export function integrationRoutes(db: Db) {
  const router = Router();

  // List all integrations for a company
  router.get("/companies/:companyId/integrations", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoard(req);
    assertCompanyAccess(req, companyId);

    const rows = await db
      .select()
      .from(companyIntegrations)
      .where(eq(companyIntegrations.companyId, companyId));

    const masked = rows.map((row) => ({
      ...row,
      config: maskSensitiveFields(row.provider as IntegrationProvider, row.config as Record<string, unknown>),
    }));

    res.json({ integrations: masked });
  });

  // Get a single integration by provider
  router.get("/companies/:companyId/integrations/:provider", async (req, res) => {
    const companyId = req.params.companyId as string;
    const provider = req.params.provider as string;
    assertBoard(req);
    assertCompanyAccess(req, companyId);

    const [row] = await db
      .select()
      .from(companyIntegrations)
      .where(
        and(
          eq(companyIntegrations.companyId, companyId),
          eq(companyIntegrations.provider, provider),
        ),
      );

    if (!row) {
      res.status(404).json({ error: "integration not found" });
      return;
    }

    res.json({
      integration: {
        ...row,
        config: maskSensitiveFields(row.provider as IntegrationProvider, row.config as Record<string, unknown>),
      },
    });
  });

  // Upsert: create or update an integration
  router.put("/companies/:companyId/integrations", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoard(req);
    assertCompanyAccess(req, companyId);

    const parsed = upsertIntegrationSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "validation failed", details: parsed.error.flatten() });
      return;
    }

    const { provider, name, config } = parsed.data;

    const providerSchema = integrationConfigSchemas[provider];
    const configParsed = providerSchema.safeParse(config);
    if (!configParsed.success) {
      res.status(400).json({ error: "invalid config for provider", details: configParsed.error.flatten() });
      return;
    }

    const existing = await db
      .select()
      .from(companyIntegrations)
      .where(
        and(
          eq(companyIntegrations.companyId, companyId),
          eq(companyIntegrations.provider, provider),
        ),
      );

    const actor = getActorInfo(req);
    let row;

    if (existing.length > 0) {
      const mergedConfig = mergeConfig(
        existing[0].config as Record<string, unknown>,
        configParsed.data as Record<string, unknown>,
        provider,
      );

      [row] = await db
        .update(companyIntegrations)
        .set({
          name: name || existing[0].name,
          config: mergedConfig,
          status: "active",
          updatedAt: new Date(),
        })
        .where(eq(companyIntegrations.id, existing[0].id))
        .returning();

      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        action: "integration.updated",
        entityType: "integration",
        entityId: row.id,
        details: { provider },
      });
    } else {
      [row] = await db
        .insert(companyIntegrations)
        .values({
          companyId,
          provider,
          name: name || provider.toUpperCase(),
          config: configParsed.data,
          status: "active",
        })
        .returning();

      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        action: "integration.created",
        entityType: "integration",
        entityId: row.id,
        details: { provider },
      });
    }

    res.json({
      integration: {
        ...row,
        config: maskSensitiveFields(row.provider as IntegrationProvider, row.config as Record<string, unknown>),
      },
    });
  });

  // Delete an integration
  router.delete("/companies/:companyId/integrations/:provider", async (req, res) => {
    const companyId = req.params.companyId as string;
    const provider = req.params.provider as string;
    assertBoard(req);
    assertCompanyAccess(req, companyId);

    const [row] = await db
      .select()
      .from(companyIntegrations)
      .where(
        and(
          eq(companyIntegrations.companyId, companyId),
          eq(companyIntegrations.provider, provider),
        ),
      );

    if (!row) {
      res.status(404).json({ error: "integration not found" });
      return;
    }

    await db.delete(companyIntegrations).where(eq(companyIntegrations.id, row.id));

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "integration.deleted",
      entityType: "integration",
      entityId: row.id,
      details: { provider },
    });

    res.json({ ok: true });
  });

  // Test connection
  router.post("/companies/:companyId/integrations/:provider/test", async (req, res) => {
    const companyId = req.params.companyId as string;
    const provider = req.params.provider as string;
    assertBoard(req);
    assertCompanyAccess(req, companyId);

    const providerSchema = integrationConfigSchemas[provider as IntegrationProvider];
    if (!providerSchema) {
      res.status(400).json({ error: `unknown provider: ${provider}` });
      return;
    }

    let config: Record<string, unknown>;

    if (req.body.config) {
      const configParsed = providerSchema.safeParse(req.body.config);
      if (!configParsed.success) {
        res.status(400).json({ error: "invalid config", details: configParsed.error.flatten() });
        return;
      }
      config = configParsed.data as Record<string, unknown>;
    } else {
      const [row] = await db
        .select()
        .from(companyIntegrations)
        .where(
          and(
            eq(companyIntegrations.companyId, companyId),
            eq(companyIntegrations.provider, provider),
          ),
        );
      if (!row) {
        res.status(404).json({ error: "integration not found; provide config in body to test ad-hoc" });
        return;
      }
      config = row.config as Record<string, unknown>;
    }

    try {
      const result = await testConnection(provider as IntegrationProvider, config);

      if (result.ok) {
        await db
          .update(companyIntegrations)
          .set({ lastTestedAt: new Date(), status: "active" })
          .where(
            and(
              eq(companyIntegrations.companyId, companyId),
              eq(companyIntegrations.provider, provider),
            ),
          );
      }

      res.json(result);
    } catch (err) {
      res.json({
        ok: false,
        error: err instanceof Error ? err.message : "connection test failed",
      });
    }
  });

  return router;
}

const SENSITIVE_FIELDS: Record<IntegrationProvider, string[]> = {
  mysql: ["password"],
  minio: ["secretKey"],
  gitlab: ["token"],
};

function maskSensitiveFields(
  provider: IntegrationProvider,
  config: Record<string, unknown>,
): Record<string, unknown> {
  const fields = SENSITIVE_FIELDS[provider] ?? [];
  const masked = { ...config };
  for (const field of fields) {
    if (masked[field] && typeof masked[field] === "string") {
      const val = masked[field] as string;
      masked[field] = val.length > 4 ? "••••" + val.slice(-4) : "••••";
    }
  }
  return masked;
}

/**
 * When updating, if a sensitive field comes in as "••••xxxx" (masked),
 * preserve the existing value from the database.
 */
function mergeConfig(
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>,
  provider: string,
): Record<string, unknown> {
  const fields = SENSITIVE_FIELDS[provider as IntegrationProvider] ?? [];
  const merged = { ...incoming };
  for (const field of fields) {
    const val = merged[field];
    if (typeof val === "string" && val.startsWith("••••")) {
      merged[field] = existing[field];
    }
  }
  return merged;
}

async function testConnection(
  provider: IntegrationProvider,
  config: Record<string, unknown>,
): Promise<{ ok: boolean; message: string; error?: string }> {
  switch (provider) {
    case "mysql":
      return testMysql(config);
    case "minio":
      return testMinio(config);
    case "gitlab":
      return testGitlab(config);
    default:
      return { ok: false, message: "unknown provider", error: "unknown provider" };
  }
}

async function testMysql(config: Record<string, unknown>): Promise<{ ok: boolean; message: string; error?: string }> {
  const { host, port, database, username, password, ssl } = config as {
    host: string; port: number; database: string; username: string; password: string; ssl: boolean;
  };

  try {
    const net = await import("node:net");
    return new Promise((resolve) => {
      const socket = net.createConnection({ host, port: port || 3306, timeout: 5000 }, () => {
        socket.destroy();
        resolve({
          ok: true,
          message: `TCP connection to ${host}:${port || 3306} succeeded (database: ${database}, user: ${username}, ssl: ${ssl})`,
        });
      });
      socket.on("error", (err) => {
        resolve({
          ok: false,
          message: `Cannot reach ${host}:${port || 3306}`,
          error: err.message,
        });
      });
      socket.on("timeout", () => {
        socket.destroy();
        resolve({
          ok: false,
          message: `Connection to ${host}:${port || 3306} timed out`,
          error: "timeout",
        });
      });
    });
  } catch (err) {
    return {
      ok: false,
      message: "MySQL connection test failed",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function testMinio(config: Record<string, unknown>): Promise<{ ok: boolean; message: string; error?: string }> {
  const { endpoint, port, useSSL, bucket } = config as {
    endpoint: string; port: number; useSSL: boolean; bucket: string;
    accessKey: string; secretKey: string;
  };

  const proto = useSSL ? "https" : "http";
  const url = `${proto}://${endpoint}:${port || 9000}/minio/health/live`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (res.ok) {
      return { ok: true, message: `MinIO is reachable at ${endpoint}:${port || 9000} (bucket: ${bucket})` };
    }
    return { ok: false, message: `MinIO responded with status ${res.status}`, error: `HTTP ${res.status}` };
  } catch (err) {
    return {
      ok: false,
      message: `Cannot reach MinIO at ${endpoint}:${port || 9000}`,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function testGitlab(config: Record<string, unknown>): Promise<{ ok: boolean; message: string; error?: string }> {
  const { url, token } = config as { url: string; token: string; group: string };
  const apiUrl = `${url.replace(/\/+$/, "")}/api/v4/user`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(apiUrl, {
      headers: { "PRIVATE-TOKEN": token },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (res.ok) {
      const user = (await res.json()) as { username?: string };
      return { ok: true, message: `Authenticated as ${user.username ?? "unknown"} on ${url}` };
    }
    if (res.status === 401) {
      return { ok: false, message: "Authentication failed — invalid token", error: "401 Unauthorized" };
    }
    return { ok: false, message: `GitLab responded with status ${res.status}`, error: `HTTP ${res.status}` };
  } catch (err) {
    return {
      ok: false,
      message: `Cannot reach GitLab at ${url}`,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
