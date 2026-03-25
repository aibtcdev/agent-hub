/**
 * Integration tests for agent-hub Hono app.
 *
 * Uses an in-memory mock of D1Database so no real Cloudflare binding is needed.
 * HUB_API_KEY is left undefined so all write endpoints accept open access.
 *
 * Happy-path scenario:
 *   1. Register two agents
 *   2. List agents — both appear
 *   3. Submit a task from agent-a to agent-b
 *   4. Query tasks with ?to_agent=agent-b filter — task appears
 *   5. PATCH task status to completed
 *
 * Error-path scenario:
 *   1. POST /agents without agent_name → 400 MISSING_FIELD
 */

import { describe, it, expect, beforeEach } from "bun:test";
import app from "../src/index";
import type { Env } from "../src/index";

// ---------------------------------------------------------------------------
// Minimal in-memory D1 mock
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

/**
 * Very small SQL parser — only handles the patterns that agent-hub actually
 * uses:  INSERT, INSERT … ON CONFLICT DO UPDATE, UPDATE … WHERE id = ?,
 * DELETE, SELECT * FROM <table> WHERE …, SELECT … GROUP BY …
 *
 * We don't implement a real SQL engine.  Instead each prepare() call
 * inspects the SQL text and returns a specialised handler.
 */
class MockD1Database {
  // table name → rows map
  private tables: Map<string, Map<number, Row>> = new Map();
  private sequences: Map<string, number> = new Map();

  constructor() {
    for (const t of ["agents", "capabilities", "submitted_tasks"]) {
      this.tables.set(t, new Map());
      this.sequences.set(t, 0);
    }
  }

  private nextId(table: string): number {
    const id = (this.sequences.get(table) ?? 0) + 1;
    this.sequences.set(table, id);
    return id;
  }

  private getTable(name: string): Map<number, Row> {
    if (!this.tables.has(name)) this.tables.set(name, new Map());
    return this.tables.get(name)!;
  }

  /** Detect which table a SQL string references. */
  private detectTable(sql: string): string {
    const m = sql.match(/(?:FROM|INTO|UPDATE|DELETE\s+FROM)\s+(\w+)/i);
    return m ? m[1].toLowerCase() : "";
  }

  prepare(sql: string): MockD1PreparedStatement {
    return new MockD1PreparedStatement(sql, this);
  }

  async batch(stmts: MockD1PreparedStatement[]): Promise<D1Result[]> {
    const results: D1Result[] = [];
    for (const s of stmts) {
      results.push(await s.run());
    }
    return results;
  }

  // ---- Internal helpers called by MockD1PreparedStatement ----

  _run(sql: string, params: unknown[]): D1Result {
    const upper = sql.trim().toUpperCase();
    const table = this.detectTable(sql);
    const tbl = this.getTable(table);

    if (upper.startsWith("INSERT INTO") && upper.includes("ON CONFLICT")) {
      return this._upsertAgent(sql, params, tbl);
    }

    if (upper.startsWith("INSERT INTO")) {
      return this._insert(table, sql, params, tbl);
    }

    if (upper.startsWith("UPDATE")) {
      return this._update(sql, params, tbl);
    }

    if (upper.startsWith("DELETE")) {
      return this._delete(sql, params, tbl);
    }

    return { success: true, meta: { changes: 0, last_row_id: 0, duration: 0, size_after: 0, rows_written: 0, rows_read: 0, changed_db: false }, results: [] };
  }

  _all<T = Row>(sql: string, params: unknown[]): D1Result<T> {
    const table = this.detectTable(sql);
    const tbl = this.getTable(table);
    let rows = Array.from(tbl.values()) as T[];

    // Very small WHERE clause interpreter
    rows = this._applyWhere(sql, params, rows as Row[]) as T[];

    // GROUP BY for /health query
    if (sql.toLowerCase().includes("group by status")) {
      const grouped = new Map<string, number>();
      for (const r of rows as Row[]) {
        const s = String(r["status"] ?? "");
        grouped.set(s, (grouped.get(s) ?? 0) + 1);
      }
      rows = Array.from(grouped.entries()).map(([status, count]) => ({ status, count })) as T[];
    }

    return {
      success: true,
      results: rows,
      meta: { changes: 0, last_row_id: 0, duration: 0, size_after: 0, rows_written: 0, rows_read: rows.length, changed_db: false },
    };
  }

