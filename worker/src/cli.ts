#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/** CLI entry point for Worker Next -- `capown-worker` command. */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn } from "node:child_process";
import * as TOML from "toml";
import { log } from "./logging.js";
import { WorkerRunner, makeWorkerNameSlug } from "./runner.js";
import { loadConfig, writeConfigFile, type WorkerNextConfig } from "./config.js";
import {
  loadOrGenerateIdentity,
  saveIdentityIds,
  parseIdentityFile,
} from "./identity.js";
import { MasterClient } from "./master-client.js";
import { getPlatformInfo } from "./platform.js";
import {
  getWorkerProcessInfo,
  requestWorkerStop,
  startRuntimeControl,
  waitForWorkerStatus,
  workerLogPath,
  readWorkerLogTail,
  readWorkerLogTailSnapshot,
  followWorkerLog,
  type RuntimeControl,
  type WorkerProcessMode,
} from "./service.js";
import { PRODUCT_VERSION as VERSION } from "./generated/version.js";

export interface CliArgs {
  command: string;
  config?: string;
  identity?: string;
  name?: string;
  link?: string;
  foreground?: boolean;
  backgroundChild?: boolean;
  lines?: number;
  follow?: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { command: "start" };
  let commandSeen = false;
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--config" && i + 1 < argv.length) {
      args.config = argv[++i];
    } else if (a === "--identity" && i + 1 < argv.length) {
      args.identity = argv[++i];
    } else if (a === "--name" && i + 1 < argv.length) {
      args.name = argv[++i];
    } else if (a === "--lines" && i + 1 < argv.length) {
      args.lines = Number(argv[++i]);
    } else if (a === "--no-follow") {
      args.follow = false;
    } else if (a === "--foreground" || a === "-f") {
      args.foreground = true;
    } else if (a === "--background-child") {
      args.foreground = true;
      args.backgroundChild = true;
    } else if (a === "--help" || a === "-h") {
      args.command = "help";
    } else if (a === "--version" || a === "-V") {
      args.command = "version";
    } else if (!a.startsWith("-")) {
      if (!commandSeen && (a === "register" || a === "start" || a === "stop" || a === "status" || a === "logs" || a === "help" || a === "version")) {
        args.command = a;
        commandSeen = true;
      } else if (!commandSeen && a === "config") {
        args.command = a;
        commandSeen = true;
      } else if (args.command === "register" && !args.link) {
        args.link = a;
      } else if (args.command === "config") {
        args.link = a; // subcommand (e.g. "show")
      } else if (!commandSeen) {
        args.command = a;
        commandSeen = true;
      }
    }
    i++;
  }
  return args;
}

function printHelp(): void {
  const lines = [
    "capown-worker v" + VERSION,
    "",
    "Usage:",
    "  capown-worker [command] [options]",
    "",
    "Commands:",
    "  register <link> [--name <name>]  Register this worker with a Master",
    "  start                            Start the Worker in the background (default)",
    "  start --foreground               Run the Worker in the current terminal",
    "  status                           Show registration and process status",
    "  stop                             Stop the running Worker",
    "  logs [--lines <count>]            Follow Worker logs (default: last 200 lines)",
    "  config show                      Display current configuration",
    "  help                             Show this help message",
    "  version                          Show version",
    "",
    "Options:",
    "  --config <path>  Path to config TOML file",
    "  --identity <path> Path to identity TOML file",
    "  --name <name>    Worker name (for register command)",
    "  --lines <count>  Number of log lines to show",
    "  --no-follow      Show recent logs and exit",
    "  -f, --foreground Run start in the current terminal",
    "  -h, --help       Show this help message",
    "  -V, --version    Show version",
    "",
    "Environment:",
    "  CAPOWN_WORKER_NEXT_CONFIG  Config file path",
    "  CAPOWN_WORKER_CONFIG       Config file path",
    "  CAPOWN_CONFIG              Config file path (lowest priority)",
    "  CAPOWN_WORKER_IDENTITY     Identity file path",
    "",
    "Registration link format:",
    "  https://master.example.com/v1/worker-registrations/<token>",
    "",
  ];
  for (const line of lines) {
    process.stdout.write(line + "\n");
  }
}

// --------------------------------------------------------------------------
// Registration link parsing
// --------------------------------------------------------------------------

interface ParsedLink {
  masterUrl: string;
  registrationToken: string;
}

