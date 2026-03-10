import { Hono } from "hono";
import { v4 as uuidv4 } from "uuid";
import {
  insertTask,
  getTask,
  getAgent,
  listTasksForAgent,
  listTasksForAgentByStatus,
  completeTask,
  touchAgent,
} from "../db.js";
import { extractAuth } from "../auth.js";

const app = new Hono();

/**
 * POST /tasks
 * Submit a task to another agent.
 *
 * Body: { to_agent, subject, payload? }
 * Auth headers required (sender identity).
 */
app.post("/", async (c) => {
  const rawBody = await c.req.text();
  const auth = extractAuth(c.req.raw.headers, rawBody);

  if (!auth.ok) {
    return c.json({ error: auth.error }, 401);
  }

  let body: {
    to_agent: string;
    subject: string;
    payload?: Record<string, unknown>;
  };

  try {
    body = JSON.parse(rawBody);
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (!body.to_agent || !body.subject) {
    return c.json({ error: "to_agent and subject are required" }, 400);
  }

  // Verify both agents exist
  const sender = getAgent.get({ id: auth.agentAddress });
  if (!sender) {
    return c.json({ error: "Sender agent not registered" }, 403);
  }

  const recipient = getAgent.get({ id: body.to_agent });
  if (!recipient) {
    return c.json({ error: "Recipient agent not found" }, 404);
  }

  const taskId = uuidv4();

  insertTask.run({
    id: taskId,
    from_agent: auth.agentAddress,
    to_agent: body.to_agent,
    subject: body.subject,
    payload: body.payload ? JSON.stringify(body.payload) : null,
    status: "pending",
    result: null,
    created_at: new Date().toISOString(),
    completed_at: null,
  });

  // Touch sender's last_seen
  touchAgent.run({ id: auth.agentAddress });

  return c.json({ ok: true, task_id: taskId }, 201);
});

/**
 * GET /tasks
 * Poll for tasks assigned to the authenticated agent.
 *
 * For GET requests with no body, sign an empty string ("") as the message.
 * Note: this signature is replayable — a timestamp nonce is recommended for v2.
 *
 * Query params:
 *   ?status=pending|active|completed|failed   (optional, returns all if omitted)
 *   ?to_agent=<stacks-address>                (optional, must match auth address if provided)
 */
app.get("/", (c) => {
  const auth = extractAuth(c.req.raw.headers, "");
  if (!auth.ok) {
    return c.json({ error: auth.error }, 401);
  }

  const statusFilter = c.req.query("status");
  const toAgentFilter = c.req.query("to_agent");

  // If caller specifies to_agent, it must match the authenticated agent
  if (toAgentFilter && toAgentFilter !== auth.agentAddress) {
    return c.json(
      { error: "to_agent must match the authenticated agent address" },
      403
    );
  }

  const tasks = statusFilter
    ? listTasksForAgentByStatus.all({
        agent_id: auth.agentAddress,
        status: statusFilter,
      })
    : listTasksForAgent.all({ agent_id: auth.agentAddress });

  touchAgent.run({ id: auth.agentAddress });

  return c.json(
    tasks.map((t) => ({
      ...t,
      payload: t.payload ? JSON.parse(t.payload) : null,
      result: t.result ? JSON.parse(t.result) : null,
    }))
  );
});

/**
 * GET /tasks/:id
 * Check task status.
 */
app.get("/:id", (c) => {
  const task = getTask.get({ id: c.req.param("id") });

  if (!task) {
    return c.json({ error: "Task not found" }, 404);
  }

  return c.json({
    ...task,
    payload: task.payload ? JSON.parse(task.payload) : null,
    result: task.result ? JSON.parse(task.result) : null,
  });
});

/**
 * POST /tasks/:id/complete
 * Mark a task as completed (or failed) with a result.
 *
 * Body: { status: 'completed' | 'failed', result? }
 * Auth headers required (must be the assigned agent).
 */
app.post("/:id/complete", async (c) => {
  const rawBody = await c.req.text();
  const auth = extractAuth(c.req.raw.headers, rawBody);

  if (!auth.ok) {
    return c.json({ error: auth.error }, 401);
  }

  const task = getTask.get({ id: c.req.param("id") });
  if (!task) {
    return c.json({ error: "Task not found" }, 404);
  }

  // Only the assigned agent can complete
  if (task.to_agent !== auth.agentAddress) {
    return c.json({ error: "Only the assigned agent can complete this task" }, 403);
  }

  if (task.status !== "pending" && task.status !== "active") {
    return c.json({ error: `Task already ${task.status}` }, 409);
  }

  let body: {
    status: "completed" | "failed";
    result?: Record<string, unknown>;
  };

  try {
    body = JSON.parse(rawBody);
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (body.status !== "completed" && body.status !== "failed") {
    return c.json({ error: "status must be 'completed' or 'failed'" }, 400);
  }

  completeTask.run({
    id: task.id,
    status: body.status,
    result: body.result ? JSON.stringify(body.result) : null,
  });

  // Touch agent's last_seen
  touchAgent.run({ id: auth.agentAddress });

  return c.json({ ok: true });
});

export default app;
