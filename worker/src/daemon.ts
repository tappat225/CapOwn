// SPDX-License-Identifier: Apache-2.0
/** Worker Next daemon: main loop -- auth, runtime report, SSE, reconnect. */

import { log } from "./logging.js";
import { loadConfig, type WorkerNextConfig } from "./config.js";
import {
  loadOrGenerateIdentity,
  saveIdentityIds,
  type IdentityData,
} from "./identity.js";
import { MasterClient } from "./master-client.js";
import { SSEClient } from "./sse.js";
import { getPlatformInfo } from "./platform.js";

// Backoff limits for reconnection
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;
const BACKOFF_JITTER = 0.25;
const STABLE_PING_COUNT = 4; // resets backoff after this many successful pings

export interface DaemonOptions {
  configPath?: string;
  identityPath?: string;
}

export class Daemon {
  private _abort = new AbortController();
  private _running = false;
  private _config!: WorkerNextConfig;
  private _identity!: IdentityData;
  private _client!: MasterClient;
  private _workerId = "";
  private _workerName = "";

  constructor(private readonly _opts: DaemonOptions) {}

  async run(): Promise<void> {
    this._running = true;

    // Wire up signal handlers
    const onSignal = (): void => {
      if (!this._running) return;
      log.info("daemon: signal received, shutting down...");
      this.stop();
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);

    try {
      await this._init();
      if (this._running) {
        await this._mainLoop();
      }
    } finally {
      log.info("daemon: stopped");
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    }
  }

  stop(): void {
    if (this._running) {
      this._running = false;
      this._abort.abort();
    }
  }

  // ------------------------------------------------------------------
  // Initialization
  // ------------------------------------------------------------------

  private async _init(): Promise<void> {
    // Load config
    this._config = loadConfig({
      configPath: this._opts.configPath,
      identityPath: this._opts.identityPath,
    });
    log.info(
      "daemon: config loaded (master_url=%s, identity=%s)",
      this._config.master_url,
      this._config.identityPath,
    );

    // Load or generate identity
    this._identity = loadOrGenerateIdentity(this._config.identityPath);
    this._workerId = this._identity.workerId;
    this._workerName = this._config.worker_name || makeWorkerNameSlug(
      getPlatformInfo().hostname,
    );

    log.info(
      "daemon: identity loaded (worker_id=%s, worker_name=%s)",
      this._workerId || "<not enrolled>",
      this._workerName,
    );

    // Validate: if no worker_id exists, enrollment_token is required
    if (!this._workerId && !this._config.enrollment_token) {
      throw new Error(
        "configuration error: enrollment_token is required when no worker_id "
        + "exists in identity file. Either set enrollment_token for first-time "
        + "enrollment, or provide an existing identity.",
      );
    }

    // Create master client
    this._client = new MasterClient({
      masterUrl: this._config.master_url,
    });

    const platform = getPlatformInfo();
    log.info(
      "daemon: platform (hostname=%s, os=%s, arch=%s)",
      platform.hostname,
      platform.os,
      platform.arch,
    );
  }

  // ------------------------------------------------------------------
  // Main loop
  // ------------------------------------------------------------------

