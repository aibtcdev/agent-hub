import Database from "better-sqlite3";
import { join } from "path";

const DB_PATH = join(import.meta.dir, "..", "agent-hub.db");

const db = new Database(DB_PATH);

// WAL mode for better concurrent read performance
db.pragma("journal_mode = WAL");

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
export const insertAgent = db.prepare<Agent>(
  `INSERT INTO agents (id, name, bns_name, bitcoin_address, capabilities, endpoint_url)
   VALUES (@id, @name, @bns_name, @bitcoin_address, @capabilities, @endpoint_url)`
);

export const getAgent = db.prepare<{ id: string }, Agent>(
  `SELECT * FROM agents WHERE id = @id`
);

export const listAgents = db.prepare<[], Agent>(`SELECT * FROM agents`);

export const listAgentsByCapability = db.prepare<{ cap: string }, Agent>(
  `SELECT * FROM agents WHERE capabilities LIKE @cap`
);

export const touchAgent = db.prepare<{ id: string }>(
  `UPDATE agents SET last_seen = datetime('now') WHERE id = @id`
);

// Task queries
export const insertTask = db.prepare<Task>(
  `INSERT INTO tasks (id, from_agent, to_agent, subject, payload)
   VALUES (@id, @from_agent, @to_agent, @subject, @payload)`
);

export const getTask = db.prepare<{ id: string }, Task>(
  `SELECT * FROM tasks WHERE id = @id`
);

export const listTasksForAgent = db.prepare<{ agent_id: string }, Task>(
  `SELECT * FROM tasks WHERE to_agent = @agent_id ORDER BY created_at DESC`
);

export const completeTask = db.prepare<{
  id: string;
  status: string;
  result: string | null;
}>(
  `UPDATE tasks SET status = @status, result = @result, completed_at = datetime('now') WHERE id = @id`
);

export default db;
