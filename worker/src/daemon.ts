// SPDX-License-Identifier: Apache-2.0
/** Worker Next daemon: main loop -- auth, runtime report, SSE, reconnect. */

import { log } from "./logging.js";
import { loadConfig, type WorkerNextConfig } from "./config.js";
import {
  loadOrGenerateIdentity,
  type IdentityData,
} from "./identity.js";
import { MasterClient } from "./master-client.js";
import { SSEClient } from "./sse.js";
import { getPlatformInfo } from "./platform.js";

// Backoff limits for reconnection
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;
const BACKOFF_JITTER = 0.25;
const STABLE_PING_COUNT = 4;

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

  constructor(private readonly _opts: DaemonOptions) {}

  async run(): Promise<void> {
    this._running = true;

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

    log.info(
      "daemon: identity loaded (worker_id=%s, worker_name=%s)",
      this._identity.workerId || "<none>",
      this._identity.workerName || "<none>",
    );

    // Daemon requires an existing registration (worker_id in identity)
    if (!this._identity.workerId) {
      throw new Error(
        "daemon: no worker_id found in identity. " +
        "Use 'capown-worker register <registration-link>' first.",
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
      // Step 1: Authenticate with challenge-response
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
      if (!(await this._client.reportRuntime(this._identity.workerId))) {
        if (!this._client.sessionToken) continue;
        log.warn(
          "daemon: runtime report failed, will retry in %ds",
          this._config.reconnect_interval,
        );
        await this._sleep(this._config.reconnect_interval * 1000);
        continue;
      }

      // Step 3: Connect SSE stream
      log.info("daemon: connecting SSE stream...");

      try {
        const sseClient = new SSEClient({
          masterUrl: this._config.master_url,
          workerId: this._identity.workerId,
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

      consecutivePings = 0;

      if (this._running) {
        const delay = Math.min(backoff, BACKOFF_MAX_MS);
        log.info("daemon: reconnecting in %dms...", delay);
        await this._sleep(delay);
        backoff = Math.min(
          Math.floor(backoff * (1.5 + Math.random() * BACKOFF_JITTER * 2 - BACKOFF_JITTER)),
          BACKOFF_MAX_MS,
        );
      }
    }
  }

  // ------------------------------------------------------------------
  // Authentication (challenge-response only)
  // ------------------------------------------------------------------

  private async _authenticate(): Promise<boolean> {
    const token = await this._client.authenticate(
      this._identity.workerId,
      this._identity.privateKeyHex,
    );
    return token !== null;
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

export function makeWorkerNameSlug(hostname: string): string {
  let slug = hostname.toLowerCase();
  slug = slug.replace(/[^a-z0-9._-]/g, "-");
  slug = slug.replace(/-+/g, "-");
  slug = slug.replace(/^[^a-z0-9]+/, "").replace(/[^a-z0-9]+$/, "");
  if (!slug) slug = "worker";
  if (slug.length < 3) slug = slug.padEnd(3, "0");
  if (slug.length > 48) slug = slug.slice(0, 48);
  slug = slug.replace(/[^a-z0-9]+$/, "");
  if (RESERVED_WORKER_NAMES.has(slug)) slug = slug + "-worker";
  if (slug.startsWith("wrk_")) slug = "n" + slug;
  return slug;
}
