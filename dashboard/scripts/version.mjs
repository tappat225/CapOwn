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
  for (const field of ["dashboard_version", "minimum_protocol_version"]) {
    if (
      typeof manifest[field] !== "string" ||
      !SEMVER_RE.test(manifest[field])
    ) {
      throw new Error(`${field} must contain a valid SemVer value`);
    }
  }
  return manifest;
}

function sync(manifest) {
  const packagePath = resolve(ROOT, "package.json");
  const lockPath = resolve(ROOT, "package-lock.json");
  const packageData = readJson(packagePath);
  const lockData = readJson(lockPath);

  packageData.version = manifest.dashboard_version;
  if (!lockData.packages || !lockData.packages[""]) {
    throw new Error("package-lock.json has no root package metadata");
  }
  lockData.version = manifest.dashboard_version;
  lockData.packages[""].version = manifest.dashboard_version;
  writeJsonIfChanged(packagePath, packageData);
  writeJsonIfChanged(lockPath, lockData);

  const generatedPath = resolve(ROOT, "src/generated/version.ts");
  mkdirSync(dirname(generatedPath), { recursive: true });
  writeFileSync(
    generatedPath,
    `// SPDX-License-Identifier: Apache-2.0
/** Generated from ../../version.json. Do not edit manually. */

export const DASHBOARD_VERSION = ${JSON.stringify(manifest.dashboard_version)};
export const MINIMUM_PROTOCOL_VERSION = ${JSON.stringify(manifest.minimum_protocol_version)};
`,
    "utf8",
  );
}

function check(manifest) {
  const packageData = readJson(resolve(ROOT, "package.json"));
  const lockData = readJson(resolve(ROOT, "package-lock.json"));
  if (packageData.version !== manifest.dashboard_version) {
    throw new Error(
      `package.json version is ${packageData.version}, expected ${manifest.dashboard_version}`,
    );
  }
  if (lockData.version !== manifest.dashboard_version) {
    throw new Error(
      `package-lock.json version is ${lockData.version}, expected ${manifest.dashboard_version}`,
    );
  }
  if (lockData.packages?.[""]?.version !== manifest.dashboard_version) {
    throw new Error(
      `package-lock.json root version is ${lockData.packages?.[""]?.version}, expected ${manifest.dashboard_version}`,
    );
  }

  const generatedPath = resolve(ROOT, "src/generated/version.ts");
  const generated = readFileSync(generatedPath, "utf8");
  const checks = [
    [
      "generated Dashboard version",
      /DASHBOARD_VERSION = "([^"]+)"/,
      manifest.dashboard_version,
    ],
    [
      "generated minimum protocol version",
      /MINIMUM_PROTOCOL_VERSION = "([^"]+)"/,
      manifest.minimum_protocol_version,
    ],
  ];
  for (const [label, pattern, expected] of checks) {
    const actual = generated.match(pattern)?.[1];
    if (actual !== expected) {
      throw new Error(`${label} is ${actual}, expected ${expected}`);
    }
  }
}

function main() {
  const command = process.argv[2] ?? "check";
  const manifest = loadManifest();
  if (command === "sync") {
    sync(manifest);
    console.log(
      `Dashboard version synchronized to ${manifest.dashboard_version}`,
    );
    return;
  }
  if (command === "check") {
    check(manifest);
    console.log(
      `Version metadata is consistent: Dashboard ${manifest.dashboard_version}, minimum protocol ${manifest.minimum_protocol_version}`,
    );
    return;
  }
  throw new Error("Usage: node scripts/version.mjs <sync|check>");
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
