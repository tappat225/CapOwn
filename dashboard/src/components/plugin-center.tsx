"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "./icons";
import { useLocale } from "./locale-provider";
import { useMasterConnection } from "./master-connection";
import {
  clearMasterSession,
  isSessionInvalidError,
  MasterClient,
  MasterClientError,
  type CatalogEntry,
  type PluginCatalog,
  type PluginInfo,
  type WorkerInfo,
} from "@/lib/master-client";
import { filterWorkersByOwner } from "@/lib/worker-scope";

type Filter = "all" | "running" | "issues" | "disabled";
type Deployment = { worker: WorkerInfo; plugin: PluginInfo };
type PluginGroup = {
  pluginId: string;
  version: string;
  kind: string;
  transport: string;
  tools: PluginInfo["tools"];
  deployments: Deployment[];
};

export function PluginCenter({
  userId,
  masterOrigin,
  accessToken,
}: {
  userId: string;
  masterOrigin: string;
  accessToken: string;
}) {
  const { refreshRevision } = useMasterConnection();
  const { locale, t } = useLocale();
  const client = useMemo(
    () => new MasterClient({ origin: masterOrigin }),
    [masterOrigin],
  );
  const [workers, setWorkers] = useState<WorkerInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [updating, setUpdating] = useState<string | null>(null);

  const redirectToLogin = useCallback(() => {
    clearMasterSession();
    window.location.assign("/login");
  }, []);

  const load = useCallback(async () => {
    try {
      const workerList = await client.listWorkers(accessToken);
      setWorkers(filterWorkersByOwner(workerList, userId));
      setError("");
    } catch (reason) {
      if (isSessionInvalidError(reason)) return redirectToLogin();
      setError(
        reason instanceof Error ? reason.message : "Unable to load plugins",
      );
    } finally {
      setLoading(false);
    }
  }, [accessToken, client, redirectToLogin, userId]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 60_000);
    return () => window.clearInterval(timer);
  }, [load, refreshRevision]);

  const groups = useMemo(() => aggregatePlugins(workers), [workers]);
  useEffect(() => {
    if (!selectedId && groups[0]) setSelectedId(groups[0].pluginId);
    if (selectedId && !groups.some((group) => group.pluginId === selectedId))
      setSelectedId(groups[0]?.pluginId ?? null);
  }, [groups, selectedId]);

  const filtered = groups.filter((group) => {
    const matchesQuery =
      `${group.pluginId} ${group.kind} ${group.transport} ${group.tools.map((tool) => tool.name).join(" ")}`
        .toLowerCase()
        .includes(query.toLowerCase());
    if (!matchesQuery) return false;
    if (filter === "running")
      return group.deployments.some(
        ({ plugin }) => plugin.status === "running",
      );
    if (filter === "issues")
      return group.deployments.some(({ plugin }) => plugin.status === "error");
    if (filter === "disabled")
      return group.deployments.some(({ plugin }) => !plugin.enabled);
    return true;
  });
  const selected =
    groups.find((group) => group.pluginId === selectedId) ?? null;
  const instances = groups.reduce(
    (sum, group) => sum + group.deployments.length,
    0,
  );
  const healthy = groups.reduce(
    (sum, group) =>
      sum +
      group.deployments.filter(({ plugin }) => plugin.status === "running")
        .length,
    0,
  );
  const issues = groups.reduce(
    (sum, group) =>
      sum +
      group.deployments.filter(({ plugin }) => plugin.status === "error")
        .length,
    0,
  );
  const disabled = groups.reduce(
    (sum, group) =>
      sum + group.deployments.filter(({ plugin }) => !plugin.enabled).length,
    0,
  );

  async function toggle(deployment: Deployment) {
    const next = !deployment.plugin.enabled;
    if (!next && !window.confirm(t("disablePluginWarning"))) return;
    const key = `${deployment.worker.worker_id}:${deployment.plugin.plugin_id}`;
    setUpdating(key);
    try {
      let task = await client.setWorkerPluginEnabled(
        accessToken,
        deployment.worker.worker_id,
        deployment.plugin.plugin_id,
        next,
      );
      const deadline = Date.now() + 35_000;
      while (task.status === "pending" || task.status === "running") {
        if (Date.now() > deadline)
          throw new MasterClientError(t("pluginUpdateTimeout"));
        await wait(500);
        task = await client.getTask(accessToken, task.task_id);
      }
      if (task.status !== "completed")
        throw new MasterClientError(t("pluginUpdateError"));
      await load();
    } catch (reason) {
      if (isSessionInvalidError(reason)) return redirectToLogin();
      setError(
        reason instanceof Error ? reason.message : t("pluginUpdateError"),
      );
    } finally {
      setUpdating(null);
    }
  }

  return (
    <main className="mx-auto max-w-[1480px] px-4 py-8 sm:px-7 lg:px-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-[#10214b] sm:text-[34px]">
            {locale === "zh" ? "插件中心" : "Plugin Center"}
          </h1>
          <p className="mt-2 text-sm text-slate-500">
            {locale === "zh"
              ? "跨 Worker 查看和管理已上报的本地插件。"
              : "Inspect and manage locally configured plugins across your Workers."}
          </p>
        </div>
      </div>

      <>
        <section className="mt-7 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <PluginMetric
            icon="puzzle"
            value={instances}
            label={locale === "zh" ? "插件实例" : "installed instances"}
          />
          <PluginMetric
            icon="pulse"
            value={healthy}
            label={locale === "zh" ? "运行正常" : "healthy"}
            green
          />
          <PluginMetric
            icon="warning"
            value={issues}
            label={locale === "zh" ? "需要处理" : "needs attention"}
            red
          />
          <PluginMetric
            icon="refresh"
            value={disabled}
            label={locale === "zh" ? "已禁用" : "disabled"}
          />
        </section>

        {error && (
          <div className="mt-5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}

        <div className="mt-6 flex flex-wrap items-center gap-3">
          <label className="relative min-w-[240px] flex-1 sm:max-w-sm">
            <Icon
              name="search"
              className="pointer-events-none absolute top-2.5 left-3 h-4 w-4 text-slate-400"
            />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={
                locale === "zh"
                  ? "搜索插件或工具..."
                  : "Search plugins or tools..."
              }
              className="w-full rounded-xl border border-slate-200 bg-white py-2 pr-3 pl-9 text-sm outline-none focus:border-[#3157e1]"
            />
          </label>
          <div className="flex flex-wrap gap-2">
            {(["all", "running", "issues", "disabled"] as Filter[]).map(
              (item) => (
                <button
                  key={item}
                  type="button"
                  onClick={() => setFilter(item)}
                  className={`rounded-xl border px-3.5 py-2 text-xs font-semibold capitalize ${filter === item ? "border-[#3157e1] bg-[#3157e1] text-white" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"}`}
                >
                  {filterLabel(item, locale)}
                </button>
              ),
            )}
          </div>
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="rounded-xl border border-slate-200 bg-white p-2.5 text-slate-500 hover:bg-slate-50"
          >
            <Icon
              name="refresh"
              className={`h-4 w-4 ${loading ? "animate-spin" : ""}`}
            />
          </button>
        </div>

        <div className="mt-4 grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
          <section className="capown-card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-left text-sm">
                <thead className="bg-slate-50/80 text-[11px] font-semibold tracking-wide text-slate-500 uppercase">
                  <tr>
                    <th className="px-5 py-3.5">Plugin</th>
                    <th className="px-4 py-3.5">Source</th>
                    <th className="px-4 py-3.5">Version</th>
                    <th className="px-4 py-3.5">Tools</th>
                    <th className="px-4 py-3.5">Workers</th>
                    <th className="px-4 py-3.5">Runtime</th>
                    <th className="w-10 px-3 py-3.5" />
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((group) => {
                    const hasError = group.deployments.some(
                      ({ plugin }) => plugin.status === "error",
                    );
                    const running = group.deployments.filter(
                      ({ plugin }) => plugin.status === "running",
                    ).length;
                    return (
                      <tr
                        key={group.pluginId}
                        onClick={() => setSelectedId(group.pluginId)}
                        className={`cursor-pointer border-t border-slate-100 ${selectedId === group.pluginId ? "bg-blue-50/70 shadow-[inset_3px_0_0_#3157e1]" : "hover:bg-slate-50/70"}`}
                      >
                        <td className="px-5 py-4">
                          <div className="flex items-center gap-3">
                            <span className="grid h-10 w-10 place-items-center rounded-xl bg-indigo-50 text-[#3157e1]">
                              <Icon
                                name={
                                  group.kind.toLowerCase().includes("file")
                                    ? "folder"
                                    : "puzzle"
                                }
                                className="h-5 w-5"
                              />
                            </span>
                            <div>
                              <p className="font-bold text-[#172b5d]">
                                {group.pluginId}
                              </p>
                              <p className="mt-1 text-xs text-slate-400">
                                {group.kind} · {group.transport}
                              </p>
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-4">
                          <span className="rounded-lg bg-slate-100 px-2 py-1 text-xs font-medium text-slate-600">
                            {locale === "zh" ? "本地清单" : "Local manifest"}
                          </span>
                        </td>
                        <td className="px-4 py-4 text-slate-600">
                          {group.version || "—"}
                        </td>
                        <td className="px-4 py-4 text-slate-600">
                          {group.tools.length}
                        </td>
                        <td className="px-4 py-4 text-slate-600">
                          {group.deployments.length} / {workers.length}
                        </td>
                        <td className="px-4 py-4">
                          <span
                            className={`text-xs font-semibold ${hasError ? "text-red-600" : running > 0 ? "text-emerald-600" : "text-slate-400"}`}
                          >
                            {hasError
                              ? locale === "zh"
                                ? "异常"
                                : "Needs attention"
                              : `${running} ${locale === "zh" ? "运行中" : "running"}`}
                          </span>
                        </td>
                        <td className="px-3 py-4 text-slate-400">
                          <Icon name="chevron" className="h-4 w-4" />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {!loading && filtered.length === 0 && (
              <div className="p-12 text-center text-sm text-slate-400">
                {locale === "zh" ? "没有匹配的插件" : "No matching plugins"}
              </div>
            )}
          </section>

          <aside className="capown-card h-fit overflow-hidden xl:sticky xl:top-20">
            {selected ? (
              <PluginSummary
                group={selected}
                workerCount={workers.length}
                locale={locale}
                updating={updating}
                onToggle={toggle}
              />
            ) : (
              <div className="p-8 text-center text-sm text-slate-400">
                {locale === "zh"
                  ? "选择一个插件查看详情"
                  : "Select a plugin to inspect it"}
              </div>
            )}
          </aside>
        </div>
      </>
    </main>
  );
}

function PluginSummary({
  group,
  workerCount,
  locale,
  updating,
  onToggle,
}: {
  group: PluginGroup;
  workerCount: number;
  locale: "zh" | "en";
  updating: string | null;
  onToggle: (deployment: Deployment) => Promise<void>;
}) {
  return (
    <>
      <div className="border-b border-slate-200 p-5">
        <div className="flex items-start gap-3">
          <span className="grid h-12 w-12 place-items-center rounded-xl bg-indigo-50 text-[#3157e1]">
            <Icon name="puzzle" className="h-6 w-6" />
          </span>
          <div className="min-w-0">
            <h2 className="truncate text-xl font-bold text-[#142552]">
              {group.pluginId}
            </h2>
            <p className="mt-1 text-sm text-slate-500">
              v{group.version} · {group.kind}/{group.transport}
            </p>
          </div>
        </div>
        <div className="mt-4 flex items-center justify-between rounded-xl bg-slate-50 px-3 py-2 text-xs">
          <span className="text-slate-500">
            {locale === "zh" ? "部署覆盖" : "Deployment coverage"}
          </span>
          <strong className="text-[#17316b]">
            {group.deployments.length} / {workerCount} Workers
          </strong>
        </div>
      </div>
      <div className="p-5">
        <h3 className="text-xs font-bold tracking-wide text-slate-500 uppercase">
          Tools
        </h3>
        <div className="mt-3 flex flex-wrap gap-2">
          {group.tools.slice(0, 8).map((tool) => (
            <span
              key={tool.name}
              title={tool.description}
              className="rounded-lg bg-slate-100 px-2.5 py-1.5 font-mono text-[11px] text-slate-600"
            >
              {tool.name}
            </span>
          ))}
          {group.tools.length === 0 && (
            <span className="text-xs text-slate-400">No tools reported</span>
          )}
        </div>
        <h3 className="mt-6 text-xs font-bold tracking-wide text-slate-500 uppercase">
          {locale === "zh" ? "部署状态" : "Deployments"}
        </h3>
        <div className="mt-3 space-y-2">
          {group.deployments.map((deployment) => {
            const key = `${deployment.worker.worker_id}:${deployment.plugin.plugin_id}`;
            const busy = updating === key;
            return (
              <div
                key={deployment.worker.worker_id}
                className="rounded-xl border border-slate-200 p-3"
              >
                <div className="flex items-center gap-3">
                  <span
                    className={`h-2 w-2 rounded-full ${deployment.plugin.status === "error" ? "bg-red-500" : deployment.plugin.status === "running" ? "bg-emerald-500" : "bg-slate-400"}`}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-[#21345f]">
                      {deployment.worker.worker_name}
                    </p>
                    <p
                      className={`mt-0.5 text-[11px] ${deployment.plugin.status === "error" ? "text-red-600" : "text-slate-400"}`}
                    >
                      {deployment.plugin.status}
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled={deployment.worker.status !== "online" || busy}
                    onClick={() => void onToggle(deployment)}
                    className={`rounded-lg border px-2.5 py-1.5 text-[11px] font-semibold disabled:opacity-40 ${deployment.plugin.enabled ? "border-slate-200 text-slate-600" : "border-[#3157e1]/30 text-[#3157e1]"}`}
                  >
                    {busy
                      ? "..."
                      : deployment.plugin.enabled
                        ? locale === "zh"
                          ? "禁用"
                          : "Disable"
                        : locale === "zh"
                          ? "启用"
                          : "Enable"}
                  </button>
                </div>
                {deployment.plugin.error && (
                  <p className="mt-2 rounded-lg bg-red-50 px-2.5 py-2 text-[11px] text-red-700">
                    {deployment.plugin.error}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}

function PluginMetric({
  icon,
  value,
  label,
  green = false,
  red = false,
}: {
  icon: "puzzle" | "pulse" | "warning" | "refresh";
  value: number;
  label: string;
  green?: boolean;
  red?: boolean;
}) {
  const tone = green
    ? "bg-emerald-50 text-emerald-600"
    : red
      ? "bg-rose-50 text-rose-600"
      : "bg-indigo-50 text-[#3157e1]";
  return (
    <article className="capown-card flex items-center gap-4 p-5">
      <span className={`grid h-13 w-13 place-items-center rounded-2xl ${tone}`}>
        <Icon name={icon} className="h-6 w-6" />
      </span>
      <div>
        <p className="text-3xl leading-none font-bold text-[#10214b]">
          {value}
        </p>
        <p className="mt-2 text-sm text-slate-500">{label}</p>
      </div>
    </article>
  );
}
export function MarketplaceView({
  catalog,
  workers,
  locale,
  loading,
  updating,
  onInstall,
}: {
  catalog: PluginCatalog | null;
  workers: WorkerInfo[];
  locale: "zh" | "en";
  loading: boolean;
  updating: string | null;
  onInstall: (entry: CatalogEntry) => void;
}) {
  if (loading) {
    return (
      <div className="mt-12 text-center text-sm text-slate-400">
        {locale === "zh" ? "加载中..." : "Loading..."}
      </div>
    );
  }
  if (!catalog || catalog.plugins.length === 0) {
    return (
      <div className="mt-12 text-center text-sm text-slate-400">
        {locale === "zh"
          ? "插件目录为空，请检查 Master 的 registry 配置。"
          : "Plugin catalog is empty. Check Master registry configuration."}
      </div>
    );
  }
  return (
    <div className="mt-7">
      <p className="mb-5 text-sm text-slate-500">
        {locale === "zh"
          ? "以下插件经官方审核，仅操作 Worker 本地资源，可安全安装到远程 Worker。"
          : "These plugins are officially reviewed. They only access local Worker resources and can be safely installed to remote Workers."}
      </p>
      <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
        {catalog.plugins.map((entry) => {
          const latest = entry.versions[0];
          const installedCount = workers.filter((w) =>
            w.plugins.some((p) => p.plugin_id === entry.plugin_id),
          ).length;
          return (
            <article
              key={entry.plugin_id}
              className="capown-card flex flex-col p-5"
            >
              <div className="flex min-w-0 items-start gap-3">
                <span className="grid h-11 w-11 shrink-0 place-items-center overflow-hidden rounded-xl bg-indigo-50 text-[#3157e1]">
                  <CatalogPluginIcon value={entry.icon} />
                </span>
                <div className="min-w-0 flex-1">
                  <h3 className="truncate font-bold text-[#172b5d]">
                    {entry.display_name || entry.plugin_id}
                  </h3>
                  <p className="mt-0.5 truncate text-xs text-slate-400">
                    v{latest?.version ?? "—"} · {entry.publisher}
                  </p>
                </div>
              </div>
              <p className="mt-3 line-clamp-2 flex-1 text-sm text-slate-500">
                {entry.description}
              </p>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {entry.tags.map((tag) => (
                  <span
                    key={tag}
                    className="rounded-md bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-500"
                  >
                    {tag}
                  </span>
                ))}
              </div>
              <div className="mt-4 flex items-center justify-between border-t border-slate-100 pt-4">
                <span className="text-xs text-slate-400">
                  {installedCount > 0
                    ? locale === "zh"
                      ? `已安装 ${installedCount}/${workers.length} Workers`
                      : `Installed on ${installedCount}/${workers.length} Workers`
                    : locale === "zh"
                      ? "未安装"
                      : "Not installed"}
                </span>
                <button
                  type="button"
                  disabled={workers.length === 0 || !!updating}
                  onClick={() => onInstall(entry)}
                  className="rounded-lg bg-[#3157e1] px-3.5 py-2 text-xs font-semibold text-white hover:bg-[#2647c0] disabled:opacity-40"
                >
                  {locale === "zh" ? "安装" : "Install"}
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}

function CatalogPluginIcon({ value }: { value: string }) {
  const iconNames = {
    folder: "folder",
    key: "key",
    plugins: "plugins",
    puzzle: "puzzle",
    server: "server",
    terminal: "terminal",
  } as const;
  const iconName = iconNames[value.toLowerCase() as keyof typeof iconNames];
  if (iconName) return <Icon name={iconName} className="h-5 w-5" />;
  return (
    <span className="max-w-full truncate text-sm">{value || "Plugin"}</span>
  );
}

export function WorkerPickerModal({
  entry,
  workers,
  locale,
  updating,
  onClose,
  onConfirm,
}: {
  entry: CatalogEntry;
  workers: WorkerInfo[];
  locale: "zh" | "en";
  updating: string | null;
  onClose: () => void;
  onConfirm: (worker: WorkerInfo) => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="mx-4 w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold text-[#10214b]">
            {locale === "zh"
              ? `安装 ${entry.display_name}`
              : `Install ${entry.display_name}`}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100"
          >
            ✕
          </button>
        </div>
        <p className="mt-2 text-sm text-slate-500">
          {locale === "zh"
            ? "选择要安装此插件的 Worker："
            : "Select a Worker to install this plugin:"}
        </p>
        <div className="mt-4 max-h-64 space-y-2 overflow-y-auto">
          {workers.map((worker) => {
            const alreadyInstalled = worker.plugins.some(
              (p) => p.plugin_id === entry.plugin_id,
            );
            const busy =
              updating === `install:${worker.worker_id}:${entry.plugin_id}`;
            return (
              <div
                key={worker.worker_id}
                className="flex items-center gap-3 rounded-xl border border-slate-200 px-4 py-3"
              >
                <span
                  className={`h-2.5 w-2.5 rounded-full ${worker.status === "online" ? "bg-emerald-500" : "bg-slate-300"}`}
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-[#21345f]">
                    {worker.worker_name}
                  </p>
                  <p className="text-[11px] text-slate-400">
                    {worker.status}
                    {alreadyInstalled
                      ? locale === "zh"
                        ? " · 已安装"
                        : " · installed"
                      : ""}
                  </p>
                </div>
                <button
                  type="button"
                  disabled={worker.status !== "online" || busy}
                  onClick={() => onConfirm(worker)}
                  className="rounded-lg bg-[#3157e1] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#2647c0] disabled:opacity-40"
                >
                  {busy
                    ? "..."
                    : alreadyInstalled
                      ? locale === "zh"
                        ? "重新安装"
                        : "Reinstall"
                      : locale === "zh"
                        ? "安装"
                        : "Install"}
                </button>
              </div>
            );
          })}
          {workers.length === 0 && (
            <p className="py-6 text-center text-sm text-slate-400">
              {locale === "zh" ? "没有可用的 Worker" : "No Workers available"}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function aggregatePlugins(workers: WorkerInfo[]): PluginGroup[] {
  const map = new Map<string, PluginGroup>();
  for (const worker of workers)
    for (const plugin of worker.plugins) {
      const current = map.get(plugin.plugin_id);
      if (current) {
        current.deployments.push({ worker, plugin });
        for (const tool of plugin.tools)
          if (!current.tools.some((item) => item.name === tool.name))
            current.tools.push(tool);
      } else
        map.set(plugin.plugin_id, {
          pluginId: plugin.plugin_id,
          version: plugin.version,
          kind: plugin.kind,
          transport: plugin.transport,
          tools: [...plugin.tools],
          deployments: [{ worker, plugin }],
        });
    }
  return [...map.values()].sort((a, b) => a.pluginId.localeCompare(b.pluginId));
}
function filterLabel(filter: Filter, locale: "zh" | "en") {
  const labels =
    locale === "zh"
      ? {
          all: "全部",
          running: "运行中",
          issues: "需要处理",
          disabled: "已禁用",
        }
      : {
          all: "All",
          running: "Running",
          issues: "Needs attention",
          disabled: "Disabled",
        };
  return labels[filter];
}
function wait(milliseconds: number) {
  return new Promise<void>((resolve) =>
    window.setTimeout(resolve, milliseconds),
  );
}
