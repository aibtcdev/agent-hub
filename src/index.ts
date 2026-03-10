import { Hono } from "hono";
import { logger } from "hono/logger";
import agentRoutes from "./routes/agents.js";
import taskRoutes from "./routes/tasks.js";

const app = new Hono();

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
app.route("/agents", agentRoutes);
app.route("/tasks", taskRoutes);

const port = parseInt(process.env.PORT ?? "3100");

console.log(`agent-hub listening on http://localhost:${port}`);

export default {
  port,
  fetch: app.fetch,
};
