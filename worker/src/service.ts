// SPDX-License-Identifier: Apache-2.0
/** Local Worker process lifecycle and authenticated control channel. */

import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";

const STATE_SCHEMA_VERSION = 1;
const CONTROL_HOST = "127.0.0.1";
const CONTROL_TIMEOUT_MS = 1_000;
const STARTING_TIMEOUT_MS = 10_000;

export type WorkerProcessMode = "background" | "foreground";
export type WorkerProcessStatus = "starting" | "running" | "stopped";

interface RuntimeState {
  schema_version: number;
  instance_id: string;
  pid: number;
  started_at: string;
  status: Exclude<WorkerProcessStatus, "stopped">;
  mode: WorkerProcessMode;
  port: number;
  control_token: string;
  config_path: string;
  identity_path: string;
  log_path: string;
}

interface RuntimeLock {
  pid: number;
  created_at: string;
}

interface ControlRequest {
  token: string;
  command: "status" | "stop";
}

interface ControlResponse {
  ok: boolean;
  error?: string;
  pid?: number;
  status?: Exclude<WorkerProcessStatus, "stopped">;
  mode?: WorkerProcessMode;
  started_at?: string;
  log_path?: string;
}

export interface WorkerProcessInfo {
  status: WorkerProcessStatus;
  pid?: number;
  mode?: WorkerProcessMode;
  startedAt?: string;
  logPath: string;
}

export interface RuntimeControl {
  markRunning(): void;
  close(): Promise<void>;
}

function runtimePaths(configPath: string): {
  statePath: string;
  lockPath: string;
  logPath: string;
} {
  const directory = path.dirname(path.resolve(configPath));
  return {
    statePath: path.join(directory, "worker-runtime.json"),
    lockPath: path.join(directory, "worker-runtime.lock"),
    logPath: path.join(directory, "worker.log"),
  };
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readJSONFile<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
  } catch {
    return null;
  }
}

function readRuntimeState(statePath: string): RuntimeState | null {
  const state = readJSONFile<Partial<RuntimeState>>(statePath);
  if (
    state?.schema_version !== STATE_SCHEMA_VERSION ||
    typeof state.instance_id !== "string" ||
    !Number.isInteger(state.pid) ||
    typeof state.started_at !== "string" ||
    (state.status !== "starting" && state.status !== "running") ||
    (state.mode !== "background" && state.mode !== "foreground") ||
    !Number.isInteger(state.port) ||
    typeof state.control_token !== "string" ||
    typeof state.log_path !== "string"
  ) {
    return null;
  }
  return state as RuntimeState;
}

function removeFileBestEffort(filePath: string): void {
  try {
    fs.rmSync(filePath, { force: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "EPERM" && code !== "EACCES") throw error;
  }
}

function writeState(statePath: string, state: RuntimeState): void {
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: "utf-8",
    mode: 0o600,
  });
}

function removeStateIfCurrent(statePath: string, instanceID: string): void {
  const current = readRuntimeState(statePath);
  if (!current || current.instance_id === instanceID) {
    removeFileBestEffort(statePath);
  }
}

