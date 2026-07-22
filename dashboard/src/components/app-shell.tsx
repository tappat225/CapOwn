"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { Icon, type IconName } from "./icons";
import { useLocale } from "./locale-provider";
import {
  useMasterConnection,
  type MasterConnectionStatus,
} from "./master-connection";
import {
  clearMasterSession,
  loadMasterSession,
  MasterClient,
  type StoredMasterSession,
} from "@/lib/master-client";

type NavItem = { href: string; label: string; icon: IconName };

export function AppShell({
  session,
  children,
}: {
  session: StoredMasterSession;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const { locale, toggleLocale } = useLocale();
  const { status } = useMasterConnection();
  const [loggingOut, setLoggingOut] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  const mainItems: NavItem[] = [
    {
      href: "/dashboard",
      label: locale === "zh" ? "概览" : "Overview",
      icon: "overview",
    },
    { href: "/workers", label: "Workers", icon: "workers" },
    {
      href: "/plugins",
      label: locale === "zh" ? "插件" : "Plugins",
      icon: "plugins",
    },
    {
      href: "/plugins/marketplace",
      label: locale === "zh" ? "插件市场" : "Plugin marketplace",
      icon: "marketplace",
    },
    {
      href: "/access",
      label: locale === "zh" ? "访问凭据" : "Access",
      icon: "access",
    },
  ];
  const adminItems: NavItem[] = [
    {
      href: "/admin/invitations",
      label: locale === "zh" ? "邀请" : "Invitations",
      icon: "invitations",
    },
    {
      href: "/admin/accounts",
      label: locale === "zh" ? "账户" : "Accounts",
      icon: "accounts",
    },
  ];

  async function handleLogout() {
    setLoggingOut(true);
    const stored = loadMasterSession();
    if (stored) {
      await new MasterClient({ origin: stored.masterOrigin }).logout(
        stored.accessToken,
      );
    }
    clearMasterSession();
    window.location.assign("/login");
  }

  return (
    <div className="min-h-screen bg-[var(--page)] lg:grid lg:grid-cols-[236px_minmax(0,1fr)]">
      <aside
        className={`fixed inset-y-0 left-0 z-50 flex w-[236px] flex-col border-r border-slate-200 bg-white transition-transform lg:sticky lg:top-0 lg:h-screen lg:translate-x-0 ${mobileOpen ? "translate-x-0" : "-translate-x-full"}`}
      >
        <div className="flex h-20 items-center justify-between px-6">
          <Link
            href="/dashboard"
            className="flex items-center gap-3 text-[21px] font-bold tracking-tight text-[#0d1d46]"
          >
            <span className="grid h-9 w-9 place-items-center rounded-xl bg-[#3157e1] text-sm font-black text-white shadow-lg shadow-blue-200">
              C
            </span>
            CapOwn
          </Link>
          <button
            type="button"
            onClick={() => setMobileOpen(false)}
            className="rounded-lg p-2 text-slate-500 lg:hidden"
            aria-label="Close navigation"
          >
            <Icon name="close" className="h-5 w-5" />
          </button>
        </div>

        <nav className="flex-1 space-y-1 px-3 pt-4">
          {mainItems.map((item) => (
            <NavLink
              key={item.href}
              item={item}
              active={pathname === item.href}
              onClick={() => setMobileOpen(false)}
            />
          ))}
          {session.user.role === "admin" && (
            <>
              <p className="px-3 pt-6 pb-2 text-[10px] font-bold tracking-[0.16em] text-slate-400 uppercase">
                Administration
              </p>
              {adminItems.map((item) => (
                <NavLink
                  key={item.href}
                  item={item}
                  active={pathname === item.href}
                  onClick={() => setMobileOpen(false)}
                />
              ))}
            </>
          )}
        </nav>

        <div className="space-y-1 border-t border-slate-100 p-3">
          <a
            href="https://github.com/CapOwn"
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-50"
          >
            <Icon name="help" className="h-5 w-5" />
            {locale === "zh" ? "帮助与文档" : "Help & docs"}
          </a>
        </div>
      </aside>

      {mobileOpen && (
        <button
          type="button"
          className="fixed inset-0 z-40 bg-slate-950/35 backdrop-blur-sm lg:hidden"
          onClick={() => setMobileOpen(false)}
          aria-label="Close navigation overlay"
        />
      )}

      <div className="min-w-0">
        <header className="sticky top-0 z-30 flex h-16 items-center border-b border-slate-200 bg-white/90 px-4 backdrop-blur-xl sm:px-7">
          <button
            type="button"
            onClick={() => setMobileOpen(true)}
            className="mr-3 rounded-lg border border-slate-200 p-2 text-slate-600 lg:hidden"
            aria-label="Open navigation"
          >
            <Icon name="workers" className="h-5 w-5" />
          </button>
          <div className="flex min-w-0 items-center gap-3">
            <span className="hidden text-xs font-semibold text-slate-500 sm:inline">
              Master
            </span>
            <span className="hidden h-5 w-px bg-slate-200 sm:block" />
            <span
              className="max-w-[42vw] truncate text-sm font-medium text-[#1a2b56]"
              title={session.masterOrigin}
            >
              {session.masterOrigin}
            </span>
            <span
              className={`hidden items-center gap-1.5 text-xs font-medium sm:flex ${connectionTone(status)}`}
            >
              <span
                className={`h-2 w-2 rounded-full ${connectionDot(status)}`}
              />
              {connectionLabel(status)}
            </span>
          </div>
          <div className="ml-auto flex items-center gap-1 sm:gap-2">
            {session.user.role === "admin" && (
              <span className="inline-flex rounded-lg bg-indigo-50 px-3 py-1.5 text-xs font-semibold text-indigo-700">
                Administrator
              </span>
            )}
            <button
              type="button"
              onClick={toggleLocale}
              className="flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
            >
              <Icon name="globe" className="h-4 w-4" />
              {locale === "zh" ? "EN" : "中文"}
            </button>
            <div className="hidden h-7 w-px bg-slate-200 sm:block" />
            <div className="hidden items-center gap-2 px-2 sm:flex">
              <span className="grid h-8 w-8 place-items-center rounded-full bg-[#132858] text-xs font-bold text-white">
                {session.user.username.slice(0, 2).toUpperCase()}
              </span>
              <span className="max-w-28 truncate text-sm font-medium text-slate-700">
                {session.user.username}
              </span>
            </div>
            <button
              type="button"
              onClick={() => void handleLogout()}
              disabled={loggingOut}
              className="rounded-xl px-3 py-2 text-xs font-medium text-slate-500 hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
            >
              {loggingOut ? "..." : locale === "zh" ? "退出" : "Sign out"}
            </button>
          </div>
        </header>
        {status !== "connected" && (
          <div
            role="status"
            className={`border-b px-4 py-2 text-center text-xs font-medium sm:px-7 ${
              status === "unreachable"
                ? "border-red-200 bg-red-50 text-red-700"
                : "border-amber-200 bg-amber-50 text-amber-700"
            }`}
          >
            {status === "unreachable"
              ? locale === "zh"
                ? "Master 当前不可访问，Dashboard 正在自动重连。"
                : "Master is unreachable. Dashboard is retrying automatically."
              : locale === "zh"
                ? "正在连接 Master…"
                : "Connecting to Master..."}
          </div>
        )}
        <div className="min-w-0">{children}</div>
      </div>
    </div>
  );
}

function connectionLabel(status: MasterConnectionStatus) {
  switch (status) {
    case "connected":
      return "Connected";
    case "reconnecting":
      return "Reconnecting";
    case "unreachable":
      return "Unreachable";
    default:
      return "Connecting";
  }
}

function connectionTone(status: MasterConnectionStatus) {
  if (status === "connected") return "text-emerald-600";
  if (status === "unreachable") return "text-red-600";
  return "text-amber-600";
}

function connectionDot(status: MasterConnectionStatus) {
  if (status === "connected") return "bg-emerald-500";
  if (status === "unreachable") return "bg-red-500";
  return "animate-pulse bg-amber-500";
}

function NavLink({
  item,
  active,
  onClick,
}: {
  item: NavItem;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <Link
      href={item.href}
      onClick={onClick}
      className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold transition ${active ? "bg-gradient-to-r from-[#3157e1] to-[#445ff0] text-white shadow-md shadow-blue-200/70" : "text-slate-600 hover:bg-slate-50 hover:text-[#17316b]"}`}
    >
      <Icon name={item.icon} className="h-5 w-5" />
      {item.label}
    </Link>
  );
}
