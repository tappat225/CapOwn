// SPDX-License-Identifier: Apache-2.0

import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { cp, mkdir, readdir, readFile, readlink, rename, rm, writeFile } from "node:fs/promises";
import { get as httpsGet } from "node:https";
import type { IncomingMessage } from "node:http";
import { join, isAbsolute, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { validateManifest } from "./manifest.js";
import type { PluginManifest } from "./types.js";

export interface InstallParams {
  plugin_id: string;
  version: string;
  package_url: string;
  sha256: string;
  manifest: Record<string, unknown>;
}

export interface UninstallParams {
  plugin_id: string;
}

const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024; // 100 MB
const MAX_REDIRECTS = 3;

/**
 * Download, verify, extract, and write the manifest for a plugin.
 * Returns the validated manifest ready for registration.
 */
export async function installPlugin(
  configDir: string,
  params: InstallParams,
  signal?: AbortSignal,
): Promise<PluginManifest> {
  const { plugin_id: pluginId, package_url: packageUrl, sha256 } = params;

  const installDir = join(configDir, "plugins", pluginId);
  const pluginsDir = join(configDir, "plugins.d");
  const workspacePath = join(configDir, "workspace");

  enforceSecurePackageURL(packageUrl);
  enforceSHA256(sha256);

  if (signal?.aborted) {
    throw new Error("install canceled");
  }

  const tempDir = join(tmpdir(), `capown-install-${randomBytes(6).toString("hex")}`);
  await mkdir(tempDir, { recursive: true });
  const archivePath = join(tempDir, `${pluginId}.tar.gz`);
  const extractDir = join(tempDir, "extract");

  try {
    await downloadFile(packageUrl, archivePath, signal);

    const fileBuffer = await readFile(archivePath);
    const hash = createHash("sha256").update(fileBuffer).digest("hex");
    if (hash !== sha256.toLowerCase()) {
      throw new Error(`sha256 mismatch: expected ${sha256}, got ${hash}`);
    }

    // Extract to a temp directory first, then validate members before promoting.
    await mkdir(extractDir, { recursive: true, mode: 0o700 });
    await extractTarGz(archivePath, extractDir, signal);
    await assertNoPathTraversal(extractDir);

    // Promote validated tree into the install directory.
    // Prefer rename; fall back to recursive copy when volumes differ.
    await rm(installDir, { recursive: true, force: true });
    await mkdir(join(configDir, "plugins"), { recursive: true, mode: 0o700 });
    try {
      await rename(extractDir, installDir);
    } catch {
      await cp(extractDir, installDir, { recursive: true });
      await rm(extractDir, { recursive: true, force: true });
    }

    const manifest = renderManifest(params.manifest, installDir, workspacePath);
    enforceCommandPaths(manifest, installDir, workspacePath);

    await mkdir(pluginsDir, { recursive: true, mode: 0o700 });
    const manifestPath = join(pluginsDir, `${pluginId}.json`);
    const tempManifest = `${manifestPath}.tmp-${process.pid}`;
    await writeFile(tempManifest, JSON.stringify(manifest, null, 2) + "\n", {
      encoding: "utf-8",
      mode: 0o600,
    });
    await rename(tempManifest, manifestPath);

    return manifest;
  } catch (err) {
    // Clean partial install directory if promotion failed mid-way.
    await rm(installDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Remove a plugin's manifest and installation directory.
 */
export async function uninstallPlugin(
  configDir: string,
  params: UninstallParams,
): Promise<void> {
  const { plugin_id: pluginId } = params;
  const manifestPath = join(configDir, "plugins.d", `${pluginId}.json`);
  const installDir = join(configDir, "plugins", pluginId);

  await rm(manifestPath, { force: true });
  await rm(installDir, { recursive: true, force: true });
}

function renderManifest(
  template: Record<string, unknown>,
  installDir: string,
  workspacePath: string,
): PluginManifest {
  const json = JSON.stringify(template);
  const rendered = json
    .replace(/\{\{install_dir\}\}/g, installDir.replace(/\\/g, "/"))
    .replace(/\{\{workspace\}\}/g, workspacePath.replace(/\\/g, "/"));
  const raw = JSON.parse(rendered) as Record<string, unknown>;
  return validateManifest(raw);
}

function enforceSecurePackageURL(url: string): void {
  if (!url.startsWith("https://")) {
    throw new Error("package_url must use HTTPS");
  }
}

function enforceSHA256(sha256: string): void {
  if (!sha256 || sha256.length !== 64 || !/^[0-9a-f]+$/i.test(sha256)) {
    throw new Error("sha256 is required and must be a 64-character hex string");
  }
}

function isInsideDir(root: string, target: string): boolean {
  const normalizedRoot = resolve(root);
  const normalizedTarget = resolve(target);
  const rel = relative(normalizedRoot, normalizedTarget);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Walk the extracted tree and reject any member outside destDir.
 * Also rejects symlink/junction members that would escape (via realpath-like resolve).
 */
async function assertNoPathTraversal(root: string): Promise<void> {
  const walk = async (dir: string): Promise<void> => {
    const children = await readdir(dir, { withFileTypes: true });
    for (const child of children) {
      const full = join(dir, child.name);
      if (!isInsideDir(root, full)) {
        throw new Error(`path traversal detected: ${full} is outside ${root}`);
      }
      if (child.isSymbolicLink()) {
        // Resolve the link target relative to its parent and ensure it stays inside root.
        const target = resolve(dir, await readlinkSafe(full));
        if (!isInsideDir(root, target)) {
          throw new Error(`symlink path traversal detected: ${full} -> ${target}`);
        }
      } else if (child.isDirectory()) {
        await walk(full);
      }
    }
  };
  await walk(root);
}

async function readlinkSafe(path: string): Promise<string> {
  return readlink(path);
}

/**
 * Validate that path-like command arguments stay inside installDir or workspace.
 * Interpreters without path separators (e.g. "node") are allowed as argv[0].
 */
function enforceCommandPaths(
  manifest: PluginManifest,
  installDir: string,
  workspacePath: string,
): void {
  for (let i = 0; i < manifest.command.length; i++) {
    const arg = manifest.command[i]!;
    const looksLikePath =
      arg.includes("/") || arg.includes("\\") || arg.startsWith(".") || isAbsolute(arg);

    if (i === 0 && !looksLikePath) {
      // PATH-resolvable interpreter name.
      continue;
    }
    if (!looksLikePath) {
      continue;
    }

    const resolved = resolve(arg);
    if (isInsideDir(installDir, resolved) || isInsideDir(workspacePath, resolved)) {
      continue;
    }
    throw new Error(
      `command argument ${arg} must be inside install directory or workspace`,
    );
  }
}

/**
 * Download a file from an HTTPS URL to a local path.
 * Redirect targets must also be HTTPS.
 */
async function downloadFile(
  url: string,
  destPath: string,
  signal?: AbortSignal,
  redirectsLeft: number = MAX_REDIRECTS,
): Promise<void> {
  if (!url.startsWith("https://")) {
    throw new Error("package_url must use HTTPS");
  }
  if (signal?.aborted) {
    throw new Error("download canceled");
  }

  return new Promise<void>((resolvePromise, reject) => {
    let settled = false;
    const finish = (err?: Error): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      if (err) reject(err);
      else resolvePromise();
    };

    const request = httpsGet(url, (res: IncomingMessage) => {
      if (
        res.statusCode &&
        res.statusCode >= 300 &&
        res.statusCode < 400 &&
        res.headers.location
      ) {
        res.resume();
        if (redirectsLeft <= 0) {
          finish(new Error("too many redirects"));
          return;
        }
        const next = res.headers.location;
        if (!next.startsWith("https://")) {
          finish(new Error("redirect target must use HTTPS"));
          return;
        }
        downloadFile(next, destPath, signal, redirectsLeft - 1).then(
          () => finish(),
          (err: Error) => finish(err),
        );
        return;
      }

      if (res.statusCode !== 200) {
        res.resume();
        finish(new Error(`download failed: HTTP ${res.statusCode}`));
        return;
      }

      const chunks: Buffer[] = [];
      let totalBytes = 0;

      res.on("data", (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes > MAX_DOWNLOAD_BYTES) {
          res.destroy();
          request.destroy();
          finish(new Error("download exceeds size limit"));
          return;
        }
        chunks.push(chunk);
      });

      res.on("end", () => {
        if (signal?.aborted) {
          finish(new Error("download canceled"));
          return;
        }
        void writeFile(destPath, Buffer.concat(chunks), { mode: 0o600 }).then(
          () => finish(),
          (err: Error) => finish(err),
        );
      });

      res.on("error", (err: Error) => {
        finish(err);
      });
    });

    const onAbort = (): void => {
      request.destroy();
      finish(new Error("download canceled"));
    };

    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }

    request.on("error", (err: Error) => {
      finish(err);
    });

    request.setTimeout(60_000, () => {
      request.destroy();
      finish(new Error("download timed out"));
    });
  });
}

/**
 * Extract a .tar.gz archive using the system tar command.
 */
async function extractTarGz(
  archivePath: string,
  destDir: string,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) {
    throw new Error("extraction canceled");
  }

  return new Promise<void>((resolvePromise, reject) => {
    let settled = false;
    const finish = (err?: Error): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      if (err) reject(err);
      else resolvePromise();
    };

    const child = execFile(
      "tar",
      ["-xzf", archivePath, "-C", destDir],
      { timeout: 60_000 },
      (error) => {
        if (error) {
          if (signal?.aborted) {
            finish(new Error("extraction canceled"));
          } else {
            finish(new Error(`extraction failed: ${error.message}`));
          }
        } else {
          finish();
        }
      },
    );

    const onAbort = (): void => {
      child.kill();
      finish(new Error("extraction canceled"));
    };

    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}
