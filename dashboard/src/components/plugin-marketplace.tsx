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
  type WorkerInfo,
} from "@/lib/master-client";
import { filterWorkersByOwner } from "@/lib/worker-scope";
import { MarketplaceView, WorkerPickerModal } from "./plugin-center";

export function PluginMarketplace({
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
  const [catalog, setCatalog] = useState<PluginCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [updating, setUpdating] = useState<string | null>(null);
  const [installTarget, setInstallTarget] = useState<CatalogEntry | null>(null);

  const redirectToLogin = useCallback(() => {
    clearMasterSession();
    window.location.assign("/login");
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [workerList, catalogResponse] = await Promise.all([
        client.listWorkers(accessToken),
        client.getPluginCatalog(accessToken).catch((reason) => {
          if (isSessionInvalidError(reason)) throw reason;
          return null;
        }),
      ]);
      setWorkers(filterWorkersByOwner(workerList, userId));
      setCatalog(catalogResponse);
      setError("");
    } catch (reason) {
      if (isSessionInvalidError(reason)) return redirectToLogin();
      setError(
        reason instanceof Error ? reason.message : "Unable to load marketplace",
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

  async function installToWorker(entry: CatalogEntry, worker: WorkerInfo) {
    const version = entry.versions[0];
    if (!version) return;
    const key = "install:" + worker.worker_id + ":" + entry.plugin_id;
    setUpdating(key);
    try {
      let task = await client.installPluginToWorker(
        accessToken,
        worker.worker_id,
        entry,
        version,
      );
      const deadline = Date.now() + 300_000;
      while (task.status === "pending" || task.status === "running") {
        if (Date.now() > deadline)
          throw new MasterClientError(t("pluginUpdateTimeout"));
        await wait(1000);
        task = await client.getTask(accessToken, task.task_id);
      }
      if (task.status !== "completed")
        throw new MasterClientError(t("pluginUpdateError"));
      setInstallTarget(null);
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
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-[#10214b] sm:text-[34px]">
            {locale === "zh" ? "插件市场" : "Plugin marketplace"}
          </h1>
          <p className="mt-2 text-sm text-slate-500">
            {locale === "zh"
              ? "浏览可用插件并选择要安装的 Worker。"
              : "Browse available plugins and choose a Worker to install them on."}
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
            className={loading ? "h-4 w-4 animate-spin" : "h-4 w-4"}
          />
          {locale === "zh" ? "刷新" : "Refresh"}
        </button>
      </div>

      {error && (
        <div className="mt-5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <MarketplaceView
        catalog={catalog}
        workers={workers}
        locale={locale}
        loading={loading}
        updating={updating}
        onInstall={(entry) => setInstallTarget(entry)}
      />

      {installTarget && (
        <WorkerPickerModal
          entry={installTarget}
          workers={workers}
          locale={locale}
          updating={updating}
          onClose={() => setInstallTarget(null)}
          onConfirm={(worker) => void installToWorker(installTarget, worker)}
        />
      )}
    </main>
  );
}

function wait(milliseconds: number) {
  return new Promise<void>((resolve) =>
    window.setTimeout(resolve, milliseconds),
  );
}
