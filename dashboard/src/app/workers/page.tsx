"use client";

import { SessionPage } from "@/components/session-page";
import { WorkerListClient } from "@/components/worker-list";

export default function WorkersPage() {
  return (
    <SessionPage>
      {(session) => (
        <WorkerListClient
          userId={session.user.userId}
          masterOrigin={session.masterOrigin}
          accessToken={session.accessToken}
        />
      )}
    </SessionPage>
  );
}
