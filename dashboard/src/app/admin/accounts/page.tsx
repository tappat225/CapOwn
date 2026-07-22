"use client";

import { AdminUserList } from "@/components/admin-user-list";
import { SessionPage } from "@/components/session-page";

export default function AccountsPage() {
  return (
    <SessionPage requireAdmin>
      {(session) => (
        <AdminUserList
          currentUserId={session.user.userId}
          masterOrigin={session.masterOrigin}
          accessToken={session.accessToken}
        />
      )}
    </SessionPage>
  );
}
