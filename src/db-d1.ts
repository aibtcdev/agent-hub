import type { Agent, Task, DbClient } from "./types.js";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    bns_name TEXT,
    bitcoin_address TEXT,
    capabilities TEXT,
    endpoint_url TEXT,
    registered_at TEXT DEFAULT (datetime('now')),
    last_seen TEXT
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    from_agent TEXT NOT NULL,
    to_agent TEXT NOT NULL,
    subject TEXT NOT NULL,
    payload TEXT,
    status TEXT DEFAULT 'pending',
    result TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT,
    FOREIGN KEY (from_agent) REFERENCES agents(id),
    FOREIGN KEY (to_agent) REFERENCES agents(id)
  );
`;

export function createD1Client(d1: D1Database): DbClient {
  let initialized = false;

  async function ensureSchema(): Promise<void> {
    if (initialized) return;
    // D1 batch executes multiple statements
    await d1.batch([
      d1.prepare(SCHEMA.split(";").filter((s) => s.trim())[0] + ";"),
      d1.prepare(SCHEMA.split(";").filter((s) => s.trim())[1] + ";"),
    ]);
    initialized = true;
  }

  return {
    async insertAgent(agent) {
      await ensureSchema();
      await d1
        .prepare(
          `INSERT INTO agents (id, name, bns_name, bitcoin_address, capabilities, endpoint_url)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .bind(
          agent.id,
          agent.name,
          agent.bns_name,
          agent.bitcoin_address,
          agent.capabilities,
          agent.endpoint_url
        )
        .run();
    },

    async getAgent(id) {
      await ensureSchema();
      const result = await d1
        .prepare(`SELECT * FROM agents WHERE id = ?`)
        .bind(id)
        .first<Agent>();
      return result ?? null;
    },

    async listAgents() {
      await ensureSchema();
      const result = await d1.prepare(`SELECT * FROM agents`).all<Agent>();
      return result.results;
    },

    async listAgentsByCapability(cap) {
      await ensureSchema();
      const result = await d1
        .prepare(`SELECT * FROM agents WHERE capabilities LIKE ?`)
        .bind(`%${cap}%`)
        .all<Agent>();
      return result.results;
    },

    async touchAgent(id) {
      await ensureSchema();
      await d1
        .prepare(`UPDATE agents SET last_seen = datetime('now') WHERE id = ?`)
        .bind(id)
        .run();
    },

    async insertTask(task) {
      await ensureSchema();
      await d1
        .prepare(
          `INSERT INTO tasks (id, from_agent, to_agent, subject, payload)
           VALUES (?, ?, ?, ?, ?)`
        )
        .bind(task.id, task.from_agent, task.to_agent, task.subject, task.payload)
        .run();
    },

    async getTask(id) {
      await ensureSchema();
      const result = await d1
        .prepare(`SELECT * FROM tasks WHERE id = ?`)
        .bind(id)
        .first<Task>();
      return result ?? null;
    },

    async listTasksForAgent(agentId) {
      await ensureSchema();
      const result = await d1
        .prepare(
          `SELECT * FROM tasks WHERE to_agent = ? ORDER BY created_at DESC`
        )
        .bind(agentId)
        .all<Task>();
      return result.results;
    },

    async listTasksForAgentByStatus(agentId, status) {
      await ensureSchema();
      const result = await d1
        .prepare(
          `SELECT * FROM tasks WHERE to_agent = ? AND status = ? ORDER BY created_at DESC`
        )
        .bind(agentId, status)
        .all<Task>();
      return result.results;
    },

    async completeTask(id, status, result) {
      await ensureSchema();
      await d1
        .prepare(
          `UPDATE tasks SET status = ?, result = ?, completed_at = datetime('now') WHERE id = ?`
        )
        .bind(status, result, id)
        .run();
    },
  };
}
