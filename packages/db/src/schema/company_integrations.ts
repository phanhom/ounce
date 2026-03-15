import { pgTable, uuid, text, jsonb, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const companyIntegrations = pgTable(
  "company_integrations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull(),
    provider: text("provider").notNull(),
    name: text("name").notNull(),
    config: jsonb("config").notNull().default({}),
    status: text("status").notNull().default("inactive"),
    lastTestedAt: timestamp("last_tested_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyProviderUniqueIdx: uniqueIndex("company_integrations_company_provider_idx").on(
      table.companyId,
      table.provider,
    ),
  }),
);
