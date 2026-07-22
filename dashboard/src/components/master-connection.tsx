"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  clearMasterSession,
  consumeMasterEventStream,
  isSessionInvalidError,
  MasterClient,
  MasterClientError,
  type StoredMasterSession,
} from "@/lib/master-client";

export type MasterConnectionStatus =
  "connecting" | "connected" | "reconnecting" | "unreachable";

interface MasterConnectionContextValue {
  status: MasterConnectionStatus;
  refreshRevision: number;
}

const MasterConnectionContext =
  createContext<MasterConnectionContextValue | null>(null);

export function MasterConnectionProvider({
  session,
  children,
}: {
  session: StoredMasterSession;
  children: React.ReactNode;
}) {
  const [status, setStatus] = useState<MasterConnectionStatus>("connecting");
  const [refreshRevision, setRefreshRevision] = useState(0);
  const [reconnectRevision, setReconnectRevision] = useState(0);
  const hadConnected = useRef(false);
  const connectionStatus = useRef<MasterConnectionStatus>("connecting");

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        setRefreshRevision((current) => current + 1);
        if (connectionStatus.current !== "connected") {
          setReconnectRevision((current) => current + 1);
        }
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () =>
      document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, []);

  useEffect(() => {
    const client = new MasterClient({ origin: session.masterOrigin });
    const lifecycleController = new AbortController();
    let lastEventId: string | undefined;
    let retryCount = 0;

    const run = async () => {
      while (!lifecycleController.signal.aborted) {
        updateStatus(hadConnected.current ? "reconnecting" : "connecting");
        const attemptController = new AbortController();
        const abortAttempt = () => attemptController.abort();
        lifecycleController.signal.addEventListener("abort", abortAttempt, {
          once: true,
        });

        try {
          const response = await client.openUserEventStream(
            session.accessToken,
            attemptController.signal,
            lastEventId,
          );
          if (lifecycleController.signal.aborted) return;

          const isReconnect = hadConnected.current;
          hadConnected.current = true;
          retryCount = 0;
          updateStatus("connected");
          if (isReconnect) setRefreshRevision((current) => current + 1);

          await consumeMasterEventStream(
            response,
            (event) => {
              if (event.id) lastEventId = event.id;
              setRefreshRevision((current) => current + 1);
            },
            attemptController.signal,
          );

          if (!lifecycleController.signal.aborted) {
            throw new MasterClientError(
              "Master event stream disconnected",
              502,
            );
          }
        } catch (reason) {
          if (lifecycleController.signal.aborted) return;
          if (isSessionInvalidError(reason)) {
            clearMasterSession();
            window.location.assign("/login");
            return;
          }
          updateStatus("unreachable");
          retryCount += 1;
        } finally {
          lifecycleController.signal.removeEventListener("abort", abortAttempt);
          attemptController.abort();
        }

        await waitForRetry(
          Math.min(1000 * 2 ** Math.min(retryCount - 1, 3), 10_000),
          lifecycleController.signal,
        );
      }
    };

    void run();
    return () => lifecycleController.abort();

    function updateStatus(next: MasterConnectionStatus) {
      connectionStatus.current = next;
      setStatus(next);
    }
  }, [reconnectRevision, session.accessToken, session.masterOrigin]);

  const value = useMemo(
    () => ({ status, refreshRevision }),
    [refreshRevision, status],
  );

  return (
    <MasterConnectionContext.Provider value={value}>
      {children}
    </MasterConnectionContext.Provider>
  );
}

export function useMasterConnection(): MasterConnectionContextValue {
  const context = useContext(MasterConnectionContext);
  if (!context) {
    throw new Error(
      "useMasterConnection must be used within MasterConnectionProvider",
    );
  }
  return context;
}

function waitForRetry(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = window.setTimeout(done, milliseconds);
    signal.addEventListener("abort", done, { once: true });

    function done() {
      window.clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}
