"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  clearMasterSession,
  isSessionInvalidError,
  MasterClient,
  MasterClientError,
  type MasterUser,
} from "@/lib/master-client";
import { useLocale } from "./locale-provider";
import { useMasterConnection } from "./master-connection";

export function AdminUserList({
  currentUserId,
  masterOrigin,
  accessToken,
}: {
  currentUserId: string;
  masterOrigin: string;
  accessToken: string;
}) {
  const { t } = useLocale();
  const { refreshRevision } = useMasterConnection();
  const client = useMemo(
    () => new MasterClient({ origin: masterOrigin }),
    [masterOrigin],
  );
  const [users, setUsers] = useState<MasterUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState<string | null>(null);
  const [error, setError] = useState("");

  const redirectToLogin = useCallback(() => {
    clearMasterSession();
    window.location.assign("/login");
  }, []);

  const loadUsers = useCallback(async () => {
    try {
      setUsers(await client.listUsers(accessToken));
      setError("");
    } catch (reason) {
      if (isSessionInvalidError(reason)) {
        redirectToLogin();
        return;
      }
      setError(
        reason instanceof MasterClientError
          ? reason.message
          : t("userLoadError"),
      );
    } finally {
      setLoading(false);
    }
  }, [accessToken, client, redirectToLogin, t]);

  useEffect(() => {
    void loadUsers();
  }, [loadUsers, refreshRevision]);

  async function setStatus(user: MasterUser, status: "active" | "disabled") {
    setActing(user.userId);
    try {
      const updated = await client.setUserStatus(
        accessToken,
        user.username,
        status,
      );
      setUsers((current) =>
        current.map((item) =>
          item.userId === updated.userId ? updated : item,
        ),
      );
    } catch (reason) {
      if (isSessionInvalidError(reason)) return redirectToLogin();
      setError(
        reason instanceof MasterClientError
          ? reason.message
          : t("userUpdateError"),
      );
    } finally {
      setActing(null);
    }
  }

  async function deleteUser(user: MasterUser) {
    if (!window.confirm(t("deleteUserWarning"))) return;
    setActing(user.userId);
    try {
      await client.deleteUser(accessToken, user.username);
      setUsers((current) =>
        current.filter((item) => item.userId !== user.userId),
      );
    } catch (reason) {
      if (isSessionInvalidError(reason)) return redirectToLogin();
      setError(
        reason instanceof MasterClientError
          ? reason.message
          : t("userDeleteError"),
      );
    } finally {
      setActing(null);
    }
  }

  return (
    <main className="mx-auto max-w-[1480px] px-4 py-8 sm:px-7 lg:px-8">
      <div className="mb-5 flex items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-[#10214b] sm:text-[34px]">
            {t("userManagement")}
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            {t("userManagementHint")}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void loadUsers()}
          disabled={loading}
          className="rounded-xl border bg-white px-4 py-2 text-sm font-medium text-slate-600 disabled:opacity-50"
        >
          {t("refresh")}
        </button>
      </div>
      {error && (
        <p className="mb-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </p>
      )}
      <div className="capown-card mt-6 overflow-hidden">
        {users.map((user) => {
          const current = user.userId === currentUserId;
          const disabled = user.status === "disabled";
          const busy = acting === user.userId;
          return (
            <div
              key={user.userId}
              className="flex flex-wrap items-center gap-3 border-b px-4 py-4 last:border-b-0"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold">
                  {user.username}
                </p>
                <p className="mt-1 text-xs text-slate-400">
                  {user.role} · {user.status ?? "active"} · {user.userId}
                </p>
              </div>
              {!current && (
                <>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void setStatus(user, disabled ? "active" : "disabled")
                    }
                    className="rounded-lg border px-3 py-1.5 text-xs font-medium text-slate-600 disabled:opacity-40"
                  >
                    {disabled ? t("enableUser") : t("disableUser")}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void deleteUser(user)}
                    className="rounded-lg px-3 py-1.5 text-xs font-medium text-red-600 disabled:opacity-40"
                  >
                    {t("deleteUser")}
                  </button>
                </>
              )}
            </div>
          );
        })}
        {!loading && users.length === 0 && (
          <p className="p-6 text-sm text-slate-400">{t("noUsers")}</p>
        )}
      </div>
    </main>
  );
}
