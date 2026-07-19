// SPDX-License-Identifier: Apache-2.0
/** Tests for the local Worker process control channel. */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  getWorkerProcessInfo,
  readWorkerLogTail,
  requestWorkerStop,
  startRuntimeControl,
} from "../src/service.js";

describe("Worker process control", () => {
  it("reports running state and accepts an authenticated stop request", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "worker-service-test-"));
    const configPath = path.join(directory, "config.toml");
    const identityPath = path.join(directory, "identity.toml");
    fs.writeFileSync(configPath, 'master_url = "http://localhost:9210"\n');
    fs.writeFileSync(identityPath, 'worker_id = "wrk_service_test"\n');
    let stopRequested = false;
    const control = await startRuntimeControl({
      configPath,
      identityPath,
      mode: "foreground",
      onStop: () => {
        stopRequested = true;
      },
    });

    try {
      control.markRunning();
      const running = await getWorkerProcessInfo(configPath);
      assert.equal(running.status, "running");
      assert.equal(running.pid, process.pid);
      assert.equal(running.mode, "foreground");

      await requestWorkerStop(configPath);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(stopRequested, true);
    } finally {
      await control.close();
      fs.rmSync(directory, { force: true, recursive: true });
    }
  });

  it("cleans stale runtime state instead of trusting a reused PID", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "worker-service-stale-"));
    const configPath = path.join(directory, "config.toml");
    fs.writeFileSync(configPath, 'master_url = "http://localhost:9210"\n');
    fs.writeFileSync(
      path.join(directory, "worker-runtime.json"),
      JSON.stringify({
        schema_version: 1,
        instance_id: "stale",
        pid: process.pid,
        started_at: new Date().toISOString(),
        status: "running",
        mode: "background",
        port: 1,
        control_token: "not-valid",
        config_path: configPath,
        identity_path: path.join(directory, "identity.toml"),
        log_path: path.join(directory, "worker.log"),
      }),
    );

    try {
      const status = await getWorkerProcessInfo(configPath);
      assert.equal(status.status, "stopped");
      assert.equal(fs.existsSync(path.join(directory, "worker-runtime.json")), false);
    } finally {
      fs.rmSync(directory, { force: true, recursive: true });
    }
  });
});

describe("Worker logs", () => {
  it("returns only the requested trailing lines", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "worker-log-test-"));
    const logPath = path.join(directory, "worker.log");
    try {
      fs.writeFileSync(logPath, "one\ntwo\nthree\nfour\n", "utf-8");
      assert.equal(readWorkerLogTail(logPath, 2), "three\nfour\n");
      assert.equal(readWorkerLogTail(logPath, 20), "one\ntwo\nthree\nfour\n");
    } finally {
      fs.rmSync(directory, { force: true, recursive: true });
    }
  });
});
