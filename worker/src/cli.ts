// SPDX-License-Identifier: Apache-2.0
/** CLI entry point for Worker Next -- `capown-worker` command. */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as TOML from "toml";
import { log } from "./logging.js";
import { Daemon, makeWorkerNameSlug } from "./daemon.js";
import { loadConfig, writeConfigFile, type WorkerNextConfig } from "./config.js";
import {
  loadOrGenerateIdentity,
  saveIdentityIds,
  parseIdentityFile,
} from "./identity.js";
import { MasterClient } from "./master-client.js";
import { getPlatformInfo } from "./platform.js";

const VERSION = "0.1.0";

interface CliArgs {
  command: string;
  config?: string;
  identity?: string;
  name?: string;
  link?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { command: "daemon" };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--config" && i + 1 < argv.length) {
      args.config = argv[++i];
    } else if (a === "--identity" && i + 1 < argv.length) {
      args.identity = argv[++i];
    } else if (a === "--name" && i + 1 < argv.length) {
      args.name = argv[++i];
    } else if (a === "--help" || a === "-h") {
      args.command = "help";
    } else if (a === "--version" || a === "-V") {
      args.command = "version";
    } else if (!a.startsWith("-")) {
      if (a === "register" || a === "daemon" || a === "status" || a === "help" || a === "version") {
        args.command = a;
      } else if (a === "config") {
        args.command = a;
      } else if (args.command === "daemon") {
        args.command = "register";
        args.link = a;
      } else if (args.command === "register" && !args.link) {
        args.link = a;
      } else if (args.command === "config") {
        args.link = a; // subcommand (e.g. "show")
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
    "  daemon                           Start the Worker Next daemon (default)",
    "  status                           Show worker status and configuration",
    "  config show                      Display current configuration",
    "  help                             Show this help message",
    "  version                          Show version",
    "",
    "Options:",
    "  --config <path>  Path to config TOML file",
    "  --identity <path> Path to identity TOML file",
    "  --name <name>    Worker name (for register command)",
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
  process.stdout.write("  capown-worker daemon\n");

  return 0;
}

function handleStatus(args: CliArgs): number {
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

  if (!identity.workerId) {
    process.stdout.write("Status: NOT REGISTERED\n");
    process.stdout.write("Run 'capown-worker register <link>' to register.\n");
  } else {
    process.stdout.write("Status: READY\n");
    process.stdout.write("Run 'capown-worker daemon' to start.\n");
  }

  return 0;
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
      return handleStatus(args);
    }
    case "config": {
      if (args.link === "show") {
        return handleConfigShow(args);
      }
      process.stderr.write("usage: capown-worker config show\n");
      return 1;
    }
    case "daemon": {
      const daemon = new Daemon({ configPath: args.config, identityPath: args.identity });
      try {
        await daemon.run();
      } catch (err) {
        log.error("daemon: fatal error: %s", err);
        return 1;
      }
      return 0;
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
