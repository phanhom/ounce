import os from "node:os";
import net from "node:net";
import { logger } from "../middleware/logger.js";

const DEFAULT_BEACON_PORT = 19820;

// Tiered scanning parameters
const PROBE_TIMEOUT_SMALL_MS = 800;   // /21 – /30 (up to ~2046 IPs)
const PROBE_TIMEOUT_LARGE_MS = 300;   // /16 – /20 (up to ~65534 IPs)
const CONCURRENCY_SMALL = 128;
const CONCURRENCY_LARGE = 256;
const CLAMP_PREFIX = 16;              // anything broader than /16 gets clamped to /16

export interface DiscoveredAdapterInfo {
  type: string;
  label: string;
  version: string;
  auth: string;
  pairCode?: string;
}

export interface DiscoveredWorker {
  host: string;
  port: number;
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
  version: string;
  adapters: DiscoveredAdapterInfo[];
}

interface Subnet {
  address: string;
  netmask: string;
  prefix: number;
}

// -------------------------------------------------------------------------
// Subnet detection from local NICs
// -------------------------------------------------------------------------

function detectSubnets(): Subnet[] {
  const interfaces = os.networkInterfaces();
  const subnets: Subnet[] = [];

  for (const iface of Object.values(interfaces)) {
    if (!iface) continue;
    for (const addr of iface) {
      if (addr.family !== "IPv4" || addr.internal) continue;

      const parts = addr.netmask.split(".").map(Number);
      const prefix = parts.reduce(
        (sum, octet) => sum + (octet >>> 0).toString(2).replace(/0/g, "").length,
        0,
      );

      if (prefix > 30 || prefix < 1) continue;

      if (prefix < CLAMP_PREFIX) {
        logger.info(
          { detected: `${addr.address}/${prefix}`, clamped: `/${CLAMP_PREFIX}` },
          "subnet broader than /16 — clamping to /16 for scan",
        );
        const clampedMask = "255.255.0.0";
        subnets.push({ address: addr.address, netmask: clampedMask, prefix: CLAMP_PREFIX });
      } else {
        subnets.push({ address: addr.address, netmask: addr.netmask, prefix });
      }
    }
  }

  return subnets;
}

// -------------------------------------------------------------------------
// IP range generator — up to /16 (65534 hosts)
// -------------------------------------------------------------------------

function* ipRange(subnet: Subnet): Generator<string> {
  const addrParts = subnet.address.split(".").map(Number);
  const maskParts = subnet.netmask.split(".").map(Number);

  const network =
    ((addrParts[0] & maskParts[0]) << 24) |
    ((addrParts[1] & maskParts[1]) << 16) |
    ((addrParts[2] & maskParts[2]) << 8) |
    (addrParts[3] & maskParts[3]);

  const hostBits = 32 - subnet.prefix;
  const count = (1 << hostBits) - 2;

  for (let i = 1; i <= count; i++) {
    const ip = network + i;
    yield `${(ip >>> 24) & 0xff}.${(ip >>> 16) & 0xff}.${(ip >>> 8) & 0xff}.${ip & 0xff}`;
  }
}

// -------------------------------------------------------------------------
// Port probe — fast TCP connect to check if beacon is listening
// -------------------------------------------------------------------------

function probePort(ip: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => { sock.destroy(); resolve(true); });
    sock.once("timeout", () => { sock.destroy(); resolve(false); });
    sock.once("error", () => { sock.destroy(); resolve(false); });
    sock.connect(port, ip);
  });
}

// -------------------------------------------------------------------------
// Fetch /info from a discovered worker beacon
// -------------------------------------------------------------------------

async function fetchBeaconInfo(ip: string, port: number, timeoutMs: number): Promise<DiscoveredWorker | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs * 3);

    const res = await fetch(`http://${ip}:${port}/info`, {
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) return null;

    const data = (await res.json()) as Record<string, unknown>;
    if (data.service !== "paperclip-worker") return null;

    const rawAdapters = Array.isArray(data.adapters) ? (data.adapters as Record<string, unknown>[]) : [];
    const adapters: DiscoveredAdapterInfo[] = rawAdapters.map((a) => ({
      type: String(a.type ?? ""),
      label: String(a.label ?? ""),
      version: String(a.version ?? ""),
      auth: String(a.auth ?? ""),
      pairCode: typeof a.pairCode === "string" ? a.pairCode : undefined,
    }));

    return {
      host: ip,
      port,
      hostname: String(data.hostname ?? ""),
      platform: String(data.platform ?? ""),
      arch: String(data.arch ?? ""),
      nodeVersion: String(data.nodeVersion ?? ""),
      capabilities: Array.isArray(data.capabilities) ? (data.capabilities as string[]) : [],
      maxConcurrency: typeof data.maxConcurrency === "number" ? data.maxConcurrency : 4,
      labels:
        typeof data.labels === "object" && data.labels !== null
          ? (data.labels as Record<string, unknown>)
          : {},
      fingerprint: String(data.fingerprint ?? ""),
      publicKey: String(data.publicKey ?? ""),
      paired: Boolean(data.paired),
      version: String(data.version ?? ""),
      adapters,
    };
  } catch {
    return null;
  }
}

// -------------------------------------------------------------------------
// Batch scanning with configurable concurrency and timeout
// -------------------------------------------------------------------------

interface ScanConfig {
  concurrency: number;
  probeTimeoutMs: number;
  /** Stop scanning after finding this many workers (0 = no limit) */
  maxResults: number;
  onProgress?: (scanned: number, total: number, found: number) => void;
}

