// SPDX-License-Identifier: Apache-2.0
/** Worker Next daemon: main loop -- auth, runtime report, job claim, optional SSE wake. */

import { log } from "./logging.js";
import { loadConfig, type WorkerNextConfig } from "./config.js";
import {
  loadOrGenerateIdentity,
  type IdentityData,
} from "./identity.js";
import { MasterClient } from "./master-client.js";
import { SSEClient } from "./sse.js";
import { getPlatformInfo } from "./platform.js";
import { PluginManager } from "./plugins/manager.js";
import { PluginError, PluginErrorCodes } from "./plugins/errors.js";
import type { WorkerJob, PluginCallParams, PluginSetEnabledParams, TaskResultReport } from "./protocol.js";

// Backoff limits for reconnection
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;
const BACKOFF_JITTER = 0.25;
const STABLE_CLAIM_COUNT = 4;
const CLAIM_LIMIT = 1;
const CLAIM_WAIT_SECONDS = 25;

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
  private _pluginManager!: PluginManager;
  private _activeTasks = new Map<string, AbortController>();
  private _unsubscribePluginSnapshots?: () => void;
  private _claimAbort: AbortController | null = null;
  private _wakePending = false;

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
      this._unsubscribePluginSnapshots?.();
      this._unsubscribePluginSnapshots = undefined;
      if (this._pluginManager) {
        await this._pluginManager.stopPlugins().catch(() => {});
      }
      log.info("daemon: stopped");
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    }
  }

  stop(): void {
    if (this._running) {
      this._running = false;
      this._claimAbort?.abort();
      for (const active of this._activeTasks.values()) {
        active.abort();
      }
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

    this._identity = loadOrGenerateIdentity(this._config.identityPath);

    log.info(
      "daemon: identity loaded (worker_id=%s, worker_name=%s)",
      this._identity.workerId || "<none>",
      this._identity.workerName || "<none>",
    );

    if (!this._identity.workerId) {
      throw new Error(
        "daemon: no worker_id found in identity. " +
        "Use 'capown-worker register <registration-link>' first.",
      );
    }

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

    const { dirname } = await import("node:path");
    const configDir = dirname(this._config.configPath);
    this._pluginManager = new PluginManager(configDir);
    await this._pluginManager.loadPlugins();
    await this._pluginManager.startPlugins();
    log.info(
      "daemon: plugins loaded (%d plugins)",
      this._pluginManager.getPluginSnapshots().length,
    );

    this._unsubscribePluginSnapshots = this._pluginManager.onSnapshotsChanged(() => {
      if (!this._abort.signal.aborted && this._client.sessionToken && this._identity.workerId) {
        const snapshots = this._pluginManager.getPluginSnapshots();
        this._client.reportRuntime(this._identity.workerId, snapshots).catch(() => {});
      }
    });
  }

  // ------------------------------------------------------------------
  // Main loop
  // ------------------------------------------------------------------

  private async _mainLoop(): Promise<void> {
    let backoff = BACKOFF_BASE_MS;
    let consecutiveClaims = 0;

    while (this._running) {
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

      const pluginSnapshots = this._pluginManager.getPluginSnapshots();
      if (!(await this._client.reportRuntime(this._identity.workerId, pluginSnapshots))) {
        if (!this._client.sessionToken) continue;
        log.warn(
          "daemon: runtime report failed, will retry in %ds",
          this._config.reconnect_interval,
        );
        await this._sleep(this._config.reconnect_interval * 1000);
        continue;
      }

      // Optional SSE wake accelerator runs alongside the claim loop.
      const stopWake = this._startWakeStream();
      try {
        log.info("daemon: starting job claim loop...");
        while (this._running && this._client.sessionToken) {
          const waitSeconds = this._wakePending ? 0 : CLAIM_WAIT_SECONDS;
          this._wakePending = false;
          this._claimAbort = new AbortController();
          const linked = this._linkAbort(this._claimAbort, this._abort.signal);

          const response = await this._client.claimJobs(this._identity.workerId, {
            limit: CLAIM_LIMIT,
            waitSeconds,
            signal: this._claimAbort.signal,
          });
          linked.dispose();
          this._claimAbort = null;

          if (!this._running) break;
          if (!response) {
            if (!this._client.sessionToken) break;
            // Long-poll may be aborted by an SSE wake so the Worker can claim sooner.
            if (this._wakePending) continue;
            log.warn("daemon: job claim failed, will retry with backoff");
            break;
          }

          consecutiveClaims++;
          if (consecutiveClaims >= STABLE_CLAIM_COUNT) {
            backoff = BACKOFF_BASE_MS;
            consecutiveClaims = 0;
          }

          for (const job of response.jobs) {
            this._handleJob(job).catch((err) => {
              log.error("daemon: job handler error: %s", err);
            });
          }
        }
      } finally {
        stopWake();
      }

      consecutiveClaims = 0;

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

  private _startWakeStream(): () => void {
    const wakeAbort = new AbortController();
    const linked = this._linkAbort(wakeAbort, this._abort.signal);

    const run = async (): Promise<void> => {
      let reconnectDelay = BACKOFF_BASE_MS;

      while (this._running && this._client.sessionToken && !wakeAbort.signal.aborted) {
        let stable = false;
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
              stable = true;
            },
            onEvent: (event) => {
              if (event === "wake") {
                this._wakePending = true;
              }
            },
            signal: wakeAbort.signal,
          });
          await sseClient.connect();
        } catch (err) {
          if (this._running && this._client.sessionToken && !wakeAbort.signal.aborted) {
            log.warn("daemon: optional SSE wake stream closed: %s", err);
          }
        }

        if (!this._running || !this._client.sessionToken || wakeAbort.signal.aborted) {
          break;
        }

        if (stable) {
          reconnectDelay = BACKOFF_BASE_MS;
        } else {
          reconnectDelay = Math.min(
            Math.floor(reconnectDelay * (1.5 + Math.random() * BACKOFF_JITTER * 2 - BACKOFF_JITTER)),
            BACKOFF_MAX_MS,
          );
        }
        if (!(await this._sleepWithSignal(reconnectDelay, wakeAbort.signal))) {
          break;
        }
      }
    };

    void run();
    return () => {
      wakeAbort.abort();
      linked.dispose();
    };
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
  // Job handling
  // ------------------------------------------------------------------

  private async _handleJob(job: WorkerJob): Promise<void> {
    if (!this._isValidJob(job)) {
      log.error("daemon: claimed job missing required fields");
      return;
    }

    if (job.job_type === "cancel") {
      log.info("daemon: cancel job for task %s", job.task_id);
      const abort = this._activeTasks.get(job.task_id);
      if (abort) {
        abort.abort();
      }
      return;
    }

    if (job.job_type === "task") {
      if (job.task_type === "plugin_call") {
        if (this._activeTasks.has(job.task_id)) {
          log.warn("daemon: duplicate delivery ignored for active task %s", job.task_id);
          return;
        }
        const startedAt = new Date().toISOString();
        const taskAbort = new AbortController();
        this._activeTasks.set(job.task_id, taskAbort);
        try {
          const accepted = await this._reportTaskResult(job.task_id, {
            task_id: job.task_id,
            delivery_id: job.delivery_id,
            worker_id: this._identity.workerId,
            status: "running",
            started_at: startedAt,
            truncated: false,
          });
          if (!accepted) return;
          await this._handlePluginCall(
            job.task_id,
            job.params as unknown as PluginCallParams,
            job.timeout_seconds as number,
            taskAbort,
            startedAt,
            job.delivery_id,
          );
        } finally {
          this._activeTasks.delete(job.task_id);
        }
        return;
      }
      if (job.task_type === "plugin_set_enabled") {
        const startedAt = new Date().toISOString();
        const accepted = await this._reportTaskResult(job.task_id, {
          task_id: job.task_id,
          delivery_id: job.delivery_id,
          worker_id: this._identity.workerId,
          status: "running",
          started_at: startedAt,
          truncated: false,
        });
        if (!accepted) return;
        const params = job.params as unknown as PluginSetEnabledParams;
        try {
          if (typeof params.plugin_id !== "string" || typeof params.enabled !== "boolean") {
            throw new PluginError(PluginErrorCodes.PluginSchemaInvalid, "plugin state parameters are invalid");
          }
          const plugin = await this._pluginManager.setPluginEnabled(params.plugin_id, params.enabled);
          await this._client.reportRuntime(this._identity.workerId, this._pluginManager.getPluginSnapshots());
          await this._reportTaskResult(job.task_id, {
            task_id: job.task_id,
            delivery_id: job.delivery_id,
            worker_id: this._identity.workerId,
            status: "completed",
            result: { is_error: false, content: [], structured_content: plugin },
            started_at: startedAt,
            completed_at: new Date().toISOString(),
            truncated: false,
          });
        } catch (error) {
          const code = error instanceof PluginError ? error.code : PluginErrorCodes.PluginProtocolError;
          const message = error instanceof PluginError ? error.safeMessage : "failed to update plugin state";
          await this._reportTaskResult(job.task_id, {
            task_id: job.task_id,
            delivery_id: job.delivery_id,
            worker_id: this._identity.workerId,
            status: "failed",
            error: { code, message, details: null },
            started_at: startedAt,
            completed_at: new Date().toISOString(),
            truncated: false,
          });
        }
        return;
      }
      log.warn("daemon: unknown task type %s", job.task_type);
      const startedAt = new Date().toISOString();
      const accepted = await this._reportTaskResult(job.task_id, {
        task_id: job.task_id,
        delivery_id: job.delivery_id,
        worker_id: this._identity.workerId,
        status: "running",
        started_at: startedAt,
        truncated: false,
      });
      if (!accepted) return;
      await this._reportTaskResult(job.task_id, {
        task_id: job.task_id,
        delivery_id: job.delivery_id,
        worker_id: this._identity.workerId,
        status: "failed",
        error: {
          code: "invalid_input",
          message: `unsupported task type: ${job.task_type}`,
          details: null,
        },
		started_at: startedAt,
		completed_at: new Date().toISOString(),
        truncated: false,
      });
    }
  }

  private async _handlePluginCall(
    taskId: string,
    params: PluginCallParams,
    timeoutSeconds: number,
    taskAbort: AbortController,
    startedAt: string,
	deliveryId: string,
  ): Promise<void> {
    try {
      if (taskAbort.signal.aborted) {
        await this._reportCanceled(taskId, deliveryId, startedAt);
        return;
      }
      const result = await this._pluginManager.invokePlugin(
        params.plugin_id,
        params.tool_name,
        params.arguments,
        timeoutSeconds,
        taskAbort.signal,
      );

      if (taskAbort.signal.aborted) {
        await this._reportCanceled(taskId, deliveryId, startedAt);
        return;
      }

      await this._reportTaskResult(taskId, {
        task_id: taskId,
        delivery_id: deliveryId,
        worker_id: this._identity.workerId,
        status: "completed",
        result,
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        truncated: false,
      });
    } catch (err) {
      if (taskAbort.signal.aborted) {
        await this._reportCanceled(taskId, deliveryId, startedAt);
        return;
      }
      const errorCode = err instanceof PluginError ? err.code : PluginErrorCodes.PluginProtocolError;
      const message = err instanceof PluginError ? err.safeMessage : "internal error";

      await this._reportTaskResult(taskId, {
        task_id: taskId,
        delivery_id: deliveryId,
        worker_id: this._identity.workerId,
        status: err instanceof PluginError && err.code === PluginErrorCodes.PluginTimeout ? "timeout" : "failed",
        error: { code: errorCode, message, details: null },
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        truncated: false,
      });
    }
  }

  private async _reportCanceled(
    taskId: string,
    deliveryId: string,
    startedAt: string,
  ): Promise<boolean> {
    return this._reportTaskResult(taskId, {
      task_id: taskId,
      delivery_id: deliveryId,
      worker_id: this._identity.workerId,
      status: "canceled",
      error: {
        code: PluginErrorCodes.PluginCanceled,
        message: "task canceled",
        details: null,
      },
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      truncated: false,
    });
  }

  private _isValidJob(value: unknown): value is WorkerJob {
    if (!value || typeof value !== "object") return false;
    const job = value as Record<string, unknown>;
    if (typeof job.task_id !== "string" || !/^tsk_[0-9a-f]{24}$/.test(job.task_id)) {
      return false;
    }
    if (typeof job.delivery_id !== "string" || !/^job_[0-9a-f]{24}$/.test(job.delivery_id)) {
      return false;
    }
    if (job.job_type === "cancel") {
      return true;
    }
    if (job.job_type !== "task") {
      return false;
    }
    return typeof job.task_type === "string" && job.task_type.length > 0
      && !!job.params && typeof job.params === "object" && !Array.isArray(job.params)
      && typeof job.timeout_seconds === "number"
      && Number.isInteger(job.timeout_seconds)
      && job.timeout_seconds >= 1 && job.timeout_seconds <= 3600;
  }

  private async _reportTaskResult(taskId: string, report: TaskResultReport): Promise<boolean> {
    let attempt = 0;
    while (this._running && !this._abort.signal.aborted) {
      if (!this._client.sessionToken) {
        await this._sleep(250);
        continue;
      }
      const outcome = await this._client.reportTaskResultOutcome(taskId, report);
      if (outcome === "ok") return true;
      if (outcome === "rejected") {
        log.error("daemon: master rejected result for task %s", taskId);
        return false;
      }
      attempt++;
      const delay = Math.min(250 * attempt, 5_000);
      await this._sleep(delay);
    }
    return false;
  }

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------

  private _linkAbort(child: AbortController, parent: AbortSignal): { dispose: () => void } {
    if (parent.aborted) {
      child.abort();
      return { dispose: () => {} };
    }
    const onAbort = (): void => child.abort();
    parent.addEventListener("abort", onAbort, { once: true });
    return {
      dispose: () => parent.removeEventListener("abort", onAbort),
    };
  }

  private _sleepWithSignal(ms: number, signal: AbortSignal): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout;
      const finish = (completed: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        this._abort.signal.removeEventListener("abort", onAbort);
        resolve(completed);
      };
      const onAbort = (): void => finish(false);
      timer = setTimeout(() => finish(true), ms);
      signal.addEventListener("abort", onAbort, { once: true });
      this._abort.signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted || this._abort.signal.aborted) finish(false);
    });
  }

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
