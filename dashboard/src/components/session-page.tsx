"use client";

import { useEffect, useState } from "react";
import { AppShell } from "./app-shell";
import { MasterConnectionProvider } from "./master-connection";
import {
  loadMasterSession,
  type StoredMasterSession,
} from "@/lib/master-client";

export function SessionPage({
  children,
  requireAdmin = false,
}: {
  children: (session: StoredMasterSession) => React.ReactNode;
  requireAdmin?: boolean;
}) {
  const [session, setSession] = useState<StoredMasterSession | null>(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    const stored = loadMasterSession();
    if (!stored) {
      window.location.replace("/login");
      return;
    }
    if (requireAdmin && stored.user.role !== "admin") {
      window.location.replace("/dashboard");
      return;
    }
    setSession(stored);
    setChecking(false);
  }, [requireAdmin]);

  if (checking || !session) {
    return (
      <main className="grid min-h-screen place-items-center bg-slate-50 text-sm text-slate-500">
        Loading CapOwn...
      </main>
    );
  }

  return (
    <MasterConnectionProvider session={session}>
      <AppShell session={session}>{children(session)}</AppShell>
    </MasterConnectionProvider>
  );
}
