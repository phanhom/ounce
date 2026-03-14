# Remote Worker: Cross-Platform Distributed Agent Execution

**Date**: 2026-03-14
**Status**: Draft
**Author**: Design discussion

## 1. Problem

All local adapters (`claude_local`, `codex_local`, `cursor`, `gemini_local`, `opencode_local`, `pi_local`)
execute agents via `child_process.spawn()` on the Paperclip server host.
This limits execution to a single machine.

Real-world needs:
- Mac mini on the office LAN running Cursor and Claude Code (behind NAT, no public IP)
- GPU Linux server in the cloud running Codex or Claude Code
- Multiple developer Macs contributing idle capacity
- Mixing adapter types across heterogeneous hardware

## 2. Design Principles

1. **Worker connects outbound** — the remote machine initiates the WebSocket connection
   to Paperclip. This solves NAT, firewalls, and dynamic IPs without VPN or port forwarding.
2. **Reuse existing adapter code** — the worker imports the same `@paperclipai/adapter-*`
   packages and calls their `execute()` functions locally. Zero adapter rewriting.
3. **Company-scoped** — workers are bound to a company, consistent with Paperclip's
   multi-tenant model.
4. **Cross-platform** — the worker is a pure Node.js process. It runs identically on
   macOS (ARM/x86) and Linux (x86/ARM).
5. **Graceful degradation** — if no remote worker is available, execution falls back to
   local spawn (existing behavior).

## 3. Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                   Paperclip Server                       │
│                                                         │
│  ┌──────────────┐   ┌──────────────┐   ┌─────────────┐ │
│  │ Heartbeat    │──>│ Adapter      │──>│ Worker      │ │
│  │ Scheduler    │   │ Router       │   │ Registry    │ │
│  └──────────────┘   └──────┬───────┘   └──────┬──────┘ │
│                            │                   │        │
│                     ┌──────┴───────┐    WS endpoint     │
│                     │ Local exec   │   /api/ws/worker   │
│                     │ (fallback)   │          │         │
│                     └──────────────┘          │         │
└───────────────────────────────────────────────┼─────────┘
                                                │
                    ┌───────────────────────────┼──────────────────────┐
                    │                           │                      │
           ┌────────┴─────────┐      ┌─────────┴────────┐   ┌────────┴─────────┐
           │ Worker (Mac mini) │      │ Worker (Linux VM) │   │ Worker (Mac Pro)  │
           │ LAN / NAT         │      │ Cloud / Public    │   │ Office / VPN      │
           │                   │      │                   │   │                   │
           │ • claude CLI ✓    │      │ • codex CLI ✓     │   │ • cursor CLI ✓    │
           │ • codex CLI ✓     │      │ • claude CLI ✓    │   │ • claude CLI ✓    │
           │ • cursor CLI ✗    │      │ • cursor CLI ✗    │   │ • codex CLI ✓     │
           └───────────────────┘      └───────────────────┘   └───────────────────┘
