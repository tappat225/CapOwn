"use client";

import Link from "next/link";
import { useState } from "react";
import { useLocale } from "./locale-provider";
import {
  clearMasterSession,
  loadMasterSession,
  MasterClient,
} from "@/lib/master-client";

interface NavProps {
  user: {
    username: string;
    role: string;
  };
  masterOrigin: string;
}

export function Nav({ user, masterOrigin }: NavProps) {
  const { t, toggleLocale } = useLocale();
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState("");

  async function handleLogout() {
    setLoggingOut(true);
    setLogoutError("");
    try {
      const session = loadMasterSession();
      if (session) {
        await new MasterClient({ origin: session.masterOrigin }).logout(
          session.accessToken,
        );
      }
      clearMasterSession();
      window.location.assign("/login");
    } catch {
      setLogoutError(t("logoutError"));
      setLoggingOut(false);
    }
  }

  return (
    <header className="sticky top-0 z-30 border-b bg-white/90 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-7xl items-center gap-6 px-4 sm:px-6">
        <Link href="/dashboard" className="flex shrink-0 items-center gap-2.5">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-[#3157d5] text-[11px] font-bold text-white">
            CO
          </span>
          <span className="hidden text-sm font-semibold sm:inline">CapOwn</span>
        </Link>

        <div className="ml-auto flex min-w-0 items-center gap-2 sm:gap-3">
          <div className="hidden min-w-0 text-right lg:block">
            <p className="max-w-64 truncate text-xs font-medium text-slate-700">
              {masterOrigin}
            </p>
            <p className="text-[11px] text-slate-400">{t("connectedMaster")}</p>
          </div>
          <button
            type="button"
            onClick={toggleLocale}
            className="rounded-lg border px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
          >
            {t("language")}
          </button>
          <div className="hidden h-8 w-px bg-slate-200 sm:block" />
          <div className="hidden text-right sm:block">
            <p className="text-xs font-medium text-slate-700">
              {user.username}
            </p>
            <p className="text-[11px] text-slate-400 capitalize">{user.role}</p>
          </div>
          <button
            type="button"
            onClick={handleLogout}
            disabled={loggingOut}
            className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-slate-500 hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
          >
            {loggingOut ? t("signingOut") : t("signOut")}
          </button>
          {logoutError && (
            <span className="absolute top-14 right-4 rounded-lg border border-red-200 bg-white px-3 py-2 text-xs text-red-600 shadow-lg">
              {logoutError}
            </span>
          )}
        </div>
      </div>
    </header>
  );
}
