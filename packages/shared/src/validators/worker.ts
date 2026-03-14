import { z } from "zod";

export const createWorkerSchema = z.object({
  name: z.string().min(1).max(200),
  labels: z.record(z.unknown()).optional().default({}),
  maxConcurrency: z.number().int().min(1).max(64).optional().default(4),
});

export type CreateWorker = z.infer<typeof createWorkerSchema>;

export const updateWorkerSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  labels: z.record(z.unknown()).optional(),
  maxConcurrency: z.number().int().min(1).max(64).optional(),
});

export type UpdateWorker = z.infer<typeof updateWorkerSchema>;
