"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  clearMasterSession,
  isSessionInvalidError,
  MasterClient,
  MasterClientError,
  type InvitationInfo,
} from "@/lib/master-client";
import { useLocale } from "./locale-provider";
import { useMasterConnection } from "./master-connection";

export function AdminInvitationList({
  masterOrigin,
  accessToken,
}: {
  masterOrigin: string;
  accessToken: string;
}) {
  const { locale, t } = useLocale();
  const { refreshRevision } = useMasterConnection();
  const client = useMemo(
    () => new MasterClient({ origin: masterOrigin }),
    [masterOrigin],
  );
  const [invitations, setInvitations] = useState<InvitationInfo[]>([]);
  const [label, setLabel] = useState("");
  const [createdCode, setCreatedCode] = useState("");
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState<string | null>(null);
  const [error, setError] = useState("");

  const redirectToLogin = useCallback(() => {
    clearMasterSession();
    window.location.assign("/login");
  }, []);

  const loadInvitations = useCallback(async () => {
    try {
      setInvitations(await client.listInvitations(accessToken));
      setError("");
    } catch (reason) {
      if (isSessionInvalidError(reason)) return redirectToLogin();
      setError(
        reason instanceof MasterClientError
          ? reason.message
          : t("invitationLoadError"),
      );
    } finally {
      setLoading(false);
    }
  }, [accessToken, client, redirectToLogin, t]);

  useEffect(() => {
    void loadInvitations();
  }, [loadInvitations, refreshRevision]);

  async function createInvitation() {
    setActing("create");
    setCreatedCode("");
    try {
      const created = await client.createInvitation(accessToken, label.trim());
      setCreatedCode(created.invitation_code);
      setLabel("");
      setInvitations((current) => [created, ...current]);
      setError("");
    } catch (reason) {
      if (isSessionInvalidError(reason)) return redirectToLogin();
      setError(
        reason instanceof MasterClientError
          ? reason.message
          : t("invitationCreateError"),
      );
    } finally {
      setActing(null);
    }
  }

  async function revokeInvitation(invitationId: string) {
    setActing(invitationId);
    try {
      await client.revokeInvitation(accessToken, invitationId);
      setInvitations((current) =>
        current.map((item) =>
          item.invitation_id === invitationId
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
          : t("invitationRevokeError"),
      );
    } finally {
      setActing(null);
    }
  }

  return (
    <main className="mx-auto max-w-[1480px] px-4 py-8 sm:px-7 lg:px-8">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-[#10214b] sm:text-[34px]">
          {t("invitations")}
        </h1>
        <p className="mt-1 text-sm text-slate-500">{t("invitationsHint")}</p>
      </div>

      <div className="capown-card mt-7 flex flex-col gap-3 p-4 sm:flex-row">
        <input
          value={label}
          maxLength={120}
          onChange={(event) => setLabel(event.target.value)}
          placeholder={t("invitationLabel")}
          className="min-w-0 flex-1 rounded-xl border bg-slate-50 px-3.5 py-2.5 text-sm outline-none focus:border-[#3157d5]"
        />
        <button
          type="button"
          disabled={acting !== null}
          onClick={() => void createInvitation()}
          className="rounded-xl bg-[#3157d5] px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
        >
          {acting === "create"
            ? t("creatingInvitation")
            : t("createInvitation")}
        </button>
      </div>

      {createdCode && (
        <div className="mt-4 rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
          <p className="text-sm font-semibold text-emerald-800">
            {t("invitationCreated")}
          </p>
          <p className="mt-1 text-xs text-emerald-700">
            {t("invitationSecretWarning")}
          </p>
          <div className="mt-3 flex items-center gap-2">
            <code className="min-w-0 flex-1 overflow-x-auto rounded-lg bg-white px-3 py-2 text-xs text-slate-700">
              {createdCode}
            </code>
            <button
              type="button"
              onClick={() => void navigator.clipboard.writeText(createdCode)}
              className="rounded-lg border bg-white px-3 py-2 text-xs font-medium text-slate-600"
            >
              {t("copy")}
            </button>
          </div>
        </div>
      )}

      {error && (
        <p className="mt-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </p>
      )}

      <div className="capown-card mt-4 overflow-hidden">
        {invitations.map((invitation) => (
          <div
            key={invitation.invitation_id}
            className="flex flex-wrap items-center gap-3 border-b px-4 py-4 last:border-b-0"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">
                {invitation.label || invitation.code_prefix}
              </p>
              <p className="mt-1 text-xs text-slate-400">
                {invitation.code_prefix} · {invitation.status} · {t("expires")}{" "}
                {new Date(invitation.expires_at).toLocaleString(
                  locale === "zh" ? "zh-CN" : "en-US",
                )}
              </p>
            </div>
            {invitation.status === "active" && (
              <button
                type="button"
                disabled={acting !== null}
                onClick={() => void revokeInvitation(invitation.invitation_id)}
                className="rounded-lg px-3 py-1.5 text-xs font-medium text-red-600 disabled:opacity-40"
              >
                {t("revokeInvitation")}
              </button>
            )}
          </div>
        ))}
        {!loading && invitations.length === 0 && (
          <p className="p-6 text-sm text-slate-400">{t("noInvitations")}</p>
        )}
      </div>
    </main>
  );
}
