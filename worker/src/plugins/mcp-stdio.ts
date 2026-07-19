// SPDX-License-Identifier: Apache-2.0

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";
import type { PluginManifest, PluginToolInfo, McpJsonRpcRequest, McpJsonRpcResponse, McpTool, McpCallToolResult, PluginInfo, PluginStatus } from "./types.js";
import { PluginError, PluginErrorCodes } from "./errors.js";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  abortHandler?: () => void;
}

export interface McpAdapterEvents {
  statusChanged: (status: PluginStatus, error?: string) => void;
}

export declare interface McpStdioAdapter {
  on<U extends keyof McpAdapterEvents>(event: U, listener: McpAdapterEvents[U]): this;
  emit<U extends keyof McpAdapterEvents>(event: U, ...args: Parameters<McpAdapterEvents[U]>): boolean;
}

export class McpStdioAdapter extends EventEmitter {
  private proc: ChildProcess | null = null;
  private rl: ReturnType<typeof createInterface> | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private _status: PluginStatus = "stopped";
  private _tools: PluginToolInfo[] = [];
  private _error = "";
  private activeCalls = 0;
  private stopping = false;

  private initTimeout: ReturnType<typeof setTimeout> | null = null;
  private manifest: PluginManifest;

  constructor(manifest: PluginManifest) {
    super();
    this.manifest = manifest;
  }

  get status(): PluginStatus {
    if (!this.manifest.enabled) return "disabled";
    return this._status;
  }

  get tools(): PluginToolInfo[] {
    return this._tools;
  }

  get pluginId(): string {
    return this.manifest.plugin_id;
  }

  get isHealthy(): boolean {
    return this._status === "running";
  }

  async start(): Promise<void> {
    if (!this.manifest.enabled) {
      this._status = "disabled";
      return;
    }

    this._status = "starting";
    this.stopping = false;
    this.emit("statusChanged", "starting");

    const [cmd, ...args] = this.manifest.command;
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (!key.startsWith("CAPOWN_")) env[key] = value;
    }
    Object.assign(env, this.manifest.env);