export function parseRegistrationLink(link: string): ParsedLink | string {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return "invalid URL: " + link;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return "registration link must use http:// or https://";
  }
  if (url.username || url.password || url.search || url.hash) {
    return "registration link must not contain credentials, query, or fragment";
  }

  const pathParts = url.pathname.split("/");

  if (
    pathParts.length !== 4 ||
    pathParts[0] !== "" ||
    pathParts[1] !== "v1" ||
    pathParts[2] !== "worker-registrations" ||
    !pathParts[3]
  ) {
    return "link must be in format: <master-url>/v1/worker-registrations/<token>";
  }

  const token = pathParts[3];
  if (!/^cown_register_[0-9a-f]{40}$/.test(token)) {
    return "registration token has an invalid format";
  }

  const masterUrl = url.origin.replace(/\/+$/, "");
  return { masterUrl, registrationToken: token };
}

// --------------------------------------------------------------------------
// Command handlers
// --------------------------------------------------------------------------

async function handleRegister(args: CliArgs): Promise<number> {
  if (!args.link) {
    process.stderr.write("error: registration link is required\n");
    process.stderr.write("usage: capown-worker register <link> [--name <name>]\n");
    return 1;
  }

  // Parse link
  const parsed = parseRegistrationLink(args.link);
  if (typeof parsed === "string") {
    process.stderr.write("error: " + parsed + "\n");
    return 1;
  }

  // Resolve config and identity paths
  const envConfig = process.env["CAPOWN_WORKER_NEXT_CONFIG"] ??
    process.env["CAPOWN_WORKER_CONFIG"] ??
    process.env["CAPOWN_CONFIG"];
  const configPath = args.config || envConfig || path.join(os.homedir(), ".capown", "worker", "config.toml");

  const identityPath = args.identity ||
    process.env["CAPOWN_WORKER_IDENTITY"] ||
    path.join(os.homedir(), ".capown", "worker", "identity.toml");

  const resolvedConfigPath = path.resolve(configPath);
  const resolvedIdentityPath = path.resolve(identityPath);

  // Load or generate identity (generates keypair if missing)
  const identity = loadOrGenerateIdentity(resolvedIdentityPath);

  // Determine worker name
  let workerName = args.name;
  if (!workerName) {
    try {
      const existingConfig = loadConfig({ configPath: resolvedConfigPath, identityPath: resolvedIdentityPath });
      if (existingConfig.worker_name && existingConfig.worker_name !== "my-worker-next") {
        workerName = existingConfig.worker_name;
      }
    } catch {
      // ignore
    }
  }
  if (!workerName) {
    workerName = makeWorkerNameSlug(getPlatformInfo().hostname);
  }

  process.stdout.write("Registering worker with Master at " + parsed.masterUrl + "\n");

  // Register via Master API
  const client = new MasterClient({ masterUrl: parsed.masterUrl });
  const result = await client.register(
    parsed.registrationToken,
    workerName,
    identity.publicKeyHex,
  );

  if (!result) {
    process.stderr.write("error: registration failed\n");
    return 1;
  }

  // Save worker_id and worker_name to identity
  saveIdentityIds(resolvedIdentityPath, result.workerId, result.workerName);

  // Read existing config to preserve reconnect_interval
  let existingReconnectInterval: number | undefined;
  try {
    if (fs.existsSync(resolvedConfigPath)) {
      const raw = fs.readFileSync(resolvedConfigPath, "utf-8");
      const parsedConfig = TOML.parse(raw) as Record<string, unknown>;
      const workerSection = (parsedConfig["worker"] ?? {}) as Record<string, unknown>;
      existingReconnectInterval = (workerSection["reconnect_interval"] ?? parsedConfig["reconnect_interval"]) as number | undefined;
    }
  } catch {
    // ignore
  }

  writeConfigFile(resolvedConfigPath, {
    master_url: parsed.masterUrl,
    worker_name: result.workerName,
    reconnect_interval: existingReconnectInterval ?? 5,
  });

  process.stdout.write("\n");
  process.stdout.write("Worker registered successfully!\n");
  process.stdout.write("  Worker ID:   " + result.workerId + "\n");
  process.stdout.write("  Worker Name: " + result.workerName + "\n");
  process.stdout.write("  Master URL:  " + parsed.masterUrl + "\n");
  process.stdout.write("\n");
  process.stdout.write("Next steps:\n");
  process.stdout.write("  capown-worker start\n");

  return 0;
}

