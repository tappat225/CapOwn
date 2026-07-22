"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  clearMasterSession,
  getStoredMasterOrigin,
  loadMasterSession,
  MasterClient,
  MasterClientError,
  MINIMUM_PASSWORD_LENGTH,
  saveMasterOrigin,
  saveMasterSession,
  type MasterMeta,
} from "@/lib/master-client";

export function LoginForm() {
  const router = useRouter();
  const [masterOrigin, setMasterOrigin] = useState("");
  const [meta, setMeta] = useState<MasterMeta | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [invitationCode, setInvitationCode] = useState("");
  const [authMode, setAuthMode] = useState<"login" | "register">("login");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [checkingSession, setCheckingSession] = useState(true);

  useEffect(() => {
    setMasterOrigin(getStoredMasterOrigin());

    const stored = loadMasterSession();
    if (!stored) {
      setCheckingSession(false);
      return;
    }

    const client = new MasterClient({ origin: stored.masterOrigin });
    client
      .getCurrentUser(stored.accessToken)
      .then(() => router.replace("/dashboard"))
      .catch(() => {
        clearMasterSession();
        setCheckingSession(false);
      });
  }, [router]);

  async function connectToMaster(event?: React.FormEvent) {
    event?.preventDefault();
    setError("");
    setLoading(true);

    try {
      const client = new MasterClient({ origin: masterOrigin });
      const discovered = await client.getMeta();
      setMasterOrigin(client.masterOrigin);
      saveMasterOrigin(client.masterOrigin);
      setMeta(discovered);
    } catch (reason) {
      setError(formatError(reason, "Unable to connect to Master."));
    } finally {
      setLoading(false);
      setCheckingSession(false);
    }
  }

  async function authenticate(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setLoading(true);

    try {
      const client = new MasterClient({ origin: masterOrigin });
      const result = !meta?.initialized
        ? await client.registerFirstUser(username, password)
        : authMode === "register"
          ? await client.registerUser(username, password, invitationCode)
          : await client.login(username, password);
      const user = await client.getCurrentUser(result.accessToken);

      saveMasterOrigin(client.masterOrigin);
      saveMasterSession(client.masterOrigin, { ...result, user });
      router.replace("/dashboard");
    } catch (reason) {
      setError(formatError(reason, "Authentication failed."));
    } finally {
      setLoading(false);
    }
  }

  function resetConnection() {
    setMeta(null);
    setUsername("");
    setPassword("");
    setInvitationCode("");
    setAuthMode("login");
    setError("");
  }

  if (checkingSession) {
    return (
      <main className="grid min-h-screen place-items-center text-sm text-slate-500">
        Checking session...
      </main>
    );
  }

  const firstUser = meta !== null && !meta.initialized;

  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden px-5 py-10">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,#e8edff,transparent_42%),radial-gradient(circle_at_bottom_right,#e9f7f1,transparent_38%)]" />

      <section className="relative z-10 w-full max-w-xl rounded-3xl border bg-white p-7 shadow-[0_24px_80px_rgba(30,41,59,0.12)] sm:p-10">
        <div className="mb-8 flex items-center gap-3">
          <div className="grid h-10 w-10 place-items-center rounded-xl bg-[#3157d5] text-sm font-bold text-white">
            CO
          </div>
          <span className="text-sm font-semibold tracking-wide">
            CapOwn Dashboard
          </span>
        </div>

        <h1 className="text-2xl font-semibold tracking-tight">
          {firstUser
            ? "Initialize your Master"
            : authMode === "register"
              ? "Create your account"
              : "Connect to CapOwn Master"}
        </h1>
        <p className="mt-2 text-sm leading-6 text-slate-500">
          The Dashboard connects directly to the Master you choose. Credentials
          and the web session are handled by that Master.
        </p>

        {!meta ? (
          <form
            onSubmit={(event) => void connectToMaster(event)}
            className="mt-8 space-y-5"
          >
            <Field label="Master URL">
              <input
                type="url"
                required
                autoComplete="url"
                value={masterOrigin}
                onChange={(event) => setMasterOrigin(event.target.value)}
                placeholder="https://master.example.com"
                className="w-full rounded-xl border bg-[#f8fafc] px-3.5 py-3 text-sm outline-none focus:border-[#3157d5] focus:bg-white focus:ring-4 focus:ring-[#3157d5]/10"
              />
            </Field>
            {error && <ErrorMessage>{error}</ErrorMessage>}
            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-xl bg-[#3157d5] px-4 py-3 text-sm font-semibold text-white hover:bg-[#2848b6] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {loading ? "Connecting..." : "Connect"}
            </button>
          </form>
        ) : (
          <form
            onSubmit={(event) => void authenticate(event)}
            className="mt-8 space-y-5"
          >
            <div className="flex items-center justify-between rounded-xl border bg-slate-50 px-3.5 py-3">
              <div className="min-w-0">
                <p className="text-xs text-slate-400">Connected Master</p>
                <p className="truncate font-mono text-sm font-medium text-slate-700">
                  {masterOrigin}
                </p>
                <p className="mt-1 text-xs text-slate-400">
                  Protocol {meta.protocol_version} ·{" "}
                  {meta.initialized ? "initialized" : "not initialized"}
                </p>
              </div>
              <button
                type="button"
                onClick={resetConnection}
                className="shrink-0 text-xs font-medium text-[#3157d5] hover:underline"
              >
                Change
              </button>
            </div>

            <Field label="Username">
              <input
                type="text"
                required
                autoComplete="username"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                className="w-full rounded-xl border bg-[#f8fafc] px-3.5 py-3 text-sm outline-none focus:border-[#3157d5] focus:bg-white focus:ring-4 focus:ring-[#3157d5]/10"
              />
            </Field>

            <Field label="Password">
              <input
                type="password"
                required
                minLength={MINIMUM_PASSWORD_LENGTH}
                autoComplete={
                  firstUser || authMode === "register"
                    ? "new-password"
                    : "current-password"
                }
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                className="w-full rounded-xl border bg-[#f8fafc] px-3.5 py-3 text-sm outline-none focus:border-[#3157d5] focus:bg-white focus:ring-4 focus:ring-[#3157d5]/10"
              />
            </Field>

            {!firstUser && authMode === "register" && (
              <Field label="Invitation code">
                <input
                  type="text"
                  required
                  autoComplete="off"
                  value={invitationCode}
                  onChange={(event) => setInvitationCode(event.target.value)}
                  placeholder="cown_invite_..."
                  className="w-full rounded-xl border bg-[#f8fafc] px-3.5 py-3 font-mono text-sm outline-none focus:border-[#3157d5] focus:bg-white focus:ring-4 focus:ring-[#3157d5]/10"
                />
              </Field>
            )}

            {error && <ErrorMessage>{error}</ErrorMessage>}
            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-xl bg-[#3157d5] px-4 py-3 text-sm font-semibold text-white hover:bg-[#2848b6] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {loading
                ? "Working..."
                : firstUser
                  ? "Create first admin"
                  : authMode === "register"
                    ? "Create account"
                    : "Sign in"}
            </button>
            {!firstUser && (
              <button
                type="button"
                onClick={() => {
                  setAuthMode((current) =>
                    current === "login" ? "register" : "login",
                  );
                  setInvitationCode("");
                  setError("");
                }}
                className="w-full text-center text-sm font-medium text-[#3157d5] hover:underline"
              >
                {authMode === "login"
                  ? "Have an invitation? Create an account"
                  : "Already have an account? Sign in"}
              </button>
            )}
          </form>
        )}
      </section>
    </main>
  );
}

function formatError(reason: unknown, fallback: string): string {
  if (reason instanceof MasterClientError) return reason.message;
  if (reason instanceof Error) return reason.message;
  return fallback;
}

function ErrorMessage({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-red-200 bg-red-50 px-3.5 py-3 text-sm text-red-700">
      {children}
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-2 block text-sm font-medium text-slate-700">
        {label}
      </span>
      {children}
    </label>
  );
}
