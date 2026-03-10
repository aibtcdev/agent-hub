import { Hono } from "hono";
import type { DbClient } from "../types.js";
import { extractAuth } from "../auth.js";

type RouteEnv = {
  Variables: {
    db: DbClient;
  };
};

export function createAgentRoutes(): Hono<RouteEnv> {
  const app = new Hono<RouteEnv>();

  /**
   * POST /agents/register
   * Register a new agent with BIP-137 proof of identity.
   *
   * Body: { name, bns_name?, capabilities?, endpoint_url? }
   * Auth headers: X-Agent-Address, X-Bitcoin-Address, X-Signature (signs body)
   */
  app.post("/register", async (c) => {
    const rawBody = await c.req.text();
    const auth = extractAuth(c.req.raw.headers, rawBody);

    if (!auth.ok) {
      return c.json({ error: auth.error }, 401);
    }

    let body: {
      name: string;
      bns_name?: string;
      capabilities?: string[];
      endpoint_url?: string;
    };

    try {
      body = JSON.parse(rawBody);
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    if (!body.name) {
      return c.json({ error: "name is required" }, 400);
    }

    const db = c.var.db;

    // Check if agent already registered
    const existing = await db.getAgent(auth.agentAddress);
    if (existing) {
      return c.json({ error: "Agent already registered" }, 409);
    }

    await db.insertAgent({
      id: auth.agentAddress,
      name: body.name,
      bns_name: body.bns_name ?? null,
      bitcoin_address: auth.bitcoinAddress,
      capabilities: body.capabilities ? JSON.stringify(body.capabilities) : null,
      endpoint_url: body.endpoint_url ?? null,
    });

    return c.json({ ok: true, agent_id: auth.agentAddress }, 201);
  });

  /**
   * GET /agents
   * List all agents. Optionally filter by capability via ?capability=foo
   */
  app.get("/", async (c) => {
    const capability = c.req.query("capability");
    const db = c.var.db;

    let agents;
    if (capability) {
      agents = await db.listAgentsByCapability(capability);
    } else {
      agents = await db.listAgents();
    }

    // Parse capabilities JSON for response
    const parsed = agents.map((a) => ({
      ...a,
      capabilities: a.capabilities ? JSON.parse(a.capabilities) : [],
    }));

    return c.json(parsed);
  });

  return app;
}
