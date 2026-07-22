import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  consumeMasterEventStream,
  normalizeMasterOrigin,
  MasterClient,
  MasterClientError,
  isSessionInvalidError,
} from "../master-client";

// ── Mock fetch ────────────────────────────────────────────────────

function mockFetch(status: number, body: unknown) {
  return vi.mocked(fetch).mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () =>
      Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
  } as Response);
}

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockReset();
});

describe("Master Client", () => {
  describe("normalizeMasterOrigin", () => {
    it("should accept a valid HTTPS URL", () => {
      const url = normalizeMasterOrigin("https://api.capown.net");
      expect(url).toBe("https://api.capown.net");
    });

    it("should accept an HTTP origin for a local Master", () => {
      expect(normalizeMasterOrigin("http://localhost:9230")).toBe(
        "http://localhost:9230",
      );
    });

    it("should accept an origin with port", () => {
      const url = normalizeMasterOrigin("https://master.example.com:7850");
      expect(url).toBe("https://master.example.com:7850");
    });

    it("should strip trailing slash", () => {
      const url = normalizeMasterOrigin("https://master.example.com/");
      expect(url).toBe("https://master.example.com");
    });

    it("should trim whitespace", () => {
      const url = normalizeMasterOrigin("  https://api.capown.net  ");
      expect(url).toBe("https://api.capown.net");
    });

    it("should reject an empty origin", () => {
      expect(() => normalizeMasterOrigin("")).toThrow(
        "Master origin is required",
      );
    });

    it("should reject URLs with unsupported protocols", () => {
      expect(() => normalizeMasterOrigin("ftp://api.capown.net")).toThrow(
        "must use HTTP or HTTPS",
      );
    });

    it("should reject an invalid URL", () => {
      expect(() => normalizeMasterOrigin("not-a-valid-url")).toThrow(
        "Invalid Master origin",
      );
    });

    it("should reject URLs containing credentials", () => {
      expect(() =>
        normalizeMasterOrigin("https://user:secret@master.example.com"),
      ).toThrow("must not include credentials");
    });

    it("should reject URLs with a path", () => {
      expect(() => normalizeMasterOrigin("https://api.capown.net/v1")).toThrow(
        "must not include a path",
      );
    });

    it("should reject URLs with /api path", () => {
      expect(() => normalizeMasterOrigin("https://api.capown.net/api")).toThrow(
        "must not include a path",
      );
    });

    it("should reject URLs with query parameters", () => {
      expect(() =>
        normalizeMasterOrigin("https://api.capown.net?foo=bar"),
      ).toThrow("must not include query parameters");
    });

    it("should reject URLs with fragment", () => {
      expect(() =>
        normalizeMasterOrigin("https://api.capown.net#section"),
      ).toThrow("must not include");
    });
  });

  describe("constructor", () => {
    it("should construct with origin only", () => {
      const client = new MasterClient({
        origin: "https://master.example.com",
      });
      expect(client).toBeInstanceOf(MasterClient);
    });

    it("should strip trailing slash from origin", () => {
      const client = new MasterClient({
        origin: "https://master.example.com/",
      });
      expect(client).toBeInstanceOf(MasterClient);
    });

    it("should accept timeout option", () => {
      const client = new MasterClient({
        origin: "https://master.example.com",
        timeoutMs: 5000,
      });
      expect(client).toBeInstanceOf(MasterClient);
    });

    it("should reject non-HTTP protocols", () => {
      expect(
        () => new MasterClient({ origin: "data:text/html,hello" }),
      ).toThrow("must use HTTP or HTTPS");
    });
  });

  describe("login", () => {
    it("should discover an uninitialized Master", async () => {
      mockFetch(200, {
        product: "capown-master",
        version: "0.1.0",
        protocol_version: "0.1.0",
        initialized: false,
        capabilities: [],
      });

      const client = new MasterClient({ origin: "http://localhost:9230" });
      await expect(client.getMeta()).resolves.toMatchObject({
        initialized: false,
        protocol_version: "0.1.0",
      });
    });

    it("should reject a non-CapOwn service", async () => {
      mockFetch(200, {
        product: "other-service",
        version: "1.0.0",
        protocol_version: "0.1.0",
        initialized: true,
        capabilities: [],
      });
      await expect(
        new MasterClient({ origin: "http://localhost:9230" }).getMeta(),
      ).rejects.toThrow("not a CapOwn Master");
    });

    it("should accept a newer protocol version", async () => {
      mockFetch(200, {
        product: "capown-master",
        version: "0.2.0",
        protocol_version: "0.2.0",
        initialized: true,
        capabilities: [],
      });
      await expect(
        new MasterClient({ origin: "http://localhost:9230" }).getMeta(),
      ).resolves.toMatchObject({ protocol_version: "0.2.0" });
    });

    it("should reject a protocol version below the minimum", async () => {
      mockFetch(200, {
        product: "capown-master",
        version: "1.0.0",
        protocol_version: "0.0.1",
        initialized: true,
        capabilities: [],
      });
      await expect(
        new MasterClient({ origin: "http://localhost:9230" }).getMeta(),
      ).rejects.toThrow("expected at least 0.1.0");
    });

    it("should parse the first-user registration response", async () => {
      mockFetch(201, {
        access_token: "cown_web_first_user_token",
        token_type: "bearer",
        expires_at: "2026-07-14T06:23:19.123456",
        user: {
          user_id: "a1b2c3d4e5f6",
          username: "admin",
          role: "admin",
        },
      });

      const client = new MasterClient({ origin: "http://localhost:9230" });
      const result = await client.registerFirstUser("admin", "password123");
      expect(result.user.userId).toBe("a1b2c3d4e5f6");
      expect(result.user.role).toBe("admin");
    });

    it("should register an invited normal user", async () => {
      mockFetch(201, {
        access_token: "cown_web_invited_user_token",
        token_type: "bearer",
        expires_at: "2026-07-20T06:23:19Z",
        user: { user_id: "user123", username: "alice", role: "user" },
      });
      const client = new MasterClient({ origin: "http://localhost:9230" });
      const result = await client.registerUser(
        "alice",
        "secret1",
        "cown_invite_123456",
      );
      expect(result.user.role).toBe("user");
      expect(fetch).toHaveBeenCalledWith(
        "http://localhost:9230/v1/auth/register",
        expect.objectContaining({
          body: JSON.stringify({
            username: "alice",
            password: "secret1",
            invitation_code: "cown_invite_123456",
          }),
        }),
      );
    });

    it("should parse the real Master login response shape", async () => {
      const realMasterResponse = {
        access_token: "cown_web_abcdef1234567890abcdef1234567890",
        token_type: "bearer",
        expires_at: "2026-07-14T06:23:19.123456",
        user: {
          user_id: "a1b2c3d4e5f6",
          username: "testuser",
          role: "user",
        },
      };

      mockFetch(200, realMasterResponse);

      const client = new MasterClient({
        origin: "https://master.example.com",
      });
      const result = await client.login("testuser", "secret");

      expect(result.accessToken).toBe(realMasterResponse.access_token);
      expect(result.tokenType).toBe("bearer");
      expect(result.expiresAt).toBeInstanceOf(Date);
      expect(result.expiresAt.toISOString()).toBe("2026-07-14T06:23:19.123Z");
      expect(result.user.userId).toBe("a1b2c3d4e5f6");
      expect(result.user.username).toBe("testuser");
      expect(result.user.role).toBe("user");
      expect(fetch).toHaveBeenCalledWith(
        "https://master.example.com/v1/auth/login",
        expect.objectContaining({ redirect: "error" }),
      );
    });

    it("should parse the admin user response shape", async () => {
      const adminResponse = {
        access_token: "cown_web_9999888877776666555544443333222211110000",
        token_type: "bearer",
        expires_at: "2026-07-14T06:30:00.000000",
        user: {
          user_id: "fedcba098765",
          username: "admin01",
          role: "admin",
        },
      };

      mockFetch(200, adminResponse);

      const client = new MasterClient({
        origin: "https://master.example.com",
      });
      const result = await client.login("admin01", "p@ssword");

      expect(result.user.role).toBe("admin");
      expect(result.user.username).toBe("admin01");
    });

    it("should reject a login with wrong shape", async () => {
      mockFetch(200, {
        token: "cown_web_abc123",
        user_id: "u123",
        username: "testuser",
        role: "user",
        expires_at: "2026-07-14T06:23:19.123456",
      });

      const client = new MasterClient({
        origin: "https://master.example.com",
      });

      await expect(client.login("testuser", "secret")).rejects.toThrow(
        "unrecognized login response",
      );
    });

    it("should reject an unexpected token type", async () => {
      mockFetch(200, {
        access_token: "cown_web_abcdef1234567890",
        token_type: "web_session",
        expires_at: "2026-07-14T06:23:19.123456",
        user: { user_id: "u123", username: "testuser", role: "user" },
      });

      const client = new MasterClient({
        origin: "https://master.example.com",
      });
      await expect(client.login("testuser", "secret")).rejects.toThrow(
        "unrecognized login response",
      );
    });

    it("should reject an unsupported role", async () => {
      mockFetch(200, {
        access_token: "cown_web_abcdef1234567890",
        token_type: "bearer",
        expires_at: "2026-07-14T06:23:19.123456",
        user: { user_id: "u123", username: "testuser", role: "owner" },
      });

      const client = new MasterClient({
        origin: "https://master.example.com",
      });
      await expect(client.login("testuser", "secret")).rejects.toThrow(
        "unrecognized login response",
      );
    });

    it("should reject login on 401", async () => {
      mockFetch(401, { detail: "Invalid credentials" });

      const client = new MasterClient({
        origin: "https://master.example.com",
      });

      const err = await client.login("bad", "creds").then(
        () => {
          throw new Error("expected rejection");
        },
        (e) => e,
      );

      expect(err).toBeInstanceOf(MasterClientError);
      expect(err).toHaveProperty("statusCode", 401);
    });
  });

  describe("listWorkers", () => {
    it("should parse a collection response of workers", async () => {
      const masterResponse = {
        items: [
          {
            worker_id: "wrk_a1b2c3d4e5f6a1b2c3d4e5f6",
            worker_name: "dev-server-01",
            owner_user_id: "usr_alice",
            owner_username: "alice",
            hostname: "dev-01.example.com",
            os: "linux",
            mode: "container",
            capabilities: ["shell", "file"],
            workspace: "/workspace",
            status: "online",
            last_heartbeat: "2026-07-13T22:00:00.000000",
            registered_at: "2026-01-15T10:00:00.000000",
            previous_worker_name: null,
            renamed_at: null,
            plugins: [],
          },
          {
            worker_id: "wrk_999988887777666655554444",
            worker_name: "build-agent-02",
            owner_user_id: "usr_bob",
            owner_username: "bob",
            hostname: "build-02.example.com",
            os: "linux",
            mode: "vm",
            capabilities: ["shell", "file", "system_info"],
            workspace: "/workspace",
            status: "offline",
            last_heartbeat: "2026-07-12T18:30:00.000000",
            registered_at: "2026-02-20T08:00:00.000000",
            previous_worker_name: null,
            renamed_at: null,
            plugins: [],
          },
        ],
        total: 2,
      };

      mockFetch(200, masterResponse);

      const client = new MasterClient({
        origin: "https://master.example.com",
      });
      const workers = await client.listWorkers("cown_web_test_token");

      expect(Array.isArray(workers)).toBe(true);
      expect(workers).toHaveLength(2);
      expect(workers[0]!.worker_id).toBe("wrk_a1b2c3d4e5f6a1b2c3d4e5f6");
      expect(workers[0]!.worker_name).toBe("dev-server-01");
      expect(workers[0]!.status).toBe("online");
      expect(workers[1]!.status).toBe("offline");
      expect(fetch).toHaveBeenCalledWith(
        "https://master.example.com/v1/workers",
        expect.anything(),
      );
    });

    it("should treat an omitted plugin snapshot as an empty list", async () => {
      mockFetch(200, {
        items: [
          {
            worker_id: "wrk_new_worker",
            worker_name: "new-worker",
            owner_user_id: "usr_alice",
            owner_username: "alice",
            hostname: "new-worker.local",
            os: "linux",
            mode: "capability",
            capabilities: [],
            workspace: "/workspace",
            status: "online",
            last_heartbeat: null,
            registered_at: "2026-07-19T00:00:00Z",
            previous_worker_name: null,
            renamed_at: null,
          },
        ],
        total: 1,
      });

      const client = new MasterClient({ origin: "https://master.example.com" });
      const workers = await client.listWorkers("cown_web_test_token");

      expect(workers[0]!.plugins).toEqual([]);
    });

    it("should reject a bare array response", async () => {
      // The new /v1 API returns a collection object, not a bare array
      mockFetch(200, [
        {
          worker_id: "wrk_000000000000000000000000",
          worker_name: "bad",
          owner_user_id: "usr_bad",
          owner_username: "bad",
          hostname: "x",
          os: "linux",
          mode: "container",
          capabilities: [],
          workspace: "/workspace",
          status: "online",
          last_heartbeat: null,
          registered_at: null,
          previous_worker_name: null,
          renamed_at: null,
          plugins: [],
        },
      ]);

      const client = new MasterClient({
        origin: "https://master.example.com",
      });

      await expect(client.listWorkers("token")).rejects.toThrow(
        "unrecognized worker list response",
      );
    });

    it("should return an empty array when no workers exist", async () => {
      mockFetch(200, { items: [], total: 0 });

      const client = new MasterClient({
        origin: "https://master.example.com",
      });
      const workers = await client.listWorkers("token");

      expect(workers).toEqual([]);
    });
  });

  describe("revokeWorker", () => {
    it("should succeed on 204 No Content", async () => {
      mockFetch(204, null);

      const client = new MasterClient({
        origin: "https://master.example.com",
      });

      await expect(
        client.revokeWorker("token", "wrk_a1b2c3d4e5f6a1b2c3d4e5f6"),
      ).resolves.toBeUndefined();
    });

    it("should reject on non-204 status", async () => {
      mockFetch(200, {
        status: "revoked",
        worker_id: "wrk_999988887777666655554444",
      });

      const client = new MasterClient({
        origin: "https://master.example.com",
      });
      await expect(
        client.revokeWorker("token", "wrk_a1b2c3d4e5f6a1b2c3d4e5f6"),
      ).rejects.toThrow("Master API returned 200");
    });
  });

  describe("credential creation", () => {
    it("should create a Worker registration and return its one-time secret", async () => {
      mockFetch(201, {
        token_id: "reg_123",
        registration_token: "cown_register_123456",
        token_prefix: "cown_register_",
        scope: "worker",
        expires_at: "2026-07-20T00:00:00Z",
        max_uses: 1,
        label: "Build worker",
        created_at: "2026-07-19T00:00:00Z",
        registration_url:
          "https://master.example.com/v1/worker-registrations/cown_register_123456",
      });

      const client = new MasterClient({ origin: "https://master.example.com" });
      const created = await client.createWorkerRegistration(
        "cown_web_test",
        "Build worker",
      );

      expect(created.registration_token).toBe("cown_register_123456");
      expect(created.registration_url).toContain("/v1/worker-registrations/");
      expect(fetch).toHaveBeenCalledWith(
        "https://master.example.com/v1/worker-registrations",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ label: "Build worker" }),
        }),
      );
    });

    it("should create a client token for Client and MCP access", async () => {
      mockFetch(201, {
        token_id: "tok_123",
        token: "cown_cli_123456",
        token_type: "client",
        token_prefix: "cown_cli_",
        label: "MCP host",
        created_at: "2026-07-19T00:00:00Z",
      });

      const client = new MasterClient({ origin: "https://master.example.com" });
      const created = await client.createClientToken(
        "cown_web_test",
        "MCP host",
      );

      expect(created.token).toBe("cown_cli_123456");
      expect(fetch).toHaveBeenCalledWith(
        "https://master.example.com/v1/tokens",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ type: "client", label: "MCP host" }),
        }),
      );
    });
  });

  describe("plugins", () => {
    it("should parse plugin snapshots and dispatch an enable task", async () => {
      mockFetch(200, [
        {
          plugin_id: "filesystem",
          version: "1.0.0",
          kind: "mcp",
          transport: "stdio",
          enabled: false,
          status: "disabled",
          tools: [],
          error: "",
        },
      ]);
      const client = new MasterClient({ origin: "https://master.example.com" });
      await expect(
        client.listWorkerPlugins("token", "wrk_test"),
      ).resolves.toHaveLength(1);

      mockFetch(202, {
        task_id: "tsk_123",
        target_worker: "wrk_test",
        task_type: "plugin_set_enabled",
        params: { plugin_id: "filesystem", enabled: true },
        status: "pending",
        timeout_seconds: 30,
        created_at: "2026-07-18T00:00:00Z",
        truncated: false,
      });
      const task = await client.setWorkerPluginEnabled(
        "token",
        "wrk_test",
        "filesystem",
        true,
      );
      expect(task.task_type).toBe("plugin_set_enabled");
      expect(fetch).toHaveBeenLastCalledWith(
        "https://master.example.com/v1/workers/wrk_test/plugins/filesystem",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ enabled: true }),
        }),
      );
    });
  });

  describe("invitations", () => {
    it("should create a one-time invitation and preserve plaintext only in the creation response", async () => {
      mockFetch(201, {
        invitation_id: "invite123",
        invitation_code: "cown_invite_123456",
        code_prefix: "cown_invite_123456",
        label: "Invite Alice",
        created_by: "admin123",
        created_at: "2026-07-19T00:00:00Z",
        expires_at: "2026-07-26T00:00:00Z",
        used_at: null,
        used_by: null,
        revoked_at: null,
        status: "active",
      });
      const client = new MasterClient({ origin: "https://master.example.com" });
      const created = await client.createInvitation("token", "Invite Alice");
      expect(created.invitation_code).toBe("cown_invite_123456");
      expect(fetch).toHaveBeenCalledWith(
        "https://master.example.com/v1/admin/invitations",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ label: "Invite Alice" }),
        }),
      );
    });
  });

  describe("listClientTokens", () => {
    it("should parse a collection response of tokens", async () => {
      const masterResponse = {
        items: [
          {
            token_id: "tok_abc123",
            token_prefix: "cown_cli_",
            label: "dev-cli-token",
            created_at: "2026-06-01T10:00:00.000000",
            expires_at: "2027-06-01T10:00:00.000000",
            last_used_at: "2026-07-13T22:00:00.000000",
            last_used_ip: "203.0.113.42",
            status: "active",
          },
        ],
        total: 1,
      };

      mockFetch(200, masterResponse);

      const client = new MasterClient({
        origin: "https://master.example.com",
      });
      const tokens = await client.listClientTokens("token");

      expect(tokens).toHaveLength(1);
      expect(tokens[0]!.token_prefix).toBe("cown_cli_");
      expect(tokens[0]!.label).toBe("dev-cli-token");
      expect(tokens[0]!.status).toBe("active");
      expect(tokens[0]!.last_used_ip).toBe("203.0.113.42");
      expect(fetch).toHaveBeenCalledWith(
        "https://master.example.com/v1/tokens?type=client",
        expect.anything(),
      );
    });

    it("should return an empty array when no tokens exist", async () => {
      mockFetch(200, { items: [], total: 0 });

      const client = new MasterClient({
        origin: "https://master.example.com",
      });
      const tokens = await client.listClientTokens("token");

      expect(tokens).toEqual([]);
    });
  });

  describe("setClientTokenStatus", () => {
    it("should update a client token status", async () => {
      mockFetch(200, {
        token_id: "tok_abc123",
        token_prefix: "cown_cli_",
        label: "dev-cli-token",
        created_at: "2026-06-01T10:00:00.000000",
        expires_at: null,
        last_used_at: null,
        last_used_ip: null,
        status: "disabled",
      });

      const client = new MasterClient({
        origin: "https://master.example.com",
      });
      const updated = await client.setClientTokenStatus(
        "token",
        "tok_abc123",
        "disabled",
      );

      expect(updated.status).toBe("disabled");
      expect(fetch).toHaveBeenCalledWith(
        "https://master.example.com/v1/tokens/tok_abc123",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ status: "disabled" }),
          headers: expect.objectContaining({
            Authorization: "Bearer token",
            "Content-Type": "application/json",
          }),
        }),
      );
    });
  });

  describe("revokeClientToken", () => {
    it("should succeed on 204 No Content", async () => {
      mockFetch(204, null);

      const client = new MasterClient({
        origin: "https://master.example.com",
      });

      await expect(
        client.revokeClientToken("token", "tok_abc123"),
      ).resolves.toBeUndefined();
    });
  });

  describe("openUserEventStream", () => {
    it("should forward Last-Event-ID and SSE headers", async () => {
      const response = {
        ok: true,
        status: 200,
        body: new ReadableStream(),
      } as Response;
      vi.mocked(fetch).mockResolvedValueOnce(response);
      const client = new MasterClient({
        origin: "https://master.example.com",
      });
      const controller = new AbortController();

      await expect(
        client.openUserEventStream(
          "cown_web_test",
          controller.signal,
          "stream-id:42",
        ),
      ).resolves.toBe(response);
      expect(fetch).toHaveBeenCalledWith(
        "https://master.example.com/v1/events",
        expect.objectContaining({
          headers: {
            Authorization: "Bearer cown_web_test",
            Accept: "text/event-stream",
            "Last-Event-ID": "stream-id:42",
          },
          redirect: "error",
          signal: controller.signal,
        }),
      );
    });

    it("should parse chunked events and ignore heartbeat comments", async () => {
      const encoder = new TextEncoder();
      const response = new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(": connected\n\n"));
            controller.enqueue(
              encoder.encode(
                'id: 42\nevent: worker.online\ndata: {"worker_id":',
              ),
            );
            controller.enqueue(encoder.encode('"wrk_test"}\n\n: ping\n\n'));
            controller.close();
          },
        }),
      );
      const events: Array<{ event: string; data: string; id?: string }> = [];

      await consumeMasterEventStream(
        response,
        (event) => events.push(event),
        new AbortController().signal,
      );

      expect(events).toEqual([
        {
          event: "worker.online",
          data: '{"worker_id":"wrk_test"}',
          id: "42",
        },
      ]);
    });

    it("should fail when the stream stays silent past the watchdog", async () => {
      const response = new Response(new ReadableStream());

      await expect(
        consumeMasterEventStream(
          response,
          () => undefined,
          new AbortController().signal,
          5,
        ),
      ).rejects.toMatchObject({ statusCode: 504 });
    });

    it("should preserve the Master error status", async () => {
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: false,
        status: 401,
      } as Response);
      const client = new MasterClient({
        origin: "https://master.example.com",
      });

      const error = await client
        .openUserEventStream("expired", new AbortController().signal)
        .then(
          () => null,
          (reason: unknown) => reason,
        );
      expect(error).toBeInstanceOf(MasterClientError);
      expect(error).toHaveProperty("statusCode", 401);
    });

    it("should distinguish a disabled session from ordinary forbidden access", async () => {
      mockFetch(403, {
        error: {
          code: "user_disabled",
          message: "user is disabled",
          details: null,
        },
      });
      const client = new MasterClient({ origin: "https://master.example.com" });
      const error = await client
        .listWorkers("disabled")
        .catch((reason) => reason);
      expect(error).toBeInstanceOf(MasterClientError);
      expect(error).toHaveProperty("errorCode", "user_disabled");
      expect(isSessionInvalidError(error)).toBe(true);
      expect(
        isSessionInvalidError(
          new MasterClientError("forbidden", 403, "forbidden"),
        ),
      ).toBe(false);
    });
  });
});
