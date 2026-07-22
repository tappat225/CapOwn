"use client";

import { PluginCenter } from "@/components/plugin-center";
import { SessionPage } from "@/components/session-page";

export default function PluginsPage() {
  return (
    <SessionPage>
      {(session) => (
        <PluginCenter
          userId={session.user.userId}
          masterOrigin={session.masterOrigin}
          accessToken={session.accessToken}
        />
      )}
    </SessionPage>
  );
}
