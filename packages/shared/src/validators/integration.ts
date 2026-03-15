import { z } from "zod";
import { INTEGRATION_PROVIDERS } from "../constants.js";

const mysqlConfigSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(3306),
  database: z.string().min(1),
  username: z.string().min(1),
  password: z.string(),
  ssl: z.boolean().default(false),
});

const minioConfigSchema = z.object({
  endpoint: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(9000),
  accessKey: z.string().min(1),
  secretKey: z.string().min(1),
  bucket: z.string().min(1),
  region: z.string().default("us-east-1"),
  useSSL: z.boolean().default(false),
});

const gitlabConfigSchema = z.object({
  url: z.string().url(),
  token: z.string().min(1),
  group: z.string().default(""),
});

export const integrationConfigSchemas = {
  mysql: mysqlConfigSchema,
  minio: minioConfigSchema,
  gitlab: gitlabConfigSchema,
} as const;

export const upsertIntegrationSchema = z.object({
  provider: z.enum(INTEGRATION_PROVIDERS),
  name: z.string().min(1).max(100).optional(),
  config: z.record(z.unknown()),
});

export type UpsertIntegration = z.infer<typeof upsertIntegrationSchema>;

export { mysqlConfigSchema, minioConfigSchema, gitlabConfigSchema };
