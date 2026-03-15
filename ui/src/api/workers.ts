import { api } from "./client";

export interface WorkerInfo {
  id: string;
  companyId: string;
  name: string;
  platform?: string;
  arch?: string;
  nodeVersion?: string;
  capabilities: string[];
  labels: Record<string, unknown>;
  maxConcurrency: number;
  status: "online" | "offline";
  activeRuns: number;
  lastSeenAt?: string;
  createdAt: string;
  updatedAt: string;
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
  fingerprint: string;
  publicKey: string;
}

export interface DiscoverResult {
  discovered: DiscoveredWorker[];
  scanned: number;
  total: number;
  truncated: boolean;
}

export interface ProbeResult {
  worker: DiscoveredWorker;
}

export interface PairResult {
  worker: WorkerInfo;
  token: string;
}

export const workersApi = {
  list: (companyId: string) =>
    api.get<{ workers: WorkerInfo[] }>(`/companies/${companyId}/workers`),

  get: (id: string) =>
    api.get<{ worker: WorkerInfo }>(`/workers/${id}`),

  remove: (id: string) =>
    api.delete<{ ok: boolean }>(`/workers/${id}`),

  discover: (companyId: string, body?: { subnets?: string[]; extraHosts?: string[]; port?: number; limit?: number }) =>
    api.post<DiscoverResult>(`/companies/${companyId}/workers/discover`, body ?? {}),

  probe: (companyId: string, body: { host: string; port?: number }) =>
    api.post<ProbeResult>(`/companies/${companyId}/workers/probe`, body),

  pair: (companyId: string, body: { host: string; port?: number; fingerprint: string; name?: string }) =>
    api.post<PairResult>(`/companies/${companyId}/workers/pair`, body),
};
