import type { PluginInfo } from "./master-client";

export interface WorkerPluginSummary {
  running: number;
  issues: number;
  disabled: number;
}

export function summarizeWorkerPlugins(
  plugins: PluginInfo[],
): WorkerPluginSummary {
  return plugins.reduce<WorkerPluginSummary>(
    (summary, plugin) => {
      if (!plugin.enabled || plugin.status === "disabled") {
        summary.disabled += 1;
      } else if (plugin.status === "running") {
        summary.running += 1;
      } else {
        summary.issues += 1;
      }
      return summary;
    },
    { running: 0, issues: 0, disabled: 0 },
  );
}

export function formatWorkerCapability(capability: string): string {
  if (capability === "plugin.invoke") return "Plugin invocation";
  return capability;
}
