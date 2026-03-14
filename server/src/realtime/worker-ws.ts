import { createHash } from "node:crypto";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import { createRequire } from "node:module";
import type { Duplex } from "node:stream";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { workers } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import type {
  WorkerRegistry,
  WorkerRegisterFrame,
  WorkerLogFrame,
  WorkerMetaFrame,
  WorkerResultFrame,
  WorkerToServerFrame,
  WorkerSocket,
} from "../services/worker-registry.js";

interface WsSocket extends WorkerSocket {
  ping(): void;
  on(event: "message", listener: (data: Buffer | string) => void): void;
  on(event: "pong", listener: () => void): void;
  on(event: "close", listener: () => void): void;
  on(event: "error", listener: (err: Error) => void): void;
}

interface WsServer {
  clients: Set<WsSocket>;
  on(event: "connection", listener: (socket: WsSocket, req: IncomingMessage) => void): void;
  on(event: "close", listener: () => void): void;
  handleUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    callback: (ws: WsSocket) => void,
  ): void;
  emit(event: "connection", ws: WsSocket, req: IncomingMessage): boolean;
}

const require = createRequire(import.meta.url);
const { WebSocket, WebSocketServer } = require("ws") as {
  WebSocket: { OPEN: number };
  WebSocketServer: new (opts: { noServer: boolean }) => WsServer;
};

const WORKER_WS_PATH = "/api/ws/worker";
const PING_INTERVAL_MS = 30_000;

interface WorkerUpgradeContext {
  workerId: string;
  companyId: string;
}

interface IncomingMessageWithWorkerContext extends IncomingMessage {
  paperclipWorkerContext?: WorkerUpgradeContext;
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function rejectUpgrade(socket: Duplex, statusLine: string, message: string) {
  const safe = message.replace(/[\r\n]+/g, " ").trim();
  socket.write(`HTTP/1.1 ${statusLine}\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\n${safe}`);
  socket.destroy();
}

function extractBearerToken(req: IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (!auth || !auth.toLowerCase().startsWith("bearer ")) return null;
  const token = auth.slice("bearer ".length).trim();
  return token.length > 0 ? token : null;
}

async function verifyWorkerToken(
  db: Db,
  token: string,
): Promise<WorkerUpgradeContext | null> {
  const tokenHash = hashToken(token);
  const row = await db
    .select({ id: workers.id, companyId: workers.companyId })
    .from(workers)
    .where(eq(workers.tokenHash, tokenHash))
    .then((rows) => rows[0] ?? null);

  if (!row) return null;
  return { workerId: row.id, companyId: row.companyId };
}

function parseWorkerFrame(raw: Buffer | string): WorkerToServerFrame | null {
  try {
    const text = typeof raw === "string" ? raw : raw.toString("utf-8");
    const parsed = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || typeof parsed.type !== "string") return null;
    return parsed as WorkerToServerFrame;
  } catch {
    return null;
  }
}

export function setupWorkerWebSocketServer(
  server: HttpServer,
  db: Db,
  registry: WorkerRegistry,
) {
  const wss = new WebSocketServer({ noServer: true });
  const aliveByClient = new Map<WsSocket, boolean>();
  const workerIdByClient = new Map<WsSocket, string>();

  const pingInterval = setInterval(() => {
    for (const socket of wss.clients) {
      if (!aliveByClient.get(socket)) {
        socket.terminate();
        continue;
      }
      aliveByClient.set(socket, false);
      socket.ping();
    }
  }, PING_INTERVAL_MS);

  wss.on("connection", (socket: WsSocket, req: IncomingMessage) => {
    const ctx = (req as IncomingMessageWithWorkerContext).paperclipWorkerContext;
    if (!ctx) {
      socket.close(1008, "missing context");
      return;
    }

    const { workerId, companyId } = ctx;

    registry.register({
      workerId,
      companyId,
      ws: socket,
      platform: "",
      arch: "",
      nodeVersion: "",
      capabilities: [],
      labels: {},
      maxConcurrency: 4,
      activeRuns: 0,
      connectedAt: new Date(),
    });

    workerIdByClient.set(socket, workerId);
    aliveByClient.set(socket, true);

    void db
      .update(workers)
      .set({ status: "online", lastSeenAt: new Date(), updatedAt: new Date() })
      .where(eq(workers.id, workerId))
      .catch((err) => logger.error({ err, workerId }, "failed to update worker status to online"));

    socket.send(JSON.stringify({
      type: "welcome",
      workerId,
      serverVersion: "1.0.0",
    }));

    socket.on("message", (data) => {
      const frame = parseWorkerFrame(data);
      if (!frame) return;

      switch (frame.type) {
        case "register":
          registry.updateCapabilities(workerId, frame as WorkerRegisterFrame);
          void db
            .update(workers)
            .set({
              platform: (frame as WorkerRegisterFrame).platform,
              arch: (frame as WorkerRegisterFrame).arch,
              nodeVersion: (frame as WorkerRegisterFrame).nodeVersion,
              capabilities: (frame as WorkerRegisterFrame).capabilities,
              labels: (frame as WorkerRegisterFrame).labels,
              maxConcurrency: (frame as WorkerRegisterFrame).maxConcurrency,
              lastSeenAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(workers.id, workerId))
            .catch((err) => logger.error({ err, workerId }, "failed to persist worker registration"));
          socket.send(JSON.stringify({ type: "registered" }));
          break;

        case "log":
          registry.handleLog(workerId, frame as WorkerLogFrame);
          break;

        case "meta":
          registry.handleMeta(workerId, frame as WorkerMetaFrame);
          break;

        case "result":
          registry.handleResult(workerId, frame as WorkerResultFrame);
          break;

        case "pong":
          aliveByClient.set(socket, true);
          break;
      }
    });

    socket.on("pong", () => {
      aliveByClient.set(socket, true);
    });

    socket.on("close", () => {
      const wId = workerIdByClient.get(socket);
      if (wId) {
        registry.unregister(wId);
        void db
          .update(workers)
          .set({ status: "offline", activeRuns: 0, updatedAt: new Date() })
          .where(eq(workers.id, wId))
          .catch((err) => logger.error({ err, workerId: wId }, "failed to update worker status to offline"));
      }
      workerIdByClient.delete(socket);
      aliveByClient.delete(socket);
    });

    socket.on("error", (err: Error) => {
      logger.warn({ err, workerId }, "worker websocket client error");
    });
  });

  wss.on("close", () => {
    clearInterval(pingInterval);
  });

  server.on("upgrade", (req, socket, head) => {
    if (!req.url) return;

    const url = new URL(req.url, "http://localhost");
    if (url.pathname !== WORKER_WS_PATH) return;

    const token = extractBearerToken(req);
    if (!token) {
      rejectUpgrade(socket, "401 Unauthorized", "missing token");
      return;
    }

    void verifyWorkerToken(db, token)
      .then((workerCtx) => {
        if (!workerCtx) {
          rejectUpgrade(socket, "403 Forbidden", "invalid worker token");
          return;
        }

        const reqWithContext = req as IncomingMessageWithWorkerContext;
        reqWithContext.paperclipWorkerContext = workerCtx;

        wss.handleUpgrade(req, socket, head, (ws: WsSocket) => {
          wss.emit("connection", ws, reqWithContext);
        });
      })
      .catch((err) => {
        logger.error({ err, path: req.url }, "failed worker websocket upgrade authorization");
        rejectUpgrade(socket, "500 Internal Server Error", "upgrade failed");
      });
  });

  return wss;
}
