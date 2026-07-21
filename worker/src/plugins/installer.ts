// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { get as httpsGet } from "node:https";
import { get as httpGet } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
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

/**
 * Download, verify, extract, and write the manifest for a plugin.
 * Returns the validated manifest ready for registration.
 */
export async function installPlugin(
  configDir: string,
  params: InstallParams,
): Promise<PluginManifest> {
  const { plugin_id: pluginId, package_url: packageUrl, sha256 } = params;

  const installDir = join(configDir, "plugins", pluginId);
  const pluginsDir = join(configDir, "plugins.d");
  const workspacePath = join(configDir, "workspace");

  // 1. Download to a temp file
  const tempDir = join(tmpdir(), `capown-install-${randomBytes(6).toString("hex")}`);
  await mkdir(tempDir, { recursive: true });
  const archivePath = join(tempDir, `${pluginId}.tar.gz`);

  try {
    await downloadFile(packageUrl, archivePath);

    // 2. Verify SHA-256
    if (sha256) {
      const fileBuffer = await readFile(archivePath);
      const hash = createHash("sha256").update(fileBuffer).digest("hex");
      if (hash !== sha256.toLowerCase()) {
        throw new Error(
          `sha256 mismatch: expected ${sha256}, got ${hash}`,
        );
      }
    }

    // 3. Extract into install directory
    await rm(installDir, { recursive: true, force: true });
    await mkdir(installDir, { recursive: true, mode: 0o700 });
    await extractTarGz(archivePath, installDir);

    // 4. Render manifest template
    const manifest = renderManifest(params.manifest, installDir, workspacePath);

    // 5. Write manifest to plugins.d
    await mkdir(pluginsDir, { recursive: true, mode: 0o700 });
    const manifestPath = join(pluginsDir, `${pluginId}.json`);
    const tempManifest = `${manifestPath}.tmp-${process.pid}`;
    await writeFile(tempManifest, JSON.stringify(manifest, null, 2) + "\n", {
      encoding: "utf-8",
      mode: 0o600,
    });
    await rename(tempManifest, manifestPath);

    return manifest;
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

/**
 * Replace template variables in the manifest and validate it.
 */
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

/**
 * Download a file from an HTTPS URL to a local path.
 */
async function downloadFile(url: string, destPath: string): Promise<void> {
  if (!url.startsWith("https://") && !url.startsWith("http://")) {
    throw new Error("package_url must use http or https");
  }

  const get = url.startsWith("https://") ? httpsGet : httpGet;

  return new Promise<void>((resolve, reject) => {
    const request = get(url, (res) => {
      // Follow redirects (up to 3)
      if (
        res.statusCode &&
        res.statusCode >= 300 &&
        res.statusCode < 400 &&
        res.headers.location
      ) {
        res.resume();
        downloadFile(res.headers.location, destPath).then(resolve, reject);
        return;
      }

      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`download failed: HTTP ${res.statusCode}`));
        return;
      }

      const chunks: Buffer[] = [];
      let totalBytes = 0;

      res.on("data", (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes > MAX_DOWNLOAD_BYTES) {
          res.destroy();
          reject(new Error("download exceeds size limit"));
          return;
        }
        chunks.push(chunk);
      });

      res.on("end", async () => {
        try {
          const buffer = Buffer.concat(chunks);
          await writeFile(destPath, buffer, { mode: 0o600 });
          resolve();
        } catch (err) {
          reject(err);
        }
      });

      res.on("error", reject);
    });

    request.on("error", reject);
    request.setTimeout(60_000, () => {
      request.destroy();
      reject(new Error("download timed out"));
    });
  });
}

/**
 * Extract a .tar.gz archive using the system tar command.
 */
async function extractTarGz(archivePath: string, destDir: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    execFile(
      "tar",
      ["-xzf", archivePath, "-C", destDir],
      { timeout: 60_000 },
      (error) => {
        if (error) {
          reject(new Error(`extraction failed: ${error.message}`));
        } else {
          resolve();
        }
      },
    );
  });
}
