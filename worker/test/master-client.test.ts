// SPDX-License-Identifier: Apache-2.0
/** Integration tests for MasterClient with mocked HTTP responses. */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { MasterClient } from "../src/master-client.js";

// --------------------------------------------------------------------------
// Mock HTTP server for Master API
// --------------------------------------------------------------------------

interface MockHandler {
  method: string;
  path: string;
  status: number;
  body: unknown;
  match?: (body: unknown) => boolean;
}

let _handlers: MockHandler[] = [];
let _originalFetch: typeof global.fetch;

function addHandler(h: MockHandler): void {
  _handlers.push(h);
}

function resetHandlers(): void {
  _handlers = [];
}

function mockFetch(url: string, opts: RequestInit): Promise<Response> {
  const parsed = new URL(url);
  const path = parsed.pathname;
  const method = (opts.method ?? "GET").toUpperCase();

  for (const h of _handlers) {
    if (h.method === method && h.path === path) {
      if (h.match && opts.body) {
        try {
          const parsedBody = JSON.parse(opts.body as string);
          if (!h.match(parsedBody)) continue;
        } catch {
          continue;
        }
      }
      return Promise.resolve(
        new Response(JSON.stringify(h.body), {
          status: h.status,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
  }

  return Promise.resolve(
    new Response(JSON.stringify({ error: "unhandled" }), {
      status: 501,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

const MASTER_URL = "http://mock-master:9230";

describe("MasterClient", () => {
  before(() => {
    _originalFetch = global.fetch;
    global.fetch = mockFetch as unknown as typeof global.fetch;
  });

  after(() => {
    global.fetch = _originalFetch;
  });

  beforeEach(() => {
    resetHandlers();
  });

  // ------------------------------------------------------------------
  // register
  // ------------------------------------------------------------------

  it("register succeeds with valid token", async () => {
    addHandler({
      method: "POST",
      path: "/v1/workers",
      status: 201,
      body: { worker_id: "wrk_test123", worker_name: "test-worker" },
    });

    const client = new MasterClient({ masterUrl: MASTER_URL });
    const result = await client.register(
      "cown_register_valid",
      "test-worker",
      "a".repeat(64),
    );

    assert.ok(result !== null);
    assert.equal(result!.workerId, "wrk_test123");
    assert.equal(result!.workerName, "test-worker");
  });

  it("register returns null on 409 conflict", async () => {
    addHandler({
      method: "POST",
      path: "/v1/workers",
      status: 409,
      body: { error: { code: "conflict", message: "name taken", details: null } },
    });

    const client = new MasterClient({ masterUrl: MASTER_URL });
    const result = await client.register(
      "cown_register_test",
      "taken-name",
      "b".repeat(64),
    );
    assert.equal(result, null);
  });

  it("register returns null on 401 invalid token", async () => {
    addHandler({
      method: "POST",
      path: "/v1/workers",
      status: 401,
      body: { error: { code: "registration_invalid", message: "invalid", details: null } },
    });

    const client = new MasterClient({ masterUrl: MASTER_URL });
    const result = await client.register(
      "cown_register_bad",
      "bad-token",
      "c".repeat(64),
    );
    assert.equal(result, null);
  });

  it("register returns null on network error", async () => {
    const client = new MasterClient({ masterUrl: MASTER_URL });
    const result = await client.register(
      "cown_register_net",
      "net-error",
      "d".repeat(64),
    );
    assert.equal(result, null);
  });

  // ------------------------------------------------------------------
  // authenticate (challenge + session)
  // ------------------------------------------------------------------

  it("authenticate succeeds with valid signature", async () => {
    addHandler({
      method: "POST",
      path: "/v1/workers/auth/challenges",
      status: 200,
      body: { nonce: "test-nonce-abc", expires_at: "2026-01-01T00:00:00" },
    });

    addHandler({
      method: "POST",
      path: "/v1/workers/auth/sessions",
      status: 200,
      body: { status: "ok", session_token: "cown_sess_mock123" },
    });

    const client = new MasterClient({ masterUrl: MASTER_URL });
    const privateKeyHex = "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20";
    const token = await client.authenticate("wrk_test123", privateKeyHex);

    assert.ok(token !== null);
    assert.equal(token, "cown_sess_mock123");
    assert.equal(client.sessionToken, "cown_sess_mock123");
  });

  it("authenticate returns null on challenge failure", async () => {
    addHandler({
      method: "POST",
      path: "/v1/workers/auth/challenges",
      status: 404,
      body: { error: { code: "worker_not_found", message: "not found", details: null } },
    });

    const client = new MasterClient({ masterUrl: MASTER_URL });
    const token = await client.authenticate(
      "wrk_nonexistent",
      "a".repeat(64),
    );

    assert.equal(token, null);
  });

  it("authenticate returns null on session verify failure", async () => {
    addHandler({
      method: "POST",
      path: "/v1/workers/auth/challenges",
      status: 200,
      body: { nonce: "test-nonce-def", expires_at: "2026-01-01T00:00:00" },
    });

    addHandler({
      method: "POST",
      path: "/v1/workers/auth/sessions",
      status: 401,
      body: { error: { code: "signature_invalid", message: "bad sig", details: null } },
    });

    const client = new MasterClient({ masterUrl: MASTER_URL });
    const token = await client.authenticate(
      "wrk_test123",
      "a".repeat(64),
    );

    assert.equal(token, null);
  });

  // ------------------------------------------------------------------
  // reportRuntime
  // ------------------------------------------------------------------

  it("reportRuntime succeeds with valid session", async () => {
    addHandler({
      method: "PUT",
      path: "/v1/workers/wrk_runtime_test/runtime",
      status: 200,
      body: { worker_id: "wrk_runtime_test", hostname: "test-host", capabilities: [] },
      match: (body) => {
        const runtime = body as {
          capabilities?: string[];
          plugins?: Array<{ plugin_id?: string }>;
        };
        return (
          runtime.capabilities?.includes("plugin.invoke") === true &&
          runtime.plugins?.[0]?.plugin_id === "filesystem"
        );
      },
    });

    const client = new MasterClient({ masterUrl: MASTER_URL });
    client.sessionToken = "cown_sess_valid";
    const ok = await client.reportRuntime(
      "wrk_runtime_test",
      [
        {
          plugin_id: "filesystem",
          version: "1.0.0",
          kind: "mcp",
          transport: "stdio",
          enabled: true,
          status: "running",
          tools: [],
          error: "",
        },
      ],
      ["plugin.invoke"],
    );

    assert.equal(ok, true);
  });

  it("reportRuntime clears session on 401", async () => {
    addHandler({
      method: "PUT",
      path: "/v1/workers/wrk_runtime_unauth/runtime",
      status: 401,
      body: { error: { code: "unauthorized", message: "bad token", details: null } },
    });

    const client = new MasterClient({ masterUrl: MASTER_URL });
    client.sessionToken = "cown_sess_expired";
    const ok = await client.reportRuntime("wrk_runtime_unauth");

    assert.equal(ok, false);
    assert.equal(client.sessionToken, "");
  });

  it("reportRuntime returns false on 404", async () => {
    addHandler({
      method: "PUT",
      path: "/v1/workers/wrk_gone/runtime",
      status: 404,
      body: { error: { code: "worker_not_found", message: "gone", details: null } },
    });

    const client = new MasterClient({ masterUrl: MASTER_URL });
    client.sessionToken = "cown_sess_valid";
    const ok = await client.reportRuntime("wrk_gone");

    assert.equal(ok, false);
    assert.equal(client.sessionToken, "cown_sess_valid");
  });

  // ------------------------------------------------------------------
  // claimJobs
  // ------------------------------------------------------------------

  it("claimJobs returns jobs from long-poll endpoint", async () => {
    addHandler({
      method: "POST",
      path: "/v1/workers/wrk_claim_test/jobs/claim",
      status: 200,
      body: {
        jobs: [
          {
            job_type: "task",
            delivery_id: "job_0123456789abcdef01234567",
            task_id: "tsk_0123456789abcdef01234567",
            task_type: "plugin_call",
            params: { plugin_id: "demo", tool_name: "echo", arguments: {} },
            timeout_seconds: 30,
          },
        ],
      },
    });

    const client = new MasterClient({ masterUrl: MASTER_URL });
    client.sessionToken = "cown_sess_valid";
    const response = await client.claimJobs("wrk_claim_test", {
      limit: 1,
      waitSeconds: 0,
    });

    assert.ok(response);
    assert.equal(response.jobs.length, 1);
    assert.equal(response.jobs[0].job_type, "task");
    assert.equal(response.jobs[0].task_id, "tsk_0123456789abcdef01234567");
  });

  it("claimJobs clears session on 401", async () => {
    addHandler({
      method: "POST",
      path: "/v1/workers/wrk_claim_unauth/jobs/claim",
      status: 401,
      body: { error: { code: "unauthorized", message: "bad token", details: null } },
    });

    const client = new MasterClient({ masterUrl: MASTER_URL });
    client.sessionToken = "cown_sess_expired";
    const response = await client.claimJobs("wrk_claim_unauth", { waitSeconds: 0 });

    assert.equal(response, null);
    assert.equal(client.sessionToken, "");
  });

  it("classifies task result failures for durable retry", async () => {
    const report = {
      task_id: "tsk_0123456789abcdef01234567",
      delivery_id: "job_0123456789abcdef01234567",
      worker_id: "wrk_0123456789abcdef01234567",
      status: "running" as const,
      truncated: false,
    };

    addHandler({
      method: "PUT",
      path: "/v1/tasks/tsk_0123456789abcdef01234567/result",
      status: 503,
      body: { error: { code: "internal", message: "retry", details: null } },
    });
    const retryClient = new MasterClient({ masterUrl: MASTER_URL });
    retryClient.sessionToken = "cown_sess_valid";
    assert.equal(
      await retryClient.reportTaskResultOutcome(report.task_id, report),
      "retryable",
    );

    resetHandlers();
    addHandler({
      method: "PUT",
      path: "/v1/tasks/tsk_0123456789abcdef01234567/result",
      status: 400,
      body: { error: { code: "invalid_input", message: "rejected", details: null } },
    });
    const rejectedClient = new MasterClient({ masterUrl: MASTER_URL });
    rejectedClient.sessionToken = "cown_sess_valid";
    assert.equal(
      await rejectedClient.reportTaskResultOutcome(report.task_id, report),
      "rejected",
    );
  });
});
