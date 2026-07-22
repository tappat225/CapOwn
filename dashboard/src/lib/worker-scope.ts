import type { WorkerInfo } from "./master-client";

export function filterWorkersByOwner(
  workers: WorkerInfo[],
  userId: string,
): WorkerInfo[] {
  return workers.filter((worker) => worker.owner_user_id === userId);
}