  _first<T = Row>(sql: string, params: unknown[]): T | null {
    const result = this._all<T>(sql, params);
    return result.results[0] ?? null;
  }

  // ---- SQL micro-interpreters ----

  private _upsertAgent(sql: string, params: unknown[], tbl: Map<number, Row>): D1Result {
    // For agent upsert: param ?1 = agent_name
    const agentName = String(params[0]);
    let existing: Row | undefined;
    let existingId: number | undefined;
    for (const [id, row] of tbl.entries()) {
      if (row["agent_name"] === agentName) { existing = row; existingId = id; break; }
    }

    if (existing && existingId !== undefined) {
      // DO UPDATE SET — merge non-null params over existing
      const updated: Row = { ...existing };
      // Indices into params for the ON CONFLICT update fields:
      // display_name=?2, description=?3, url=?4, stx_address=?5, btc_address=?6,
      // bns_name=?7, status=?8, version=?9, skill_count=?10, sensor_count=?11,
      // last_heartbeat=?12, updated_at=?14
      const fieldMap: Record<string, number> = {
        display_name: 1, description: 2, url: 3, stx_address: 4, btc_address: 5,
        bns_name: 6, status: 7, version: 8, skill_count: 9, sensor_count: 10,
        last_heartbeat: 11, updated_at: 13,
      };
      for (const [field, idx] of Object.entries(fieldMap)) {
        if (params[idx] !== null && params[idx] !== undefined) {
          updated[field] = params[idx];
        }
      }
      tbl.set(existingId, updated);
      return { success: true, meta: { changes: 1, last_row_id: existingId, duration: 0, size_after: 0, rows_written: 1, rows_read: 0, changed_db: true }, results: [] };
    }

    // INSERT new agent
    const id = this.nextId("agents");
    const row: Row = {
      id,
      agent_name: params[0],
      display_name: params[1],
      description: params[2],
      url: params[3],
      stx_address: params[4],
      btc_address: params[5],
      bns_name: params[6],
      status: params[7] ?? "online",
      version: params[8],
      skill_count: params[9] ?? 0,
      sensor_count: params[10] ?? 0,
      last_heartbeat: params[11],
      registered_at: params[12],
      updated_at: params[13],
    };
    tbl.set(id, row);
    return { success: true, meta: { changes: 1, last_row_id: id, duration: 0, size_after: 0, rows_written: 1, rows_read: 0, changed_db: true }, results: [] };
  }

  private _insert(table: string, sql: string, params: unknown[], tbl: Map<number, Row>): D1Result {
    const id = this.nextId(table);
    let row: Row;

    if (table === "capabilities") {
      row = {
        id,
        agent_name: params[0], skill_name: params[1], description: params[2],
        has_sensor: params[3], has_cli: params[4], tags: params[5], registered_at: params[6],
      };
    } else if (table === "submitted_tasks") {
      row = {
        id,
        from_agent: params[0], to_agent: params[1], subject: params[2],
        description: params[3], skill_match: params[4], priority: params[5],
        status: "pending", submitted_at: params[6], updated_at: params[7],
      };
    } else {
      row = { id };
      params.forEach((v, i) => { row[`col${i}`] = v; });
    }

    tbl.set(id, row);
    return { success: true, meta: { changes: 1, last_row_id: id, duration: 0, size_after: 0, rows_written: 1, rows_read: 0, changed_db: true }, results: [] };
  }

  private _update(sql: string, params: unknown[], tbl: Map<number, Row>): D1Result {
    // UPDATE submitted_tasks SET … WHERE id = ?5
    const idParam = params[params.length - 1];
    const id = typeof idParam === "number" ? idParam : parseInt(String(idParam), 10);
    const row = tbl.get(id);
    if (!row) return { success: true, meta: { changes: 0, last_row_id: 0, duration: 0, size_after: 0, rows_written: 0, rows_read: 0, changed_db: false }, results: [] };

    const updated = { ...row };
    // PATCH /tasks/:id — params: ?1=status, ?2=result_summary, ?3=to_agent, ?4=updated_at, ?5=id
    if (params[0] !== null && params[0] !== undefined) updated["status"] = params[0];
    if (params[1] !== null && params[1] !== undefined) updated["result_summary"] = params[1];
    if (params[2] !== null && params[2] !== undefined) updated["to_agent"] = params[2];
    if (params[3] !== null && params[3] !== undefined) updated["updated_at"] = params[3];
    tbl.set(id, updated);
    return { success: true, meta: { changes: 1, last_row_id: id, duration: 0, size_after: 0, rows_written: 1, rows_read: 0, changed_db: true }, results: [] };
  }

