"use client";

import { PluginMarketplace } from "@/components/plugin-marketplace";
import { SessionPage } from "@/components/session-page";

export default function PluginMarketplacePage() {
  return (
    <SessionPage>
      {(session) => (
        <PluginMarketplace
          userId={session.user.userId}
          masterOrigin={session.masterOrigin}
          accessToken={session.accessToken}
        />
      )}
    </SessionPage>
  );
}
