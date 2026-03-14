# Paperclip Worker — Setup Guide

The Paperclip Worker is a lightweight daemon that runs on any machine with AI CLI
tools installed (Claude Code, Codex, Cursor, etc.). It exposes the machine's
capabilities to the Paperclip control plane so agents can execute tasks remotely.

## How It Works

```
┌─────────────────────────┐       ┌─────────────────────────┐
│    Paperclip Server     │       │   Remote Worker (Mac/    │
│    (control plane)      │       │   Linux with CLI tools)  │
│                         │       │                          │
│  1. Scan LAN :19820 ───────▶   │  Beacon HTTP :19820      │
│     ◀──── /info ────────────   │    GET /info             │
│                         │       │    POST /pair            │
│  2. POST /pair + key ──────▶   │                          │
│     ◀──── OK ───────────────   │  3. Validate key         │
│                         │       │  4. POST /pair-accept ──▶│
│  ◀── WebSocket connect ────────│  5. Connect outbound WS  │
│                         │       │                          │
│  6. Dispatch tasks ─────────▶  │  7. Spawn CLI locally    │
│     ◀── stream results ────────│  8. Return results       │
└─────────────────────────┘       └──────────────────────────┘
```

## Prerequisites

- **Node.js** >= 18 on the remote machine
- At least one supported AI CLI tool installed:
  - `claude` (Claude Code)
  - `codex` (OpenAI Codex CLI)
  - `cursor` (Cursor CLI)
  - Or any other Paperclip-supported adapter

## 1. Deploy the Worker

The worker bundles into a **single 400KB file** — no npm publish needed.

### Build the bundle (on the dev machine)

```bash
cd packages/worker
pnpm bundle
# output: dist/paperclip-worker.mjs
```

### Deploy to a remote machine

Pick whichever method fits your environment:

**Method A: scp (simplest)**

```bash
scp packages/worker/dist/paperclip-worker.mjs user@remote:~/paperclip-worker.mjs
```

**Method B: git clone (if the remote has repo access)**

```bash
ssh user@remote
git clone <your-repo-url> paperclip
cd paperclip
pnpm install && pnpm --filter @paperclipai/worker bundle
# the bundle is at packages/worker/dist/paperclip-worker.mjs
```

**Method C: tarball**

```bash
# On dev machine
cd packages/worker && pnpm pack
# produces paperclipai-worker-0.3.0.tgz

scp paperclipai-worker-0.3.0.tgz user@remote:~/
ssh user@remote 'npm install -g ./paperclipai-worker-0.3.0.tgz'
```

## 2. Start the Worker

```bash
# If using the single-file bundle (Method A):
node ~/paperclip-worker.mjs

# If installed via tarball (Method C):
paperclip-worker

# If running from cloned repo (Method B):
node packages/worker/dist/paperclip-worker.mjs
```

No configuration needed. On first start the worker will:

1. **Auto-detect** all installed CLI tools and register their capabilities
2. **Generate a cryptographic pairing key** saved to `~/.paperclip/worker-key`
3. **Start an HTTP beacon** on port `19820` (configurable with `--port`)
4. **Print a banner** showing the LAN IP, port, capabilities, and pairing key

Example output:

```
┌─────────────────────────────────────────────────────────┐
│              Paperclip Remote Worker                    │
├─────────────────────────────────────────────────────────┤
│  Platform     │ darwin arm64 (Node v22.14.0)            │
│  Hostname     │ macbook-pro.local                       │
│  Capabilities │ claude_local, codex_local               │
│  Beacon Port  │ 19820                                   │
│  LAN Address  │ 192.168.1.42:19820                      │
├─────────────────────────────────────────────────────────┤
│  Status       │ awaiting pairing...                     │
├─────────────────────────────────────────────────────────┤
│  Worker Key (use this to pair from Paperclip UI):       │
│  pclip_wk_A7xK9m2Qf...                                 │
└─────────────────────────────────────────────────────────┘
```

## 3. Pair from the Paperclip Server

### Option A: Auto-discover (same LAN)

1. Open the Paperclip UI → **Workers** page
2. Click **Discover Workers**
3. The server scans your LAN subnets (192.168.x.x, 10.x.x.x, etc.) on port 19820
4. Select the discovered worker (results capped at 10, with "show more" if truncated)
5. Enter the **pairing key** displayed on the worker's terminal
6. The worker appears as **online** and can now receive tasks

### Option B: Manual add (cross-subnet or remote)

1. Open the Paperclip UI → **Workers** page
2. Click **Add Worker** → enter `<ip>:<port>` (e.g. `10.0.5.100:19820`)
3. The server probes that address and shows the worker info
4. Enter the **pairing key**
5. Done

