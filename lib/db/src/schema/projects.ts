import { pgTable, text, serial, boolean, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const projectsTable = pgTable("projects", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  slug: text("slug").notNull().unique(),
  url: text("url").notNull(),
  status: text("status").notNull().default("LIVE"),
  isPublic: boolean("is_public").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertProjectSchema = createInsertSchema(projectsTable, {
  name: z.string().min(1).max(100).trim(),
  description: z.string().min(1).max(500).trim(),
  slug: z.string().min(1).max(120).regex(/^[a-z0-9-]+$/).trim().optional(),
  url: z.string().min(1).max(500).trim(),
  status: z.enum(["LIVE", "BUILDING", "OFFLINE"]),
  sortOrder: z.number().int().min(0).max(9999).default(0),
}).omit({ id: true, createdAt: true });

export const updateProjectSchema = insertProjectSchema.partial();

export type InsertProject = z.infer<typeof insertProjectSchema>;
export type UpdateProject = z.infer<typeof updateProjectSchema>;
export type Project = typeof projectsTable.$inferSelect;
