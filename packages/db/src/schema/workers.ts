import { pgTable, uuid, text, integer, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const workers = pgTable(
  "workers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull(),
    platform: text("platform"),
    arch: text("arch"),
    nodeVersion: text("node_version"),
    capabilities: jsonb("capabilities").$type<string[]>().notNull().default([]),
    labels: jsonb("labels").$type<Record<string, unknown>>().notNull().default({}),
    maxConcurrency: integer("max_concurrency").notNull().default(4),
    status: text("status").notNull().default("offline"),
    activeRuns: integer("active_runs").notNull().default(0),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tokenHashIdx: uniqueIndex("workers_token_hash_idx").on(table.tokenHash),
    companyStatusIdx: index("workers_company_status_idx").on(table.companyId, table.status),
  }),
);
