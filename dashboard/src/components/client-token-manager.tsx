"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  clearMasterSession,
  isSessionInvalidError,
  MasterClient,
  MasterClientError,
  type ClientTokenInfo,
} from "@/lib/master-client";
import { Icon } from "./icons";
import { useLocale } from "./locale-provider";

interface ClientTokenManagerProps {
  masterOrigin: string;
  accessToken: string;
  refreshKey?: number;
}

function formatMasterDate(value: string | null, locale: "zh" | "en") {
  if (!value) return null;
  const normalized = value.replace(/(\.\d{3})\d+/, "$1");
  const withTimezone = /(?:z|[+-]\d{2}:?\d{2})$/i.test(normalized)
    ? normalized
    : `${normalized}Z`;
  const parsed = new Date(withTimezone);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(parsed);
}

function statusLabel(
  status: string,
  labels: { active: string; disabled: string; revoked: string },
) {
  if (status === "disabled") return labels.disabled;
  if (status === "revoked") return labels.revoked;
  return labels.active;
}

export function ClientTokenManager({
  masterOrigin,
  accessToken,
  refreshKey = 0,
}: ClientTokenManagerProps) {
  const { locale, t } = useLocale();
  const client = useMemo(
    () => new MasterClient({ origin: masterOrigin }),
    [masterOrigin],
  );
  const [tokens, setTokens] = useState<ClientTokenInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState<string | null>(null);
  const [error, setError] = useState("");

  const redirectToLogin = useCallback(() => {
    clearMasterSession();
    window.location.assign("/login");
  }, []);

  const loadTokens = useCallback(async () => {
    setLoading(true);
    try {
      setTokens(await client.listClientTokens(accessToken));
      setError("");
    } catch (reason) {
      if (isSessionInvalidError(reason)) return redirectToLogin();
      setError(
        reason instanceof MasterClientError
          ? reason.message
          : t("clientTokenLoadError"),
      );
    } finally {
      setLoading(false);
    }
  }, [accessToken, client, redirectToLogin, t]);

  useEffect(() => {
    void loadTokens();
  }, [loadTokens, refreshKey]);

  async function changeStatus(token: ClientTokenInfo) {
    const nextStatus = token.status === "disabled" ? "active" : "disabled";
    if (
      nextStatus === "disabled" &&
      !window.confirm(t("clientTokenDisableWarning"))
    )
      return;

    setActing(token.token_id);
    setError("");
    try {
      const updated = await client.setClientTokenStatus(
        accessToken,
        token.token_id,
        nextStatus,
      );
      setTokens((current) =>
        current.map((item) =>
          item.token_id === token.token_id ? updated : item,
        ),
      );
    } catch (reason) {
      if (isSessionInvalidError(reason)) return redirectToLogin();
      setError(
        reason instanceof MasterClientError
          ? reason.message
          : t("clientTokenUpdateError"),
      );
    } finally {
      setActing(null);
    }
  }

  async function revoke(token: ClientTokenInfo) {
    if (!window.confirm(t("clientTokenRevokeWarning"))) return;

    setActing(token.token_id);
    setError("");
    try {
      await client.revokeClientToken(accessToken, token.token_id);
      setTokens((current) =>
        current.map((item) =>
          item.token_id === token.token_id
            ? {
                ...item,
                status: "revoked",
                revoked_at: new Date().toISOString(),
              }
            : item,
        ),
      );
    } catch (reason) {
      if (isSessionInvalidError(reason)) return redirectToLogin();
      setError(
        reason instanceof MasterClientError
          ? reason.message
          : t("clientTokenRevokeError"),
      );
    } finally {
      setActing(null);
    }
  }

  return (
    <section className="mx-auto max-w-[1480px] px-4 pb-8 sm:px-7 lg:px-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-[#10214b]">
            {t("clientTokenManagement")}
          </h2>
          <p className="mt-1 text-sm leading-6 text-slate-500">
            {t("clientTokenManagementHint")}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void loadTokens()}
          disabled={loading || acting !== null}
          className="rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
        >
          <Icon name="refresh" className="mr-1.5 inline-block h-3.5 w-3.5" />
          {t("refresh")}
        </button>
      </div>

      {error && (
        <p className="mt-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </p>
      )}

      <div className="capown-card mt-5 overflow-hidden">
        {tokens.map((token) => {
          const disabled = token.status === "disabled";
          const revoked = token.status === "revoked";
          const lastUsed = formatMasterDate(token.last_used_at, locale);
          const created = formatMasterDate(token.created_at, locale);

          return (
            <article
              key={token.token_id}
              className="border-b border-slate-100 px-4 py-4 last:border-b-0 sm:px-5"
            >
              <div className="flex flex-wrap items-start gap-4">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="truncate text-sm font-semibold text-slate-800">
                      {token.label || token.token_prefix}
                    </h3>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                        revoked
                          ? "bg-red-50 text-red-700"
                          : disabled
                            ? "bg-amber-50 text-amber-700"
                            : "bg-emerald-50 text-emerald-700"
                      }`}
                    >
                      {statusLabel(token.status, {
                        active: t("clientTokenActive"),
                        disabled: t("clientTokenDisabled"),
                        revoked: t("clientTokenRevoked"),
                      })}
                    </span>
                  </div>
                  <code className="mt-1 block truncate text-xs text-slate-400">
                    {token.token_prefix}
                  </code>
                </div>

                {!revoked && (
                  <div className="flex shrink-0 flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={acting !== null}
                      onClick={() => void changeStatus(token)}
                      className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-40"
                    >
                      {disabled
                        ? t("enableClientToken")
                        : t("disableClientToken")}
                    </button>
                    <button
                      type="button"
                      disabled={acting !== null}
                      onClick={() => void revoke(token)}
                      className="rounded-lg px-3 py-1.5 text-xs font-semibold text-red-600 hover:bg-red-50 disabled:opacity-40"
                    >
                      {t("revokeClientToken")}
                    </button>
                  </div>
                )}
              </div>

              <dl className="mt-4 grid gap-3 text-xs sm:grid-cols-3">
                <div>
                  <dt className="text-slate-400">
                    {t("clientTokenCreatedAt")}
                  </dt>
                  <dd
                    className="mt-1 font-medium text-slate-600"
                    title={token.created_at}
                  >
                    {created ?? t("clientTokenNotRecorded")}
                  </dd>
                </div>
                <div>
                  <dt className="text-slate-400">{t("clientTokenLastUsed")}</dt>
                  <dd
                    className="mt-1 font-medium text-slate-600"
                    title={token.last_used_at ?? undefined}
                  >
                    {lastUsed ?? t("clientTokenNeverUsed")}
                  </dd>
                </div>
                <div>
                  <dt className="text-slate-400">{t("clientTokenLastIp")}</dt>
                  <dd className="mt-1 font-mono font-medium text-slate-600">
                    {token.last_used_ip ?? t("clientTokenNotRecorded")}
                  </dd>
                </div>
              </dl>
            </article>
          );
        })}
        {!loading && tokens.length === 0 && (
          <p className="p-6 text-sm text-slate-400">{t("noClientTokens")}</p>
        )}
        {loading && (
          <p className="p-6 text-sm text-slate-400">{t("loading")}</p>
        )}
      </div>
    </section>
  );
}
