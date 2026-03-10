// Agent Hub — Cloudflare Worker + D1
// Public discovery layer for AIBTC agent ecosystem
// Routes: register/lookup agents, query capabilities, submit tasks

import { Hono } from "hono";
import { cors } from "hono/cors";

// worker-logs RPC binding type
interface LogsBinding {
  info: (appId: string, msg: string, context?: Record<string, unknown>) => Promise<void>;
  warn: (appId: string, msg: string, context?: Record<string, unknown>) => Promise<void>;
  error: (appId: string, msg: string, context?: Record<string, unknown>) => Promise<void>;
}

const APP_ID = "agent-hub";

export interface Env {
  DB: D1Database;
  LOGS?: LogsBinding;
  HUB_API_KEY?: string; // optional: protect write endpoints
}

// ---- Types ----

interface AgentRow {
  id: number;
  agent_name: string;
  display_name: string | null;
  description: string | null;
  url: string | null;
  stx_address: string | null;
  btc_address: string | null;
  bns_name: string | null;
  status: string;
  version: string | null;
  skill_count: number;
  sensor_count: number;
  last_heartbeat: string | null;
  registered_at: string;
  updated_at: string;
}

interface CapabilityRow {
  id: number;
  agent_name: string;
  skill_name: string;
  description: string | null;
  has_sensor: number;
  has_cli: number;
  tags: string | null;
  registered_at: string;
}

interface TaskRow {
  id: number;
  from_agent: string;
  to_agent: string | null;
  subject: string;
  description: string | null;
  skill_match: string | null;
  priority: number;
  status: string;
  result_summary: string | null;
  submitted_at: string;
  updated_at: string;
}

// ---- Helpers ----

function jsonErr(error: string, status: number, code?: string): Response {
  return Response.json({ error, code: code ?? "ERROR" }, { status });
}

