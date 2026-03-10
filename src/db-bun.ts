import { Database } from "bun:sqlite";
import { join } from "path";
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

export function createBunClient(dbPath?: string): DbClient {
  const path = dbPath ?? process.env.DB_PATH ?? join(import.meta.dir, "..", "agent-hub.db");
  const db = new Database(path);
  db.run("PRAGMA journal_mode = WAL");
  db.exec(SCHEMA);

  const stmts = {
    insertAgent: db.query(
      `INSERT INTO agents (id, name, bns_name, bitcoin_address, capabilities, endpoint_url)
       VALUES ($id, $name, $bns_name, $bitcoin_address, $capabilities, $endpoint_url)`
    ),
    getAgent: db.query<Agent, { $id: string }>(
      `SELECT * FROM agents WHERE id = $id`
    ),
    listAgents: db.query<Agent, []>(`SELECT * FROM agents`),
    listAgentsByCapability: db.query<Agent, { $cap: string }>(
      `SELECT * FROM agents WHERE capabilities LIKE $cap`
    ),
    touchAgent: db.query(
      `UPDATE agents SET last_seen = datetime('now') WHERE id = $id`
    ),
    insertTask: db.query(
      `INSERT INTO tasks (id, from_agent, to_agent, subject, payload)
       VALUES ($id, $from_agent, $to_agent, $subject, $payload)`
    ),
    getTask: db.query<Task, { $id: string }>(
      `SELECT * FROM tasks WHERE id = $id`
    ),
    listTasksForAgent: db.query<Task, { $agent_id: string }>(
      `SELECT * FROM tasks WHERE to_agent = $agent_id ORDER BY created_at DESC`
    ),
    listTasksForAgentByStatus: db.query<Task, { $agent_id: string; $status: string }>(
      `SELECT * FROM tasks WHERE to_agent = $agent_id AND status = $status ORDER BY created_at DESC`
    ),
    completeTask: db.query(
      `UPDATE tasks SET status = $status, result = $result, completed_at = datetime('now') WHERE id = $id`
    ),
  };

  return {
    async insertAgent(agent) {
      stmts.insertAgent.run({
        $id: agent.id,
        $name: agent.name,
        $bns_name: agent.bns_name,
        $bitcoin_address: agent.bitcoin_address,
        $capabilities: agent.capabilities,
        $endpoint_url: agent.endpoint_url,
      });
    },
    async getAgent(id) {
      return stmts.getAgent.get({ $id: id }) ?? null;
    },
    async listAgents() {
      return stmts.listAgents.all();
    },
    async listAgentsByCapability(cap) {
      return stmts.listAgentsByCapability.all({ $cap: `%${cap}%` });
    },
    async touchAgent(id) {
      stmts.touchAgent.run({ $id: id });
    },
    async insertTask(task) {
      stmts.insertTask.run({
        $id: task.id,
        $from_agent: task.from_agent,
        $to_agent: task.to_agent,
        $subject: task.subject,
        $payload: task.payload,
      });
    },
    async getTask(id) {
      return stmts.getTask.get({ $id: id }) ?? null;
    },
    async listTasksForAgent(agentId) {
      return stmts.listTasksForAgent.all({ $agent_id: agentId });
    },
    async listTasksForAgentByStatus(agentId, status) {
      return stmts.listTasksForAgentByStatus.all({ $agent_id: agentId, $status: status });
    },
    async completeTask(id, status, result) {
      stmts.completeTask.run({ $id: id, $status: status, $result: result });
    },
  };
}
