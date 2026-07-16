// SPDX-License-Identifier: Apache-2.0
/// <reference types="node" />
/** Worker identity management -- Ed25519 keypair + identity.toml persistence.

Compatible with the Python Worker's identity file format (flat TOML with
hex-encoded raw 32-byte Ed25519 seed as ``private_key``).

PyNaCl stores an Ed25519 private key as the raw 32-byte signing seed.
Node.js ``crypto`` represents it as a PKCS#8 DER-wrapped ``KeyObject``.
This module converts between the two formats.
*/

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

// --------------------------------------------------------------------------
// PKCS#8 DER constants for Ed25519
// --------------------------------------------------------------------------
// PKCS#8 private key info wrapping a raw 32-byte Ed25519 seed:
//   30 2e 02 01 00 30 05 06 03 2b 65 70 04 22 04 20 [32 bytes seed]
// Total: 46 bytes.

const ED25519_PKCS8_PREFIX = Buffer.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06,
  0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);
const PKCS8_HEADER_SIZE = 16; // length of ED25519_PKCS8_PREFIX
const RAW_SEED_SIZE = 32;
const PKCS8_TOTAL = PKCS8_HEADER_SIZE + RAW_SEED_SIZE; // 46

// SPKI for Ed25519 public key:
//   30 2a 30 05 06 03 2b 65 70 03 21 00 [32 bytes public key]
// Total: 44 bytes. Public key at offset 12.

const ED25519_SPKI_PREFIX = Buffer.from([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65,
  0x70, 0x03, 0x21, 0x00,
]);
const SPKI_HEADER_SIZE = 12;
const RAW_PUBKEY_SIZE = 32;

// --------------------------------------------------------------------------
// Identity data
// --------------------------------------------------------------------------

export interface IdentityData {
  privateKeyHex: string; // 64 lowercase hex chars (32 bytes seed)
  publicKeyHex: string; // 64 lowercase hex chars (32 bytes)
  workerId: string;
  workerName: string;
}

// --------------------------------------------------------------------------
// Keypair generation (PyNaCl-compatible raw hex format)
// --------------------------------------------------------------------------

/** Generate a new Ed25519 keypair, returning hex-encoded raw keys. */
export function generateKeypair(): { privateKeyHex: string; publicKeyHex: string } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");

  const privateDer = privateKey.export({ format: "der", type: "pkcs8" });
  // Last 32 bytes of PKCS8 DER are the raw seed
  const rawSeed = privateDer.subarray(PKCS8_HEADER_SIZE);
  const privateKeyHex = Buffer.from(rawSeed).toString("hex");

  const publicDer = publicKey.export({ format: "der", type: "spki" });
  // Raw public key starts at offset 12 in SPKI DER
  const rawPub = publicDer.subarray(SPKI_HEADER_SIZE);
  const publicKeyHex = Buffer.from(rawPub).toString("hex");

  return { privateKeyHex, publicKeyHex };
}

// --------------------------------------------------------------------------
// Format conversion helpers
// --------------------------------------------------------------------------

/** Wrap a raw 32-byte Ed25519 seed into PKCS#8 DER and return a private KeyObject. */
function seedToPrivateKey(seedHex: string): crypto.KeyObject {
  const seed = Buffer.from(seedHex, "hex");
  if (seed.length !== RAW_SEED_SIZE) {
    throw new Error(
      `invalid Ed25519 private key: expected ${RAW_SEED_SIZE} bytes, got ${seed.length}`,
    );
  }
  const der = Buffer.concat([ED25519_PKCS8_PREFIX, seed]);
  return crypto.createPrivateKey({ format: "der", type: "pkcs8", key: der });
}

/** Wrap a raw 32-byte Ed25519 public key into SPKI DER and return a KeyObject. */
function rawPubToPublicKey(pubHex: string): crypto.KeyObject {
  const raw = Buffer.from(pubHex, "hex");
  if (raw.length !== RAW_PUBKEY_SIZE) {
    throw new Error(
      `invalid Ed25519 public key: expected ${RAW_PUBKEY_SIZE} bytes, got ${raw.length}`,
    );
  }
  const der = Buffer.concat([ED25519_SPKI_PREFIX, raw]);
  return crypto.createPublicKey({ format: "der", type: "spki", key: der });
}

