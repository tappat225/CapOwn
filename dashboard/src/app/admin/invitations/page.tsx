"use client";

import { AdminInvitationList } from "@/components/admin-invitation-list";
import { SessionPage } from "@/components/session-page";

export default function InvitationsPage() {
  return (
    <SessionPage requireAdmin>
      {(session) => (
        <AdminInvitationList
          masterOrigin={session.masterOrigin}
          accessToken={session.accessToken}
        />
      )}
    </SessionPage>
  );
}