  private _delete(sql: string, params: unknown[], tbl: Map<number, Row>): D1Result {
    // DELETE FROM <table> WHERE agent_name = ?
    const agentName = String(params[0]);
    let deleted = 0;
    for (const [id, row] of tbl.entries()) {
      if (row["agent_name"] === agentName) { tbl.delete(id); deleted++; }
    }
    return { success: true, meta: { changes: deleted, last_row_id: 0, duration: 0, size_after: 0, rows_written: deleted, rows_read: 0, changed_db: deleted > 0 }, results: [] };
  }

  private _applyWhere(sql: string, params: unknown[], rows: Row[]): Row[] {
    const lower = sql.toLowerCase();

    // agent_name = ?
    if (lower.includes("where agent_name = ?")) {
      const name = String(params[0]);
      rows = rows.filter(r => r["agent_name"] === name);
    }

    // WHERE status = ?  (for GET /agents?status=)
    if (lower.includes("where status = ?")) {
      const status = String(params[0]);
      rows = rows.filter(r => r["status"] === status);
    }

    // Dynamic WHERE 1=1 ... (GET /tasks with optional filters)
    if (lower.includes("where 1=1")) {
      let pIdx = 0;

      if (lower.includes("(from_agent = ? or to_agent = ?)")) {
        const agent = String(params[pIdx++]);
        pIdx++; // same value used twice
        rows = rows.filter(r => r["from_agent"] === agent || r["to_agent"] === agent);
      }
      if (lower.includes("and to_agent = ?")) {
        const to = String(params[pIdx++]);
        rows = rows.filter(r => r["to_agent"] === to);
      }
      if (lower.includes("and from_agent = ?")) {
        const from = String(params[pIdx++]);
        rows = rows.filter(r => r["from_agent"] === from);
      }
      if (lower.includes("and status = ?")) {
        const status = String(params[pIdx++]);
        rows = rows.filter(r => r["status"] === status);
      }
      // last param is always LIMIT — ignore for mock (return all)
    }

    // capabilities WHERE agent_name = ?
    if (lower.includes("from capabilities where agent_name = ?")) {
      const name = String(params[0]);
      rows = rows.filter(r => r["agent_name"] === name);
    }

    return rows;
  }
}

class MockD1PreparedStatement {
  private boundParams: unknown[] = [];

  constructor(private sql: string, private db: MockD1Database) {}

  bind(...values: unknown[]): this {
    this.boundParams = values;
    return this;
  }

  async run(): Promise<D1Result> {
    return this.db._run(this.sql, this.boundParams);
  }

  async all<T = Row>(): Promise<D1Result<T>> {
    return this.db._all<T>(this.sql, this.boundParams);
  }

