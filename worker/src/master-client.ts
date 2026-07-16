// SPDX-License-Identifier: Apache-2.0
/// <reference types="node" />
/** HTTP client for the CapOwn Master v1 API -- enroll, challenge, session, runtime. */

import * as crypto from "node:crypto";
import { log } from "./logging.js";
import { signNonce } from "./identity.js";
import { getPlatformInfo } from "./platform.js";
import type {
  EnrollmentRegisterRequest,
  EnrollmentRegisterResponse,
  WorkerAuthChallengeResponse,
  WorkerAuthVerifyResponse,
  WorkerReconnectRequest,
  WorkerInfo,
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

export interface EnrollResult {
  workerId: string;
  workerName: string;
}

export interface SessionResult {
  sessionToken: string;
}

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
  // Enrollment
  // ------------------------------------------------------------------

  /** Register this worker with the Master via enrollment token.
   *
   * Returns ``{workerId, workerName}`` on success or null on failure.
   */
  async enroll(
    enrollmentToken: string,
    workerName: string,
    publicKeyHex: string,
  ): Promise<EnrollResult | null> {
    const platform = getPlatformInfo();
    const body: EnrollmentRegisterRequest = {
      enrollment_token: enrollmentToken,
      worker_name: workerName,
      public_key: publicKeyHex,
      hostname: platform.hostname,
      os: platform.os,
      mode: "capability",
      capabilities: [],
      workspace: "",
    };

    const url = buildUrl(this._opts.masterUrl, "/v1/workers");
    const result = await doPost<EnrollmentRegisterResponse>(url, body);

    if (result.ok) {
      log.info(
        "master: enrolled as %s (worker_id=%s)",
        result.data.worker_name,
        result.data.worker_id,
      );
      return {
        workerId: result.data.worker_id,
        workerName: result.data.worker_name,
      };
    }

    // Log error details without leaking secrets
    const status = result.status;
    const text = result.text.length > 200 ? result.text.slice(0, 200) + "..." : result.text;
    if (status === 409) {
      log.error("master: enrollment failed -- name already taken (409)");
    } else if (status === 401) {
      log.error("master: enrollment failed -- token invalid or expired (401)");
    } else {
      log.error("master: enrollment failed (%d): %s", status, text);
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
      log.error(
        "master: challenge request failed (%d): %s",
        challengeResult.status,
        challengeResult.text.slice(0, 200),
      );
      return null;
    }

    const nonce = challengeResult.data.nonce;

    // Step 2: Sign the nonce with Ed25519
    let signature: string;
    try {
      signature = signNonce(privateKeyHex, nonce);
    } catch (err) {
      log.error("master: failed to sign nonce: %s", err);
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
      log.error(
        "master: auth verify failed (%d): %s",
        sessionResult.status,
        sessionResult.text.slice(0, 200),
      );
      return null;
    }

    this._sessionToken = sessionResult.data.session_token;
    log.info("master: authenticated as %s", workerId);
    return this._sessionToken;
  }

  // ------------------------------------------------------------------
  // Runtime metadata
  // ------------------------------------------------------------------

  /** Report runtime metadata to the Master after reconnection.
   *
   * Returns true on success. On 401/403, clears the session token
   * (caller should re-authenticate).
   */
  async reportRuntime(workerId: string): Promise<boolean> {
    const platform = getPlatformInfo();
    const body: WorkerReconnectRequest = {
      hostname: platform.hostname,
      os: platform.os,
      mode: "capability",
      capabilities: [],
      workspace: "",
    };

    const url = buildUrl(
      this._opts.masterUrl,
      "/v1/workers/" + encodeURIComponent(workerId) + "/runtime",
    );
    const result = await doPut<WorkerInfo>(url, body, this._authHeaders());

    if (result.ok) {
      log.info(
        "master: reported runtime metadata (hostname=%s, mode=capability)",
        platform.hostname,
      );
      return true;
    }

    const status = result.status;
    if (status === 401 || status === 403) {
      log.warn(
        "master: session rejected during runtime report (%d), clearing session",
        status,
      );
      this._sessionToken = "";
    } else {
      log.error(
        "master: runtime report failed (%d): %s",
        status,
        result.text.slice(0, 200),
      );
    }
    return false;
  }
}
