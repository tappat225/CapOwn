// SPDX-License-Identifier: Apache-2.0
/** CLI entry point for Worker Next -- `capown-worker-next` command. */

import { log } from "./logging.js";
import { Daemon } from "./daemon.js";

const VERSION = "0.1.0";

interface CliArgs {
  command: string;
  config?: string;
  identity?: string;
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
    } else if (a === "--help" || a === "-h") {
      args.command = "help";
    } else if (a === "--version" || a === "-V") {
      args.command = "version";
    } else if (!a.startsWith("-")) {
      args.command = a;
    }
    i++;
  }
  return args;
}

function printHelp(): void {
  const lines = [
    "capown-worker-next v" + VERSION,
    "",
    "Usage:",
    "  capown-worker-next [command] [options]",
    "",
    "Commands:",
    "  daemon           Start the Worker Next daemon (default)",
    "  status           Show worker status and configuration",
    "  help             Show this help message",
    "  version          Show version",
    "",
    "Options:",
    "  --config <path>  Path to config TOML file",
    "  --identity <path> Path to identity TOML file",
    "  -h, --help       Show this help message",
    "  -V, --version    Show version",
    "",
    "Environment:",
    "  CAPOWN_WORKER_NEXT_CONFIG  Config file path (overrides CAPOWN_WORKER_CONFIG)",
    "  CAPOWN_WORKER_CONFIG       Config file path",
    "  CAPOWN_CONFIG              Config file path (lowest priority)",
    "  CAPOWN_WORKER_IDENTITY     Identity file path",
    "",
  ];
  for (const line of lines) {
    process.stdout.write(line + "\n");
  }
}

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);

  switch (args.command) {
    case "help": {
      printHelp();
      return 0;
    }
    case "version": {
      process.stdout.write("capown-worker-next v" + VERSION + "\n");
      return 0;
    }
    case "status": {
      process.stdout.write("capown-worker-next v" + VERSION + "\n");
      return 0;
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
