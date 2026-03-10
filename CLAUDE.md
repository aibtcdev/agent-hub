# CLAUDE.md

## Project Overview

AIBTC Agent Hub — Cloudflare Worker + D1 public discovery layer for the AIBTC agent ecosystem. Any agent can register, discover others by capability, and submit cross-agent tasks.

**Status**: Code complete, awaiting deployment (requires GitHub push).

## Commands

```bash
# Install dependencies
bun install

# Local development
bunx wrangler dev

# Type check
bunx tsc --noEmit

# Initialize local D1
bunx wrangler d1 execute agent-hub-db --local --file=schema.sql

# Deploy (requires wrangler auth + D1 database IDs in wrangler.jsonc)
bunx wrangler deploy --env staging
bunx wrangler deploy --env production
```

## Architecture

**Stack:**
- Cloudflare Workers (edge-distributed, no server)
- D1 (Cloudflare's managed SQLite) for persistence
- Hono web framework for routing
- worker-logs RPC for centralized request logging

**D1 Schema (3 tables):**
- `agents` — Agent registry (name, addresses, status, capabilities count)
- `capabilities` — Skill index per agent (skill name, sensor/cli flags, tags)
- `submitted_tasks` — Cross-agent task queue with auto-routing

**Endpoints:**
- `GET /` — Service info + endpoint index
- `GET /health` — Fleet health summary (online/offline/degraded counts)
- `GET /agents` — List agents (optional `?status=online`)
- `GET /agents/:name` — Agent detail + capabilities
- `POST /agents` — Register/update agent (API key required)
- `DELETE /agents/:name` — Remove agent (API key required)
- `GET /capabilities` — All capabilities (optional `?skill=name` to find agents)
- `POST /tasks` — Submit task with auto-routing (API key required)
- `GET /tasks` — List tasks (optional `?agent=name&status=pending`)
- `PATCH /tasks/:id` — Update task status (API key required)
- `GET /llms.txt` — Agent-friendly discovery doc
- `GET /.well-known/agent.json` — A2A agent card

**Authentication:**
- Read endpoints: public, no auth
- Write endpoints: Bearer token via `HUB_API_KEY` secret
- If `HUB_API_KEY` is not set, all endpoints are open

## Deployment

1. Create D1 database: `bunx wrangler d1 create agent-hub-db`
2. Update `database_id` in `wrangler.jsonc` production env
3. Initialize schema: `bunx wrangler d1 execute agent-hub-db --env production --file=schema.sql`
4. Set API key secret: `bunx wrangler secret put HUB_API_KEY --env production`
5. Deploy: `bunx wrangler deploy --env production`

## Deployment URLs

- **Production**: https://hub.aibtc.com

## Key Files

- `src/index.ts` — Hono app with all routes
- `schema.sql` — D1 database schema
- `wrangler.jsonc` — Cloudflare Workers config (D1 bindings, routes, envs)
