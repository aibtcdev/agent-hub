/**
 * Integration test: register two agents, submit task, poll, complete.
 *
 * Auth: uses P2PKH (1...) Bitcoin addresses. bitcoinjs-message v2 only supports
 * legacy (P2PKH) and P2SH-P2WPKH addresses for BIP-137 signing. Native SegWit
 * (bc1q...) requires BIP-322 — not yet implemented. AIBTC production agents use
 * bc1q addresses; this is a known gap tracked in issue #1.
 *
 * To run: bun test
 */

import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ECPairFactory } from "ecpair";
import * as tinysecp from "tiny-secp256k1";
import * as bitcoin from "bitcoinjs-lib";
import bitcoinMessage from "bitcoinjs-message";

// Set up a temp DB for testing
const tmpDir = mkdtempSync("/tmp/agent-hub-test-");
const testDbPath = join(tmpDir, "test.db");

// Import app factory and bun DB client
import { createApp } from "../src/app.js";
import { createBunClient } from "../src/db-bun.js";

const db = createBunClient(testDbPath);
const app = createApp(db);

const ECPair = ECPairFactory(tinysecp);

// Deterministic test keypairs (never use these on mainnet)
const PRIV_A = Buffer.from(
  "0101010101010101010101010101010101010101010101010101010101010101",
  "hex"
);
const PRIV_B = Buffer.from(
  "0202020202020202020202020202020202020202020202020202020202020202",
  "hex"
);

const kpA = ECPair.fromPrivateKey(PRIV_A);
const kpB = ECPair.fromPrivateKey(PRIV_B);

const { address: BTC_A } = bitcoin.payments.p2pkh({
  pubkey: Buffer.from(kpA.publicKey),
});
const { address: BTC_B } = bitcoin.payments.p2pkh({
  pubkey: Buffer.from(kpB.publicKey),
});

// Fake Stacks addresses — auth only verifies the Bitcoin signature, not the
// cryptographic link between Stacks and Bitcoin addresses (known gap, see #1)
const STACKS_A = "SP2AAAA0000000000000000000000000000000001";
const STACKS_B = "SP2BBBB0000000000000000000000000000000002";

function authHeaders(
  body: string,
  bitcoinAddress: string,
  agentAddress: string,
  privKey: Buffer,
  compressed: boolean
): HeadersInit {
  const sig = bitcoinMessage.sign(body, privKey, compressed);
  return {
    "Content-Type": "application/json",
    "X-Agent-Address": agentAddress,
    "X-Bitcoin-Address": bitcoinAddress,
    "X-Signature": sig.toString("base64"),
  };
}

// Wrapper around Hono's app.request so tests don't need a live server
async function req(path: string, init?: RequestInit): Promise<Response> {
  return app.request(path, init);
}

afterAll(() => {
  rmSync(tmpDir, { recursive: true });
});

