"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon, type IconName } from "./icons";
import { useLocale } from "./locale-provider";
import { useMasterConnection } from "./master-connection";
import {
  clearMasterSession,
  isSessionInvalidError,
  MasterClient,
  type WorkerInfo,
} from "@/lib/master-client";
import { filterWorkersByOwner } from "@/lib/worker-scope";

interface DashboardOverviewProps {
  userId: string;
  username: string;
  masterOrigin: string;
  accessToken: string;
  expiresAt: string;
}

export function DashboardOverview(props: DashboardOverviewProps) {
  const { locale } = useLocale();
  const { refreshRevision } = useMasterConnection();
  const client = useMemo(
    () => new MasterClient({ origin: props.masterOrigin }),
    [props.masterOrigin],
  );
  const [workers, setWorkers] = useState<WorkerInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const workerItems = await client.listWorkers(props.accessToken);
      setWorkers(filterWorkersByOwner(workerItems, props.userId));
      setError("");
    } catch (reason) {
      if (isSessionInvalidError(reason)) {
        clearMasterSession();
        window.location.assign("/login");
        return;
      }
      setError(
        reason instanceof Error ? reason.message : "Unable to load overview",
      );
    } finally {
      setLoading(false);
    }
  }, [client, props.accessToken, props.userId]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 60_000);
    return () => window.clearInterval(timer);
  }, [load, refreshRevision]);

  const online = workers.filter((worker) => worker.status === "online").length;
  const pluginInstances = workers.reduce(
    (total, worker) => total + worker.plugins.length,
    0,
  );
  const runningPlugins = workers.reduce(
    (total, worker) =>
      total +
      worker.plugins.filter((plugin) => plugin.status === "running").length,
    0,
  );
  const stats = [
    {
      label: locale === "zh" ? "Worker 总数" : "total workers",
      value: workers.length,
      icon: "server" as IconName,
      tone: "blue",
    },
    {
      label: locale === "zh" ? "在线" : "online",
      value: online,
      icon: "pulse" as IconName,
      tone: "green",
    },
    {
      label: locale === "zh" ? "插件实例" : "plugin instances",
      value: pluginInstances,
      icon: "puzzle" as IconName,
      tone: "violet",
    },
    {
      label: locale === "zh" ? "运行中" : "running",
      value: runningPlugins,
      icon: "check" as IconName,
      tone: "green",
    },
  ];

  return (
    <main className="mx-auto max-w-[1480px] px-4 py-8 sm:px-7 lg:px-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-[#10214b] sm:text-[34px]">
            {locale === "zh"
              ? `你好，${props.username}`
              : `Hello, ${props.username}`}
          </h1>
          <p className="mt-2 text-sm text-slate-500">
            {locale === "zh"
              ? "这是你的 CapOwn 环境当前状态。"
              : "Here is the current state of your CapOwn environment."}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-600 shadow-sm hover:bg-slate-50 disabled:opacity-50"
        >
          <Icon
            name="refresh"
            className={`h-4 w-4 ${loading ? "animate-spin" : ""}`}
          />
          {locale === "zh" ? "刷新" : "Refresh"}
        </button>
      </div>

      {error && (
        <div className="mt-5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <section className="mt-7 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {stats.map((stat) => (
          <StatCard key={stat.label} {...stat} loading={loading} />
        ))}
      </section>

      <section className="capown-card mt-5 overflow-hidden">
        <div className="flex flex-wrap items-center gap-x-12 gap-y-3 px-5 py-3 text-sm">
          <HealthItem
            color="bg-emerald-500"
            value={online}
            label={locale === "zh" ? "在线" : "Online"}
          />
          <HealthItem
            color="bg-slate-400"
            value={Math.max(workers.length - online, 0)}
            label={locale === "zh" ? "离线" : "Offline"}
          />
          <HealthItem
            color="bg-rose-500"
            value={workers.reduce(
              (sum, worker) =>
                sum +
                worker.plugins.filter((plugin) => plugin.status === "error")
                  .length,
              0,
            )}
            label={locale === "zh" ? "插件异常" : "Plugin errors"}
          />
          <span className="ml-auto text-xs text-slate-400">
            {locale === "zh" ? "会话到期" : "Session expires"}:{" "}
            {new Date(props.expiresAt).toLocaleString(
              locale === "zh" ? "zh-CN" : "en-US",
            )}
          </span>
        </div>
      </section>

      <section className="capown-card mt-5 overflow-hidden">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
          <div>
            <h2 className="text-lg font-bold text-[#142552]">Workers</h2>
          </div>
          <Link
            href="/workers"
            className="rounded-lg border border-[#3157e1]/40 px-3 py-2 text-xs font-semibold text-[#3157e1] hover:bg-blue-50"
          >
            {locale === "zh" ? "查看全部" : "View all workers"}
          </Link>
        </div>
        <WorkerPreview
          workers={workers.slice(0, 5)}
          loading={loading}
          locale={locale}
        />
      </section>

      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <QuickCard
          icon="key"
          title={locale === "zh" ? "连接新的 Worker" : "Connect a new Worker"}
          detail={
            locale === "zh"
              ? "创建一次性注册链接，将节点安全接入当前 Master。"
              : "Create a one-time registration link for a new node."
          }
          href="/access"
          action={locale === "zh" ? "创建凭据" : "Create credential"}
        />
        <QuickCard
          icon="puzzle"
          title={locale === "zh" ? "插件中心" : "Plugin Center"}
          detail={
            locale === "zh"
              ? "跨 Worker 查看插件部署、运行状态与工具。"
              : "Inspect deployments, runtime state, and tools across Workers."
          }
          href="/plugins"
          action={locale === "zh" ? "管理插件" : "Manage plugins"}
        />
      </div>
    </main>
  );
}

function StatCard({
  label,
  value,
  icon,
  tone,
  loading,
}: {
  label: string;
  value: number;
  icon: IconName;
  tone: string;
  loading: boolean;
}) {
  const tones: Record<string, string> = {
    blue: "bg-indigo-50 text-[#3157e1]",
    green: "bg-emerald-50 text-emerald-600",
    violet: "bg-violet-50 text-violet-600",
    amber: "bg-amber-50 text-amber-600",
  };
  return (
    <article className="capown-card flex items-center gap-5 p-5">
      <span
        className={`grid h-14 w-14 place-items-center rounded-2xl ${tones[tone]}`}
      >
        <Icon name={icon} className="h-7 w-7" />
      </span>
      <div>
        <p className="text-3xl leading-none font-bold text-[#10214b]">
          {loading ? "—" : value}
        </p>
        <p className="mt-2 text-sm text-slate-500">{label}</p>
      </div>
    </article>
  );
}

function HealthItem({
  color,
  value,
  label,
}: {
  color: string;
  value: number;
  label: string;
}) {
  return (
    <span className="flex items-center gap-2 text-slate-600">
      <span className={`h-2.5 w-2.5 rounded-full ${color}`} />
      <strong className="text-[#142552]">{value}</strong>
      {label}
    </span>
  );
}

function WorkerPreview({
  workers,
  loading,
  locale,
}: {
  workers: WorkerInfo[];
  loading: boolean;
  locale: "zh" | "en";
}) {
  if (loading && workers.length === 0)
    return <p className="p-8 text-center text-sm text-slate-400">Loading...</p>;
  if (workers.length === 0)
    return (
      <p className="p-8 text-center text-sm text-slate-400">
        {locale === "zh" ? "暂无 Worker" : "No Workers yet"}
      </p>
    );
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[780px] text-left text-sm">
        <thead className="bg-slate-50/70 text-[11px] font-semibold tracking-wide text-slate-500 uppercase">
          <tr>
            <th className="px-5 py-3">Worker</th>
            <th className="px-4 py-3">State</th>
            <th className="px-4 py-3">Host</th>
            <th className="px-4 py-3">OS</th>
            <th className="px-4 py-3">Plugins</th>
            <th className="px-4 py-3">Heartbeat</th>
          </tr>
        </thead>
        <tbody>
          {workers.map((worker) => (
            <tr key={worker.worker_id} className="border-t border-slate-100">
              <td className="px-5 py-3.5 font-semibold text-[#172b5d]">
                {worker.worker_name}
              </td>
              <td className="px-4 py-3.5">
                <StateBadge
                  online={worker.status === "online"}
                  locale={locale}
                />
              </td>
              <td className="px-4 py-3.5 text-slate-600">
                {worker.hostname || "—"}
              </td>
              <td className="px-4 py-3.5 text-slate-600">{worker.os || "—"}</td>
              <td className="px-4 py-3.5 text-slate-600">
                {worker.plugins.length}
              </td>
              <td className="px-4 py-3.5 text-slate-500">
                {relativeTime(worker.last_heartbeat, locale)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
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

function QuickCard({
  icon,
  title,
  detail,
  href,
  action,
}: {
  icon: IconName;
  title: string;
  detail: string;
  href: string;
  action: string;
}) {
  return (
    <article className="capown-card flex items-center gap-4 p-5">
      <span className="grid h-14 w-14 shrink-0 place-items-center rounded-2xl bg-indigo-50 text-[#3157e1]">
        <Icon name={icon} className="h-7 w-7" />
      </span>
      <div className="min-w-0 flex-1">
        <h3 className="font-bold text-[#142552]">{title}</h3>
        <p className="mt-1 text-sm leading-5 text-slate-500">{detail}</p>
      </div>
      <Link
        href={href}
        className="shrink-0 rounded-xl bg-[#3157e1] px-4 py-2.5 text-xs font-semibold text-white hover:bg-[#2848b6]"
      >
        {action}
      </Link>
    </article>
  );
}

function relativeTime(value: string | null, locale: "zh" | "en"): string {
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
