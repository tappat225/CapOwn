// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateManifest } from "../src/plugins/manifest.js";
import { McpStdioAdapter } from "../src/plugins/mcp-stdio.js";
import { PluginManager } from "../src/plugins/manager.js";
import { PluginErrorCodes } from "../src/plugins/errors.js";
import type { PluginManifest } from "../src/plugins/types.js";

function baseManifest(command: string[] = [process.execPath, "plugin.js"]): PluginManifest {
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
  it("accepts literal argv characters because commands do not use a shell", () => {
    const manifest = baseManifest(["C:\\Program Files\\node.exe", "--flag=a&b"]);
    assert.deepEqual(validateManifest(manifest as unknown as Record<string, unknown>).command, manifest.command);
  });

  it("rejects uppercase plugin IDs and unknown nested fields", () => {
    assert.throws(() => validateManifest({
      ...baseManifest(),
      plugin_id: "Uppercase",
    } as unknown as Record<string, unknown>));
    assert.throws(() => validateManifest({
      ...baseManifest(),
      limits: { ...baseManifest().limits, unexpected: 1 },
    } as unknown as Record<string, unknown>));
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
      const persisted = JSON.parse(await readFile(manifestPath, "utf-8")) as { enabled: boolean };
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
    const adapter = new McpStdioAdapter(baseManifest([process.execPath, "-e", script]));
    await adapter.start();
    assert.equal(adapter.status, "running");

    const controller = new AbortController();
    const invocation = adapter.invoke("wait", {}, 5, controller.signal);
    setTimeout(() => controller.abort(), 25);

    await assert.rejects(invocation, (error: unknown) => {
      return typeof error === "object" && error !== null
        && "code" in error && error.code === PluginErrorCodes.PluginCanceled;
    });
    await adapter.stop();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(adapter.status, "stopped");
  });
});
