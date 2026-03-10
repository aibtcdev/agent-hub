import { Database } from "bun:sqlite";
import { join } from "path";

const DB_PATH = process.env.DB_PATH ?? join(import.meta.dir, "..", "agent-hub.db");

const db = new Database(DB_PATH);

// WAL mode for better concurrent read performance
db.run("PRAGMA journal_mode = WAL");

db.exec(`
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
`);

export type Agent = {
  id: string;
  name: string;
  bns_name: string | null;
  bitcoin_address: string | null;
  capabilities: string | null;
  endpoint_url: string | null;
  registered_at: string;
  last_seen: string | null;
};

export type Task = {
  id: string;
  from_agent: string;
  to_agent: string;
  subject: string;
  payload: string | null;
  status: string;
  result: string | null;
  created_at: string;
  completed_at: string | null;
};

// Agent queries
export const insertAgent = db.query<void, Omit<Agent, "registered_at" | "last_seen">>(
  `INSERT INTO agents (id, name, bns_name, bitcoin_address, capabilities, endpoint_url)
   VALUES (@id, @name, @bns_name, @bitcoin_address, @capabilities, @endpoint_url)`
);

export const getAgent = db.query<Agent, { id: string }>(
  `SELECT * FROM agents WHERE id = @id`
);

export const listAgents = db.query<Agent, []>(`SELECT * FROM agents`);

export const listAgentsByCapability = db.query<Agent, { cap: string }>(
  `SELECT * FROM agents WHERE capabilities LIKE @cap`
);

export const touchAgent = db.query<void, { id: string }>(
  `UPDATE agents SET last_seen = datetime('now') WHERE id = @id`
);

// Task queries
export const insertTask = db.query<
  void,
  Omit<Task, "status" | "result" | "created_at" | "completed_at">
>(
  `INSERT INTO tasks (id, from_agent, to_agent, subject, payload)
   VALUES (@id, @from_agent, @to_agent, @subject, @payload)`
);

export const getTask = db.query<Task, { id: string }>(
  `SELECT * FROM tasks WHERE id = @id`
);

export const listTasksForAgent = db.query<Task, { agent_id: string }>(
  `SELECT * FROM tasks WHERE to_agent = @agent_id ORDER BY created_at DESC`
);

export const listTasksForAgentByStatus = db.query<
  Task,
  { agent_id: string; status: string }
>(
  `SELECT * FROM tasks WHERE to_agent = @agent_id AND status = @status ORDER BY created_at DESC`
);

export const completeTask = db.query<
  void,
  { id: string; status: string; result: string | null }
>(
  `UPDATE tasks SET status = @status, result = @result, completed_at = datetime('now') WHERE id = @id`
);

export default db;
