"use client";

import { useMemo, useState } from "react";
import {
  clearMasterSession,
  isSessionInvalidError,
  MasterClient,
  MasterClientError,
  type CreatedClientToken,
  type CreatedWorkerRegistration,
} from "@/lib/master-client";
import { useLocale } from "./locale-provider";

interface CredentialGeneratorProps {
  masterOrigin: string;
  accessToken: string;
  onClientTokenCreated?: () => void;
}

type CredentialKind = "worker" | "client";

export function CredentialGenerator({
  masterOrigin,
  accessToken,
  onClientTokenCreated,
}: CredentialGeneratorProps) {
  const { t } = useLocale();
  const client = useMemo(
    () => new MasterClient({ origin: masterOrigin }),
    [masterOrigin],
  );
  const [workerLabel, setWorkerLabel] = useState("");
  const [clientLabel, setClientLabel] = useState("");
  const [createdWorker, setCreatedWorker] =
    useState<CreatedWorkerRegistration | null>(null);
  const [createdClient, setCreatedClient] = useState<CreatedClientToken | null>(
    null,
  );
  const [acting, setActing] = useState<CredentialKind | null>(null);
  const [copied, setCopied] = useState("");
  const [error, setError] = useState("");

  function redirectToLogin() {
    clearMasterSession();
    window.location.assign("/login");
  }

  function handleError(reason: unknown) {
    if (isSessionInvalidError(reason)) {
      redirectToLogin();
      return;
    }
    setError(
      reason instanceof MasterClientError
        ? reason.message
        : t("credentialCreateError"),
    );
  }

  async function createWorkerRegistration() {
    setActing("worker");
    setError("");
    setCreatedWorker(null);
    try {
      const created = await client.createWorkerRegistration(
        accessToken,
        workerLabel.trim(),
      );
      setCreatedWorker(created);
      setWorkerLabel("");
    } catch (reason) {
      handleError(reason);
    } finally {
      setActing(null);
    }
  }

  async function createClientToken() {
    setActing("client");
    setError("");
    setCreatedClient(null);
    try {
      const created = await client.createClientToken(
        accessToken,
        clientLabel.trim(),
      );
      setCreatedClient(created);
      setClientLabel("");
      onClientTokenCreated?.();
    } catch (reason) {
      handleError(reason);
    } finally {
      setActing(null);
    }
  }

  async function copyValue(key: string, value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
      window.setTimeout(() => setCopied(""), 1800);
    } catch {
      setError(t("copyError"));
    }
  }

  const workerRegisterCommand = createdWorker
    ? `capown-worker register ${masterOrigin.replace(/\/+$/, "")}/v1/worker-registrations/${createdWorker.registration_token}`
    : "";
  const clientConfig = createdClient
    ? `master_url = "${masterOrigin}"\nclient_token = "${createdClient.token}"`
    : "";
  const masterIsLocal = isLocalMasterOrigin(masterOrigin);

  return (
    <main className="mx-auto max-w-[1480px] px-4 py-8 sm:px-7 lg:px-8">
      <div className="max-w-3xl">
        <h1 className="text-3xl font-bold tracking-tight text-[#10214b] sm:text-[34px]">
          {t("credentialsTitle")}
        </h1>
        <p className="mt-1 text-sm leading-6 text-slate-500">
          {t("credentialsHint")}
        </p>
      </div>

      {error && (
        <p className="mt-5 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </p>
      )}

      <div className="mt-7 grid gap-5 lg:grid-cols-2">
        <article className="capown-card min-w-0 p-6">
          <h3 className="text-base font-semibold">{t("workerRegistration")}</h3>
          <p className="mt-1 min-h-12 text-sm leading-6 text-slate-500">
            {t("workerRegistrationHint")}
          </p>
          <label className="mt-5 block">
            <span className="mb-2 block text-xs font-medium text-slate-600">
              {t("workerLabel")}
            </span>
            <input
              value={workerLabel}
              maxLength={120}
              onChange={(event) => setWorkerLabel(event.target.value)}
              placeholder="worker-01"
              className="w-full rounded-xl border bg-slate-50 px-3.5 py-2.5 text-sm outline-none focus:border-[#3157d5] focus:bg-white focus:ring-4 focus:ring-[#3157d5]/10"
            />
          </label>
          <button
            type="button"
            disabled={acting !== null}
            onClick={() => void createWorkerRegistration()}
            className="mt-4 w-full rounded-xl bg-[#3157d5] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#2848b6] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {acting === "worker"
              ? t("creatingWorkerRegistration")
              : t("createWorkerRegistration")}
          </button>

          {createdWorker && (
            <div className="mt-5 border-t pt-4">
              <p className="text-sm font-semibold text-emerald-700">
                {t("workerRegistrationCreated")}
              </p>
              <p className="mt-1 text-xs leading-5 text-slate-500">
                {t("secretShownOnce")}
              </p>
              <div className="mt-3">
                <div className="mb-2 flex items-center justify-between gap-3">
                  <p className="text-xs font-medium text-slate-600">
                    {t("workerRegisterCommand")}
                  </p>
                  <button
                    type="button"
                    onClick={() =>
                      void copyValue("worker-command", workerRegisterCommand)
                    }
                    className="shrink-0 rounded-lg border px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
                  >
                    {copied === "worker-command" ? t("copied") : t("copy")}
                  </button>
                </div>
                <pre className="overflow-x-auto rounded-xl bg-slate-950 p-3 text-xs leading-6 break-all whitespace-pre-wrap text-slate-100">
                  {workerRegisterCommand}
                </pre>
                {masterIsLocal && (
                  <p className="mt-2 text-xs leading-5 text-amber-800">
                    {t("workerRegisterCommandLocalHint")}
                  </p>
                )}
              </div>
              {createdWorker.registration_url ? (
                <SecretValue
                  label={t("registrationUrl")}
                  value={createdWorker.registration_url}
                  copyLabel={copied === "worker-url" ? t("copied") : t("copy")}
                  onCopy={() =>
                    void copyValue(
                      "worker-url",
                      createdWorker.registration_url!,
                    )
                  }
                />
              ) : null}
              <SecretValue
                label={t("registrationToken")}
                value={createdWorker.registration_token}
                copyLabel={copied === "worker-token" ? t("copied") : t("copy")}
                onCopy={() =>
                  void copyValue(
                    "worker-token",
                    createdWorker.registration_token,
                  )
                }
              />
            </div>
          )}
        </article>

        <article className="capown-card min-w-0 p-6">
          <h3 className="text-base font-semibold">{t("clientAccess")}</h3>
          <p className="mt-1 min-h-12 text-sm leading-6 text-slate-500">
            {t("clientAccessHint")}
          </p>
          <label className="mt-5 block">
            <span className="mb-2 block text-xs font-medium text-slate-600">
              {t("clientLabel")}
            </span>
            <input
              value={clientLabel}
              maxLength={120}
              onChange={(event) => setClientLabel(event.target.value)}
              placeholder="mcp-host"
              className="w-full rounded-xl border bg-slate-50 px-3.5 py-2.5 text-sm outline-none focus:border-[#3157d5] focus:bg-white focus:ring-4 focus:ring-[#3157d5]/10"
            />
          </label>
          <button
            type="button"
            disabled={acting !== null}
            onClick={() => void createClientToken()}
            className="mt-4 w-full rounded-xl bg-[#3157d5] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#2848b6] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {acting === "client"
              ? t("creatingClientToken")
              : t("createClientToken")}
          </button>

          {createdClient && (
            <div className="mt-5 border-t pt-4">
              <p className="text-sm font-semibold text-emerald-700">
                {t("clientTokenCreated")}
              </p>
              <p className="mt-1 text-xs leading-5 text-slate-500">
                {t("secretShownOnce")}
              </p>
              <SecretValue
                label={t("masterUrl")}
                value={masterOrigin}
                copyLabel={copied === "master-url" ? t("copied") : t("copy")}
                onCopy={() => void copyValue("master-url", masterOrigin)}
              />
              <SecretValue
                label={t("clientToken")}
                value={createdClient.token}
                copyLabel={copied === "client-token" ? t("copied") : t("copy")}
                onCopy={() =>
                  void copyValue("client-token", createdClient.token)
                }
              />
              <div className="mt-3">
                <div className="mb-2 flex items-center justify-between gap-3">
                  <p className="text-xs font-medium text-slate-600">
                    {t("clientConfig")}
                  </p>
                  <button
                    type="button"
                    onClick={() =>
                      void copyValue("client-config", clientConfig)
                    }
                    className="shrink-0 rounded-lg border px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
                  >
                    {copied === "client-config" ? t("copied") : t("copy")}
                  </button>
                </div>
                <pre className="overflow-x-auto rounded-xl bg-slate-950 p-3 text-xs leading-6 whitespace-pre text-slate-100">
                  {clientConfig}
                </pre>
              </div>
            </div>
          )}
        </article>
      </div>
    </main>
  );
}

function isLocalMasterOrigin(origin: string): boolean {
  try {
    const host = new URL(origin).hostname.toLowerCase();
    return (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "0.0.0.0" ||
      host === "[::1]" ||
      host === "::1"
    );
  } catch {
    return false;
  }
}

function SecretValue({
  label,
  value,
  copyLabel,
  onCopy,
}: {
  label: string;
  value: string;
  copyLabel: string;
  onCopy: () => void;
}) {
  return (
    <div className="mt-3 min-w-0">
      <p className="mb-1.5 text-xs font-medium text-slate-600">{label}</p>
      <div className="flex min-w-0 items-start gap-2">
        <code className="min-w-0 flex-1 overflow-x-auto rounded-lg bg-slate-50 px-3 py-2 text-xs leading-5 break-all text-slate-700">
          {value}
        </code>
        <button
          type="button"
          onClick={onCopy}
          className="shrink-0 rounded-lg border bg-white px-2.5 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50"
        >
          {copyLabel}
        </button>
      </div>
    </div>
  );
}
