#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST_PATH = resolve(ROOT, "version.json");
const COMPONENT_NAMES = ["master", "worker", "dashboard"];
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
  if (typeof manifest.protocol_version !== "string") {
    throw new Error("protocol_version must be a string");
  }
  if (!SEMVER_RE.test(manifest.protocol_version)) {
    throw new Error("protocol_version must contain a valid SemVer value");
  }
  if (!manifest.components || typeof manifest.components !== "object") {
    throw new Error("components must be an object");
  }

  for (const name of COMPONENT_NAMES) {
    const component = manifest.components[name];
    if (!component || typeof component.version !== "string") {
      throw new Error(`components.${name}.version must be a string`);
    }
    if (!SEMVER_RE.test(component.version)) {
      throw new Error(`components.${name}.version must contain a valid SemVer value`);
    }
  }

  const dashboardMinimum = manifest.components.dashboard.minimum_protocol_version;
  if (typeof dashboardMinimum !== "string" || !SEMVER_RE.test(dashboardMinimum)) {
    throw new Error(
      "components.dashboard.minimum_protocol_version must contain a valid SemVer value",
    );
  }
  return manifest;
}

function componentVersion(manifest, name) {
  return manifest.components[name].version;
}

function assertEqual(label, actual, expected) {
  if (actual !== expected) {
    throw new Error(
      `${label} is ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`,
    );
  }
}

function syncPackage(componentRoot, version) {
  const packagePath = resolve(ROOT, componentRoot, "package.json");
  const lockPath = resolve(ROOT, componentRoot, "package-lock.json");
  const packageData = readJson(packagePath);
  const lockData = readJson(lockPath);

  packageData.version = version;
  if (!lockData.packages || !lockData.packages[""]) {
    throw new Error(`${componentRoot}/package-lock.json has no root package metadata`);
  }
  lockData.version = version;
  lockData.lockfileVersion = 3;
  lockData.packages[""].version = version;
  writeJsonIfChanged(packagePath, packageData);
  writeJsonIfChanged(lockPath, lockData);
}

function syncWorker(manifest) {
  const version = componentVersion(manifest, "worker");
  syncPackage("worker", version);

  const generatedPath = resolve(ROOT, "worker/src/generated/version.ts");
  mkdirSync(dirname(generatedPath), { recursive: true });
  const generated = `// SPDX-License-Identifier: Apache-2.0
/** Generated from ../../../version.json. Do not edit manually. */

export const WORKER_VERSION = ${JSON.stringify(version)};
export const PROTOCOL_VERSION = ${JSON.stringify(manifest.protocol_version)};
`;
  writeFileSync(generatedPath, generated, "utf8");
}

function syncDashboard(manifest) {
  const version = componentVersion(manifest, "dashboard");
  syncPackage("dashboard", version);

  const generatedPath = resolve(ROOT, "dashboard/src/generated/version.ts");
  mkdirSync(dirname(generatedPath), { recursive: true });
  const generated = `// SPDX-License-Identifier: Apache-2.0
/** Generated from ../../../version.json. Do not edit manually. */

export const DASHBOARD_VERSION = ${JSON.stringify(version)};
export const MINIMUM_PROTOCOL_VERSION = ${JSON.stringify(
    manifest.components.dashboard.minimum_protocol_version,
  )};
`;
  writeFileSync(generatedPath, generated, "utf8");
}

function checkPackage(componentRoot, version) {
  const packageData = readJson(resolve(ROOT, componentRoot, "package.json"));
  const lockData = readJson(resolve(ROOT, componentRoot, "package-lock.json"));
  assertEqual(`${componentRoot}/package.json version`, packageData.version, version);
  assertEqual(`${componentRoot}/package-lock.json version`, lockData.version, version);
  assertEqual(`${componentRoot}/package-lock.json lockfileVersion`, lockData.lockfileVersion, 3);
  assertEqual(
    `${componentRoot}/package-lock.json root version`,
    lockData.packages?.[""]?.version,
    version,
  );
}

function checkGenerated(path, checks, missingMessage) {
  try {
    const generated = readFileSync(path, "utf8");
    for (const [label, pattern, expected] of checks) {
      assertEqual(label, generated.match(pattern)?.[1], expected);
    }
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(missingMessage);
    }
    throw error;
  }
}

function checkWorker(manifest) {
  checkPackage("worker", componentVersion(manifest, "worker"));
  checkGenerated(
    resolve(ROOT, "worker/src/generated/version.ts"),
    [
      [
        "generated Worker version",
        /WORKER_VERSION = "([^"]+)"/,
        componentVersion(manifest, "worker"),
      ],
      [
        "generated Worker protocol version",
        /PROTOCOL_VERSION = "([^"]+)"/,
        manifest.protocol_version,
      ],
    ],
    "Worker generated version is missing; run sync-worker first",
  );
}

function checkDashboard(manifest) {
  checkPackage("dashboard", componentVersion(manifest, "dashboard"));
  checkGenerated(
    resolve(ROOT, "dashboard/src/generated/version.ts"),
    [
      [
        "generated Dashboard version",
        /DASHBOARD_VERSION = "([^"]+)"/,
        componentVersion(manifest, "dashboard"),
      ],
      [
        "generated Dashboard minimum protocol version",
        /MINIMUM_PROTOCOL_VERSION = "([^"]+)"/,
        manifest.components.dashboard.minimum_protocol_version,
      ],
    ],
    "Dashboard generated version is missing; run sync-dashboard first",
  );
}

function check(manifest) {
  checkWorker(manifest);
  checkDashboard(manifest);
  const openapi = readFileSync(resolve(ROOT, "protocol/openapi.yaml"), "utf8");
  const protocolChecks = [
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
  for (const [label, pattern, expected] of protocolChecks) {
    assertEqual(label, openapi.match(pattern)?.[1], expected);
  }
}

function main() {
  const command = process.argv[2] ?? "check";
  const manifest = loadManifest();
  switch (command) {
    case "master":
      console.log(componentVersion(manifest, "master"));
      break;
    case "worker":
      console.log(componentVersion(manifest, "worker"));
      break;
    case "dashboard":
      console.log(componentVersion(manifest, "dashboard"));
      break;
    case "protocol":
      console.log(manifest.protocol_version);
      break;
    case "sync-worker":
      syncWorker(manifest);
      console.log(`Worker version synchronized to ${componentVersion(manifest, "worker")}`);
      break;
    case "sync-dashboard":
      syncDashboard(manifest);
      console.log(
        `Dashboard version synchronized to ${componentVersion(manifest, "dashboard")}`,
      );
      break;
    case "check-dashboard":
      checkDashboard(manifest);
      console.log(
        `Dashboard version metadata is consistent: ${componentVersion(manifest, "dashboard")}`,
      );
      break;
    case "check":
      check(manifest);
      console.log(
        `Version metadata is consistent: protocol ${manifest.protocol_version}, ` +
          `Master ${componentVersion(manifest, "master")}, ` +
          `Worker ${componentVersion(manifest, "worker")}, ` +
          `Dashboard ${componentVersion(manifest, "dashboard")}`,
      );
      break;
    default:
      throw new Error(
        "Usage: node scripts/version.mjs <master|worker|dashboard|protocol|sync-worker|sync-dashboard|check-dashboard|check>",
      );
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