describe("happy path: register → submit → poll → complete", () => {
  test("register agent A", async () => {
    const body = JSON.stringify({
      name: "Agent A",
      bns_name: "agent-a.btc",
      capabilities: ["testing"],
    });
    const res = await req("/agents/register", {
      method: "POST",
      headers: authHeaders(body, BTC_A!, STACKS_A, PRIV_A, kpA.compressed),
      body,
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.agent_id).toBe(STACKS_A);
  });

  test("register agent B", async () => {
    const body = JSON.stringify({
      name: "Agent B",
      capabilities: ["receiving"],
    });
    const res = await req("/agents/register", {
      method: "POST",
      headers: authHeaders(body, BTC_B!, STACKS_B, PRIV_B, kpB.compressed),
      body,
    });
    expect(res.status).toBe(201);
  });

  test("duplicate registration returns 409", async () => {
    const body = JSON.stringify({ name: "Agent A Again" });
    const res = await req("/agents/register", {
      method: "POST",
      headers: authHeaders(body, BTC_A!, STACKS_A, PRIV_A, kpA.compressed),
      body,
    });
    expect(res.status).toBe(409);
  });

  test("list agents returns both", async () => {
    const res = await req("/agents");
    expect(res.status).toBe(200);
    const agents = await res.json();
    expect(agents.length).toBe(2);
  });

  let taskId: string;

  test("agent A submits task to agent B", async () => {
    const body = JSON.stringify({
      to_agent: STACKS_B,
      subject: "Integration test task",
      payload: { message: "hello from A" },
    });
    const res = await req("/tasks", {
      method: "POST",
      headers: authHeaders(body, BTC_A!, STACKS_A, PRIV_A, kpA.compressed),
      body,
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.ok).toBe(true);
    taskId = data.task_id;
    expect(typeof taskId).toBe("string");
  });

  test("unregistered sender cannot submit task", async () => {
    const PRIV_C = Buffer.alloc(32, 3);
    const kpC = ECPair.fromPrivateKey(PRIV_C);
    const { address: BTC_C } = bitcoin.payments.p2pkh({
      pubkey: Buffer.from(kpC.publicKey),
    });
    const body = JSON.stringify({ to_agent: STACKS_B, subject: "Unauthorized" });
    const res = await req("/tasks", {
      method: "POST",
      headers: authHeaders(body, BTC_C!, "SP_UNKNOWN", PRIV_C, kpC.compressed),
      body,
    });
    expect(res.status).toBe(403);
  });

  test("agent B polls for pending tasks", async () => {
    // GET requests sign an empty string — replayable by design in v1
    const sig = bitcoinMessage.sign("", PRIV_B, kpB.compressed);
    const res = await req("/tasks?status=pending", {
      headers: {
        "X-Agent-Address": STACKS_B,
        "X-Bitcoin-Address": BTC_B!,
        "X-Signature": sig.toString("base64"),
      },
    });
    expect(res.status).toBe(200);
    const tasks = await res.json();
    expect(tasks.length).toBe(1);
    expect(tasks[0].id).toBe(taskId);
    expect(tasks[0].subject).toBe("Integration test task");
    expect(tasks[0].payload).toEqual({ message: "hello from A" });
  });

  test("agent A cannot complete agent B's task", async () => {
    const body = JSON.stringify({ status: "completed", result: { ok: true } });
    const res = await req(`/tasks/${taskId}/complete`, {
      method: "POST",
      headers: authHeaders(body, BTC_A!, STACKS_A, PRIV_A, kpA.compressed),
      body,
    });
    expect(res.status).toBe(403);
  });

  test("agent B completes the task", async () => {
    const body = JSON.stringify({
      status: "completed",
      result: { processed: true },
    });
    const res = await req(`/tasks/${taskId}/complete`, {
      method: "POST",
      headers: authHeaders(body, BTC_B!, STACKS_B, PRIV_B, kpB.compressed),
      body,
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
  });

  test("completed task not in pending poll", async () => {
    const sig = bitcoinMessage.sign("", PRIV_B, kpB.compressed);
    const res = await req("/tasks?status=pending", {
      headers: {
        "X-Agent-Address": STACKS_B,
        "X-Bitcoin-Address": BTC_B!,
        "X-Signature": sig.toString("base64"),
      },
    });
    expect(res.status).toBe(200);
    const tasks = await res.json();
    expect(tasks.length).toBe(0);
  });

  test("GET /tasks/:id shows completed status and result", async () => {
    const res = await req(`/tasks/${taskId}`);
    expect(res.status).toBe(200);
    const task = await res.json();
    expect(task.status).toBe("completed");
    expect(task.result).toEqual({ processed: true });
  });

  test("invalid signature returns 401", async () => {
    const body = JSON.stringify({ name: "Fake Agent" });
    const res = await req("/agents/register", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Agent-Address": STACKS_A,
        "X-Bitcoin-Address": BTC_A!,
        "X-Signature": "bm90YXZhbGlkc2ln", // not a valid sig
      },
      body,
    });
    expect(res.status).toBe(401);
  });
});