async function sendControlRequest(
  state: RuntimeState,
  command: ControlRequest["command"],
): Promise<ControlResponse> {
  return await new Promise<ControlResponse>((resolve, reject) => {
    const socket = net.createConnection({ host: CONTROL_HOST, port: state.port });
    let response = "";
    let settled = false;

    const finish = (error?: Error, value?: ControlResponse): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(value ?? { ok: false, error: "empty control response" });
    };

    socket.setEncoding("utf-8");
    socket.setTimeout(CONTROL_TIMEOUT_MS, () => finish(new Error("control request timed out")));
    socket.once("error", (error) => finish(error));
    socket.on("data", (chunk: string) => {
      response += chunk;
      const newline = response.indexOf("\n");
      if (newline === -1) return;
      try {
        finish(undefined, JSON.parse(response.slice(0, newline)) as ControlResponse);
      } catch {
        finish(new Error("invalid control response"));
      }
    });
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ token: state.control_token, command })}\n`);
    });
  });
}

function removeStaleRuntimeFiles(configPath: string, instanceID?: string): void {
  const { statePath, lockPath } = runtimePaths(configPath);
  if (instanceID) removeStateIfCurrent(statePath, instanceID);
  else removeFileBestEffort(statePath);
  removeFileBestEffort(lockPath);
}

export async function getWorkerProcessInfo(configPath: string): Promise<WorkerProcessInfo> {
  const resolvedConfigPath = path.resolve(configPath);
  const { statePath, lockPath, logPath } = runtimePaths(resolvedConfigPath);
  const state = readRuntimeState(statePath);

  if (state) {
    try {
      const response = await sendControlRequest(state, "status");
      if (response.ok && response.pid === state.pid) {
        return {
          status: response.status ?? state.status,
          pid: state.pid,
          mode: response.mode ?? state.mode,
          startedAt: response.started_at ?? state.started_at,
          logPath: response.log_path ?? state.log_path,
        };
      }
    } catch {
      // The authenticated control endpoint is authoritative; clean stale files.
    }
    removeStaleRuntimeFiles(resolvedConfigPath, state.instance_id);
    return { status: "stopped", logPath };
  }

  const lock = readJSONFile<RuntimeLock>(lockPath);
  if (lock && isProcessAlive(lock.pid)) {
    const age = Date.now() - Date.parse(lock.created_at);
    if (Number.isFinite(age) && age >= 0 && age < STARTING_TIMEOUT_MS) {
      return { status: "starting", pid: lock.pid, logPath };
    }
  }
  removeFileBestEffort(lockPath);
  return { status: "stopped", logPath };
}

function acquireRuntimeLock(lockPath: string): number {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const descriptor = fs.openSync(lockPath, "wx", 0o600);
      fs.writeFileSync(
        descriptor,
        `${JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() })}\n`,
      );
      return descriptor;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const lock = readJSONFile<RuntimeLock>(lockPath);
      const age = lock ? Date.now() - Date.parse(lock.created_at) : Number.POSITIVE_INFINITY;
      if (lock && isProcessAlive(lock.pid) && age >= 0 && age < STARTING_TIMEOUT_MS) {
        throw new Error(`Worker is already starting (PID ${lock.pid})`);
      }
      removeFileBestEffort(lockPath);
    }
  }
  throw new Error("Unable to acquire Worker runtime lock");
}

export async function startRuntimeControl(options: {
  configPath: string;
  identityPath: string;
  mode: WorkerProcessMode;
  onStop: () => void;
}): Promise<RuntimeControl> {
  const configPath = path.resolve(options.configPath);
  const identityPath = path.resolve(options.identityPath);
  const existing = await getWorkerProcessInfo(configPath);
  if (existing.status !== "stopped") {
    throw new Error(`Worker is already ${existing.status}${existing.pid ? ` (PID ${existing.pid})` : ""}`);
  }

  const { statePath, lockPath, logPath } = runtimePaths(configPath);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  let lockDescriptor: number | undefined;
  try {
    lockDescriptor = acquireRuntimeLock(lockPath);
  } catch (error) {
    const concurrent = await getWorkerProcessInfo(configPath);
    if (concurrent.status !== "stopped") {
      throw new Error(`Worker is already ${concurrent.status}${concurrent.pid ? ` (PID ${concurrent.pid})` : ""}`);
    }
    throw error;
  }
  const instanceID = randomBytes(16).toString("hex");
  const controlToken = randomBytes(32).toString("hex");
  const startedAt = new Date().toISOString();
  let currentStatus: RuntimeState["status"] = "starting";
  let closed = false;

  const server = net.createServer((socket) => {
    socket.setEncoding("utf-8");
    let requestText = "";
    socket.on("data", (chunk: string) => {
      requestText += chunk;
      const newline = requestText.indexOf("\n");
      if (newline === -1) return;

      let request: Partial<ControlRequest>;
      try {
        request = JSON.parse(requestText.slice(0, newline)) as Partial<ControlRequest>;
      } catch {
        socket.end(`${JSON.stringify({ ok: false, error: "invalid request" })}\n`);
        return;
      }

      if (request.token !== controlToken) {
        socket.end(`${JSON.stringify({ ok: false, error: "unauthorized" })}\n`);
        return;
      }

      const response: ControlResponse = {
        ok: true,
        pid: process.pid,
        status: currentStatus,
        mode: options.mode,
        started_at: startedAt,
        log_path: logPath,
      };
      if (request.command === "status") {
        socket.end(`${JSON.stringify(response)}\n`);
      } else if (request.command === "stop") {
        socket.end(`${JSON.stringify(response)}\n`, () => setImmediate(options.onStop));
      } else {
        socket.end(`${JSON.stringify({ ok: false, error: "unknown command" })}\n`);
      }
    });
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, CONTROL_HOST, () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Unable to bind Worker control endpoint");

    const makeState = (): RuntimeState => ({
      schema_version: STATE_SCHEMA_VERSION,
      instance_id: instanceID,
      pid: process.pid,
      started_at: startedAt,
      status: currentStatus,
      mode: options.mode,
      port: address.port,
      control_token: controlToken,
      config_path: configPath,
      identity_path: identityPath,
      log_path: logPath,
    });
    writeState(statePath, makeState());

    return {
      markRunning(): void {
        if (closed) return;
        currentStatus = "running";
        writeState(statePath, makeState());
      },
      async close(): Promise<void> {
        if (closed) return;
        closed = true;
        await new Promise<void>((resolve) => server.close(() => resolve()));
        removeStateIfCurrent(statePath, instanceID);
        fs.closeSync(lockDescriptor);
        removeFileBestEffort(lockPath);
      },
    };
  } catch (error) {
    server.close();
    fs.closeSync(lockDescriptor);
    removeStaleRuntimeFiles(configPath, instanceID);
    throw error;
  }
}

export async function requestWorkerStop(configPath: string): Promise<WorkerProcessInfo> {
  const resolvedConfigPath = path.resolve(configPath);
  const { statePath, logPath } = runtimePaths(resolvedConfigPath);
  const state = readRuntimeState(statePath);
  if (!state) {
    removeStaleRuntimeFiles(resolvedConfigPath);
    return { status: "stopped", logPath };
  }

  try {
    const response = await sendControlRequest(state, "stop");
    if (!response.ok) throw new Error(response.error ?? "stop request rejected");
    return {
      status: response.status ?? state.status,
      pid: state.pid,
      mode: response.mode ?? state.mode,
      startedAt: response.started_at ?? state.started_at,
      logPath: response.log_path ?? state.log_path,
    };
  } catch (error) {
    removeStaleRuntimeFiles(resolvedConfigPath, state.instance_id);
    if (!isProcessAlive(state.pid)) return { status: "stopped", logPath };
    throw error;
  }
}

export async function waitForWorkerStatus(
  configPath: string,
  expected: WorkerProcessStatus,
  timeoutMs: number,
): Promise<WorkerProcessInfo> {
  const deadline = Date.now() + timeoutMs;
  let current = await getWorkerProcessInfo(configPath);
  while (current.status !== expected && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    current = await getWorkerProcessInfo(configPath);
  }
  return current;
}

export function workerLogPath(configPath: string): string {
  return runtimePaths(configPath).logPath;
}

export interface WorkerLogSnapshot {
  text: string;
  position: number;
}

export function readWorkerLogTailSnapshot(
  logPath: string,
  lineCount: number,
): WorkerLogSnapshot {
  if (!Number.isInteger(lineCount) || lineCount <= 0) {
    throw new Error("line count must be a positive integer");
  }

  const descriptor = fs.openSync(logPath, "r");
  try {
    const size = fs.fstatSync(descriptor).size;
    if (size === 0) return { text: "", position: 0 };

    const chunks: Buffer[] = [];
    const blockSize = 64 * 1024;
    let position = size;
    let newlines = 0;

    while (position > 0 && newlines <= lineCount) {
      const length = Math.min(blockSize, position);
      position -= length;
      const buffer = Buffer.allocUnsafe(length);
      fs.readSync(descriptor, buffer, 0, length, position);
      chunks.unshift(buffer);
      for (const byte of buffer) {
        if (byte === 0x0a) newlines++;
      }
    }

    const text = Buffer.concat(chunks).toString("utf-8");
    const lines = text.split(/\r?\n/);
    if (lines.at(-1) === "") lines.pop();
    return {
      text: lines.slice(-lineCount).join("\n") + (lines.length > 0 ? "\n" : ""),
      position: size,
    };
  } finally {
    fs.closeSync(descriptor);
  }
}

export function readWorkerLogTail(logPath: string, lineCount: number): string {
  return readWorkerLogTailSnapshot(logPath, lineCount).text;
}

function logFileIdentity(stats: fs.Stats): string {
  return `${stats.dev}:${stats.ino}:${stats.birthtimeMs}`;
}

export async function followWorkerLog(options: {
  logPath: string;
  startPosition: number;
  signal: AbortSignal;
  onData: (chunk: string) => void | Promise<void>;
  pollIntervalMs?: number;
}): Promise<void> {
  let position = Math.max(0, options.startPosition);
  let identity: string | undefined;
  const pollInterval = options.pollIntervalMs ?? 250;

  while (!options.signal.aborted) {
    let stats: fs.Stats;
    try {
      stats = fs.statSync(options.logPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      position = 0;
      identity = undefined;
      await waitForLogPoll(options.signal, pollInterval);
      continue;
    }

    const currentIdentity = logFileIdentity(stats);
    if (identity === undefined) {
      identity = currentIdentity;
    } else if (identity !== currentIdentity) {
      identity = currentIdentity;
      position = 0;
    }
    if (stats.size < position) position = 0;

    if (stats.size > position) {
      const descriptor = fs.openSync(options.logPath, "r");
      try {
        while (position < stats.size && !options.signal.aborted) {
          const length = Math.min(64 * 1024, stats.size - position);
          const buffer = Buffer.allocUnsafe(length);
          const bytesRead = fs.readSync(descriptor, buffer, 0, length, position);
          if (bytesRead === 0) break;
          position += bytesRead;
          await options.onData(buffer.subarray(0, bytesRead).toString("utf-8"));
        }
      } finally {
        fs.closeSync(descriptor);
      }
      continue;
    }

    await waitForLogPoll(options.signal, pollInterval);
  }
}

async function waitForLogPoll(signal: AbortSignal, delayMs: number): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(done, delayMs);
    const onAbort = (): void => done();
    function done(): void {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      resolve();
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