```

## 4. Data Model

### 4.1 New table: `workers`

```sql
CREATE TABLE workers (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID NOT NULL REFERENCES companies(id),
  name            TEXT NOT NULL,                        -- human-readable label
  token_hash      TEXT NOT NULL,                        -- SHA-256 of bearer token
  platform        TEXT,                                 -- "darwin" | "linux" | null (set on connect)
  arch            TEXT,                                 -- "arm64" | "x64" | null
  node_version    TEXT,                                 -- e.g. "22.5.0"
  capabilities    JSONB NOT NULL DEFAULT '[]',          -- ["claude_local","codex_local"]
  labels          JSONB NOT NULL DEFAULT '{}',          -- {"gpu": true, "location": "office"}
  status          TEXT NOT NULL DEFAULT 'offline',      -- "online" | "offline" | "busy"
  current_run_id  TEXT,                                 -- run currently executing
  last_seen_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX workers_company_status_idx ON workers(company_id, status);
CREATE UNIQUE INDEX workers_token_hash_idx ON workers(token_hash);
```

### 4.2 Agent config extension

Existing `agents.adapter_config` JSONB gains an optional `worker` field:

```jsonc
{
  "adapterType": "claude_local",
  "command": "claude",
  "cwd": "/home/user/project",
  // NEW: remote execution target
  "worker": {
    // Option A: explicit worker
    "workerId": "uuid-of-worker",
    // Option B: label-based routing (picks any matching online worker)
    "labels": { "gpu": true },
    // Option C: omitted = local execution (existing behavior)
  }
}
```

## 5. WebSocket Protocol

### 5.1 Connection lifecycle

```
Worker                                   Paperclip Server
  │                                            │
  │──── WS connect /api/ws/worker ────────────>│
  │     Authorization: Bearer pclip_wk_xxx     │
  │                                            │── verify token_hash
  │<──── { type:"welcome", workerId:"..." } ───│── set status=online
  │                                            │
  │──── { type:"register", ... } ─────────────>│── update capabilities/platform
  │<──── { type:"registered" } ────────────────│
  │                                            │
  │<─── { type:"ping" } ──────────────────────>│  (bidirectional keepalive)
  │──── { type:"pong" } ──────────────────────>│
  │                                            │
  │<──── { type:"execute", ... } ──────────────│  (server dispatches work)
  │──── { type:"log", ... } ──────────────────>│  (streaming)
  │──── { type:"log", ... } ──────────────────>│
  │──── { type:"meta", ... } ─────────────────>│
  │──── { type:"result", ... } ───────────────>│  (execution complete)
  │                                            │
  │ (disconnect / reconnect with backoff)       │── set status=offline
```

### 5.2 Frame types

**Worker → Server:**

```typescript
// Initial registration (sent after welcome)
type RegisterFrame = {
  type: "register";
  platform: "darwin" | "linux";           // os.platform()
  arch: "arm64" | "x64";                 // os.arch()
  nodeVersion: string;                    // process.version
  capabilities: string[];                 // detected adapter types
  labels: Record<string, unknown>;        // from config file
  workerVersion: string;                  // package version
};

// Execution log streaming
type LogFrame = {
  type: "log";
  requestId: string;
  stream: "stdout" | "stderr";
  chunk: string;
};

// Adapter invocation metadata
type MetaFrame = {
  type: "meta";
  requestId: string;
  meta: AdapterInvocationMeta;
};

// Execution result (terminal)
type ResultFrame = {
  type: "result";
  requestId: string;
  result: AdapterExecutionResult;
};

type PongFrame = { type: "pong" };
```

**Server → Worker:**

```typescript
type WelcomeFrame = {
  type: "welcome";
  workerId: string;
  serverVersion: string;
};

type RegisteredFrame = {
  type: "registered";
};

// Dispatch execution
type ExecuteFrame = {
  type: "execute";
  requestId: string;                       // unique per execution
  adapterType: string;                     // "claude_local" | "codex_local" | ...
  ctx: {
    runId: string;
    agent: AdapterAgent;
    runtime: AdapterRuntime;
    config: Record<string, unknown>;       // adapter config (cwd, model, etc.)
    context: Record<string, unknown>;      // wake context
    authToken?: string;                    // scoped agent JWT
  };
};

// Cancel a running execution
type CancelFrame = {
  type: "cancel";
  requestId: string;
  reason: string;
};

type PingFrame = { type: "ping" };
```

### 5.3 Security

- Worker tokens are generated via Paperclip UI (Board → Workers → Create Worker)
- Tokens use the same `pclip_wk_` prefix + SHA-256 hash-at-rest pattern as agent API keys
- Token is shown once at creation, never stored in plaintext
- Worker WebSocket connections verify token on HTTP upgrade (before WS handshake completes)
- All execution context travels over the WS connection — the worker never needs
  direct DB access
- Sensitive env vars (API keys) in `config.env` travel encrypted if the connection
  uses `wss://` (TLS) — strongly recommended for non-LAN setups

## 6. Server-Side Implementation

### 6.1 New modules

```
server/src/
├── realtime/
│   ├── live-events-ws.ts           (existing)
│   └── worker-ws.ts                (NEW — worker WebSocket server)
├── services/
│   └── worker-registry.ts          (NEW — in-memory connected worker registry)
├── routes/
│   └── workers.ts                  (NEW — CRUD API for worker management)
└── adapters/
    └── dispatch.ts                 (NEW — routing: local vs remote)
```

### 6.2 Worker Registry (`services/worker-registry.ts`)

In-memory map of connected workers, keyed by worker ID:

```typescript
interface ConnectedWorker {
  workerId: string;
  companyId: string;
  ws: WebSocket;
  capabilities: string[];
  labels: Record<string, unknown>;
  platform: string;
  currentRunId: string | null;
  connectedAt: Date;
}

class WorkerRegistry {
  private workers = new Map<string, ConnectedWorker>();

  register(worker: ConnectedWorker): void;
  unregister(workerId: string): void;

  // Find a worker that can handle this adapter type for this company
  findWorker(companyId: string, opts: {
    workerId?: string;
    adapterType?: string;
    labels?: Record<string, unknown>;
  }): ConnectedWorker | null;

  // Dispatch execution to a worker, returns a Promise that resolves
  // when the worker sends the result frame
  dispatch(
    worker: ConnectedWorker,
    adapterType: string,
    ctx: AdapterExecutionContext,
  ): Promise<AdapterExecutionResult>;

  listOnline(companyId: string): ConnectedWorker[];
}
```

### 6.3 Execution Router (`adapters/dispatch.ts`)

Wraps the existing `getServerAdapter().execute()` with worker routing:

```typescript
export async function executeAdapter(
  adapterType: string,
  ctx: AdapterExecutionContext,
): Promise<AdapterExecutionResult> {
  const workerConfig = parseObject(ctx.config.worker);
  const workerId = asString(workerConfig.workerId, "");
  const workerLabels = parseObject(workerConfig.labels);
  const hasWorkerTarget = workerId || Object.keys(workerLabels).length > 0;

  if (hasWorkerTarget) {
    const worker = workerRegistry.findWorker(ctx.agent.companyId, {
      workerId: workerId || undefined,
      adapterType,
      labels: Object.keys(workerLabels).length > 0 ? workerLabels : undefined,
    });

    if (worker) {
      return workerRegistry.dispatch(worker, adapterType, ctx);
    }

    // No matching worker online — configurable: fail or fallback to local
    if (asBoolean(workerConfig.requireRemote, false)) {
      return {
        exitCode: null,
        signal: null,
        timedOut: false,
        errorMessage: `No online worker found (workerId=${workerId})`,
        errorCode: "worker_offline",
      };
    }
    // else fall through to local execution
  }

  // Default: local execution (existing behavior, zero regression)
  const adapter = getServerAdapter(adapterType);
  return adapter.execute(ctx);
}
```

### 6.4 Worker WebSocket endpoint (`realtime/worker-ws.ts`)

Attaches to the existing HTTP server's `upgrade` event (same pattern as `live-events-ws.ts`),
listening on `/api/ws/worker`:

```typescript
export function setupWorkerWebSocketServer(
  server: HttpServer,
  db: Db,
  registry: WorkerRegistry,
) {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url!, `http://${req.headers.host}`);
    if (url.pathname !== "/api/ws/worker") return; // let other handlers proceed

    const token = extractBearerToken(req);
    if (!token) {
      rejectUpgrade(socket, "401 Unauthorized", "missing token");
      return;
    }

    verifyWorkerToken(db, token)
      .then((worker) => {
        wss.handleUpgrade(req, socket, head, (ws) => {
          registry.register({ workerId: worker.id, companyId: worker.companyId, ws, ... });
          ws.send(JSON.stringify({ type: "welcome", workerId: worker.id }));
          // ... handle messages, cleanup on close
        });
      })
      .catch(() => rejectUpgrade(socket, "403 Forbidden", "invalid token"));
  });
}
```

### 6.5 REST API for worker management (`routes/workers.ts`)

| Method | Path                          | Description                    |
|--------|-------------------------------|--------------------------------|
| GET    | `/api/companies/:id/workers`  | List workers for company       |
| POST   | `/api/companies/:id/workers`  | Create worker + generate token |
| GET    | `/api/workers/:id`            | Get worker details + status    |
| PATCH  | `/api/workers/:id`            | Update name/labels             |
| DELETE | `/api/workers/:id`            | Revoke worker token            |

## 7. Worker Package

### 7.1 Package structure

```
packages/worker/
├── package.json               # @paperclipai/worker
├── tsconfig.json
├── src/
│   ├── index.ts               # CLI entry: npx paperclipai-worker
│   ├── connection.ts          # WebSocket client with auto-reconnect
│   ├── executor.ts            # Maps adapterType → execute(), calls locally
│   ├── capability-detect.ts   # Probes which CLIs are installed
│   ├── config.ts              # Load config from file / env / CLI args
│   └── platform.ts            # OS-specific helpers (systemd, launchd)
└── install/
    ├── paperclip-worker.service    # systemd unit template (Linux)
    └── com.paperclip.worker.plist  # launchd plist template (macOS)
