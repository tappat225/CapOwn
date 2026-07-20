// SPDX-License-Identifier: Apache-2.0

import { readFile, readdir } from "node:fs/promises";
import { join, parse } from "node:path";
import type { PluginManifest } from "./types.js";

const MANIFEST_SCHEMA_VERSION = 1;

const DEFAULT_PERMISSIONS = {
  network: "none" as const,
  read_roots: [] as string[],
  write_roots: [] as string[],
};

const DEFAULT_LIMITS = {
  startup_timeout_seconds: 15,
  call_timeout_seconds: 60,
  max_argument_bytes: 200_000,
  max_output_bytes: 200_000,
  max_concurrency: 4,
};

const PLUGIN_ID_RE = /^[a-z0-9_-]{1,64}$/;
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const PERMISSION_KEYS = new Set(["network", "read_roots", "write_roots"]);
const LIMIT_KEYS = new Set([
  "startup_timeout_seconds", "call_timeout_seconds", "max_argument_bytes",
  "max_output_bytes", "max_concurrency",
]);
const RESERVED_WORKER_ENV = new Set([
  "CAPOWN_CONFIG", "CAPOWN_WORKER_CONFIG", "CAPOWN_WORKER_NEXT_CONFIG",
  "CAPOWN_WORKER_IDENTITY",
]);

const ALLOWED_KEYS = new Set([
  "schema_version", "plugin_id", "version", "display_name", "description",
  "kind", "transport", "enabled", "command", "env", "permissions", "limits",
]);

export function validateManifest(raw: Record<string, unknown>): PluginManifest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("manifest must be a JSON object");
  }
  for (const key of Object.keys(raw)) {
    if (!ALLOWED_KEYS.has(key)) {
      throw new Error(`unknown top-level field: "${key}"`);
    }
  }
  if (typeof raw.schema_version !== "number" || raw.schema_version !== MANIFEST_SCHEMA_VERSION) {
    throw new Error(`invalid schema_version: expected ${MANIFEST_SCHEMA_VERSION}`);
  }
  if (typeof raw.plugin_id !== "string" || !PLUGIN_ID_RE.test(raw.plugin_id)) {
    throw new Error("plugin_id must be 1-64 lowercase letters, digits, underscores, or hyphens");
  }
  if (typeof raw.version !== "string" || !SEMVER_RE.test(raw.version)) {
    throw new Error("version must be semver (e.g. 1.0.0)");
  }
  if (raw.kind !== "mcp") {
    throw new Error(`kind must be "mcp", got ${String(raw.kind)}`);
  }
  if (raw.transport !== "stdio") {
    throw new Error(`transport must be "stdio", got ${String(raw.transport)}`);
  }
  if (typeof raw.enabled !== "boolean") {
    throw new Error("enabled must be a boolean");
  }
  if (!Array.isArray(raw.command) || raw.command.length === 0
    || !raw.command.every((c) => typeof c === "string" && c.length > 0)) {
    throw new Error("command must be a non-empty array of strings");
  }

  const command = raw.command as string[];
  if (raw.display_name !== undefined && typeof raw.display_name !== "string") {
    throw new Error("display_name must be a string");
  }
  if (raw.description !== undefined && typeof raw.description !== "string") {
    throw new Error("description must be a string");
  }

  const env: Record<string, string> = {};
  if (raw.env !== undefined) {
    if (!raw.env || typeof raw.env !== "object" || Array.isArray(raw.env)) {
      throw new Error("env must be an object of string values");
    }
    for (const [k, v] of Object.entries(raw.env)) {
      if (RESERVED_WORKER_ENV.has(k)) {
        throw new Error(`env.${k} is reserved for the Worker`);
      }
      if (typeof v !== "string") {
        throw new Error(`env.${k} must be a string`);
      }
      env[k] = v;
    }
  }

  if (raw.permissions !== undefined
    && (!raw.permissions || typeof raw.permissions !== "object" || Array.isArray(raw.permissions))) {
    throw new Error("permissions must be an object");
  }
  const rawPermissions = (raw.permissions ?? {}) as Record<string, unknown>;
  for (const key of Object.keys(rawPermissions)) {
    if (!PERMISSION_KEYS.has(key)) throw new Error(`unknown permissions field: "${key}"`);
  }
  const permissions: PluginManifest["permissions"] = {
    ...DEFAULT_PERMISSIONS,
    ...rawPermissions as Partial<PluginManifest["permissions"]>,
  };
  if (!["none", "local", "all"].includes(permissions.network)) {
    throw new Error(`permissions.network must be "none", "local", or "all"`);
  }
  if (!Array.isArray(permissions.read_roots) || !Array.isArray(permissions.write_roots)) {
    throw new Error("permissions.read_roots and write_roots must be arrays");
  }
  if (!permissions.read_roots.every((root) => typeof root === "string")
    || !permissions.write_roots.every((root) => typeof root === "string")) {
    throw new Error("permissions roots must contain only strings");
  }

  if (raw.limits !== undefined
    && (!raw.limits || typeof raw.limits !== "object" || Array.isArray(raw.limits))) {
    throw new Error("limits must be an object");
  }
  const rawLimits = (raw.limits ?? {}) as Record<string, unknown>;
  for (const key of Object.keys(rawLimits)) {
    if (!LIMIT_KEYS.has(key)) throw new Error(`unknown limits field: "${key}"`);
  }
  const limits: PluginManifest["limits"] = {
    ...DEFAULT_LIMITS,
    ...rawLimits as Partial<PluginManifest["limits"]>,
  };
  for (const key of ["startup_timeout_seconds", "call_timeout_seconds", "max_argument_bytes", "max_output_bytes", "max_concurrency"]) {
    const val = (limits as unknown as Record<string, unknown>)[key];
    if (typeof val !== "number" || val < 1 || !Number.isInteger(val)) {
      throw new Error(`limits.${key} must be a positive integer`);
    }
  }

  return {
    schema_version: MANIFEST_SCHEMA_VERSION,
    plugin_id: raw.plugin_id,
    version: raw.version,
    display_name: typeof raw.display_name === "string" ? raw.display_name : "",
    description: typeof raw.description === "string" ? raw.description : "",
    kind: "mcp",
    transport: "stdio",
    enabled: raw.enabled,
    command,
    env,
    permissions,
    limits,
  };
}

export async function loadManifests(pluginsDir: string): Promise<LoadedPluginManifest[]> {
  let files: string[];
  try {
    files = await readdir(pluginsDir);
  } catch {
    return [];
  }

  const jsonFiles = files.filter((f) => f.endsWith(".json")).sort();
  const manifests: LoadedPluginManifest[] = [];
  const seenIds = new Set<string>();

  for (const file of jsonFiles) {
    const filePath = join(pluginsDir, file);
    try {
      const content = await readFile(filePath, "utf-8");
      const raw = JSON.parse(content);
      const manifest = validateManifest(raw);

      if (seenIds.has(manifest.plugin_id)) {
        console.warn(`[plugins] duplicate plugin_id "${manifest.plugin_id}" in ${file}, skipping`);
        continue;
      }
      seenIds.add(manifest.plugin_id);

      manifests.push({ manifest, path: filePath });
    } catch (err) {
      const baseName = parse(file).base;
      console.warn(`[plugins] skipping invalid manifest ${baseName}:`, (err as Error).message);
    }
  }

  return manifests;
}

export interface LoadedPluginManifest {
  manifest: PluginManifest;
  path: string;
}
