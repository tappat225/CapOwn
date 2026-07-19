// SPDX-License-Identifier: Apache-2.0
/// <reference types="node" />
/** Configuration loading, resolution, and validation for Worker Next. */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as TOML from "toml";
import { z } from "zod";
import { log } from "./logging.js";

// --------------------------------------------------------------------------
// Zod schema for Worker Next config
// --------------------------------------------------------------------------

const ConfigSchema = z.object({
  master_url: z
    .string()
    .refine(
      (v) => /^https?:\/\/.+/.test(v),
      { message: "master_url must start with http:// or https://" },
    ),
  worker_name: z
    .string()
    .min(3)
    .max(48)
    .regex(/^[a-z0-9][a-z0-9._-]{1,46}[a-z0-9]$/, {
      message: "worker_name must be an ASCII slug (3-48 chars, lowercase)",
    })
    .optional(),
  worker_id: z.string().optional(),
  reconnect_interval: z
    .number()
    .int()
    .positive()
    .default(5),
});

// --------------------------------------------------------------------------
// Config interface
// --------------------------------------------------------------------------

export interface WorkerNextConfig {
  readonly master_url: string;
  readonly worker_name: string;
  readonly worker_id: string;
  readonly reconnect_interval: number;
  /** Resolved paths (may differ from input). */
  readonly configPath: string;
  readonly identityPath: string;
}

// --------------------------------------------------------------------------
// Path resolution
// --------------------------------------------------------------------------

function defaultConfigPath(): string {
  // Check env vars in priority order
  const env =
    process.env["CAPOWN_WORKER_NEXT_CONFIG"] ??
    process.env["CAPOWN_WORKER_CONFIG"] ??
    process.env["CAPOWN_CONFIG"];

  if (env) {
    const resolved = path.resolve(env);
    if (fs.existsSync(resolved)) return resolved;
    log.warn("config: env var path does not exist: %s", resolved);
  }

  // Fallback: ~/.capown/worker/config.toml
  const home = path.join(os.homedir(), ".capown", "worker", "config.toml");
  if (fs.existsSync(home)) return home;

  return home; // return path even if it doesn't exist yet
}

function defaultIdentityPath(): string {
  const env = process.env["CAPOWN_WORKER_IDENTITY"];
  if (env) {
    const resolved = path.resolve(env);
    if (fs.existsSync(resolved)) return resolved;
    log.warn("identity: env var path does not exist: %s", resolved);
  }
  return path.join(os.homedir(), ".capown", "worker", "identity.toml");
}

// --------------------------------------------------------------------------
// TOML helpers
// --------------------------------------------------------------------------

interface FlatToml {
  master_url?: string;
  worker_name?: string;
  worker_id?: string;
  /** Legacy execution keys -- warn once, ignore */
  [key: string]: unknown;
}

function parseTomlFile(filePath: string): FlatToml {
  try {
    const raw = fs.readFileSync(filePath, "utf-8").replace(/^\uFEFF/, "");
    const parsed = TOML.parse(raw) as Record<string, unknown>;

    // The existing config has top-level keys (master_url, worker_name, ...)
    // and a [worker] section with runtime keys (reconnect_interval, ...).
    // We merge both levels.
    const workerSection = (parsed["worker"] ?? {}) as Record<string, unknown>;
    delete parsed["worker"];
    delete parsed["role"];

    const merged: Record<string, unknown> = { ...parsed, ...workerSection };
    return merged as unknown as FlatToml;
  } catch (err) {
    log.warn("config: failed to parse %s: %s", filePath, err);
    return {};
  }
}

// --------------------------------------------------------------------------
// Write config to TOML file
// --------------------------------------------------------------------------

export function writeConfigFile(filePath: string, config: Partial<WorkerNextConfig>): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const lines: string[] = ['# CapOwn Worker configuration'];
  if (config.master_url) {
    lines.push(`master_url = "${config.master_url}"`);
  }
  if (config.worker_name) {
    lines.push(`worker_name = "${config.worker_name}"`);
  }
  if (config.reconnect_interval) {
    lines.push(`reconnect_interval = ${config.reconnect_interval}`);
  }

  const content = lines.join("\n") + "\n";

  // Atomic write
  const tmpPath = filePath + ".tmp." + crypto.randomBytes(4).toString("hex");
  fs.writeFileSync(tmpPath, content, "utf-8");
  fs.chmodSync(tmpPath, 0o600);
  fs.renameSync(tmpPath, filePath);
}

// --------------------------------------------------------------------------
// Load & validate
// --------------------------------------------------------------------------

export interface LoadConfigOptions {
  configPath?: string;
  identityPath?: string;
}

export function loadConfig(opts?: LoadConfigOptions): WorkerNextConfig {
  const configPath = opts?.configPath
    ? path.resolve(opts.configPath)
    : defaultConfigPath();

  const identityPath = opts?.identityPath
    ? path.resolve(opts.identityPath)
    : defaultIdentityPath();

  // Parse TOML if it exists
  const raw: Record<string, unknown> = {};
  if (fs.existsSync(configPath)) {
    Object.assign(raw, parseTomlFile(configPath));
  } else {
    log.info("config: no config file found at %s, using defaults", configPath);
  }

  // Warn about legacy execution keys (ignore without failing)
  const legacyKeys = [
    "execution_mode", "workspace", "max_runtime", "idle_timeout",
    "max_output_size", "max_input_size", "container_name",
    "store_command_history", "command_preview_size", "max_command_history_size",
  ];
  const foundLegacy = legacyKeys.filter((k) => k in raw);
  if (foundLegacy.length > 0) {
    log.info(
      "config: ignoring legacy execution keys (Worker Next does not use them): %s",
      foundLegacy.join(", "),
    );
  }

  // Apply defaults for Zod validation
  const candidate = {
    master_url: (raw["master_url"] as string) ?? "https://localhost:9210",
    worker_name: (raw["worker_name"] as string) ?? undefined,
    worker_id: (raw["worker_id"] as string) ?? undefined,
    reconnect_interval:
      (raw["reconnect_interval"] as number) ?? 5,
  };

  // Validate config shape
  const parsed = ConfigSchema.parse(candidate);

  return {
    master_url: parsed.master_url,
    worker_name: parsed.worker_name ?? "",
    worker_id: parsed.worker_id ?? "",
    reconnect_interval: parsed.reconnect_interval,
    configPath,
    identityPath,
  };
}
