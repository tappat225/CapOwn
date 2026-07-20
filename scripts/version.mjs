#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST_PATH = resolve(ROOT, "version.json");
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJsonIfChanged(path, value) {
  const original = readFileSync(path, "utf8");
  const newline = original.includes("\r\n") ? "\r\n" : "\n";
  const updated = JSON.stringify(value, null, 2) + newline;
  if (updated !== original) {
    writeFileSync(path, updated, "utf8");
  }
}

function loadManifest() {
  const manifest = readJson(MANIFEST_PATH);
  for (const field of ["product_version", "protocol_version"]) {
    if (
      typeof manifest[field] !== "string" ||
      !SEMVER_RE.test(manifest[field])
    ) {
      throw new Error(`${field} must contain a valid SemVer value`);
    }
  }
  return manifest;
}

function assertEqual(label, actual, expected) {
  if (actual !== expected) {
    throw new Error(`${label} is ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
  }
}

function syncWorker(manifest) {
  const packagePath = resolve(ROOT, "worker/package.json");
  const lockPath = resolve(ROOT, "worker/package-lock.json");
  const packageData = readJson(packagePath);
  const lockData = readJson(lockPath);

  packageData.version = manifest.product_version;
  if (!lockData.packages || !lockData.packages[""]) {
    throw new Error("worker/package-lock.json has no root package metadata");
  }
  lockData.version = manifest.product_version;
  lockData.lockfileVersion = 3;
  lockData.packages[""].version = manifest.product_version;
  writeJsonIfChanged(packagePath, packageData);
  writeJsonIfChanged(lockPath, lockData);

  const generatedPath = resolve(ROOT, "worker/src/generated/version.ts");
  mkdirSync(dirname(generatedPath), { recursive: true });
  const generated = `// SPDX-License-Identifier: Apache-2.0
/** Generated from ../../../version.json. Do not edit manually. */

export const PRODUCT_VERSION = ${JSON.stringify(manifest.product_version)};
export const PROTOCOL_VERSION = ${JSON.stringify(manifest.protocol_version)};
`;
  writeFileSync(generatedPath, generated, "utf8");
}

function check(manifest) {
  const packageData = readJson(resolve(ROOT, "worker/package.json"));
  const lockData = readJson(resolve(ROOT, "worker/package-lock.json"));
  assertEqual("worker/package.json version", packageData.version, manifest.product_version);
  assertEqual("worker/package-lock.json version", lockData.version, manifest.product_version);
  assertEqual("worker/package-lock.json lockfileVersion", lockData.lockfileVersion, 3);
  assertEqual(
    "worker/package-lock.json root version",
    lockData.packages?.[""]?.version,
    manifest.product_version,
  );

  const openapi = readFileSync(resolve(ROOT, "protocol/openapi.yaml"), "utf8");
  const checks = [
    ["OpenAPI info.version", /^  version: ([^\r\n]+)$/m, manifest.protocol_version],
    [
      "OpenAPI x-capown-protocol-version",
      /^  x-capown-protocol-version: "([^"]+)"$/m,
      manifest.protocol_version,
    ],
    [
      "OpenAPI MetaResponse protocol_version",
      /^        protocol_version:\r?\n^          type: string\r?\n^          const: "([^"]+)"$/m,
      manifest.protocol_version,
    ],
  ];
  for (const [label, pattern, expected] of checks) {
    const match = openapi.match(pattern);
    assertEqual(label, match?.[1], expected);
  }

  const generatedPath = resolve(ROOT, "worker/src/generated/version.ts");
  try {
    const generated = readFileSync(generatedPath, "utf8");
    assertEqual(
      "generated Worker product version",
      generated.match(/PRODUCT_VERSION = "([^"]+)"/)?.[1],
      manifest.product_version,
    );
    assertEqual(
      "generated Worker protocol version",
      generated.match(/PROTOCOL_VERSION = "([^"]+)"/)?.[1],
      manifest.protocol_version,
    );
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error("Worker generated version is missing; run sync-worker first");
    }
    throw error;
  }
}

function main() {
  const command = process.argv[2] ?? "check";
  const manifest = loadManifest();
  switch (command) {
    case "product":
      console.log(manifest.product_version);
      break;
    case "protocol":
      console.log(manifest.protocol_version);
      break;
    case "sync-worker":
      syncWorker(manifest);
      console.log(`Worker version synchronized to ${manifest.product_version}`);
      break;
    case "check":
      check(manifest);
      console.log(
        `Version metadata is consistent: product ${manifest.product_version}, protocol ${manifest.protocol_version}`,
      );
      break;
    default:
      throw new Error("Usage: node scripts/version.mjs <product|protocol|sync-worker|check>");
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