## 4. Persist as a System Service

### macOS (launchd)

```bash
# Create a launchd plist (adjust the path to your paperclip-worker.mjs)
cat > ~/Library/LaunchAgents/com.paperclip.worker.plist << 'EOF'
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
    <string>/Users/YOUR_USER/paperclip-worker.mjs</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/paperclip-worker.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/paperclip-worker.err</string>
  <key>ThrottleInterval</key>
  <integer>5</integer>
</dict>
</plist>
EOF

# Load the service
launchctl load ~/Library/LaunchAgents/com.paperclip.worker.plist

# Check logs
tail -f /tmp/paperclip-worker.log

# Read the pairing key
cat ~/.paperclip/worker-key
```

### Linux (systemd)

```bash
# Create the service file (adjust the path to your paperclip-worker.mjs)
sudo tee /etc/systemd/system/paperclip-worker.service << 'EOF'
[Unit]
Description=Paperclip Remote Worker
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/node /home/YOUR_USER/paperclip-worker.mjs
Restart=always
RestartSec=5
User=YOUR_USER
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

# Enable and start
sudo systemctl daemon-reload
sudo systemctl enable --now paperclip-worker

# Check status and logs
sudo systemctl status paperclip-worker
sudo journalctl -u paperclip-worker -f

# Read the pairing key
cat ~/.paperclip/worker-key
```

## Quick Reference: End-to-End Flow

### Server Host (your dev machine)

```
1. pnpm install && pnpm dev
2. pnpm --filter @paperclipai/worker bundle
3. scp packages/worker/dist/paperclip-worker.mjs user@remote:~/
4. Open UI → Workers → Discover or Add by IP
5. Enter pairing key → Done
```

### Remote Mac (internal network)

```
1. Receive paperclip-worker.mjs (via scp, shared drive, etc.)
2. node paperclip-worker.mjs
3. (Optional) Set up launchd for auto-start
4. Give the pairing key to the Paperclip admin
```

### Remote Linux Server

```
1. Receive paperclip-worker.mjs
2. node paperclip-worker.mjs        (test run)
3. Set up systemd for auto-start
4. cat ~/.paperclip/worker-key       (read key)
5. Give the key to the Paperclip admin
```

## CLI Options

| Flag                | Env Variable              | Description                         | Default  |
|---------------------|---------------------------|-------------------------------------|----------|
| `--server <url>`    | `PAPERCLIP_SERVER_URL`    | Pre-configure server URL            | _(none)_ |
| `--token <token>`   | `PAPERCLIP_WORKER_TOKEN`  | Pre-configure auth token            | _(none)_ |
| `--port <port>`     |                           | Beacon listen port                  | `19820`  |
| `--capabilities x,y`|                           | Override auto-detected capabilities | _(auto)_ |
| `--max-concurrency` |                           | Max parallel agent executions       | `4`      |
| `--labels '{...}'`  |                           | JSON labels for routing             | `{}`     |
| `--config <path>`   |                           | Path to JSON config file            | _(auto)_ |

## Config File

Place a JSON file at `~/.paperclip/worker.json` or `./paperclip-worker.json`:

```json
{
  "server": "https://paperclip.example.com",
  "token": "pclip_wk_...",
  "beaconPort": 19820,
  "maxConcurrency": 8,
  "labels": { "team": "backend", "gpu": true },
  "env": {
    "ANTHROPIC_API_KEY": "sk-..."
  }
}
```

If `server` and `token` are both set, the worker connects immediately without
waiting for pairing. The beacon still runs so the worker can be re-discovered
if needed.

## Network Requirements

| Direction             | Port    | Protocol | Purpose                      |
|-----------------------|---------|----------|------------------------------|
| Server → Worker       | `19820` | HTTP     | Discovery probe + pairing    |
| Worker → Server       | `3100`  | WS/HTTP  | Outbound WebSocket + pairing |

The worker always initiates the persistent WebSocket connection **outbound** to
the server. The only inbound traffic is the lightweight HTTP beacon on port
19820, used during discovery and pairing.

## Troubleshooting

**Worker not discovered?**
- Ensure port 19820 is not blocked by the host firewall
- Try manual add with the worker's IP: `POST /api/companies/:id/workers/probe`
- Check that both machines are on the same LAN segment

**Pairing fails?**
- Double-check the key — copy the full string from `~/.paperclip/worker-key`
- Ensure the worker can reach the server URL (try `curl <server-url>/api/health`)

**No capabilities detected?**
- Ensure the CLI tools are in the worker user's `PATH`
- Run `which claude`, `which codex`, `which cursor` to verify
- Override manually: `node paperclip-worker.mjs --capabilities claude_local,codex_local`
