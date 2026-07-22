import { describe, expect, it } from "vitest";
import {
  formatWorkerCapability,
  summarizeWorkerPlugins,
} from "../worker-summary";
import type { PluginInfo } from "../master-client";

function plugin(status: PluginInfo["status"], enabled = true): PluginInfo {
  return {
    plugin_id: `plugin-${status}`,
    version: "1.0.0",
    kind: "mcp",
    transport: "stdio",
    enabled,
    status,
    tools: [],
    error: "",
  };
}

describe("worker summaries", () => {
  it("separates running, attention, and disabled plugins", () => {
    expect(
      summarizeWorkerPlugins([
        plugin("running"),
        plugin("error"),
        plugin("starting"),
        plugin("disabled", false),
        plugin("stopped", false),
      ]),
    ).toEqual({ running: 1, issues: 2, disabled: 2 });
  });

  it("uses a readable label for the aggregate plugin capability", () => {
    expect(formatWorkerCapability("plugin.invoke")).toBe("Plugin invocation");
    expect(formatWorkerCapability("container.run")).toBe("container.run");
  });
});
