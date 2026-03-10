import { Hono } from "hono";
import { logger } from "hono/logger";
import type { DbClient } from "./types.js";
import { createAgentRoutes } from "./routes/agents.js";
import { createTaskRoutes } from "./routes/tasks.js";

export type AppEnv = {
  Variables: {
    db: DbClient;
  };
};

export function createApp(db: DbClient): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // Inject DB client into context
  app.use("*", async (c, next) => {
    c.set("db", db);
    await next();
  });

  app.use("*", logger());

  // Health check
  app.get("/", (c) => {
    return c.json({
      name: "agent-hub",
      version: "0.1.0",
      description: "AIBTC Agent-to-Agent Task Hub",
    });
  });

  // Mount routes
  app.route("/agents", createAgentRoutes());
  app.route("/tasks", createTaskRoutes());

  return app;
}
