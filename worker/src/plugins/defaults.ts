// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import {
  access,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { loadManifests } from "./manifest.js";
import type { PluginManifest } from "./types.js";

const DEFAULTS_STATE_VERSION = 1;
const FILESYSTEM_PLUGIN_ID = "filesystem";
const FILESYSTEM_PACKAGE_NAME = "@modelcontextprotocol/server-filesystem";

interface DefaultsState {
  schema_version: number;
  provisioned: string[];
}

interface FilesystemPackageMetadata {
  version: string;
}

export async function provisionDefaultPlugins(
  configDir: string,
): Promise<void> {
  const pluginsDir = join(configDir, "plugins.d");
  const statePath = join(configDir, "plugin-defaults.json");
  const state = await readDefaultsState(statePath);
  if (state.provisioned.includes(FILESYSTEM_PLUGIN_ID)) return;

  await mkdir(pluginsDir, { recursive: true, mode: 0o700 });
  const defaultManifestPath = join(
    pluginsDir,
    `${FILESYSTEM_PLUGIN_ID}.json`,
  );
  try {
    await access(defaultManifestPath);
    await markProvisioned(statePath, state, FILESYSTEM_PLUGIN_ID);
    return;
  } catch {
    // The default manifest path is available for first-run provisioning.
  }

  const existing = await loadManifests(pluginsDir);
  if (
    existing.some(({ manifest }) => manifest.plugin_id === FILESYSTEM_PLUGIN_ID)
  ) {
    await markProvisioned(statePath, state, FILESYSTEM_PLUGIN_ID);
    return;
  }

  const workspacePath = join(configDir, "workspace");
  await mkdir(workspacePath, { recursive: true, mode: 0o700 });

  const require = createRequire(import.meta.url);
  const packagePath = require.resolve(
    `${FILESYSTEM_PACKAGE_NAME}/package.json`,
  );
  const packageMetadata = JSON.parse(
    await readFile(packagePath, "utf-8"),
  ) as FilesystemPackageMetadata;
  const entrypoint = join(dirname(packagePath), "dist", "index.js");

  const manifest: PluginManifest = {
    schema_version: 1,
    plugin_id: FILESYSTEM_PLUGIN_ID,
    version: packageMetadata.version,
    display_name: "Filesystem",
    description:
      "Third-party MCP filesystem server installed with CapOwn Worker.",
    kind: "mcp",
    transport: "stdio",
    enabled: true,
    command: [process.execPath, entrypoint, workspacePath],
    env: {},
    permissions: {
      network: "none",
      read_roots: [workspacePath],
      write_roots: [workspacePath],
    },
    limits: {
      startup_timeout_seconds: 15,
      call_timeout_seconds: 60,
      max_argument_bytes: 200_000,
      max_output_bytes: 1_000_000,
      max_concurrency: 4,
    },
  };

  await writeJSONAtomic(defaultManifestPath, manifest);
  await markProvisioned(statePath, state, FILESYSTEM_PLUGIN_ID);
}

async function readDefaultsState(statePath: string): Promise<DefaultsState> {
  try {
    const parsed = JSON.parse(
      await readFile(statePath, "utf-8"),
    ) as Partial<DefaultsState>;
    if (
      parsed.schema_version === DEFAULTS_STATE_VERSION &&
      Array.isArray(parsed.provisioned) &&
      parsed.provisioned.every((value) => typeof value === "string")
    ) {
      return {
        schema_version: DEFAULTS_STATE_VERSION,
        provisioned: [...parsed.provisioned],
      };
    }
  } catch {
    // A missing or invalid state file is treated as an unprovisioned Worker.
  }
  return { schema_version: DEFAULTS_STATE_VERSION, provisioned: [] };
}

async function markProvisioned(
  statePath: string,
  state: DefaultsState,
  pluginID: string,
): Promise<void> {
  if (!state.provisioned.includes(pluginID)) state.provisioned.push(pluginID);
  await writeJSONAtomic(statePath, state);
}

async function writeJSONAtomic(
  filePath: string,
  value: unknown,
): Promise<void> {
  const temporaryPath = `${filePath}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf-8",
      mode: 0o600,
    });
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}
