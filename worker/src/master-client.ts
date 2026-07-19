// SPDX-License-Identifier: Apache-2.0
/// <reference types="node" />
/** HTTP client for the CapOwn Master v1 API -- register, challenge, session, runtime. */

import { signNonce } from "./identity.js";
import { getPlatformInfo } from "./platform.js";
import type {
  WorkerRegistrationRequest,
  WorkerRegistrationResponse,
  WorkerAuthChallengeResponse,
  WorkerAuthVerifyResponse,
  WorkerReconnectRequest,
  WorkerInfo,
  PluginInfoItem,
  TaskResultReport,
  WorkerJobsResponse,
} from "./protocol.js";

// --------------------------------------------------------------------------
// URL construction
// --------------------------------------------------------------------------

function buildUrl(masterOrigin: string, path: string): string {
  // Strip any trailing slash from origin
  const base = masterOrigin.replace(/\/+$/, "");
  // Ensure path starts with /
  const p = path.startsWith("/") ? path : "/" + path;
  return base + p;
}

// --------------------------------------------------------------------------
// HTTP helpers
// --------------------------------------------------------------------------

const REQUEST_TIMEOUT_MS = 15_000; // 15 seconds

async function doPost<T>(
  url: string,
  body: unknown,
  headers?: Record<string, string>,
): Promise<{ ok: true; data: T } | { ok: false; status: number; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await resp.text();
    if (!resp.ok) {
      return { ok: false, status: resp.status, text };
    }
    return { ok: true, data: JSON.parse(text) as T };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      text: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function doPut<T>(
  url: string,
  body: unknown,
  headers?: Record<string, string>,
): Promise<{ ok: true; data: T } | { ok: false; status: number; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const resp = await fetch(url, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await resp.text();
    if (!resp.ok) {
      return { ok: false, status: resp.status, text };
    }
    return { ok: true, data: JSON.parse(text) as T };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      text: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

// --------------------------------------------------------------------------
// MasterClient
// --------------------------------------------------------------------------

export interface MasterClientOptions {
  masterUrl: string;
}

export interface RegisterResult {
  workerId: string;
  workerName: string;
}

export type TaskResultReportOutcome = "ok" | "retryable" | "rejected";

export class MasterClient {
  private _sessionToken = "";

  constructor(private readonly _opts: MasterClientOptions) {}

  get sessionToken(): string {
    return this._sessionToken;
  }

  set sessionToken(val: string) {
    this._sessionToken = val;
  }

  /** Bearer auth header if we have a session token. */
  private _authHeaders(): Record<string, string> {
    if (this._sessionToken) {
      return { Authorization: "Bearer " + this._sessionToken };
    }
    return {};
  }

  // ------------------------------------------------------------------
  // Registration
  // ------------------------------------------------------------------

  /** Register this worker with the Master via registration token.
   *
   * Returns ``{workerId, workerName}`` on success or null on failure.
   */
  async register(
    registrationToken: string,
    workerName: string,
    publicKeyHex: string,
  ): Promise<RegisterResult | null> {
    const platform = getPlatformInfo();
    const body: WorkerRegistrationRequest = {
      registration_token: registrationToken,
      worker_name: workerName,
      public_key: publicKeyHex,
      hostname: platform.hostname,
      os: platform.os,
      mode: "capability",
      capabilities: [],
      workspace: "",
    };

    const url = buildUrl(this._opts.masterUrl, "/v1/workers");
    const result = await doPost<WorkerRegistrationResponse>(url, body);

    if (result.ok) {
      return {
        workerId: result.data.worker_id,
        workerName: result.data.worker_name,
      };
    }

    return null;
  }

  // ------------------------------------------------------------------
  // Challenge-response auth
  // ------------------------------------------------------------------

  /** Perform Ed25519 challenge-response authentication.
   *
   * Returns the session token on success or null on failure.
   * Stores the session token internally.
   */
  async authenticate(
    workerId: string,
    privateKeyHex: string,
  ): Promise<string | null> {
    // Step 1: Request challenge nonce
    const challengeUrl = buildUrl(
      this._opts.masterUrl,
      "/v1/workers/auth/challenges",
    );
    const challengeResult = await doPost<WorkerAuthChallengeResponse>(
      challengeUrl,
      { worker_id: workerId },
    );

    if (!challengeResult.ok) {
      return null;
    }

    const nonce = challengeResult.data.nonce;

    // Step 2: Sign the nonce with Ed25519
    let signature: string;
    try {
      signature = signNonce(privateKeyHex, nonce);
    } catch {
      return null;
    }

    // Step 3: Verify signature and get session token
    const sessionUrl = buildUrl(
      this._opts.masterUrl,
      "/v1/workers/auth/sessions",
    );
    const sessionResult = await doPost<WorkerAuthVerifyResponse>(
      sessionUrl,
      {
        worker_id: workerId,
        nonce,
        signature,
      },
    );

    if (!sessionResult.ok) {
      return null;
    }

    this._sessionToken = sessionResult.data.session_token;
    return this._sessionToken;
  }

  // ------------------------------------------------------------------
  // Runtime metadata
  // ------------------------------------------------------------------

  /** Report runtime metadata and refresh the Worker's liveness heartbeat.
   *
   * Returns true on success. On 401/403, clears the session token
   * (caller should re-authenticate).
   */
  async reportRuntime(workerId: string, plugins: PluginInfoItem[] = []): Promise<boolean> {
    const platform = getPlatformInfo();
    const body: WorkerReconnectRequest = {
      hostname: platform.hostname,
      os: platform.os,
      mode: "capability",
      capabilities: [],
      workspace: "",
      plugins,
    };

    const url = buildUrl(
      this._opts.masterUrl,
      "/v1/workers/" + encodeURIComponent(workerId) + "/runtime",
    );
    const result = await doPut<WorkerInfo>(url, body, this._authHeaders());

    if (result.ok) {
      return true;
    }

    const status = result.status;
    if (status === 401 || status === 403) {
      this._sessionToken = "";
    }
    return false;
  }

  // ------------------------------------------------------------------
  // Job claim (long-poll)
  // ------------------------------------------------------------------

  /** Claim jobs for this worker. Supports long-poll via waitSeconds. */
  async claimJobs(
    workerId: string,
    options: { limit?: number; waitSeconds?: number; signal?: AbortSignal } = {},
  ): Promise<WorkerJobsResponse | null> {
    const limit = options.limit ?? 1;
    const waitSeconds = options.waitSeconds ?? 25;
    const url = buildUrl(
      this._opts.masterUrl,
      "/v1/workers/" + encodeURIComponent(workerId) +
        "/jobs/claim?limit=" + encodeURIComponent(String(limit)) +
        "&wait_seconds=" + encodeURIComponent(String(waitSeconds)),
    );

    // Long-poll needs a timeout longer than wait_seconds.
    const timeoutMs = Math.max(REQUEST_TIMEOUT_MS, (waitSeconds + 10) * 1000);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onOuterAbort = (): void => controller.abort();
    if (options.signal) {
      if (options.signal.aborted) {
        clearTimeout(timer);
        return null;
      }
      options.signal.addEventListener("abort", onOuterAbort, { once: true });
    }

    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "Cache-Control": "no-store",
          Accept: "application/json",
          ...this._authHeaders(),
        },
        signal: controller.signal,
      });
      const text = await resp.text();
      if (!resp.ok) {
        if (resp.status === 401 || resp.status === 403) {
          this._sessionToken = "";
        }
        return null;
      }
      return JSON.parse(text) as WorkerJobsResponse;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onOuterAbort);
    }
  }

  // ------------------------------------------------------------------
  // Task result
  // ------------------------------------------------------------------

  /** Report a task result back to the Master.
   *
   * Returns true on success.
   */
  async reportTaskResult(taskId: string, report: TaskResultReport): Promise<boolean> {
    return (await this.reportTaskResultOutcome(taskId, report)) === "ok";
  }

  /** Report a task result and classify failures for durable retry handling. */
  async reportTaskResultOutcome(
    taskId: string,
    report: TaskResultReport,
  ): Promise<TaskResultReportOutcome> {
    const url = buildUrl(
      this._opts.masterUrl,
      "/v1/tasks/" + encodeURIComponent(taskId) + "/result",
    );
    const result = await doPut<{ status: string }>(url, report, this._authHeaders());
    if (result.ok) {
      return "ok";
    }
    if (result.status === 401 || result.status === 403) {
      this._sessionToken = "";
      return "retryable";
    }
    if (result.status === 0 || result.status === 408 || result.status === 425 ||
        result.status === 429 || result.status >= 500) {
      return "retryable";
    }
    return "rejected";
  }
}
