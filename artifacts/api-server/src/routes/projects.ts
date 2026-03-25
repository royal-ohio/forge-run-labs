import { Router, type IRouter } from "express";
import { db, projectsTable, insertProjectSchema, updateProjectSchema } from "@workspace/db";
import { eq } from "drizzle-orm";

const router: IRouter = Router();

const ADMIN_TOKEN = process.env["ADMIN_TOKEN"] ?? "forgerun-labs-admin-2026";

function verifyAdmin(token: string | undefined): boolean {
  return token === ADMIN_TOKEN;
}

function toApiProject(p: typeof projectsTable.$inferSelect) {
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    slug: p.slug,
    url: p.url,
    status: p.status,
    isPublic: p.isPublic,
    sortOrder: p.sortOrder,
    createdAt: p.createdAt.toISOString(),
  };
}

function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

router.get("/projects", async (req, res) => {
  try {
    const projects = await db
      .select()
      .from(projectsTable)
      .where(eq(projectsTable.isPublic, true))
      .orderBy(projectsTable.sortOrder);
    res.json(projects.map(toApiProject));
  } catch (err) {
    req.log.error({ err }, "Failed to list public projects");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/admin/projects", async (req, res) => {
  const token = req.headers["x-admin-token"] as string | undefined;
  if (!verifyAdmin(token)) {
    res.status(403).json({ error: "Unauthorized" });
    return;
  }
  try {
    const projects = await db
      .select()
      .from(projectsTable)
      .orderBy(projectsTable.sortOrder);
    res.json(projects.map(toApiProject));
  } catch (err) {
    req.log.error({ err }, "Failed to list all projects");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/admin/projects", async (req, res) => {
  const token = req.headers["x-admin-token"] as string | undefined;
  if (!verifyAdmin(token)) {
    res.status(403).json({ error: "Unauthorized" });
    return;
  }
  try {
    const parsed = insertProjectSchema.safeParse({
      ...req.body,
      slug: req.body.slug ?? generateSlug(req.body.name ?? ""),
    });
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid input" });
      return;
    }
    const [created] = await db.insert(projectsTable).values(parsed.data).returning();
    res.status(201).json(toApiProject(created));
  } catch (err) {
    req.log.error({ err }, "Failed to create project");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.put("/admin/projects/:id", async (req, res) => {
  const token = req.headers["x-admin-token"] as string | undefined;
  if (!verifyAdmin(token)) {
    res.status(403).json({ error: "Unauthorized" });
    return;
  }
  const id = Number(req.params["id"]);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  try {
    const parsed = updateProjectSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid input" });
      return;
    }
    const [updated] = await db
      .update(projectsTable)
      .set(parsed.data)
      .where(eq(projectsTable.id, id))
      .returning();
    if (!updated) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json(toApiProject(updated));
  } catch (err) {
    req.log.error({ err }, "Failed to update project");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.delete("/admin/projects/:id", async (req, res) => {
  const token = req.headers["x-admin-token"] as string | undefined;
  if (!verifyAdmin(token)) {
    res.status(403).json({ error: "Unauthorized" });
    return;
  }
  const id = Number(req.params["id"]);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  try {
    const [deleted] = await db
      .delete(projectsTable)
      .where(eq(projectsTable.id, id))
      .returning();
    if (!deleted) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json({ status: "deleted" });
  } catch (err) {
    req.log.error({ err }, "Failed to delete project");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