  private async _mainLoop(): Promise<void> {
    let backoff = BACKOFF_BASE_MS;
    let consecutivePings = 0;

    while (this._running) {
      // Step 1: Authenticate (enroll if needed)
      if (!this._client.sessionToken) {
        const ok = await this._authenticate();
        if (!ok) {
          log.error(
            "daemon: authentication failed, will retry in %ds",
            this._config.reconnect_interval,
          );
          await this._sleep(this._config.reconnect_interval * 1000);
          continue;
        }
      }

      // Step 2: Report runtime metadata
      if (!(await this._client.reportRuntime(this._workerId))) {
        // If session was cleared (401/403), loop back to authenticate
        if (!this._client.sessionToken) continue;
        // Otherwise transient error, retry
        log.warn(
          "daemon: runtime report failed, will retry in %ds",
          this._config.reconnect_interval,
        );
        await this._sleep(this._config.reconnect_interval * 1000);
        continue;
      }

      // Step 3: Connect SSE stream
      // NOTE: backoff is NOT reset here -- it only resets after the
      // connection has remained stable for STABLE_PING_COUNT pings.
      log.info("daemon: connecting SSE stream...");

      try {
        const sseClient = new SSEClient({
          masterUrl: this._config.master_url,
          workerId: this._workerId,
          getSessionToken: () => this._client.sessionToken,
          onSessionExpired: () => {
            log.warn("daemon: SSE session expired, clearing session");
            this._client.sessionToken = "";
          },
          onHeartbeat: () => {
            consecutivePings++;
            if (consecutivePings >= STABLE_PING_COUNT) {
              backoff = BACKOFF_BASE_MS;
              consecutivePings = 0;
            }
          },
          onEvent: (_event, _data) => {},
          signal: this._abort.signal,
        });

        await sseClient.connect();
      } catch (err) {
        if (!this._running) break;
        log.error("daemon: SSE connection lost: %s", err);
      }

      // Reset ping counter on disconnect
      consecutivePings = 0;

      // Reconnect delay with exponential backoff
      if (this._running) {
        const delay = Math.min(backoff, BACKOFF_MAX_MS);
        log.info("daemon: reconnecting in %dms...", delay);
        await this._sleep(delay);
        // Increase backoff with jitter for next attempt
        backoff = Math.min(
          Math.floor(backoff * (1.5 + Math.random() * BACKOFF_JITTER * 2 - BACKOFF_JITTER)),
          BACKOFF_MAX_MS,
        );
      }
    }
  }

  // ------------------------------------------------------------------
  // Authentication
  // ------------------------------------------------------------------

  private async _authenticate(): Promise<boolean> {
    // If no worker_id, enroll first
    if (!this._workerId) {
      const result = await this._client.enroll(
        this._config.enrollment_token,
        this._workerName,
        this._identity.publicKeyHex,
      );

      if (!result) return false;

      this._workerId = result.workerId;
      this._workerName = result.workerName;

      // Persist worker_id and worker_name
      try {
        saveIdentityIds(
          this._config.identityPath,
          result.workerId,
          result.workerName,
        );
      } catch (err) {
        this._workerId = "";
        throw new Error(
          "daemon: enrollment succeeded but identity persistence failed",
          { cause: err },
        );
      }
    }

    // Now authenticate with challenge-response
    if (!this._client.sessionToken && this._workerId) {
      const token = await this._client.authenticate(
        this._workerId,
        this._identity.privateKeyHex,
      );
      return token !== null;
    }

    return !!this._client.sessionToken;
  }

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------

  private _sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this._abort.signal.removeEventListener("abort", onAbort);
        resolve();
      };
      const onAbort = (): void => {
        finish();
      };
      timer = setTimeout(finish, ms);
      this._abort.signal.addEventListener("abort", onAbort, { once: true });
      if (this._abort.signal.aborted) finish();
    });
  }
}

// --------------------------------------------------------------------------
// Worker name slug (mirrors shared/worker_name.py:make_worker_name_slug)
// --------------------------------------------------------------------------

const RESERVED_WORKER_NAMES = new Set([
  "master", "admin", "all", "none", "default", "self",
]);

const WORKER_NAME_RE = /^[a-z0-9][a-z0-9._-]{1,46}[a-z0-9]$/;

export function makeWorkerNameSlug(hostname: string): string {
  // Lowercase first, then filter
  let slug = hostname.toLowerCase();
  // Replace non-ASCII and non-alphanumeric/dot/underscore/hyphen with hyphen
  slug = slug.replace(/[^a-z0-9._-]/g, "-");
  // Collapse multiple hyphens
  slug = slug.replace(/-+/g, "-");
  // Strip leading/trailing non-alphanumeric
  slug = slug.replace(/^[^a-z0-9]+/, "").replace(/[^a-z0-9]+$/, "");
  // Fallback if empty
  if (!slug) slug = "worker";
  // Ensure length within bounds
  if (slug.length < 3) slug = slug.padEnd(3, "0");
  if (slug.length > 48) slug = slug.slice(0, 48);
  // Strip trailing non-alphanumeric again after truncation
  slug = slug.replace(/[^a-z0-9]+$/, "");
  // Check reserved names
  if (RESERVED_WORKER_NAMES.has(slug)) slug = slug + "-worker";
  // Must not start with wrk_ (reserved for worker IDs)
  if (slug.startsWith("wrk_")) slug = "n" + slug;
  return slug;
}