  async first<T = Row>(): Promise<T | null> {
    return this.db._first<T>(this.sql, this.boundParams);
  }
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeEnv(): Env {
  return {
    DB: new MockD1Database() as unknown as D1Database,
    HUB_API_KEY: undefined,
  };
}

/** Fire a request through the Hono app with the in-memory D1 env. */
async function req(
  method: string,
  path: string,
  body: unknown,
  env: Env,
  headers: Record<string, string> = {}
): Promise<Response> {
  const init: RequestInit = {
    method,
    headers: { "Content-Type": "application/json", ...headers },
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  return app.request(path, init, env);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("agent-hub integration — happy path", () => {
  let env: Env;

  beforeEach(() => {
    env = makeEnv();
  });

  it("registers agent-a successfully", async () => {
    const res = await req("POST", "/agents", { agent_name: "agent-a", description: "Test agent A" }, env);
    expect(res.status).toBe(201);
    const body = await res.json() as { ok: boolean; agent_name: string };
    expect(body.ok).toBe(true);
    expect(body.agent_name).toBe("agent-a");
  });

  it("registers agent-b successfully", async () => {
    const res = await req("POST", "/agents", { agent_name: "agent-b", description: "Test agent B" }, env);
    expect(res.status).toBe(201);
    const body = await res.json() as { ok: boolean; agent_name: string };
    expect(body.ok).toBe(true);
    expect(body.agent_name).toBe("agent-b");
  });

  it("lists both agents after registration", async () => {
    await req("POST", "/agents", { agent_name: "agent-a" }, env);
    await req("POST", "/agents", { agent_name: "agent-b" }, env);

    const res = await req("GET", "/agents", undefined, env);
    expect(res.status).toBe(200);
    const body = await res.json() as { agents: Array<{ agent_name: string }>; count: number };
    expect(body.count).toBe(2);
    const names = body.agents.map(a => a.agent_name);
    expect(names).toContain("agent-a");
    expect(names).toContain("agent-b");
  });

  it("submits a task from agent-a to agent-b", async () => {
    await req("POST", "/agents", { agent_name: "agent-a" }, env);
    await req("POST", "/agents", { agent_name: "agent-b" }, env);

    const res = await req("POST", "/tasks", {
      from_agent: "agent-a",
      to_agent: "agent-b",
      subject: "Please process this data",
    }, env);

    expect(res.status).toBe(201);
    const body = await res.json() as { ok: boolean; task_id: number; to_agent: string };
    expect(body.ok).toBe(true);
    expect(typeof body.task_id).toBe("number");
    expect(body.to_agent).toBe("agent-b");
  });

  it("filters tasks by to_agent", async () => {
    await req("POST", "/agents", { agent_name: "agent-a" }, env);
    await req("POST", "/agents", { agent_name: "agent-b" }, env);
    await req("POST", "/tasks", { from_agent: "agent-a", to_agent: "agent-b", subject: "Task one" }, env);
    await req("POST", "/tasks", { from_agent: "agent-b", to_agent: "agent-a", subject: "Task two" }, env);

    const res = await req("GET", "/tasks?to_agent=agent-b", undefined, env);
    expect(res.status).toBe(200);
    const body = await res.json() as { tasks: Array<{ to_agent: string; subject: string }>; count: number };
    expect(body.count).toBe(1);
    expect(body.tasks[0].to_agent).toBe("agent-b");
    expect(body.tasks[0].subject).toBe("Task one");
  });

  it("patches task status to completed", async () => {
    await req("POST", "/agents", { agent_name: "agent-a" }, env);
    await req("POST", "/agents", { agent_name: "agent-b" }, env);

    const createRes = await req("POST", "/tasks", {
      from_agent: "agent-a",
      to_agent: "agent-b",
      subject: "Do the thing",
    }, env);
    const created = await createRes.json() as { task_id: number };
    const taskId = created.task_id;

    const patchRes = await req("PATCH", `/tasks/${taskId}`, {
      status: "completed",
      result_summary: "All done",
    }, env);

    expect(patchRes.status).toBe(200);
    const patchBody = await patchRes.json() as { ok: boolean; task_id: number };
    expect(patchBody.ok).toBe(true);
    expect(patchBody.task_id).toBe(taskId);

    // Verify via filter
    const listRes = await req("GET", "/tasks?status=completed", undefined, env);
    const listBody = await listRes.json() as { tasks: Array<{ status: string; result_summary: string }>; count: number };
    expect(listBody.count).toBe(1);
    expect(listBody.tasks[0].status).toBe("completed");
    expect(listBody.tasks[0].result_summary).toBe("All done");
  });
});

describe("agent-hub integration — error paths", () => {
  let env: Env;

  beforeEach(() => {
    env = makeEnv();
  });

  it("returns 400 when agent_name is missing on POST /agents", async () => {
    const res = await req("POST", "/agents", { description: "No name provided" }, env);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string; code: string };
    expect(body.code).toBe("MISSING_FIELD");
  });

  it("returns 400 when from_agent or subject missing on POST /tasks", async () => {
    const res = await req("POST", "/tasks", { subject: "Missing from_agent" }, env);
    expect(res.status).toBe(400);
    const body = await res.json() as { code: string };
    expect(body.code).toBe("MISSING_FIELD");
  });

  it("returns 404 for unknown agent on GET /agents/:name", async () => {
    const res = await req("GET", "/agents/nonexistent", undefined, env);
    expect(res.status).toBe(404);
    const body = await res.json() as { code: string };
    expect(body.code).toBe("NOT_FOUND");
  });
});
