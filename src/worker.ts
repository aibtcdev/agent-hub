import { Hono } from "hono";
import { logger } from "hono/logger";
import { createD1Client } from "./db-d1.js";
import { createAgentRoutes } from "./routes/agents.js";
import { createTaskRoutes } from "./routes/tasks.js";
import type { DbClient } from "./types.js";

type Bindings = {
  DB: D1Database;
};

type WorkerEnv = {
  Bindings: Bindings;
  Variables: {
    db: DbClient;
  };
};

const app = new Hono<WorkerEnv>();

// Inject D1 client into context per-request
app.use("*", async (c, next) => {
  const db = createD1Client(c.env.DB);
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

export default app;
