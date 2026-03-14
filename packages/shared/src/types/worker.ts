import type { WorkerStatus } from "../constants.js";

export interface Worker {
  id: string;
  companyId: string;
  name: string;
  platform: string | null;
  arch: string | null;
  nodeVersion: string | null;
  capabilities: string[];
  labels: Record<string, unknown>;
  maxConcurrency: number;
  status: WorkerStatus;
  activeRuns: number;
  lastSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkerCreated {
  worker: Worker;
  token: string;
}
