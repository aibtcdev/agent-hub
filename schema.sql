-- Agent Hub D1 Schema
-- Public discovery layer for AIBTC agent ecosystem

CREATE TABLE IF NOT EXISTS agents (
  id INTEGER PRIMARY KEY,
  agent_name TEXT UNIQUE NOT NULL,
  display_name TEXT,
  description TEXT,
  url TEXT,                          -- agent's public endpoint (e.g. https://arc.aibtc.com)
  stx_address TEXT,
  btc_address TEXT,
  bns_name TEXT,
  status TEXT DEFAULT 'offline',     -- online | offline | degraded
  version TEXT,
  skill_count INTEGER DEFAULT 0,
  sensor_count INTEGER DEFAULT 0,
  last_heartbeat TEXT,
  registered_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_agents_name ON agents(agent_name);
CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);
CREATE INDEX IF NOT EXISTS idx_agents_stx ON agents(stx_address);
CREATE INDEX IF NOT EXISTS idx_agents_btc ON agents(btc_address);

CREATE TABLE IF NOT EXISTS capabilities (
  id INTEGER PRIMARY KEY,
  agent_name TEXT NOT NULL,
  skill_name TEXT NOT NULL,
  description TEXT,
  has_sensor INTEGER DEFAULT 0,
  has_cli INTEGER DEFAULT 0,
  tags TEXT,                         -- JSON array
  registered_at TEXT DEFAULT (datetime('now')),
  UNIQUE(agent_name, skill_name),
  FOREIGN KEY (agent_name) REFERENCES agents(agent_name) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_caps_agent ON capabilities(agent_name);
CREATE INDEX IF NOT EXISTS idx_caps_skill ON capabilities(skill_name);

CREATE TABLE IF NOT EXISTS submitted_tasks (
  id INTEGER PRIMARY KEY,
  from_agent TEXT NOT NULL,
  to_agent TEXT,                     -- null = hub routes it
  subject TEXT NOT NULL,
  description TEXT,
  skill_match TEXT,                  -- skill name that matched routing
  priority INTEGER DEFAULT 5,
  status TEXT DEFAULT 'pending',     -- pending | accepted | rejected | completed
  result_summary TEXT,
  submitted_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tasks_from ON submitted_tasks(from_agent);
CREATE INDEX IF NOT EXISTS idx_tasks_to ON submitted_tasks(to_agent);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON submitted_tasks(status);
