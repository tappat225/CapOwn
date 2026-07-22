import { describe, expect, it } from "vitest";
import type { WorkerInfo } from "../master-client";
import { filterWorkersByOwner } from "../worker-scope";

describe("worker scope", () => {
  it("keeps only workers owned by the current account", () => {
    const workers = [
      { worker_id: "worker-a", owner_user_id: "user-a" },
      { worker_id: "worker-b", owner_user_id: "user-b" },
      { worker_id: "worker-c", owner_user_id: "user-a" },
    ] as WorkerInfo[];

    expect(
      filterWorkersByOwner(workers, "user-a").map((item) => item.worker_id),
    ).toEqual(["worker-a", "worker-c"]);
  });
});
