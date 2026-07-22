"use client";

import { DashboardOverview } from "@/components/dashboard-overview";
import { SessionPage } from "@/components/session-page";

export default function DashboardPage() {
  return (
    <SessionPage>
      {(session) => (
        <DashboardOverview
          userId={session.user.userId}
          username={session.user.username}
          masterOrigin={session.masterOrigin}
          accessToken={session.accessToken}
          expiresAt={session.expiresAt}
        />
      )}
    </SessionPage>
  );
}