async function handleStatus(args: CliArgs): Promise<number> {
  let config: WorkerNextConfig;
  try {
    config = loadConfig({ configPath: args.config, identityPath: args.identity });
  } catch (err) {
    process.stderr.write("error: failed to load config: " + err + "\n");
    return 1;
  }

  const identity = parseIdentityFile(config.identityPath);
  const hasKeys = !!(identity.privateKeyHex && identity.publicKeyHex);

  process.stdout.write("CapOwn Worker v" + VERSION + "\n");
  process.stdout.write("\n");
  process.stdout.write("Config:\n");
  process.stdout.write("  Path:        " + config.configPath + "\n");
  process.stdout.write("  Master URL:  " + config.master_url + "\n");
  process.stdout.write("  Worker Name: " + (config.worker_name || "<not set>") + "\n");
  process.stdout.write("  Identity:    " + config.identityPath + "\n");
  process.stdout.write("\n");
  process.stdout.write("Identity:\n");
  process.stdout.write("  Keys:        " + (hasKeys ? "present" : "missing") + "\n");
  process.stdout.write("  Worker ID:   " + (identity.workerId || "<not registered>") + "\n");
  process.stdout.write("  Worker Name: " + (identity.workerName || "<not set>") + "\n");
  process.stdout.write("\n");

  const processInfo = await getWorkerProcessInfo(config.configPath);
  process.stdout.write("Process:\n");
  process.stdout.write("  Status:      " + processInfo.status.toUpperCase() + "\n");
  if (processInfo.pid) process.stdout.write("  PID:         " + processInfo.pid + "\n");
  if (processInfo.mode) process.stdout.write("  Mode:        " + processInfo.mode + "\n");
  if (processInfo.startedAt) process.stdout.write("  Started:     " + processInfo.startedAt + "\n");
  process.stdout.write("  Log:         " + processInfo.logPath + "\n");
  process.stdout.write("\n");

  if (!identity.workerId) {
    process.stdout.write("Status: NOT REGISTERED\n");
    process.stdout.write("Run 'capown-worker register <link>' to register.\n");
  } else if (processInfo.status === "running") {
    process.stdout.write("Status: RUNNING\n");
    process.stdout.write("Run 'capown-worker stop' to stop.\n");
  } else if (processInfo.status === "starting") {
    process.stdout.write("Status: STARTING\n");
  } else {
    process.stdout.write("Status: STOPPED\n");
    process.stdout.write("Run 'capown-worker start' to start.\n");
  }

  return 0;
}

function resolveStartConfig(args: CliArgs): WorkerNextConfig | null {
  try {
    const config = loadConfig({ configPath: args.config, identityPath: args.identity });
    const identity = parseIdentityFile(config.identityPath);
    if (!identity.workerId) {
      process.stderr.write("error: Worker is not registered; run 'capown-worker register <link>' first\n");
      return null;
    }
    return config;
  } catch (error) {
    process.stderr.write("error: failed to load Worker configuration: " + String(error) + "\n");
    return null;
  }
}

async function runWorkerInCurrentProcess(
  config: WorkerNextConfig,
  mode: WorkerProcessMode,
): Promise<number> {
  let runner: WorkerRunner | undefined;
  let control: RuntimeControl | undefined;
  try {
    const runtimeControl = await startRuntimeControl({
      configPath: config.configPath,
      identityPath: config.identityPath,
      mode,
      onStop: () => runner?.stop(),
    });
    control = runtimeControl;
    runner = new WorkerRunner({
      configPath: config.configPath,
      identityPath: config.identityPath,
      onReady: () => runtimeControl.markRunning(),
    });
    await runner.run();
    return 0;
  } catch (error) {
    log.error("worker: fatal error: %s", error);
    return 1;
  } finally {
    await control?.close();
  }
}

async function handleStart(args: CliArgs): Promise<number> {
  const config = resolveStartConfig(args);
  if (!config) return 1;

  const existing = await getWorkerProcessInfo(config.configPath);
  if (existing.status !== "stopped") {
    process.stderr.write(
      `error: Worker is already ${existing.status}${existing.pid ? ` (PID ${existing.pid})` : ""}\n`,
    );
    return 1;
  }

  if (args.foreground) {
    return await runWorkerInCurrentProcess(
      config,
      args.backgroundChild ? "background" : "foreground",
    );
  }

  const logPath = workerLogPath(config.configPath);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const logDescriptor = fs.openSync(logPath, "a", 0o600);
  let child;
  try {
    child = spawn(
      process.execPath,
      [
        path.resolve(process.argv[1]),
        "start",
        "--background-child",
        "--config",
        config.configPath,
        "--identity",
        config.identityPath,
      ],
      {
        detached: true,
        stdio: ["ignore", logDescriptor, logDescriptor],
        windowsHide: true,
      },
    );
    child.unref();
  } catch (error) {
    process.stderr.write("error: failed to start Worker: " + String(error) + "\n");
    return 1;
  } finally {
    fs.closeSync(logDescriptor);
  }

  const processInfo = await waitForWorkerStatus(config.configPath, "running", 10_000);
  if (processInfo.status !== "running") {
    process.stderr.write(`error: Worker failed to start; check ${logPath}\n`);
    return 1;
  }

  process.stdout.write(`Worker started in the background (PID ${processInfo.pid}).\n`);
  process.stdout.write(`Log: ${processInfo.logPath}\n`);
  return 0;
}

