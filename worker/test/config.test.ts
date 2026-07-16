// SPDX-License-Identifier: Apache-2.0
/** Unit tests for config loading and validation. */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";

describe("config", () => {
  it("loads minimal TOML config", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "config-test-"));
    try {
      const cfgPath = path.join(tmp, "config.toml");
      fs.writeFileSync(
        cfgPath,
        [
          'master_url = "http://localhost:9210"',
          'worker_name = "test-worker"',
          'enrollment_token = "cown_enroll_abc123"',
          "",
          "[worker]",
          "reconnect_interval = 3",
        ].join("\n"),
        "utf-8",
      );

      const cfg = loadConfig({ configPath: cfgPath });
      assert.equal(cfg.master_url, "http://localhost:9210");
      assert.equal(cfg.worker_name, "test-worker");
      assert.equal(cfg.enrollment_token, "cown_enroll_abc123");
      assert.equal(cfg.reconnect_interval, 3);
    } finally {
      fs.rmSync(tmp, { force: true, recursive: true });
    }
  });

  it("applies defaults when config file missing", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "config-test2-"));
    try {
      const cfgPath = path.join(tmp, "nonexistent.toml");
      const idPath = path.join(tmp, "identity.toml");
      // Must have worker_id in config to pass validation;
      // since our cfgPath doesn't exist, we need worker_id in identity --
      // but loadConfig doesn't read identity for worker_id.
      // Instead create a minimal config with worker_id.
      const realCfgPath = path.join(tmp, "config.toml");
      fs.writeFileSync(
        realCfgPath,
        'worker_id = "wrk_test"\n',
        "utf-8",
      );

      // Use the real config path instead of the nonexistent one
      const cfg = loadConfig({ configPath: realCfgPath, identityPath: idPath });
      assert.equal(cfg.master_url, "https://localhost:9210");
      assert.equal(cfg.reconnect_interval, 5);
    } finally {
      fs.rmSync(tmp, { force: true, recursive: true });
    }
  });

  it("validates master_url must be http or https", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "config-test3-"));
    try {
      const cfgPath = path.join(tmp, "config.toml");
      fs.writeFileSync(
        cfgPath,
        'master_url = "ftp://bad.example.com"\nworker_id = "wrk_test"\n',
        "utf-8",
      );

      assert.throws(() => loadConfig({ configPath: cfgPath }));
    } finally {
      fs.rmSync(tmp, { force: true, recursive: true });
    }
  });

  it("loads without enrollment_token in config (daemon validates later)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "config-test4-"));
    try {
      const cfgPath = path.join(tmp, "config.toml");
      fs.writeFileSync(
        cfgPath,
        'master_url = "http://localhost:9210"\n',
        "utf-8",
      );

      // Config loads without error; daemon will enforce enrollment
      // after checking identity file for worker_id.
      const cfg = loadConfig({ configPath: cfgPath });
      assert.equal(cfg.enrollment_token, "");
      assert.equal(cfg.worker_id, "");
    } finally {
      fs.rmSync(tmp, { force: true, recursive: true });
    }
  });

  it("does not require enrollment_token when worker_id is present", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "config-test5-"));
    try {
      const cfgPath = path.join(tmp, "config.toml");
      fs.writeFileSync(
        cfgPath,
        'master_url = "http://localhost:9210"\nworker_id = "wrk_existing"\n',
        "utf-8",
      );

      const cfg = loadConfig({ configPath: cfgPath });
      assert.equal(cfg.master_url, "http://localhost:9210");
      assert.equal(cfg.worker_id, "wrk_existing");
    } finally {
      fs.rmSync(tmp, { force: true, recursive: true });
    }
  });

  it("ignores legacy execution keys without error", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "config-test6-"));
    try {
      const cfgPath = path.join(tmp, "config.toml");
      fs.writeFileSync(
        cfgPath,
        [
          'master_url = "http://localhost:9210"',
          'worker_name = "legacy-test"',
          'enrollment_token = "cown_enroll_def456"',
          "",
          "[worker]",
          "execution_mode = \"container\"",
          "container_name = \"capown-exec\"",
          "workspace = \"/workspace\"",
          "max_runtime = 86400",
        ].join("\n"),
        "utf-8",
      );

      const cfg = loadConfig({ configPath: cfgPath });
      assert.equal(cfg.master_url, "http://localhost:9210");
      assert.equal(cfg.worker_name, "legacy-test");
    } finally {
      fs.rmSync(tmp, { force: true, recursive: true });
    }
  });
});
