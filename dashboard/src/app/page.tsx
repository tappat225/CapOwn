"use client";

import { useEffect } from "react";
import { loadMasterSession } from "@/lib/master-client";

export default function HomePage() {
  useEffect(() => {
    window.location.replace(loadMasterSession() ? "/dashboard" : "/login");
  }, []);

  return (
    <main className="grid min-h-screen place-items-center text-sm text-slate-500">
      Loading...
    </main>
  );
}
