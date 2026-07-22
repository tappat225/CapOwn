"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "./icons";
import { useLocale } from "./locale-provider";
import { useMasterConnection } from "./master-connection";
import {
  clearMasterSession,
  isSessionInvalidError,
  MasterClient,
  MasterClientError,
  type WorkerInfo,
} from "@/lib/master-client";
import { filterWorkersByOwner } from "@/lib/worker-scope";
import {
  formatWorkerCapability,
  summarizeWorkerPlugins,
} from "@/lib/worker-summary";

export function WorkerListClient({
  userId,
  masterOrigin,
  accessToken,
}: {
  userId: string;
  masterOrigin: string;
  accessToken: string;
}) {
  const { locale, t } = useLocale();
  const { refreshRevision } = useMasterConnection();
  const client = useMemo(
    () => new MasterClient({ origin: masterOrigin }),
    [masterOrigin],
  );
  const [workers, setWorkers] = useState<WorkerInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [confirmWorker, setConfirmWorker] = useState<WorkerInfo | null>(null);
  const [confirmName, setConfirmName] = useState("");
  const [revoking, setRevoking] = useState(false);
  const [pluginUpdating, setPluginUpdating] = useState<string | null>(null);

  const redirectToLogin = useCallback(() => {
    clearMasterSession();
    window.location.assign("/login");
  }, []);

  const fetchWorkers = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      try {
        const workerItems = await client.listWorkers(accessToken);
        setWorkers(filterWorkersByOwner(workerItems, userId));
        setError("");
      } catch (reason) {
        if (isSessionInvalidError(reason)) return redirectToLogin();
        setError(
          reason instanceof MasterClientError
            ? reason.message
            : t("fetchError"),
        );
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [accessToken, client, redirectToLogin, t, userId],
  );

  useEffect(() => {
    void fetchWorkers();
    const timer = window.setInterval(() => void fetchWorkers(true), 60_000);
    return () => {
      window.clearInterval(timer);
    };
  }, [fetchWorkers, refreshRevision]);

  const filtered = workers.filter((worker) =>
    `${worker.worker_name} ${worker.hostname} ${worker.os} ${worker.owner_username}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  const selectedWorker =
    workers.find((worker) => worker.worker_id === selectedId) ?? null;
  const online = workers.filter((worker) => worker.status === "online").length;
  const activePlugins = workers.reduce(
    (sum, worker) =>
      sum + worker.plugins.filter((plugin) => plugin.enabled).length,
    0,
  );

  async function togglePlugin(
    worker: WorkerInfo,
    pluginId: string,
    enabled: boolean,
  ) {
    if (!enabled && !window.confirm(t("disablePluginWarning"))) return;
    const key = `${worker.worker_id}:${pluginId}`;
    setPluginUpdating(key);
    try {
      let task = await client.setWorkerPluginEnabled(
        accessToken,
        worker.worker_id,
        pluginId,
        enabled,
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
      await fetchWorkers(true);
    } catch (reason) {
      if (isSessionInvalidError(reason)) return redirectToLogin();
      setError(
        reason instanceof Error ? reason.message : t("pluginUpdateError"),
      );
    } finally {
      setPluginUpdating(null);
    }
  }

  async function revokeWorker() {
    if (!confirmWorker) return;
    setRevoking(true);
    try {
      await client.revokeWorker(accessToken, confirmWorker.worker_id);
      setWorkers((current) =>
        current.filter(
          (worker) => worker.worker_id !== confirmWorker.worker_id,
        ),
      );
      setSelectedId(null);
      setConfirmWorker(null);
      setConfirmName("");
    } catch (reason) {
      if (isSessionInvalidError(reason)) return redirectToLogin();
      setError(reason instanceof Error ? reason.message : t("revokeError"));
    } finally {
      setRevoking(false);
    }
  }

  return (
    <main className="mx-auto max-w-[1480px] px-4 py-8 sm:px-7 lg:px-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-[#10214b] sm:text-[34px]">
            Workers
          </h1>
          <p className="mt-2 text-sm text-slate-500">{t("workerHint")}</p>
        </div>
        <Link
          href="/access"
          className="flex items-center gap-2 rounded-xl bg-[#3157e1] px-4 py-2.5 text-sm font-semibold text-white shadow-lg shadow-blue-200 hover:bg-[#2848b6]"
        >
          <Icon name="plus" className="h-4 w-4" />
          {locale === "zh" ? "注册 Worker" : "Register worker"}
        </Link>
      </div>

      <section className="mt-7 grid gap-4 sm:grid-cols-3">
        <Metric
          icon="server"
          value={workers.length}
          label={locale === "zh" ? "Worker 总数" : "total workers"}
        />
        <Metric
          icon="pulse"
          value={online}
          label={locale === "zh" ? "在线" : "online"}
          green
        />
        <Metric
          icon="puzzle"
          value={activePlugins}
          label={locale === "zh" ? "已启用插件" : "enabled plugins"}
        />
      </section>

      {error && (
        <div className="mt-5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <section className="capown-card mt-6 overflow-hidden">
        <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 p-4">
          <label className="relative min-w-[220px] flex-1 sm:max-w-sm">
            <Icon
              name="search"
              className="pointer-events-none absolute top-2.5 left-3 h-4 w-4 text-slate-400"
            />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={
                locale === "zh" ? "搜索 Worker..." : "Search workers..."
              }
              className="w-full rounded-xl border border-slate-200 bg-slate-50 py-2 pr-3 pl-9 text-sm outline-none focus:border-[#3157e1] focus:bg-white"
            />
          </label>
          <button
            type="button"
            onClick={() => void fetchWorkers()}
            disabled={loading}
            className="flex items-center gap-2 rounded-xl border border-slate-200 px-3.5 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
          >
            <Icon
              name="refresh"
              className={`h-4 w-4 ${loading ? "animate-spin" : ""}`}
            />
            {t("refresh")}
          </button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[980px] text-left text-sm">
            <thead className="bg-slate-50/80 text-[11px] font-semibold tracking-wide text-slate-500 uppercase">
              <tr>
                <th className="px-5 py-3.5">Worker</th>
                <th className="px-4 py-3.5">State</th>
                <th className="px-4 py-3.5">Hostname</th>
                <th className="px-4 py-3.5">OS</th>
                <th className="px-4 py-3.5">Mode</th>
                <th className="px-4 py-3.5">Heartbeat</th>
                <th className="px-4 py-3.5">Plugins</th>
                <th className="w-10 px-3 py-3.5" />
              </tr>
            </thead>
            <tbody>
              {filtered.map((worker) => (
                <tr
                  key={worker.worker_id}
                  onClick={() => setSelectedId(worker.worker_id)}
                  className="cursor-pointer border-t border-slate-100 hover:bg-blue-50/35"
                >
                  <td className="px-5 py-4">
                    <p className="font-bold text-[#172b5d]">
                      {worker.worker_name}
                    </p>
                    <p className="mt-1 font-mono text-[10px] text-slate-400">
                      {shortId(worker.worker_id)}
                    </p>
                  </td>
                  <td className="px-4 py-4">
                    <StateBadge
                      online={worker.status === "online"}
                      locale={locale}
                    />
                  </td>
                  <td className="px-4 py-4">
                    <p className="text-slate-700">{worker.hostname || "—"}</p>
                    <p className="mt-1 max-w-40 truncate text-xs text-slate-400">
                      {worker.workspace || "—"}
                    </p>
                  </td>
                  <td className="px-4 py-4 text-slate-600">
                    {worker.os || "—"}
                  </td>
                  <td className="px-4 py-4 text-slate-600">
                    {worker.mode || "—"}
                  </td>
                  <td className="px-4 py-4">
                    <p className="text-slate-600">
                      {relativeTime(worker.last_heartbeat, locale)}
                    </p>
                    <p className="mt-1 text-[10px] text-slate-400">
                      {formatDate(worker.last_heartbeat, locale)}
                    </p>
                  </td>
                  <td className="px-4 py-4">
                    <PluginSummaryCell
                      plugins={worker.plugins}
                      locale={locale}
                    />
                  </td>
                  <td className="px-3 py-4 text-slate-400">
                    <Icon name="chevron" className="h-4 w-4" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!loading && filtered.length === 0 && (
          <div className="p-12 text-center">
            <span className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-slate-100 text-slate-400">
              <Icon name="server" className="h-6 w-6" />
            </span>
            <p className="mt-3 text-sm font-semibold text-slate-600">
              {query
                ? locale === "zh"
                  ? "没有匹配结果"
                  : "No matching Workers"
                : t("noWorkers")}
            </p>
          </div>
        )}
        <div className="flex items-center justify-between border-t border-slate-200 px-5 py-3 text-xs text-slate-400">
          <span>
            {locale === "zh"
              ? `显示 ${filtered.length} / ${workers.length} 个 Worker`
              : `Showing ${filtered.length} of ${workers.length} Workers`}
          </span>
          <span className="flex items-center gap-2">
            <Icon name="refresh" className="h-3.5 w-3.5" />
            Auto-refresh: 60s
          </span>
        </div>
      </section>

      {selectedWorker && (
        <WorkerDrawer
          worker={selectedWorker}
          locale={locale}
          pluginUpdating={pluginUpdating}
          onClose={() => setSelectedId(null)}
          onToggle={togglePlugin}
          onRevoke={() => {
            setConfirmWorker(selectedWorker);
            setConfirmName("");
          }}
        />
      )}
      {confirmWorker && (
        <ConfirmRevoke
          worker={confirmWorker}
          locale={locale}
          confirmName={confirmName}
          setConfirmName={setConfirmName}
          revoking={revoking}
          onCancel={() => {
            setConfirmWorker(null);
            setConfirmName("");
          }}
          onConfirm={() => void revokeWorker()}
        />
      )}
    </main>
  );
}

function Metric({
  icon,
  value,
  label,
  green = false,
}: {
  icon: "server" | "pulse" | "puzzle";
  value: number;
  label: string;
  green?: boolean;
}) {
  return (
    <article className="flex items-center gap-5 border-r border-slate-200 px-1 py-2 last:border-r-0 sm:px-5">
      <span
        className={`grid h-14 w-14 place-items-center rounded-2xl ${green ? "bg-emerald-50 text-emerald-600" : "bg-indigo-50 text-[#3157e1]"}`}
      >
        <Icon name={icon} className="h-7 w-7" />
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

function WorkerDrawer({
  worker,
  locale,
  pluginUpdating,
  onClose,
  onToggle,
  onRevoke,
}: {
  worker: WorkerInfo;
  locale: "zh" | "en";
  pluginUpdating: string | null;
  onClose: () => void;
  onToggle: (
    worker: WorkerInfo,
    pluginId: string,
    enabled: boolean,
  ) => Promise<void>;
  onRevoke: () => void;
}) {
  return (
    <>
      <button
        type="button"
        className="fixed inset-0 z-40 bg-slate-950/45 backdrop-blur-[2px]"
        onClick={onClose}
        aria-label="Close Worker details"
      />
      <aside className="fixed inset-y-0 right-0 z-50 flex w-full max-w-[470px] flex-col bg-white shadow-2xl">
        <div className="flex items-start justify-between border-b border-slate-200 px-6 py-6">
          <div>
            <h2 className="text-2xl font-bold text-[#10214b]">
              {worker.worker_name}
            </h2>
            <div className="mt-3">
              <StateBadge online={worker.status === "online"} locale={locale} />
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl p-2 text-slate-500 hover:bg-slate-100"
          >
            <Icon name="close" className="h-5 w-5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-6">
          <div className="overflow-hidden rounded-xl border border-slate-200">
            {[
              ["Worker ID", worker.worker_id],
              [locale === "zh" ? "主机" : "Host", worker.hostname || "—"],
              ["OS", worker.os || "—"],
              [locale === "zh" ? "模式" : "Mode", worker.mode || "—"],
              [
                locale === "zh" ? "工作目录" : "Workspace",
                worker.workspace || "—",
              ],
              [
                locale === "zh" ? "最后心跳" : "Last heartbeat",
                formatDate(worker.last_heartbeat, locale),
              ],
            ].map(([label, value]) => (
              <div
                key={label}
                className="grid grid-cols-[120px_1fr] gap-4 border-b border-slate-100 px-4 py-3.5 text-sm last:border-b-0"
              >
                <span className="font-medium text-slate-500">{label}</span>
                <span className="min-w-0 break-all text-[#243864]">
                  {value}
                </span>
              </div>
            ))}
          </div>
          <div className="mt-7">
            <h3 className="text-lg font-bold text-[#142552]">
              {locale === "zh" ? "能力" : "Capabilities"}
            </h3>
            {worker.capabilities.length > 0 ? (
              <div className="mt-3 flex flex-wrap gap-2">
                {worker.capabilities.map((capability) => (
                  <span
                    key={capability}
                    className="rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-1.5 text-xs font-semibold text-indigo-700"
                    title={capability}
                  >
                    {formatWorkerCapability(capability)}
                  </span>
                ))}
              </div>
            ) : (
              <p className="mt-3 text-sm text-slate-400">
                {locale === "zh"
                  ? "此 Worker 尚未上报能力。"
                  : "This Worker has not reported any capabilities."}
              </p>
            )}
          </div>
          <div className="mt-7 flex items-center justify-between">
            <h3 className="text-lg font-bold text-[#142552]">
              {locale === "zh" ? "插件" : "Plugins"}
            </h3>
            <span className="text-xs text-slate-400">
              {worker.plugins.length}
            </span>
          </div>
          <div className="mt-3 overflow-hidden rounded-xl border border-slate-200">
            {worker.plugins.map((plugin) => {
              const busy =
                pluginUpdating === `${worker.worker_id}:${plugin.plugin_id}`;
              return (
                <div
                  key={plugin.plugin_id}
                  className="border-b border-slate-100 p-4 last:border-b-0"
                >
                  <div className="flex items-center gap-3">
                    <span className="grid h-9 w-9 place-items-center rounded-xl bg-indigo-50 text-[#3157e1]">
                      <Icon name="puzzle" className="h-5 w-5" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-bold text-[#1b2e5b]">
                        {plugin.plugin_id}
                      </p>
                      <p
                        className={`mt-1 text-xs font-medium ${plugin.status === "error" ? "text-red-600" : plugin.enabled ? "text-emerald-600" : "text-slate-400"}`}
                      >
                        {plugin.status} · v{plugin.version}
                      </p>
                    </div>
                    <button
                      type="button"
                      disabled={worker.status !== "online" || busy}
                      onClick={() =>
                        void onToggle(worker, plugin.plugin_id, !plugin.enabled)
                      }
                      className={`rounded-lg border px-3 py-1.5 text-xs font-semibold disabled:opacity-40 ${plugin.enabled ? "border-slate-200 text-slate-600 hover:bg-slate-50" : "border-[#3157e1]/30 text-[#3157e1] hover:bg-blue-50"}`}
                    >
                      {busy
                        ? "..."
                        : plugin.enabled
                          ? locale === "zh"
                            ? "禁用"
                            : "Disable"
                          : locale === "zh"
                            ? "启用"
                            : "Enable"}
                    </button>
                  </div>
                  {plugin.error && (
                    <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
                      {plugin.error}
                    </p>
                  )}
                  <details className="mt-3 text-xs text-slate-500">
                    <summary className="cursor-pointer font-medium">
                      {plugin.tools.length} tools
                    </summary>
                    <div className="mt-2 space-y-1">
                      {plugin.tools.map((tool) => (
                        <p
                          key={tool.name}
                          className="rounded-lg bg-slate-50 px-3 py-2 font-mono text-slate-600"
                        >
                          {tool.name}
                        </p>
                      ))}
                    </div>
                  </details>
                </div>
              );
            })}
            {worker.plugins.length === 0 && (
              <p className="p-5 text-sm text-slate-400">
                {locale === "zh"
                  ? "此 Worker 尚未上报插件。"
                  : "This Worker has not reported any plugins."}
              </p>
            )}
          </div>
        </div>
        <div className="border-t border-slate-200 p-5">
          <button
            type="button"
            onClick={onRevoke}
            className="flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-semibold text-red-600 hover:bg-red-50"
          >
            <Icon name="trash" className="h-4 w-4" />
            {locale === "zh" ? "注销 Worker" : "Revoke Worker"}
          </button>
        </div>
      </aside>
    </>
  );
}

function PluginSummaryCell({
  plugins,
  locale,
}: {
  plugins: WorkerInfo["plugins"];
  locale: "zh" | "en";
}) {
  const summary = summarizeWorkerPlugins(plugins);
  return (
    <div className="space-y-1 text-[10px]">
      <p className="font-semibold text-emerald-600">
        {summary.running} {locale === "zh" ? "运行" : "running"}
      </p>
      <p className={summary.issues > 0 ? "text-red-600" : "text-slate-400"}>
        {summary.issues} {locale === "zh" ? "异常" : "issues"}
        <span className="mx-1 text-slate-300">·</span>
        <span className="text-slate-400">
          {summary.disabled} {locale === "zh" ? "禁用" : "disabled"}
        </span>
      </p>
    </div>
  );
}

function ConfirmRevoke({
  worker,
  locale,
  confirmName,
  setConfirmName,
  revoking,
  onCancel,
  onConfirm,
}: {
  worker: WorkerInfo;
  locale: "zh" | "en";
  confirmName: string;
  setConfirmName: (value: string) => void;
  revoking: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[60] grid place-items-center bg-slate-950/45 px-4 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl">
        <span className="grid h-11 w-11 place-items-center rounded-xl bg-red-50 text-red-600">
          <Icon name="warning" className="h-6 w-6" />
        </span>
        <h2 className="mt-4 text-xl font-bold text-[#142552]">
          {locale === "zh" ? "永久注销 Worker" : "Permanently revoke Worker"}
        </h2>
        <p className="mt-2 text-sm leading-6 text-slate-500">
          {locale === "zh"
            ? "Worker 会立即断开，之后必须重新注册才能连接。此操作无法撤销。"
            : "The Worker disconnects immediately and must be registered again. This cannot be undone."}
        </p>
        <label className="mt-5 block text-xs font-semibold text-slate-600">
          {locale === "zh"
            ? `输入 ${worker.worker_name} 以确认`
            : `Type ${worker.worker_name} to confirm`}
          <input
            autoFocus
            value={confirmName}
            onChange={(event) => setConfirmName(event.target.value)}
            className="mt-2 w-full rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-sm outline-none focus:border-red-400"
          />
        </label>
        <div className="mt-6 flex justify-end gap-3">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-semibold text-slate-600"
          >
            {locale === "zh" ? "取消" : "Cancel"}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={confirmName !== worker.worker_name || revoking}
            className="rounded-xl bg-red-600 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-40"
          >
            {revoking
              ? "..."
              : locale === "zh"
                ? "永久注销"
                : "Revoke permanently"}
          </button>
        </div>
      </div>
    </div>
  );
}

function StateBadge({
  online,
  locale,
}: {
  online: boolean;
  locale: "zh" | "en";
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-semibold ${online ? "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200" : "bg-slate-100 text-slate-500 ring-1 ring-slate-200"}`}
    >
      <span
        className={`h-2 w-2 rounded-full ${online ? "bg-emerald-500" : "bg-slate-400"}`}
      />
      {online
        ? locale === "zh"
          ? "在线"
          : "Online"
        : locale === "zh"
          ? "离线"
          : "Offline"}
    </span>
  );
}
function shortId(value: string) {
  return `ID: ${value.length > 10 ? `${value.slice(0, 8)}…` : value}`;
}
function formatDate(value: string | null, locale: "zh" | "en") {
  return value
    ? new Date(value).toLocaleString(locale === "zh" ? "zh-CN" : "en-US")
    : "—";
}
function relativeTime(value: string | null, locale: "zh" | "en") {
  if (!value) return "—";
  const seconds = Math.max(
    0,
    Math.round((Date.now() - new Date(value).getTime()) / 1000),
  );
  if (seconds < 60)
    return locale === "zh" ? `${seconds} 秒前` : `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60)
    return locale === "zh" ? `${minutes} 分钟前` : `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return locale === "zh" ? `${hours} 小时前` : `${hours}h ago`;
}
function wait(milliseconds: number) {
  return new Promise<void>((resolve) =>
    window.setTimeout(resolve, milliseconds),
  );
}
