#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Sync Worker version metadata for builds.
 *
 * In the monorepo, delegates to scripts/version.mjs sync-worker.
 * Outside the monorepo (e.g. install staging under ~/.capown), succeeds when
 * src/generated/version.ts is already present.
 */

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MONOREPO_VERSION_SCRIPT = resolve(WORKER_ROOT, "../scripts/version.mjs");
const GENERATED_VERSION = resolve(WORKER_ROOT, "src/generated/version.ts");

function main() {
  if (existsSync(MONOREPO_VERSION_SCRIPT)) {
    const result = spawnSync(
      process.execPath,
      [MONOREPO_VERSION_SCRIPT, "sync-worker"],
      { stdio: "inherit", cwd: WORKER_ROOT },
    );
    if (result.error) {
      throw result.error;
    }
    process.exitCode = result.status === null ? 1 : result.status;
    return;
  }

  if (existsSync(GENERATED_VERSION)) {
    console.log(
      "Skipping monorepo version sync; using existing src/generated/version.ts",
    );
    return;
  }

  console.error(
    "Worker version metadata is missing (src/generated/version.ts).\n" +
      "From the repository root, run: node scripts/version.mjs sync-worker",
  );
  process.exitCode = 1;
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
