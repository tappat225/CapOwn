"use client";

import { CredentialGenerator } from "@/components/credential-generator";
import { ClientTokenManager } from "@/components/client-token-manager";
import { SessionPage } from "@/components/session-page";
import { useState } from "react";

export default function AccessPage() {
  const [clientTokenRefreshKey, setClientTokenRefreshKey] = useState(0);

  return (
    <SessionPage>
      {(session) => (
        <>
          <CredentialGenerator
            masterOrigin={session.masterOrigin}
            accessToken={session.accessToken}
            onClientTokenCreated={() =>
              setClientTokenRefreshKey((current) => current + 1)
            }
          />
          <ClientTokenManager
            masterOrigin={session.masterOrigin}
            accessToken={session.accessToken}
            refreshKey={clientTokenRefreshKey}
          />
        </>
      )}
    </SessionPage>
  );
}
