// SPDX-License-Identifier: Apache-2.0
/** Integration tests for Daemon startup and worker name slug generation. */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
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
    const cases = [
      "my-worker",
      "test-host-01",
      "raspberrypi",
      "localhost",
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
// Daemon initialization
// --------------------------------------------------------------------------

describe("Daemon initialization", () => {
  it("rejects missing worker_id in identity", async () => {
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
      // Identity file missing worker_id and keys -> generates keys but no worker_id
      await assert.rejects(
        () => (daemon as any)._init(),
        /no worker_id found/,
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
      fs.writeFileSync(
        idPath,
        [
          'private_key = "' + "a".repeat(64) + '"',
          'public_key = "' + "b".repeat(64) + '"',
          'worker_id = "wrk_already_registered"',
          'worker_name = "test-worker"',
        ].join("\n"),
        "utf-8",
      );

      const { Daemon } = await import("../src/daemon.js");
      const daemon = new Daemon({
        configPath: cfgPath,
        identityPath: idPath,
      });
      await (daemon as any)._init();
    } finally {
      fs.rmSync(tmp, { force: true, recursive: true });
    }
  });
});