async function scanIPs(
  ips: string[],
  port: number,
  cfg: ScanConfig,
): Promise<DiscoveredWorker[]> {
  const results: DiscoveredWorker[] = [];
  let idx = 0;
  let scanned = 0;
  let stopped = false;

  async function worker() {
    while (idx < ips.length && !stopped) {
      const ip = ips[idx++];
      const open = await probePort(ip, port, cfg.probeTimeoutMs);
      scanned++;

      if (scanned % 1000 === 0) {
        logger.info(
          { scanned, total: ips.length, found: results.length },
          "scan progress",
        );
        cfg.onProgress?.(scanned, ips.length, results.length);
      }

      if (!open) continue;

      const info = await fetchBeaconInfo(ip, port, cfg.probeTimeoutMs);
      if (info) {
        results.push(info);
        if (cfg.maxResults > 0 && results.length >= cfg.maxResults) {
          stopped = true;
          return;
        }
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(cfg.concurrency, ips.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}

// -------------------------------------------------------------------------
// Resolve scanning tier from total IP count
// -------------------------------------------------------------------------

function resolveScanConfig(
  ipCount: number,
  maxResults: number,
  onProgress?: DiscoverOptions["onProgress"],
): ScanConfig {
  if (ipCount <= 2046) {
    return {
      concurrency: CONCURRENCY_SMALL,
      probeTimeoutMs: PROBE_TIMEOUT_SMALL_MS,
      maxResults,
      onProgress,
    };
  }
  return {
    concurrency: CONCURRENCY_LARGE,
    probeTimeoutMs: PROBE_TIMEOUT_LARGE_MS,
    maxResults,
    onProgress,
  };
}

// -------------------------------------------------------------------------
// CIDR helper: clamp a prefix to /16 if broader
// -------------------------------------------------------------------------

function clampPrefix(prefix: number): number {
  return Math.max(prefix, CLAMP_PREFIX);
}

function prefixToNetmask(prefix: number): string {
  const maskNum = prefix === 0 ? 0 : ~((1 << (32 - prefix)) - 1);
  return [
    (maskNum >>> 24) & 0xff,
    (maskNum >>> 16) & 0xff,
    (maskNum >>> 8) & 0xff,
    maskNum & 0xff,
  ].join(".");
}

// -------------------------------------------------------------------------
// Public API
// -------------------------------------------------------------------------

export interface DiscoverOptions {
  port?: number;
  /** Additional IPs to probe (manual additions) */
  extraHosts?: string[];
  /** Specific subnets to scan instead of auto-detecting, e.g. ["192.168.0.0/16"] */
  subnets?: string[];
  /** Max workers to return — scanning stops early once this many are found (default 10) */
  limit?: number;
  /** Progress callback for UI streaming */
  onProgress?: (scanned: number, total: number, found: number) => void;
}

export interface DiscoverResult {
  discovered: DiscoveredWorker[];
  scanned: number;
  total: number;
  truncated: boolean;
}

export async function discoverWorkers(
  opts: DiscoverOptions = {},
): Promise<DiscoverResult> {
  const port = opts.port ?? DEFAULT_BEACON_PORT;
  const limit = opts.limit ?? 10;
  const allIPs: string[] = [];

  if (opts.subnets && opts.subnets.length > 0) {
    for (const cidr of opts.subnets) {
      const [addr, prefixStr] = cidr.split("/");
      const rawPrefix = parseInt(prefixStr, 10);
      if (!addr || isNaN(rawPrefix)) continue;

      const prefix = clampPrefix(rawPrefix);
      if (prefix !== rawPrefix) {
        logger.info(
          { requested: cidr, clamped: `${addr}/${prefix}` },
          "subnet broader than /16 — clamped to /16",
        );
      }

      const netmask = prefixToNetmask(prefix);
      for (const ip of ipRange({ address: addr, netmask, prefix })) {
        allIPs.push(ip);
      }
    }
  } else {
    const subnets = detectSubnets();
    logger.info(
      { subnets: subnets.map((s) => `${s.address}/${s.prefix}`) },
      "auto-detected LAN subnets",
    );

    for (const subnet of subnets) {
      for (const ip of ipRange(subnet)) {
        allIPs.push(ip);
      }
    }
  }

  if (opts.extraHosts) {
    for (const host of opts.extraHosts) {
      if (!allIPs.includes(host)) allIPs.push(host);
    }
  }

  if (allIPs.length === 0) {
    logger.warn(
      "no scannable IPs found — check network interfaces or pass subnets manually",
    );
    return { discovered: [], scanned: 0, total: 0, truncated: false };
  }

  const scanCfg = resolveScanConfig(allIPs.length, limit, opts.onProgress);

  logger.info(
    {
      count: allIPs.length,
      port,
      limit,
      concurrency: scanCfg.concurrency,
      probeTimeoutMs: scanCfg.probeTimeoutMs,
    },
    "starting LAN worker scan",
  );

  const raw = await scanIPs(allIPs, port, scanCfg);
  const seen = new Set<string>();
  const discovered = raw.filter((w) => {
    if (!w.fingerprint || seen.has(w.fingerprint)) return false;
    seen.add(w.fingerprint);
    return true;
  });
  const truncated = raw.length >= limit;

  logger.info(
    { found: discovered.length, scanned: allIPs.length, truncated },
    "LAN scan complete",
  );

  return { discovered, scanned: allIPs.length, total: allIPs.length, truncated };
}

/**
 * Probe a single known host (for manual "add by IP" flow).
 */
export async function probeWorker(
  host: string,
  port = DEFAULT_BEACON_PORT,
): Promise<DiscoveredWorker | null> {
  const open = await probePort(host, port, PROBE_TIMEOUT_SMALL_MS * 2);
  if (!open) return null;
  return fetchBeaconInfo(host, port, PROBE_TIMEOUT_SMALL_MS);
}