```

### 7.2 Core logic (`executor.ts`)

```typescript
import { execute as claudeExecute } from "@paperclipai/adapter-claude-local/server";
import { execute as codexExecute } from "@paperclipai/adapter-codex-local/server";
import { execute as cursorExecute } from "@paperclipai/adapter-cursor-local/server";
import { execute as geminiExecute } from "@paperclipai/adapter-gemini-local/server";

const EXECUTORS: Record<string, (ctx: AdapterExecutionContext) => Promise<AdapterExecutionResult>> = {
  claude_local: claudeExecute,
  codex_local: codexExecute,
  cursor: cursorExecute,
  gemini_local: geminiExecute,
};

export async function executeOnWorker(
  adapterType: string,
  ctx: AdapterExecutionContext,
): Promise<AdapterExecutionResult> {
  const executor = EXECUTORS[adapterType];
  if (!executor) {
    return { exitCode: null, signal: null, timedOut: false,
             errorMessage: `Worker does not support adapter: ${adapterType}` };
  }
  return executor(ctx);
}
```

### 7.3 Auto-reconnect (`connection.ts`)

```typescript
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 60_000;
const PING_INTERVAL_MS = 30_000;

class WorkerConnection {
  private ws: WebSocket | null = null;
  private reconnectAttempt = 0;
  private currentExecution: Map<string, AbortController> = new Map();

