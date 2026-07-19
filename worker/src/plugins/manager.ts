// SPDX-License-Identifier: Apache-2.0

import { join } from "node:path";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { loadManifests } from "./manifest.js";
import { PluginRegistry } from "./registry.js";
import type { PluginInfo, PluginCallResult, ContentBlock } from "./types.js";
import { PluginError, PluginErrorCodes } from "./errors.js";

const MAX_RESTART_ATTEMPTS = 3;
const RESTART_DELAY_MS = 2000;

export class PluginManager {
  private registry = new PluginRegistry();
  private pluginsDir: string;
  private restartCounts = new Map<string, number>();
  private restartTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(configDir: string) {
    this.pluginsDir = join(configDir, "plugins.d");
  }

  async loadPlugins(): Promise<void> {
    const manifests = await loadManifests(this.pluginsDir);

    for (const loaded of manifests) {
      try {
        this.registry.register(loaded.manifest, loaded.path);
      } catch (err) {
        console.warn(`[plugins] failed to register "${loaded.manifest.plugin_id}":`, (err as Error).message);
      }
    }

    if (manifests.length === 0) {
      console.log("[plugins] no plugin manifests found");
    } else {
      console.log(`[plugins] registered ${manifests.length} plugin(s)`);
    }
  }

  async startPlugins(): Promise<void> {
    await this.registry.startAll();
  }

  async stopPlugins(): Promise<void> {
    for (const [, timer] of this.restartTimers) {
      clearTimeout(timer);
    }
    this.restartTimers.clear();
    this.restartCounts.clear();

    await this.registry.stopAll();
  }

  getPluginSnapshots(): PluginInfo[] {
    return this.registry.getSnapshots();
  }

  get capabilities(): string[] {
    return this.registry.capabilities;
  }

  onSnapshotsChanged(listener: (info: PluginInfo[]) => void): () => void {
    return this.registry.onSnapshotsChanged(listener);
  }

  async setPluginEnabled(pluginId: string, enabled: boolean): Promise<PluginInfo> {
    const plugin = this.registry.get(pluginId);
    if (!plugin) {
      throw new PluginError(PluginErrorCodes.PluginNotFound, `plugin "${pluginId}" not found`);
    }

    await this.persistEnabled(plugin.manifestPath, enabled);
    plugin.manifest.enabled = enabled;

    const restartTimer = this.restartTimers.get(pluginId);
    if (restartTimer) {
      clearTimeout(restartTimer);
      this.restartTimers.delete(pluginId);
    }
    this.restartCounts.delete(pluginId);

    if (enabled) {
      if (plugin.adapter.status !== "running") await plugin.adapter.start();
    } else {
      await plugin.adapter.stop();
    }
    this.registry.emitSnapshotsChanged();
    return plugin.adapter.getInfo();
  }

  private async persistEnabled(manifestPath: string, enabled: boolean): Promise<void> {
    const raw = JSON.parse(await readFile(manifestPath, "utf-8")) as Record<string, unknown>;
    raw.enabled = enabled;
    const temporaryPath = `${manifestPath}.tmp-${process.pid}-${Date.now()}`;
    try {
      await writeFile(temporaryPath, JSON.stringify(raw, null, 2) + "\n", { encoding: "utf-8" });
      await rename(temporaryPath, manifestPath);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => {});
      throw error;
    }
  }

  async invokePlugin(
    pluginId: string,
    toolName: string,
    args: Record<string, unknown>,
    timeoutSeconds?: number,
    signal?: AbortSignal,
  ): Promise<PluginCallResult> {
    if (typeof pluginId !== "string" || pluginId.length === 0
      || typeof toolName !== "string" || toolName.length === 0
      || !args || typeof args !== "object" || Array.isArray(args)) {
      throw new PluginError(PluginErrorCodes.PluginSchemaInvalid,
        "plugin call parameters are invalid");
    }
    const plugin = this.registry.get(pluginId);
    if (!plugin) {
      throw new PluginError(PluginErrorCodes.PluginNotFound,
        `plugin "${pluginId}" not found`);
    }

    if (plugin.manifest.enabled === false) {
      throw new PluginError(PluginErrorCodes.PluginDisabled,
        `plugin "${pluginId}" is disabled`);
    }

    if (!plugin.adapter.isHealthy) {
      throw new PluginError(PluginErrorCodes.PluginUnavailable,
        `plugin "${pluginId}" is not available (status: ${plugin.adapter.status})`);
    }

    const mcpResult = await plugin.adapter.invoke(toolName, args, timeoutSeconds, signal);

    if (!mcpResult || !Array.isArray(mcpResult.content)) {
      throw new PluginError(PluginErrorCodes.PluginProtocolError,
        "plugin returned an invalid result", "plugin returned an invalid result");
    }
    if (mcpResult.isError !== undefined && typeof mcpResult.isError !== "boolean") {
      throw new PluginError(PluginErrorCodes.PluginProtocolError,
        "plugin returned an invalid isError value", "plugin returned an invalid result");
    }
    if (mcpResult.structuredContent !== undefined
      && (!mcpResult.structuredContent || typeof mcpResult.structuredContent !== "object")) {
      throw new PluginError(PluginErrorCodes.PluginProtocolError,
        "plugin returned invalid structuredContent", "plugin returned an invalid result");
    }

    const content: ContentBlock[] = mcpResult.content.map((block) => {
      if (block.type === "json" && block.data) {
        try {
          return { type: "json" as const, value: JSON.parse(block.data) };
        } catch {
          return { type: "text" as const, text: block.data };
        }
      }
      if (block.type === "text" && typeof block.text === "string") {
        return { type: "text" as const, text: block.text };
      }
      throw new PluginError(PluginErrorCodes.PluginProtocolError,
        "plugin returned an unsupported content block",
        "plugin returned unsupported content");
    });

    const structured = mcpResult.structuredContent
      ?? content.find((c) => c.type === "json")?.value
      ?? null;

    const result: PluginCallResult = {
      is_error: mcpResult.isError ?? false,
      content,
      structured_content: structured,
    };

    const maxOutputBytes = plugin.manifest.limits?.max_output_bytes ?? 200_000;
    if (Buffer.byteLength(JSON.stringify(result), "utf-8") > maxOutputBytes) {
      throw new PluginError(PluginErrorCodes.PluginOutputTooLarge,
        `plugin ${pluginId} output exceeds ${maxOutputBytes} bytes`);
    }

    return result;
  }

  handlePluginCrash(pluginId: string): void {
    const count = (this.restartCounts.get(pluginId) ?? 0) + 1;
    this.restartCounts.set(pluginId, count);

    if (count > MAX_RESTART_ATTEMPTS) {
      console.error(`[plugins] "${pluginId}" exceeded max restart attempts (${MAX_RESTART_ATTEMPTS})`);
      return;
    }

    console.log(`[plugins] restarting "${pluginId}" (attempt ${count}/${MAX_RESTART_ATTEMPTS})...`);

    const timer = setTimeout(async () => {
      this.restartTimers.delete(pluginId);
      const plugin = this.registry.get(pluginId);
      if (!plugin) return;

      try {
        await plugin.adapter.start();
        // Reset restart count on successful restart
        this.restartCounts.delete(pluginId);
      } catch (err) {
        console.error(`[plugins] restart of "${pluginId}" failed:`, (err as Error).message);
      }
    }, RESTART_DELAY_MS);

    this.restartTimers.set(pluginId, timer);
  }
}