    this.proc = spawn(cmd, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env,
      shell: false,
    });

    if (this.proc.stderr) {
      // Drain stderr without retaining or logging potentially sensitive output.
      this.proc.stderr.resume();
    }

    if (this.proc.stdout) {
      this.rl = createInterface({ input: this.proc.stdout, crlfDelay: Infinity });
      this.rl.on("line", (line: string) => this.handleLine(line));
    }

    this.proc.on("exit", (code, signal) => {
      this.handleExit(code, signal);
    });

    this.proc.on("error", () => {
      this.setError("plugin process failed to start");
    });

    try {
      await this.sendRequest("initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "capown-worker", version: "0.1.0" },
      }, this.manifest.limits?.startup_timeout_seconds ?? 15);

      this.sendNotification("notifications/initialized", {});

      const toolsResult = await this.sendRequest("tools/list", {},
        this.manifest.limits?.startup_timeout_seconds ?? 15);

      this._tools = this.parseTools(toolsResult);
      this._status = "running";
      this._error = "";
      this.emit("statusChanged", "running");
    } catch {
      this.setError("plugin initialization failed");
      this.kill();
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.kill();
    this._status = "stopped";
    this._error = "";
    this.emit("statusChanged", "stopped");
  }

  async invoke(
    toolName: string,
    args: Record<string, unknown>,
    timeoutSeconds?: number,
    signal?: AbortSignal,
  ): Promise<McpCallToolResult> {
    if (this._status !== "running") {
      throw new PluginError(PluginErrorCodes.PluginUnavailable, `plugin ${this.pluginId} is not running`);
    }

    const maxConcurrency = this.manifest.limits?.max_concurrency ?? 4;
    if (this.activeCalls >= maxConcurrency) {
      throw new PluginError(PluginErrorCodes.PluginConcurrencyExceeded,
        `plugin ${this.pluginId} concurrency limit (${maxConcurrency}) reached`);
    }

    const tool = this._tools.find((t) => t.name === toolName);
    if (!tool) {
      throw new PluginError(PluginErrorCodes.PluginToolNotFound,
        `tool "${toolName}" not found in plugin ${this.pluginId}`);
    }

    const configuredTimeout = this.manifest.limits?.call_timeout_seconds ?? 60;
    const timeout = Math.min(timeoutSeconds ?? configuredTimeout, configuredTimeout);
    const maxArgumentBytes = this.manifest.limits?.max_argument_bytes ?? 200_000;
    const maxOutputBytes = this.manifest.limits?.max_output_bytes ?? 200_000;

    // Enforce max_argument_bytes
    const argsSerialized = JSON.stringify(args);
    if (Buffer.byteLength(argsSerialized, "utf-8") > maxArgumentBytes) {
      throw new PluginError(PluginErrorCodes.PluginSchemaInvalid,
        `arguments exceed ${maxArgumentBytes} bytes`);
    }

    this.activeCalls++;
    try {
      const result = await this.sendRequest("tools/call", {
        name: toolName,
        arguments: args,
      }, timeout, signal) as McpCallToolResult;

      // Check output size (UTF-8 byte length)
      const serialized = JSON.stringify(result);
      if (Buffer.byteLength(serialized, "utf-8") > maxOutputBytes) {
        throw new PluginError(PluginErrorCodes.PluginOutputTooLarge,
          `plugin ${this.pluginId} output exceeds ${maxOutputBytes} bytes`);
      }

      return result;
    } catch (err) {
      if (err instanceof PluginError) throw err;
      throw new PluginError(PluginErrorCodes.PluginProtocolError,
        `invocation failed: ${(err as Error).message}`);
    } finally {
      this.activeCalls--;
    }
  }

  getInfo(): PluginInfo {
    return {
      plugin_id: this.manifest.plugin_id,
      version: this.manifest.version,
      kind: this.manifest.kind,
      transport: this.manifest.transport,
      enabled: this.manifest.enabled,
      status: this.status,
      tools: this._tools,
      error: this._error,
    };
  }

  private async sendRequest(
    method: string,
    params: Record<string, unknown>,
    timeoutSeconds: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      const id = this.nextId++;
      const request: McpJsonRpcRequest = {
        jsonrpc: "2.0",
        id,
        method,
        params,
      };

      const timer = setTimeout(() => {
        const pending = this.pending.get(id);
        this.removePending(id, pending);
        try {
          this.sendNotification("notifications/cancelled", {
            requestId: id,
            reason: "request timed out",
          });
        } catch {
          // The process may already have exited.
        }
        reject(new PluginError(PluginErrorCodes.PluginTimeout,
          `MCP request "${method}" timed out after ${timeoutSeconds}s`));
      }, timeoutSeconds * 1000);

      const pending: PendingRequest = { resolve, reject, timer, signal };
      if (signal) {
        pending.abortHandler = () => {
          this.removePending(id, pending);
          try {
            this.sendNotification("notifications/cancelled", {
              requestId: id,
              reason: "task canceled",
            });
          } catch {
            // The process may already have exited.
          }
          reject(new PluginError(PluginErrorCodes.PluginCanceled,
            `MCP request "${method}" was canceled`));
        };
        signal.addEventListener("abort", pending.abortHandler, { once: true });
      }
      this.pending.set(id, pending);

      if (signal?.aborted) {
        pending.abortHandler?.();
        return;
      }

      try {
        this.writeLine(JSON.stringify(request));
      } catch (err) {
        this.removePending(id, pending);
        reject(new PluginError(PluginErrorCodes.PluginProtocolError,
          `failed to write request: ${(err as Error).message}`));
      }
    });
  }

  private sendNotification(method: string, params: Record<string, unknown>): void {
    this.writeLine(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  private removePending(id: number, pending?: PendingRequest): void {
    this.pending.delete(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    if (pending.signal && pending.abortHandler) {
      pending.signal.removeEventListener("abort", pending.abortHandler);
    }
  }

  private writeLine(line: string): void {
    if (!this.proc?.stdin) {
      throw new Error("plugin process not running");
    }
    this.proc.stdin.write(line + "\n");
  }

  private handleLine(line: string): void {
    const maxOutputBytes = this.manifest.limits?.max_output_bytes ?? 200_000;
    if (Buffer.byteLength(line, "utf-8") > maxOutputBytes) {
      for (const [id, pending] of this.pending) {
        this.removePending(id, pending);
        pending.reject(new PluginError(PluginErrorCodes.PluginOutputTooLarge,
          `plugin ${this.pluginId} output exceeds ${maxOutputBytes} bytes`));
      }
      this.setError("plugin output exceeded its configured limit");
      this.kill();
      return;
    }

    let response: McpJsonRpcResponse;
    try {
      response = JSON.parse(line);
    } catch {
      return;
    }

    if (typeof response.id !== "number") return;

    const pending = this.pending.get(response.id);
    if (!pending) return;

    this.removePending(response.id, pending);

    if (response.jsonrpc !== "2.0") {
      pending.reject(new PluginError(PluginErrorCodes.PluginProtocolError,
        "MCP response has an invalid jsonrpc version",
        "plugin returned an invalid protocol response"));
      return;
    }

    if (response.error) {
      pending.reject(new PluginError(PluginErrorCodes.PluginProtocolError,
        `MCP error: ${response.error.message}`, "plugin returned an MCP error"));
    } else {
      pending.resolve(response.result);
    }
  }

  private handleExit(code: number | null, signal: string | null): void {
    for (const [id, pending] of this.pending) {
      this.removePending(id, pending);
      pending.reject(new PluginError(PluginErrorCodes.PluginUnavailable,
        "plugin process exited"));
    }
    this.pending.clear();
    this.rl?.close();
    this.rl = null;
    this.proc = null;

    if (this.stopping) {
      this._status = "stopped";
      this._error = "";
      return;
    }

    const reason = signal
      ? `killed by signal ${signal}`
      : `exited with code ${code}`;
    this.setError(reason);
  }

  private setError(msg: string): void {
    this._status = "error";
    this._error = msg;
    this.emit("statusChanged", "error", msg);
  }

  private parseTools(result: unknown): PluginToolInfo[] {
    if (!result || typeof result !== "object") return [];
    const tools = (result as Record<string, unknown>).tools;
    if (!Array.isArray(tools)) return [];

    return tools.map((value: unknown) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new PluginError(PluginErrorCodes.PluginProtocolError,
          "tools/list returned an invalid tool");
      }
      const tool = value as McpTool;
      if (typeof tool.name !== "string" || tool.name.length === 0
        || (tool.description !== undefined && typeof tool.description !== "string")
        || (tool.inputSchema !== undefined
          && (!tool.inputSchema || typeof tool.inputSchema !== "object" || Array.isArray(tool.inputSchema)))) {
        throw new PluginError(PluginErrorCodes.PluginProtocolError,
          "tools/list returned invalid tool metadata");
      }
      return {
        name: tool.name,
        description: tool.description ?? "",
        input_schema: tool.inputSchema ?? {},
      };
    });
  }

  private kill(): void {
    if (this.initTimeout) {
      clearTimeout(this.initTimeout);
      this.initTimeout = null;
    }

    for (const [id, pending] of this.pending) {
      this.removePending(id, pending);
      pending.reject(new PluginError(PluginErrorCodes.PluginCanceled,
        "plugin session terminated"));
    }
    this.pending.clear();
    this.rl?.close();
    this.rl = null;

    if (this.proc) {
      const proc = this.proc;
      proc.kill("SIGTERM");
      setTimeout(() => {
        if (proc.exitCode === null && proc.signalCode === null) {
          try { proc.kill("SIGKILL"); } catch { /* ignore */ }
        }
      }, 5000);
      this.proc = null;
    }
  }
}
