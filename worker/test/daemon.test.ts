// SPDX-License-Identifier: Apache-2.0
/** Integration tests for Daemon startup and worker name slug generation. */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { getEventListeners } from "node:events";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeWorkerNameSlug } from "../src/daemon.js";

// --------------------------------------------------------------------------
// Worker name slug (exported from daemon.ts for testing)
// --------------------------------------------------------------------------

describe("makeWorkerNameSlug", () => {
  it("lowercases and filters hostname", () => {
    assert.equal(makeWorkerNameSlug("My-Host"), "my-host");
    assert.equal(makeWorkerNameSlug("UPPERCASE"), "uppercase");
  });

  it("handles Windows-style hostnames", () => {
    // Windows hostnames can be uppercase with hyphens
    assert.equal(makeWorkerNameSlug("DESKTOP-ABC123"), "desktop-abc123");
    assert.equal(makeWorkerNameSlug("MY-PC-01"), "my-pc-01");
  });

  it("replaces non-ASCII characters with hyphens", () => {
    const slug = makeWorkerNameSlug("my-host-\u4e2d\u6587");
    assert.ok(!slug.includes("\u4e2d"));
    assert.ok(slug.startsWith("my-host"));
  });

  it("replaces punctuation-only hostname with fallback", () => {
    const slug = makeWorkerNameSlug("...");
    // Should use fallback "worker" or similar
    assert.ok(slug.length >= 3);
    assert.match(slug, /^[a-z0-9]/);
  });

  it("pads short names to minimum length", () => {
    const slug = makeWorkerNameSlug("ab");
    assert.ok(slug.length >= 3);
  });

  it("truncates long names", () => {
    const slug = makeWorkerNameSlug("a" + "x".repeat(60));
    assert.ok(slug.length <= 48);
  });

  it("handles reserved names", () => {
    assert.notEqual(makeWorkerNameSlug("master"), "master");
    assert.notEqual(makeWorkerNameSlug("admin"), "admin");
    assert.notEqual(makeWorkerNameSlug("self"), "self");
    assert.notEqual(makeWorkerNameSlug("none"), "none");
  });

  it("handles wrk_ prefix", () => {
    // Names starting with wrk_ must be rejected by adding a prefix
    const slug = makeWorkerNameSlug("wrk_test");
    assert.ok(!slug.startsWith("wrk_"), slug + " should not start with wrk_");
  });

  it("collapses multiple hyphens", () => {
    const slug = makeWorkerNameSlug("a---b");
    assert.equal(slug, "a-b");
  });

  it("strips leading/trailing non-alphanumeric chars", () => {
    assert.equal(makeWorkerNameSlug("-hello-"), "hello");
    assert.equal(makeWorkerNameSlug("_world_"), "world");
  });

  it("matches Python slug behavior for typical hostnames", () => {
    // These should produce valid worker names (ASCII slug 3-48 chars)
    const cases = [
      "my-worker",       // already valid
      "test-host-01",    // already valid
      "raspberrypi",     // typical Linux hostname
      "localhost",       // dev hostname
    ];
    for (const host of cases) {
      const slug = makeWorkerNameSlug(host);
      assert.match(
        slug,
        /^[a-z0-9][a-z0-9._-]{1,46}[a-z0-9]$/,
        `slug '${slug}' from '${host}' does not match worker name pattern`,
      );
    }
  });
});

// --------------------------------------------------------------------------
// Daemon initialization (config + identity loading)
// --------------------------------------------------------------------------

interface InitializableDaemon {
  _init(): Promise<void>;
}

interface TestableDaemon extends InitializableDaemon {
  _authenticate(): Promise<boolean>;
  _sleep(ms: number): Promise<void>;
  _abort: AbortController;
  _client: {
    sessionToken: string;
    enroll(token: string, name: string, key: string): Promise<{
      workerId: string;
      workerName: string;
    } | null>;
    authenticate(workerId: string, privateKey: string): Promise<string | null>;
  };
}

describe("Daemon initialization", () => {
  it("rejects missing enrollment_token and worker_id", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-test-"));
    try {
      const cfgPath = path.join(tmp, "config.toml");
      const idPath = path.join(tmp, "identity.toml");
      fs.writeFileSync(
        cfgPath,
        'master_url = "http://localhost:9210"\n',
        "utf-8",
      );

      const { Daemon } = await import("../src/daemon.js");
      const daemon = new Daemon({
        configPath: cfgPath,
        identityPath: idPath,
      });
      await assert.rejects(
        () => (daemon as unknown as InitializableDaemon)._init(),
        /enrollment_token is required/,
      );
    } finally {
      fs.rmSync(tmp, { force: true, recursive: true });
    }
  });

  it("accepts existing worker_id in identity", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-test2-"));
    try {
      const cfgPath = path.join(tmp, "config.toml");
      const idPath = path.join(tmp, "identity.toml");
      fs.writeFileSync(
        cfgPath,
        'master_url = "http://localhost:9210"\n',
        "utf-8",
      );
      // Identity with a worker_id: no enrollment_token needed
      fs.writeFileSync(
        idPath,
        'worker_id = "wrk_already_enrolled"\n',
        "utf-8",
      );

      const { Daemon } = await import("../src/daemon.js");
      const daemon = new Daemon({
        configPath: cfgPath,
        identityPath: idPath,
      });
      await (daemon as unknown as InitializableDaemon)._init();
    } finally {
      fs.rmSync(tmp, { force: true, recursive: true });
    }
  });

  it("fails enrollment when worker identity cannot be persisted", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-persist-test-"));
    const cfgPath = path.join(tmp, "config.toml");
    const idPath = path.join(tmp, "identity.toml");
    try {
      fs.writeFileSync(
        cfgPath,
        [
          'master_url = "http://localhost:9210"',
          'worker_name = "persist-test"',
          'enrollment_token = "cown_enroll_test"',
        ].join("\n") + "\n",
        "utf-8",
      );
      const { Daemon } = await import("../src/daemon.js");
      const daemon = new Daemon({ configPath: cfgPath, identityPath: idPath });
      const testable = daemon as unknown as TestableDaemon;
      await testable._init();
      testable._client = {
        sessionToken: "",
        enroll: async () => ({
          workerId: "wrk_persist_test",
          workerName: "persist-test",
        }),
        authenticate: async () => "cown_sess_should_not_be_reached",
      };

      fs.rmSync(tmp, { force: true, recursive: true });
      fs.writeFileSync(tmp, "blocks identity directory", "utf-8");

      await assert.rejects(
        () => testable._authenticate(),
        /identity persistence failed/,
      );
    } finally {
      fs.rmSync(tmp, { force: true, recursive: true });
    }
  });

  it("removes abort listeners after a completed retry sleep", async () => {
    const { Daemon } = await import("../src/daemon.js");
    const testable = new Daemon({}) as unknown as TestableDaemon;
    await testable._sleep(1);
    assert.equal(getEventListeners(testable._abort.signal, "abort").length, 0);
  });
});
