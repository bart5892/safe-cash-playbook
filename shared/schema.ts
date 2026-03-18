import { pgTable, text, serial, integer, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// Minimal schema - dashboard is stateless (no DB needed)
export const refreshLog = pgTable("refresh_log", {
  id: serial("id").primaryKey(),
  fetchedAt: timestamp("fetched_at").defaultNow(),
  source: text("source").default("api"),
});

export const insertRefreshLogSchema = createInsertSchema(refreshLog).omit({ id: true });
export type InsertRefreshLog = z.infer<typeof insertRefreshLogSchema>;
export type RefreshLog = typeof refreshLog.$inferSelect;
