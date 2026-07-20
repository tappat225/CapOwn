// SPDX-License-Identifier: Apache-2.0

import type { PluginManifest, PluginInfo } from "./types.js";
import { McpStdioAdapter } from "./mcp-stdio.js";

export type PluginAdapter = McpStdioAdapter;

export interface RegisteredPlugin {
  manifest: PluginManifest;
  manifestPath: string;
  adapter: PluginAdapter;
}

export class PluginRegistry {
  private plugins = new Map<string, RegisteredPlugin>();
  private statusListeners = new Set<(info: PluginInfo[]) => void>();

  register(manifest: PluginManifest, manifestPath = ""): RegisteredPlugin {
    if (this.plugins.has(manifest.plugin_id)) {
      throw new Error(`plugin "${manifest.plugin_id}" is already registered`);
    }

    const adapter = new McpStdioAdapter(manifest);
    const entry: RegisteredPlugin = { manifest, manifestPath, adapter };
    this.plugins.set(manifest.plugin_id, entry);

    adapter.on("statusChanged", () => {
      this.notifyListeners();
    });

    return entry;
  }

  get(pluginId: string): RegisteredPlugin | undefined {
    return this.plugins.get(pluginId);
  }

  getAll(): RegisteredPlugin[] {
    return Array.from(this.plugins.values());
  }

  getSnapshots(): PluginInfo[] {
    return this.getAll().map((p) => p.adapter.getInfo());
  }

  onSnapshotsChanged(listener: (info: PluginInfo[]) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  emitSnapshotsChanged(): void {
    this.notifyListeners();
  }

  private notifyListeners(): void {
    const snapshots = this.getSnapshots();
    for (const listener of this.statusListeners) {
      listener(snapshots);
    }
  }

  async startAll(): Promise<void> {
    const results = await Promise.allSettled(
      this.getAll().map((p) => p.adapter.start()),
    );
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === "rejected") {
        const plugin = this.getAll()[i];
        console.warn(`[plugins] failed to start "${plugin.manifest.plugin_id}":`, result.reason);
      }
    }
  }

  async stopAll(): Promise<void> {
    await Promise.allSettled(
      this.getAll().map((p) => p.adapter.stop()),
    );
  }

  get capabilities(): string[] {
    const caps: string[] = [];
    for (const plugin of this.getAll()) {
      if (plugin.adapter.isHealthy && plugin.adapter.tools.length > 0) {
        caps.push("plugin.invoke");
        break;
      }
    }
    return caps;
  }
}