  constructor(
    private serverUrl: string,
    private token: string,
    private executor: typeof executeOnWorker,
    private config: WorkerConfig,
  ) {}

  async connect(): Promise<void> {
    const url = this.serverUrl.replace(/^http/, "ws") + "/api/ws/worker";
    this.ws = new WebSocket(url, {
      headers: { Authorization: `Bearer ${this.token}` },
    });

    this.ws.on("open", () => {
      this.reconnectAttempt = 0;
      this.sendRegister();
      this.startPingLoop();
    });

    this.ws.on("message", (data) => this.handleMessage(data));

    this.ws.on("close", () => {
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect() {
    const delay = Math.min(
      RECONNECT_BASE_MS * 2 ** this.reconnectAttempt,
      RECONNECT_MAX_MS,
    );
    this.reconnectAttempt++;
    setTimeout(() => this.connect(), delay);
  }

  private async handleExecute(frame: ExecuteFrame) {
    const { requestId, adapterType, ctx } = frame;

    // Wire up onLog to stream back over WebSocket
    ctx.onLog = async (stream, chunk) => {
      this.send({ type: "log", requestId, stream, chunk });
    };
    ctx.onMeta = async (meta) => {
      this.send({ type: "meta", requestId, meta });
    };

    try {
      const result = await this.executor(adapterType, ctx);
      this.send({ type: "result", requestId, result });
    } catch (err) {
      this.send({
        type: "result",
        requestId,
        result: {
          exitCode: null, signal: null, timedOut: false,
          errorMessage: err instanceof Error ? err.message : String(err),
          errorCode: "worker_execution_error",
        },
      });
    }
  }
}
```

### 7.4 Capability detection (`capability-detect.ts`)

On startup, the worker probes which CLI tools are available:

```typescript
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

const PROBES: Record<string, { command: string; args: string[] }> = {
  claude_local:   { command: "claude",  args: ["--version"] },
  codex_local:    { command: "codex",   args: ["--version"] },
  cursor:         { command: "cursor",  args: ["--version"] },
  gemini_local:   { command: "gemini",  args: ["--version"] },
  opencode_local: { command: "opencode", args: ["version"] },
};

export async function detectCapabilities(): Promise<string[]> {
  const results: string[] = [];
  for (const [adapterType, probe] of Object.entries(PROBES)) {
    try {
      await exec(probe.command, probe.args, { timeout: 5_000 });
      results.push(adapterType);
    } catch {
      // CLI not installed or not in PATH — skip
    }
  }
  return results;
}
```

### 7.5 CLI interface

```bash
# Quick start (reads PAPERCLIP_WORKER_TOKEN and PAPERCLIP_SERVER_URL from env)
npx @paperclipai/worker

# Explicit options
npx @paperclipai/worker \
  --server https://paperclip.example.com \
  --token pclip_wk_abc123... \
  --labels '{"gpu": true, "location": "office"}' \
  --capabilities claude_local,codex_local

# Config file mode (~/.paperclip/worker.json or ./paperclip-worker.json)
npx @paperclipai/worker --config ./paperclip-worker.json
```

Config file format:

```jsonc
{
  "server": "https://paperclip.example.com",
  "token": "pclip_wk_abc123...",
  "labels": {
    "gpu": true,
    "location": "cloud-us-east",
    "os": "linux"
  },
  // Override auto-detection
  "capabilities": ["claude_local", "codex_local"],
  // Environment variables to inject into all executions
  "env": {
    "ANTHROPIC_API_KEY": "sk-ant-...",
    "OPENAI_API_KEY": "sk-..."
  }
}
```

## 8. Platform-Specific Installation

### 8.1 Linux (systemd)

```bash
# Install globally
npm install -g @paperclipai/worker

# Copy and configure the systemd unit
sudo cp $(npm root -g)/@paperclipai/worker/install/paperclip-worker.service \
        /etc/systemd/system/

sudo systemctl edit paperclip-worker  # set Environment= with token/server

sudo systemctl enable --now paperclip-worker
sudo systemctl status paperclip-worker
```

`paperclip-worker.service` template:

```ini
[Unit]
Description=Paperclip Remote Worker
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=paperclip
ExecStart=/usr/bin/env npx @paperclipai/worker --config /etc/paperclip/worker.json
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

### 8.2 macOS (launchd)

```bash
npm install -g @paperclipai/worker

# Copy and configure the launchd plist
cp $(npm root -g)/@paperclipai/worker/install/com.paperclip.worker.plist \
   ~/Library/LaunchAgents/

# Edit the plist to set server URL and token
# Then load it:
launchctl load ~/Library/LaunchAgents/com.paperclip.worker.plist
launchctl start com.paperclip.worker
```

`com.paperclip.worker.plist` template:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.paperclip.worker</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/usr/local/bin/npx</string>
    <string>@paperclipai/worker</string>
    <string>--config</string>
    <string>/Users/YOU/.paperclip/worker.json</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/paperclip-worker.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/paperclip-worker.err</string>
</dict>
</plist>
```

## 9. UI Changes

### 9.1 Workers management page (Board → Workers)

| View               | Content                                                        |
|--------------------|----------------------------------------------------------------|
| Workers list       | Name, platform, status (green/gray dot), capabilities, labels  |
| Create worker      | Name, labels → generates token (show once)                     |
| Worker detail      | Status, platform/arch, last seen, current run, execution log   |

### 9.2 Agent config form

When configuring an agent's adapter, add an optional "Execution Target" section:

- **Local** (default) — run on this server
- **Remote Worker** — pick from dropdown of online workers, or set label filter
- Status indicator showing whether the targeted worker is online

## 10. Execution Flow (End-to-End)

```
1. Heartbeat fires for Agent "claude-dev-1"
2. Server reads agent config: adapterType=claude_local, worker.labels={gpu:true}
3. executeAdapter() → workerRegistry.findWorker(companyId, {adapterType, labels})
4. Match: Worker "gpu-box-01" (Linux, online, has claude_local capability)
5. Server sends ExecuteFrame over WebSocket to gpu-box-01
6. Worker receives, calls claudeExecute(ctx) with:
   - ctx.onLog wired to send LogFrame back over WS
   - ctx.onMeta wired to send MetaFrame back over WS
7. Worker spawns `claude --print -` locally on the Linux box
8. stdout/stderr stream back: Worker → WS → Server → heartbeat_run_events
9. Claude finishes, worker sends ResultFrame
10. Server records heartbeat_run result as normal
11. UI shows the run transcript — identical to local execution
```

## 11. Workspace Considerations

The remote machine needs access to the project source code. Options by priority:

| Strategy              | How                                                   | When to use            |
|-----------------------|-------------------------------------------------------|------------------------|
| **Git clone/pull**    | Worker config sets `cwd` to a local git checkout.     | Most common case.      |
|                       | Agent config `cwd` overridden by worker's local path. | Stable repos.          |
| **Workspace strategy**| Use Paperclip's existing `worktree` workspace         | Multiple concurrent    |
|                       | strategy — the adapter already handles git worktrees. | agents on same repo.   |
| **Shared filesystem** | NFS/CIFS mount same directory on server and worker.   | LAN environments.      |
| **rsync on demand**   | Worker runs `rsync` before execution.                 | Large repos, slow net. |

The `cwd` in adapter config can be overridden per-worker via the worker config's `cwdOverrides`:

```jsonc
{
  "cwdOverrides": {
    "/Users/dev/projects/myapp": "/home/paperclip/projects/myapp"
  }
}
```

## 12. Security Considerations

1. **TLS required for non-LAN** — Worker connections over the internet MUST use `wss://`.
   The CLI warns when connecting to a non-localhost `ws://` URL.
2. **Token rotation** — Workers support token regeneration from the UI. Old token immediately
   invalidated; worker reconnects with the new token.
3. **No DB access** — Workers never touch the database. All context arrives over WebSocket.
4. **Env var isolation** — API keys configured on the worker machine via `worker.json`
   are never sent to the server. The server's `config.env` values travel to the worker,
   but the worker's local env takes precedence (local keys win).
5. **Execution sandboxing** — The worker runs CLI tools with the same permissions as the
   user running the worker process. For shared machines, run the worker under a dedicated
   system user with restricted filesystem access.
6. **Company scoping** — A worker token is bound to exactly one company. The server rejects
   any execution request from a different company.

## 13. Implementation Plan

### Phase 1 — Core (1 week)

| # | Task                                                   | Package         |
|---|--------------------------------------------------------|-----------------|
| 1 | Add `workers` table + migration                        | `packages/db`   |
| 2 | Worker token generation / verification utilities       | `server`        |
| 3 | `WorkerRegistry` in-memory connected-worker map        | `server`        |
| 4 | `/api/ws/worker` WebSocket endpoint                    | `server`        |
| 5 | `executeAdapter()` routing with worker dispatch        | `server`        |
| 6 | REST CRUD `/api/companies/:id/workers`                 | `server`        |
| 7 | Worker package: connection, executor, capability probe | `packages/worker` |

### Phase 2 — UX (3–4 days)

| # | Task                                                   | Package         |
|---|--------------------------------------------------------|-----------------|
| 8 | Workers management page in UI                          | `ui`            |
| 9 | Agent config form: execution target selector           | `ui`            |
| 10| Worker status indicators (online/offline/busy)         | `ui`            |
| 11| `cwd` override mapping in worker config                | `packages/worker` |

### Phase 3 — Hardening (3–4 days)

| # | Task                                                   | Package         |
|---|--------------------------------------------------------|-----------------|
| 12| systemd and launchd install templates + setup CLI      | `packages/worker` |
| 13| TLS warning for non-localhost ws:// connections         | `packages/worker` |
| 14| Execution timeout + cancel propagation                 | `server`, `worker` |
| 15| Worker health dashboard (connection uptime, runs)      | `ui`            |
| 16| Integration tests (mock worker ↔ server)               | `server`        |

### Total estimate: ~2.5 weeks

## 14. Future Extensions (Out of Scope for V1)

- **Worker pools** — load-balance across multiple workers with same labels
- **Execution queue** — queue work when all workers are busy, dispatch FIFO
- **Auto-scaling** — spin up cloud VMs on demand via Terraform/Pulumi
- **Worker metrics** — CPU, memory, disk usage reported back to server
- **Multi-company workers** — shared infrastructure workers (admin-managed)
- **Container mode** — worker optionally runs each execution in a Docker container
