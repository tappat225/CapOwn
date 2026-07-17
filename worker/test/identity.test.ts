// SPDX-License-Identifier: Apache-2.0
/** Unit tests for identity key generation, signing, and file I/O. */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  generateKeypair,
  signNonce,
  parseIdentityFile,
  writeIdentityFile,
  loadOrGenerateIdentity,
  saveIdentityIds,
  type IdentityData,
} from "../src/identity.js";

describe("identity", () => {
  it("generates valid Ed25519 keypair", () => {
    const keys = generateKeypair();
    assert.equal(keys.privateKeyHex.length, 64);
    assert.equal(keys.publicKeyHex.length, 64);
    assert.match(keys.privateKeyHex, /^[0-9a-f]{64}$/);
    assert.match(keys.publicKeyHex, /^[0-9a-f]{64}$/);
    assert.notEqual(keys.privateKeyHex, keys.publicKeyHex);
  });

  it("signs and verifies nonce", () => {
    const keys = generateKeypair();
    const nonce = "test-nonce-" + Date.now();

    const signature = signNonce(keys.privateKeyHex, nonce);
    assert.equal(signature.length, 128);
    assert.match(signature, /^[0-9a-f]{128}$/);

    const prefix = Buffer.from([
      0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65,
      0x70, 0x03, 0x21, 0x00,
    ]);
    const rawPub = Buffer.from(keys.publicKeyHex, "hex");
    const pubDer = Buffer.concat([prefix, rawPub]);
    const pubKey = crypto.createPublicKey({ format: "der", type: "spki", key: pubDer });

    const ok = crypto.verify(
      null,
      Buffer.from(nonce, "utf-8"),
      pubKey,
      Buffer.from(signature, "hex"),
    );
    assert.ok(ok);
  });

  it("writes and reads identity file", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "identity-test-"));
    try {
      const idPath = path.join(tmp, "identity.toml");

      const data: IdentityData = {
        privateKeyHex: "a".repeat(64),
        publicKeyHex: "b".repeat(64),
        workerId: "wrk_" + "0".repeat(24),
        workerName: "test-worker",
      };
      writeIdentityFile(idPath, data);

      const content = fs.readFileSync(idPath, "utf-8");
      assert.ok(content.includes('private_key = "'));
      assert.ok(content.includes('public_key = "'));
      assert.ok(content.includes('worker_id = "'));
      assert.ok(content.includes('worker_name = "'));

      const parsed = parseIdentityFile(idPath);
      assert.equal(parsed.privateKeyHex, "a".repeat(64));
      assert.equal(parsed.publicKeyHex, "b".repeat(64));
      assert.equal(parsed.workerId, "wrk_" + "0".repeat(24));
      assert.equal(parsed.workerName, "test-worker");
    } finally {
      fs.rmSync(tmp, { force: true, recursive: true });
    }
  });

  it("loadOrGenerateIdentity generates keys when missing", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "identity-test2-"));
    try {
      const idPath = path.join(tmp, "identity.toml");

      const data = loadOrGenerateIdentity(idPath);
      assert.equal(data.privateKeyHex.length, 64);
      assert.equal(data.publicKeyHex.length, 64);
      assert.equal(data.workerId, "");
      assert.equal(data.workerName, "");

      const data2 = loadOrGenerateIdentity(idPath);
      assert.equal(data2.privateKeyHex, data.privateKeyHex);
      assert.equal(data2.publicKeyHex, data.publicKeyHex);
    } finally {
      fs.rmSync(tmp, { force: true, recursive: true });
    }
  });

  it("saveIdentityIds preserves keypair", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "identity-test3-"));
    try {
      const idPath = path.join(tmp, "identity.toml");

      const before = loadOrGenerateIdentity(idPath);

      saveIdentityIds(idPath, "wrk_abc123", "named-worker");

      const after = parseIdentityFile(idPath);
      assert.equal(after.privateKeyHex, before.privateKeyHex);
      assert.equal(after.publicKeyHex, before.publicKeyHex);
      assert.equal(after.workerId, "wrk_abc123");
      assert.equal(after.workerName, "named-worker");
    } finally {
      fs.rmSync(tmp, { force: true, recursive: true });
    }
  });
});