// --------------------------------------------------------------------------
// Signing
// --------------------------------------------------------------------------

/** Sign a nonce string with the Ed25519 private key.
 *
 * Returns the hex-encoded signature (128 lowercase hex characters).
 * Compatible with PyNaCl's ``signing_key.sign(nonce_bytes).signature.hex()``.
 */
export function signNonce(privateKeyHex: string, nonce: string): string {
  const privateKey = seedToPrivateKey(privateKeyHex);
  const nonceBytes = Buffer.from(nonce, "utf-8");
  const signature = crypto.sign(null, nonceBytes, privateKey);
  return Buffer.from(signature).toString("hex");
}

// --------------------------------------------------------------------------
// Identity file I/O (flat TOML)
// --------------------------------------------------------------------------

export function parseIdentityFile(filePath: string): IdentityData {
  const result: Record<string, string> = {};
  if (!fs.existsSync(filePath)) {
    return {
      privateKeyHex: "",
      publicKeyHex: "",
      workerId: "",
      workerName: "",
    };
  }
  const raw = fs.readFileSync(filePath, "utf-8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#") || !trimmed) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    // Strip surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    result[key] = val;
  }
  return {
    privateKeyHex: result["private_key"] ?? "",
    publicKeyHex: result["public_key"] ?? "",
    workerId: result["worker_id"] ?? "",
    workerName: result["worker_name"] ?? "",
  };
}

export function writeIdentityFile(filePath: string, data: IdentityData): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Build content preserving unknown keys from existing file
  const existing: Record<string, string> = {};
  if (fs.existsSync(filePath)) {
    const raw = fs.readFileSync(filePath, "utf-8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.startsWith("#") || !trimmed) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      existing[key] = val;
    }
  }

  // Update known keys
  existing["private_key"] = data.privateKeyHex;
  existing["public_key"] = data.publicKeyHex;
  if (data.workerId) existing["worker_id"] = data.workerId;
  if (data.workerName) existing["worker_name"] = data.workerName;

  // Serialize to TOML
  const lines: string[] = [];
  for (const [k, v] of Object.entries(existing)) {
    lines.push(`${k} = "${v}"`);
  }
  const content = lines.join("\n") + "\n";

  // Atomic write: temp file + rename
  const tmpPath = filePath + ".tmp." + crypto.randomBytes(4).toString("hex");
  fs.writeFileSync(tmpPath, content, "utf-8");
  fs.chmodSync(tmpPath, 0o600);
  fs.renameSync(tmpPath, filePath);
}

// --------------------------------------------------------------------------
// Convenience loader
// --------------------------------------------------------------------------

/** Load an existing identity or generate a new keypair.
 *
 * Returns the identity data. If no keypair exists, one is generated
 * and persisted atomically.
 */
export function loadOrGenerateIdentity(filePath: string): IdentityData {
  const identity = parseIdentityFile(filePath);

  if (!identity.privateKeyHex || !identity.publicKeyHex) {
    const generated = generateKeypair();
    identity.privateKeyHex = generated.privateKeyHex;
    identity.publicKeyHex = generated.publicKeyHex;
  }

  // Persist
  writeIdentityFile(filePath, identity);

  return identity;
}

/** Save worker_id and worker_name to the identity file, preserving keys. */
export function saveIdentityIds(
  filePath: string,
  workerId: string,
  workerName: string,
): void {
  const identity = parseIdentityFile(filePath);

  // Generate keypair if missing
  if (!identity.privateKeyHex || !identity.publicKeyHex) {
    const generated = generateKeypair();
    identity.privateKeyHex = generated.privateKeyHex;
    identity.publicKeyHex = generated.publicKeyHex;
  }

  identity.workerId = workerId;
  identity.workerName = workerName;
  writeIdentityFile(filePath, identity);
}