async function handleStop(args: CliArgs): Promise<number> {
  let config: WorkerNextConfig;
  try {
    config = loadConfig({ configPath: args.config, identityPath: args.identity });
  } catch (error) {
    process.stderr.write("error: failed to load Worker configuration: " + String(error) + "\n");
    return 1;
  }

  const current = await getWorkerProcessInfo(config.configPath);
  if (current.status === "stopped") {
    process.stdout.write("Worker is not running.\n");
    return 0;
  }

  try {
    await requestWorkerStop(config.configPath);
  } catch (error) {
    process.stderr.write("error: failed to stop Worker: " + String(error) + "\n");
    return 1;
  }
  const stopped = await waitForWorkerStatus(config.configPath, "stopped", 10_000);
  if (stopped.status !== "stopped") {
    process.stderr.write("error: Worker did not stop within 10 seconds\n");
    return 1;
  }
  process.stdout.write("Worker stopped.\n");
  return 0;
}

async function handleLogs(args: CliArgs): Promise<number> {
  let config: WorkerNextConfig;
  try {
    config = loadConfig({ configPath: args.config, identityPath: args.identity });
  } catch (error) {
    process.stderr.write("error: failed to load Worker configuration: " + String(error) + "\n");
    return 1;
  }

  const lineCount = args.lines ?? 200;
  if (!Number.isInteger(lineCount) || lineCount <= 0) {
    process.stderr.write("error: --lines must be a positive integer\n");
    return 1;
  }

  const logPath = workerLogPath(config.configPath);
  try {
    if (args.follow === false) {
      if (!fs.existsSync(logPath)) {
        process.stdout.write(`No Worker log found at ${logPath}\n`);
        return 0;
      }
      process.stdout.write(readWorkerLogTail(logPath, lineCount));
      return 0;
    }

    let startPosition = 0;
    if (fs.existsSync(logPath)) {
      const snapshot = readWorkerLogTailSnapshot(logPath, lineCount);
      process.stdout.write(snapshot.text);
      startPosition = snapshot.position;
    } else {
      process.stderr.write(`Waiting for Worker log at ${logPath}...\n`);
    }

    const controller = new AbortController();
    const stopFollowing = (): void => controller.abort();
    process.once("SIGINT", stopFollowing);
    process.once("SIGTERM", stopFollowing);
    try {
      await followWorkerLog({
        logPath,
        startPosition,
        signal: controller.signal,
        onData: (chunk) => {
          process.stdout.write(chunk);
        },
      });
    } finally {
      process.off("SIGINT", stopFollowing);
      process.off("SIGTERM", stopFollowing);
    }
    return 0;
  } catch (error) {
    process.stderr.write("error: failed to read Worker log: " + String(error) + "\n");
    return 1;
  }
}

function handleConfigShow(args: CliArgs): number {
  let config: WorkerNextConfig;
  try {
    config = loadConfig({ configPath: args.config, identityPath: args.identity });
  } catch (err) {
    process.stderr.write("error: failed to load config: " + err + "\n");
    return 1;
  }

  process.stdout.write("Config path:  " + config.configPath + "\n");
  process.stdout.write("Identity:     " + config.identityPath + "\n");
  process.stdout.write("Master URL:   " + config.master_url + "\n");
  process.stdout.write("Worker Name:  " + (config.worker_name || "") + "\n");
  process.stdout.write("Reconnect:    " + config.reconnect_interval + "s\n");

  return 0;
}

// --------------------------------------------------------------------------
// Main entry point
// --------------------------------------------------------------------------

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);

  switch (args.command) {
    case "help": {
      printHelp();
      return 0;
    }
    case "version": {
      process.stdout.write("capown-worker v" + VERSION + "\n");
      return 0;
    }
    case "register": {
      return await handleRegister(args);
    }
    case "status": {
      return await handleStatus(args);
    }
    case "stop": {
      return await handleStop(args);
    }
    case "logs": {
      return await handleLogs(args);
    }
    case "config": {
      if (args.link === "show") {
        return handleConfigShow(args);
      }
      process.stderr.write("usage: capown-worker config show\n");
      return 1;
    }
    case "start": {
      return await handleStart(args);
    }
    default: {
      process.stderr.write("unknown command: " + args.command + "\n");
      return 1;
    }
  }
}

// CLI entry point
if (process.argv[1]?.endsWith("cli.js") || process.argv[1]?.endsWith("cli")) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write("fatal: " + String(err) + "\n");
      process.exit(1);
    });
}
