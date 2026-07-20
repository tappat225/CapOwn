// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateManifest } from "../src/plugins/manifest.js";
import {
  McpStdioAdapter,
  mcpStdioSpawnOptions,
} from "../src/plugins/mcp-stdio.js";
import { PluginManager } from "../src/plugins/manager.js";
import { PluginErrorCodes } from "../src/plugins/errors.js";
import type { PluginManifest } from "../src/plugins/types.js";

function baseManifest(
  command: string[] = [process.execPath, "plugin.js"],
): PluginManifest {
  return {
    schema_version: 1,
    plugin_id: "test-plugin",
    version: "1.0.0",
    kind: "mcp",
    transport: "stdio",
    enabled: true,
    command,
    env: {},
    permissions: { network: "none", read_roots: [], write_roots: [] },
    limits: {
      startup_timeout_seconds: 2,
      call_timeout_seconds: 5,
      max_argument_bytes: 1024,
      max_output_bytes: 1024,
      max_concurrency: 1,
    },
  };
}

describe("plugin manifests", () => {
  it("starts stdio plugins without a visible Windows console", () => {
    const env = { PATH: process.env["PATH"] };
    assert.deepEqual(mcpStdioSpawnOptions(env), {
      stdio: ["pipe", "pipe", "pipe"],
      env,
      shell: false,
      windowsHide: true,
    });
  });

  it("provisions the bundled filesystem plugin on first load", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "capown-default-plugin-"));
    try {
      const manager = new PluginManager(configDir);
      await manager.loadPlugins();

      const manifestPath = join(configDir, "plugins.d", "filesystem.json");
      const manifest = JSON.parse(
        await readFile(manifestPath, "utf-8"),
      ) as PluginManifest;
      assert.equal(manifest.plugin_id, "filesystem");
      assert.equal(manifest.enabled, true);
      assert.equal(manifest.command[0], process.execPath);
      assert.equal(manifest.command.at(-1), join(configDir, "workspace"));
      assert.deepEqual(manifest.permissions?.read_roots, [
        join(configDir, "workspace"),
      ]);
      assert.deepEqual(manifest.permissions?.write_roots, [
        join(configDir, "workspace"),
      ]);

      await manager.startPlugins();
      const snapshot = manager
        .getPluginSnapshots()
        .find((plugin) => plugin.plugin_id === "filesystem");
      assert.equal(snapshot?.status, "running");
      assert.ok(snapshot?.tools.some((tool) => tool.name === "read_file"));
      assert.ok(snapshot?.tools.some((tool) => tool.name === "write_file"));
      assert.deepEqual(manager.capabilities, ["plugin.invoke"]);
      const invocation = await manager.invokePlugin(
        "filesystem",
        "list_allowed_directories",
        {},
      );
      assert.equal(invocation.is_error, false);
      assert.match(JSON.stringify(invocation.content), /workspace/);
      await manager.stopPlugins();
    } finally {
      await rm(configDir, { recursive: true, force: true });
    }
  });

  it("does not replace an existing filesystem manifest", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "capown-existing-plugin-"));
    const pluginsDir = join(configDir, "plugins.d");
    await mkdir(pluginsDir);
    const manifestPath = join(pluginsDir, "custom-filesystem.json");
    const existing = {
      ...baseManifest(),
      plugin_id: "filesystem",
      enabled: false,
    };
    await writeFile(manifestPath, JSON.stringify(existing, null, 2));
    try {
      const manager = new PluginManager(configDir);
      await manager.loadPlugins();
      const persisted = JSON.parse(
        await readFile(manifestPath, "utf-8"),
      ) as PluginManifest;
      assert.equal(persisted.enabled, false);
      assert.equal(persisted.command[1], "plugin.js");
      await assert.rejects(
        readFile(join(pluginsDir, "filesystem.json"), "utf-8"),
      );
    } finally {
      await rm(configDir, { recursive: true, force: true });
    }
  });

  it("does not overwrite an invalid file at the default manifest path", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "capown-invalid-default-"));
    const pluginsDir = join(configDir, "plugins.d");
    await mkdir(pluginsDir);
    const manifestPath = join(pluginsDir, "filesystem.json");
    await writeFile(manifestPath, "user-owned invalid manifest\n");
    try {
      const manager = new PluginManager(configDir);
      await manager.loadPlugins();
      assert.equal(
        await readFile(manifestPath, "utf-8"),
        "user-owned invalid manifest\n",
      );
      assert.equal(manager.getPluginSnapshots().length, 0);
    } finally {
      await rm(configDir, { recursive: true, force: true });
    }
  });

  it("accepts literal argv characters because commands do not use a shell", () => {
    const manifest = baseManifest([
      "C:\\Program Files\\node.exe",
      "--flag=a&b",
    ]);
    assert.deepEqual(
      validateManifest(manifest as unknown as Record<string, unknown>).command,
      manifest.command,
    );
  });

  it("rejects uppercase plugin IDs and unknown nested fields", () => {
    assert.throws(() =>
      validateManifest({
        ...baseManifest(),
        plugin_id: "Uppercase",
      } as unknown as Record<string, unknown>),
    );
    assert.throws(() =>
      validateManifest({
        ...baseManifest(),
        limits: { ...baseManifest().limits, unexpected: 1 },
      } as unknown as Record<string, unknown>),
    );
  });

  it("persists remote disable state and reports it in snapshots", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "capown-plugin-"));
    const pluginsDir = join(configDir, "plugins.d");
    await mkdir(pluginsDir);
    const manifestPath = join(pluginsDir, "test.json");
    await writeFile(manifestPath, JSON.stringify(baseManifest(), null, 2));
    try {
      const manager = new PluginManager(configDir);
      await manager.loadPlugins();
      const snapshot = await manager.setPluginEnabled("test-plugin", false);
      assert.equal(snapshot.enabled, false);
      assert.equal(snapshot.status, "disabled");
      const persisted = JSON.parse(await readFile(manifestPath, "utf-8")) as {
        enabled: boolean;
      };
      assert.equal(persisted.enabled, false);
    } finally {
      await rm(configDir, { recursive: true, force: true });
    }
  });
});

describe("MCP stdio cancellation", () => {
  it("rejects an in-flight call when its AbortSignal fires", async () => {
    const script = `
      const readline = require("node:readline");
      const rl = readline.createInterface({ input: process.stdin });
      const send = (id, result) => process.stdout.write(JSON.stringify({jsonrpc:"2.0", id, result}) + "\\n");
      rl.on("line", (line) => {
        const req = JSON.parse(line);
        if (req.id === undefined) return;
        if (req.method === "initialize") send(req.id, {protocolVersion:"2025-03-26", capabilities:{}, serverInfo:{name:"test",version:"1.0.0"}});
        else if (req.method === "tools/list") send(req.id, {tools:[{name:"wait",inputSchema:{type:"object"}}]});
        else if (req.method === "tools/call") setTimeout(() => send(req.id, {content:[{type:"text",text:"late"}],isError:false}), 5000);
      });
    `;
    const adapter = new McpStdioAdapter(
      baseManifest([process.execPath, "-e", script]),
    );
    await adapter.start();
    assert.equal(adapter.status, "running");

    const controller = new AbortController();
    const invocation = adapter.invoke("wait", {}, 5, controller.signal);
    setTimeout(() => controller.abort(), 25);

    await assert.rejects(invocation, (error: unknown) => {
      return (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === PluginErrorCodes.PluginCanceled
      );
    });
    await adapter.stop();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(adapter.status, "stopped");
  });
});