function now(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function requireApiKey(c: { req: { header: (name: string) => string | undefined }; env: Env }): boolean {
  const key = c.env.HUB_API_KEY;
  if (!key) return true; // no key configured = open access
  const auth = c.req.header("Authorization");
  return auth === `Bearer ${key}`;
}

// ---- App ----

const app = new Hono<{ Bindings: Env }>();

// CORS for public read access
app.use("*", cors());

// Request logging — fire-and-forget to worker-logs
app.use("*", async (c, next) => {
  const start = Date.now();
  await next();
  const logs = c.env?.LOGS;
  if (logs) {
    const duration = Date.now() - start;
    const pathname = new URL(c.req.url).pathname;
    const ctx = c.executionCtx;
    const logEntry = logs
      .info(APP_ID, `${c.req.method} ${pathname}`, {
        method: c.req.method,
        path: pathname,
        status: c.res.status,
        duration_ms: duration,
        user_agent: c.req.header("user-agent")?.slice(0, 100),
      })
      .catch((err: unknown) => {
        console.error("[logging] Failed to send log:", err);
      });
    if (ctx?.waitUntil) {
      ctx.waitUntil(logEntry);
    }
  }
});

// ---- Service info ----

app.get("/", (c) =>
  c.json({
    service: "agent-hub",
    version: "1.0.0",
    description: "AIBTC Agent Discovery Hub — register agents, discover capabilities, route tasks",
    endpoints: {
      "GET /agents": "List all registered agents",
      "GET /agents/:name": "Agent detail + capabilities",
      "POST /agents": "Register or update an agent (requires API key)",
      "DELETE /agents/:name": "Remove an agent (requires API key)",
      "GET /capabilities": "List all capabilities, optionally filter by ?skill=name",
      "POST /tasks": "Submit a task to the hub (requires API key)",
      "GET /tasks": "List submitted tasks, optionally filter by ?agent=name&status=pending",
      "PATCH /tasks/:id": "Update task status (requires API key)",
      "GET /health": "Fleet health summary",
    },
  })
);

// ---- Health ----

app.get("/health", async (c) => {
  const result = await c.env.DB.prepare(
    "SELECT status, COUNT(*) as count FROM agents GROUP BY status"
  ).all<{ status: string; count: number }>();

  const counts = { total: 0, online: 0, offline: 0, degraded: 0 };
  for (const row of result.results) {
    counts.total += row.count;
    if (row.status === "online") counts.online = row.count;
    else if (row.status === "offline") counts.offline = row.count;
    else if (row.status === "degraded") counts.degraded = row.count;
  }

  return c.json({ ok: counts.online > 0, ...counts, checked_at: now() });
});

// ---- Agents ----

// List all agents
app.get("/agents", async (c) => {
  const status = c.req.query("status");

  let stmt;
  if (status) {
    stmt = c.env.DB.prepare("SELECT * FROM agents WHERE status = ? ORDER BY agent_name ASC").bind(status);
  } else {
    stmt = c.env.DB.prepare("SELECT * FROM agents ORDER BY agent_name ASC");
  }

  const result = await stmt.all<AgentRow>();
  return c.json({ agents: result.results, count: result.results.length });
});

// Get agent detail + capabilities
app.get("/agents/:name", async (c) => {
  const name = c.req.param("name");

  const agent = await c.env.DB.prepare("SELECT * FROM agents WHERE agent_name = ?")
    .bind(name)
    .first<AgentRow>();

  if (!agent) return jsonErr("Agent not found", 404, "NOT_FOUND");

  const caps = await c.env.DB.prepare(
    "SELECT * FROM capabilities WHERE agent_name = ? ORDER BY skill_name ASC"
  )
    .bind(name)
    .all<CapabilityRow>();

  return c.json({ agent, capabilities: caps.results });
});

// Register or update agent
app.post("/agents", async (c) => {
  if (!requireApiKey(c)) return jsonErr("Unauthorized", 401, "UNAUTHORIZED");

  const body = await c.req.json<{
    agent_name: string;
    display_name?: string;
    description?: string;
    url?: string;
    stx_address?: string;
    btc_address?: string;
    bns_name?: string;
    status?: string;
    version?: string;
    skill_count?: number;
    sensor_count?: number;
    capabilities?: Array<{
      skill_name: string;
      description?: string;
      has_sensor?: boolean;
      has_cli?: boolean;
      tags?: string[];
    }>;
  }>();

  if (!body.agent_name) return jsonErr("agent_name is required", 400, "MISSING_FIELD");

  const ts = now();

  // Upsert agent
  await c.env.DB.prepare(`
    INSERT INTO agents (agent_name, display_name, description, url, stx_address, btc_address, bns_name, status, version, skill_count, sensor_count, last_heartbeat, registered_at, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
    ON CONFLICT(agent_name) DO UPDATE SET
      display_name = COALESCE(?2, display_name),
      description = COALESCE(?3, description),
      url = COALESCE(?4, url),
      stx_address = COALESCE(?5, stx_address),
      btc_address = COALESCE(?6, btc_address),
      bns_name = COALESCE(?7, bns_name),
      status = COALESCE(?8, status),
      version = COALESCE(?9, version),
      skill_count = COALESCE(?10, skill_count),
      sensor_count = COALESCE(?11, sensor_count),
      last_heartbeat = ?12,
      updated_at = ?14
  `)
    .bind(
      body.agent_name,
      body.display_name ?? null,
      body.description ?? null,
      body.url ?? null,
      body.stx_address ?? null,
      body.btc_address ?? null,
      body.bns_name ?? null,
      body.status ?? "online",
      body.version ?? null,
      body.skill_count ?? 0,
      body.sensor_count ?? 0,
      ts, // last_heartbeat
      ts, // registered_at
      ts  // updated_at
    )
    .run();

  // Replace capabilities if provided (batched for atomicity)
  if (body.capabilities && body.capabilities.length > 0) {
    const deleteStmt = c.env.DB.prepare("DELETE FROM capabilities WHERE agent_name = ?")
      .bind(body.agent_name);

    const insertStmts = body.capabilities.map((cap) =>
      c.env.DB.prepare(`
        INSERT INTO capabilities (agent_name, skill_name, description, has_sensor, has_cli, tags, registered_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
      `)
        .bind(
          body.agent_name,
          cap.skill_name,
          cap.description ?? null,
          cap.has_sensor ? 1 : 0,
          cap.has_cli ? 1 : 0,
          cap.tags ? JSON.stringify(cap.tags) : null,
          ts
        )
    );

    await c.env.DB.batch([deleteStmt, ...insertStmts]);
  }

  return c.json({ ok: true, agent_name: body.agent_name, updated_at: ts }, 201);
});

// Delete agent
app.delete("/agents/:name", async (c) => {
  if (!requireApiKey(c)) return jsonErr("Unauthorized", 401, "UNAUTHORIZED");

  const name = c.req.param("name");
  const result = await c.env.DB.prepare("DELETE FROM agents WHERE agent_name = ?")
    .bind(name)
    .run();

  if (!result.meta.changes) return jsonErr("Agent not found", 404, "NOT_FOUND");
  return c.json({ ok: true, deleted: name });
});

// ---- Capabilities ----

app.get("/capabilities", async (c) => {
  const skill = c.req.query("skill");

  if (skill) {
    // Find agents that have this skill, prefer online agents
    const results = await c.env.DB.prepare(`
      SELECT c.*, a.status, a.display_name, a.url
      FROM capabilities c
      JOIN agents a ON a.agent_name = c.agent_name
      WHERE c.skill_name = ?
      ORDER BY
        CASE a.status WHEN 'online' THEN 0 WHEN 'degraded' THEN 1 ELSE 2 END,
        c.agent_name ASC
    `)
      .bind(skill)
      .all();

    return c.json({ skill, agents: results.results, count: results.results.length });
  }

  // All capabilities grouped by agent
  const results = await c.env.DB.prepare(
    "SELECT * FROM capabilities ORDER BY agent_name, skill_name"
  ).all<CapabilityRow>();

  return c.json({ capabilities: results.results, count: results.results.length });
});

// ---- Tasks ----

// Submit a task
app.post("/tasks", async (c) => {
  if (!requireApiKey(c)) return jsonErr("Unauthorized", 401, "UNAUTHORIZED");

  const body = await c.req.json<{
    from_agent: string;
    to_agent?: string;
    subject: string;
    description?: string;
    priority?: number;
  }>();

  if (!body.from_agent || !body.subject) {
    return jsonErr("from_agent and subject are required", 400, "MISSING_FIELD");
  }

  const ts = now();
  let toAgent = body.to_agent ?? null;
  let skillMatch: string | null = null;

  // Auto-route: if no to_agent, find the best agent by scanning the subject for skill matches
  if (!toAgent) {
    // Simple skill-based routing: check if any known skill name appears in subject or description
    const text = `${body.subject} ${body.description ?? ""}`.toLowerCase();
    const matchResult = await c.env.DB.prepare(`
      SELECT c.agent_name, c.skill_name, a.status
      FROM capabilities c
      JOIN agents a ON a.agent_name = c.agent_name
      WHERE a.status = 'online'
      ORDER BY c.skill_name ASC
    `).all<{ agent_name: string; skill_name: string; status: string }>();

    for (const row of matchResult.results) {
      if (text.includes(row.skill_name.toLowerCase())) {
        toAgent = row.agent_name;
        skillMatch = row.skill_name;
        break;
      }
    }
  }

  const result = await c.env.DB.prepare(`
    INSERT INTO submitted_tasks (from_agent, to_agent, subject, description, skill_match, priority, status, submitted_at, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', ?7, ?8)
  `)
    .bind(
      body.from_agent,
      toAgent,
      body.subject,
      body.description ?? null,
      skillMatch,
      body.priority ?? 5,
      ts,
      ts
    )
    .run();

  return c.json(
    {
      ok: true,
      task_id: result.meta.last_row_id,
      to_agent: toAgent,
      skill_match: skillMatch,
      routed: toAgent !== null,
    },
    201
  );
});

// List tasks
app.get("/tasks", async (c) => {
  const agent = c.req.query("agent");
  const status = c.req.query("status");
  const limit = parseInt(c.req.query("limit") ?? "50", 10);

  let query = "SELECT * FROM submitted_tasks WHERE 1=1";
  const binds: (string | number)[] = [];

  if (agent) {
    query += " AND (from_agent = ? OR to_agent = ?)";
    binds.push(agent, agent);
  }
  if (status) {
    query += " AND status = ?";
    binds.push(status);
  }

  query += " ORDER BY submitted_at DESC LIMIT ?";
  binds.push(limit);

  const stmt = c.env.DB.prepare(query);
  const result = await (binds.length > 0 ? stmt.bind(...binds) : stmt).all<TaskRow>();

  return c.json({ tasks: result.results, count: result.results.length });
});

// Update task status
app.patch("/tasks/:id", async (c) => {
  if (!requireApiKey(c)) return jsonErr("Unauthorized", 401, "UNAUTHORIZED");

  const id = parseInt(c.req.param("id"), 10);
  const body = await c.req.json<{
    status?: string;
    result_summary?: string;
    to_agent?: string;
  }>();

  const ts = now();
  const result = await c.env.DB.prepare(`
    UPDATE submitted_tasks SET
      status = COALESCE(?1, status),
      result_summary = COALESCE(?2, result_summary),
      to_agent = COALESCE(?3, to_agent),
      updated_at = ?4
    WHERE id = ?5
  `)
    .bind(
      body.status ?? null,
      body.result_summary ?? null,
      body.to_agent ?? null,
      ts,
      id
    )
    .run();

  if (!result.meta.changes) return jsonErr("Task not found", 404, "NOT_FOUND");
  return c.json({ ok: true, task_id: id, updated_at: ts });
});

// ---- Discovery (agent-friendly) ----

app.get("/llms.txt", async (c) => {
  const agents = await c.env.DB.prepare(
    "SELECT agent_name, display_name, status, url FROM agents WHERE status = 'online' ORDER BY agent_name"
  ).all<AgentRow>();

  const lines = [
    "# AIBTC Agent Hub",
    "# Public discovery layer for the AIBTC agent ecosystem",
    "",
    "## Endpoints",
    "GET  /agents              - List all registered agents",
    "GET  /agents/:name        - Agent detail + capabilities",
    "POST /agents              - Register or update an agent",
    "GET  /capabilities?skill= - Find agents with a specific skill",
    "POST /tasks               - Submit a task to the hub",
    "GET  /tasks               - List submitted tasks",
    "GET  /health              - Fleet health summary",
    "",
    "## Online Agents",
    ...agents.results.map(
      (a) => `- ${a.agent_name}${a.display_name ? ` (${a.display_name})` : ""}${a.url ? ` — ${a.url}` : ""}`
    ),
    "",
    "## Authentication",
    "Write endpoints require Bearer token in Authorization header.",
    "Read endpoints are public.",
  ];

  return c.text(lines.join("\n"));
});

app.get("/.well-known/agent.json", (c) =>
  c.json({
    name: "AIBTC Agent Hub",
    description: "Public discovery and task routing hub for AIBTC agent ecosystem",
    version: "1.0.0",
    capabilities: ["agent-discovery", "capability-index", "task-routing"],
    endpoints: {
      agents: "/agents",
      capabilities: "/capabilities",
      tasks: "/tasks",
      health: "/health",
    },
    auth: {
      type: "bearer",
      required_for: ["POST /agents", "DELETE /agents/:name", "POST /tasks", "PATCH /tasks/:id"],
    },
  })
);

export default app;
