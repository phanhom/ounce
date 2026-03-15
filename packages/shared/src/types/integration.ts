import type { IntegrationProvider, IntegrationStatus } from "../constants.js";

export interface MysqlConfig {
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  ssl: boolean;
}

export interface MinioConfig {
  endpoint: string;
  port: number;
  accessKey: string;
  secretKey: string;
  bucket: string;
  region: string;
  useSSL: boolean;
}

export interface GitlabConfig {
  url: string;
  token: string;
  group: string;
}

export type IntegrationConfig = MysqlConfig | MinioConfig | GitlabConfig;

export interface CompanyIntegration {
  id: string;
  companyId: string;
  provider: IntegrationProvider;
  name: string;
  config: IntegrationConfig;
  status: IntegrationStatus;
  lastTestedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
