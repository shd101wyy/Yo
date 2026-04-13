/**
 * Version cache management for Yo.
 *
 * Downloads and caches specific versions of `@shd101wyy/yo` from the npm registry.
 * Cached versions are stored in `~/.cache/yo/versions/<version>/`.
 *
 * Download flow:
 *   1. Fetch package metadata from npm registry
 *   2. Get the tarball URL for the specified version
 *   3. Download and extract the tarball
 *   4. Move contents from `package/` (npm's tarball root) to the version directory
 */

import { execFileSync } from "child_process";
import * as fs from "fs";
import * as https from "https";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { getGlobalVersionsCacheDir, getVersionCacheDir } from "./cache";

const NPM_PACKAGE_NAME = "@shd101wyy/yo";
const NPM_REGISTRY_URL = "https://registry.npmjs.org";

/**
 * Check if a specific Yo version is already cached locally.
 */
export function isVersionCached(version: string): boolean {
  const versionDir = getVersionCacheDir(version);
  if (
    !fs.existsSync(versionDir) ||
    !fs.existsSync(path.join(versionDir, "package.json"))
  ) {
    return false;
  }

  // Check if dependencies need to be installed
  try {
    const pkgJson = JSON.parse(
      fs.readFileSync(path.join(versionDir, "package.json"), "utf-8")
    );
    if (
      pkgJson.dependencies &&
      Object.keys(pkgJson.dependencies).length > 0 &&
      !fs.existsSync(path.join(versionDir, "node_modules"))
    ) {
      return false; // Dependencies not yet installed
    }
  } catch {
    // If we can't read package.json, consider it invalid
    return false;
  }

  return true;
}

/**
 * List all locally cached Yo versions.
 * Returns sorted array of version strings.
 */
export function listCachedVersions(): string[] {
  const versionsDir = getGlobalVersionsCacheDir();
  if (!fs.existsSync(versionsDir)) {
    return [];
  }

  return fs
    .readdirSync(versionsDir)
    .filter((entry) => {
      const entryPath = path.join(versionsDir, entry);
      return (
        fs.statSync(entryPath).isDirectory() &&
        fs.existsSync(path.join(entryPath, "package.json"))
      );
    })
    .sort(compareSemver);
}

/**
 * Remove a specific cached version, or all cached versions.
 */
export function cleanVersionCache(version?: string): void {
  if (version) {
    const versionDir = getVersionCacheDir(version);
    if (fs.existsSync(versionDir)) {
      fs.rmSync(versionDir, { recursive: true, force: true });
    }
  } else {
    const versionsDir = getGlobalVersionsCacheDir();
    if (fs.existsSync(versionsDir)) {
      fs.rmSync(versionsDir, { recursive: true, force: true });
    }
  }
}

/**
 * Ensure a specific Yo version is cached. Downloads if not present.
 * Returns the path to the cached version directory.
 */
export async function ensureCachedVersion(version: string): Promise<string> {
  if (isVersionCached(version)) {
    return getVersionCacheDir(version);
  }

  return downloadVersion(version);
}

/**
 * Download a specific Yo version from the npm registry and cache it.
 * Returns the path to the cached version directory.
 */
export async function downloadVersion(version: string): Promise<string> {
  // 1. Fetch package metadata to get the tarball URL
  const tarballUrl = await fetchTarballUrl(version);

  // 2. Create version cache directory
  const versionDir = getVersionCacheDir(version);
  fs.mkdirSync(versionDir, { recursive: true });

  // 3. Download tarball to a temp file
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "yo-version-"));
  const tarballPath = path.join(tmpDir, `yo-${version}.tgz`);

  try {
    console.log(`Downloading Yo v${version} from npm...`);
    await downloadFile(tarballUrl, tarballPath);

    // 4. Extract tarball
    // npm tarballs contain a `package/` root directory
    execFileSync("tar", ["xzf", tarballPath, "-C", tmpDir], {
      stdio: "pipe",
    });

    // 5. Move contents from package/ to version directory
    const extractedDir = path.join(tmpDir, "package");
    if (!fs.existsSync(extractedDir)) {
      throw new Error(
        `Unexpected tarball structure: no 'package/' directory found.`
      );
    }

    // Remove any existing partial extraction
    if (fs.existsSync(versionDir)) {
      fs.rmSync(versionDir, { recursive: true, force: true });
    }

    // Move extracted package to version cache
    fs.renameSync(extractedDir, versionDir);

    // 6. Install production dependencies (older versions may need external packages like yargs)
    installDependencies(versionDir);

    console.log(`Installed Yo v${version} to ${versionDir}`);

    return versionDir;
  } catch (err) {
    // Clean up on failure
    if (fs.existsSync(versionDir)) {
      fs.rmSync(versionDir, { recursive: true, force: true });
    }
    throw err;
  } finally {
    // Clean up temp directory
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Fetch the tarball URL for a specific version from the npm registry.
 */
async function fetchTarballUrl(version: string): Promise<string> {
  const url = `${NPM_REGISTRY_URL}/${encodeURIComponent(NPM_PACKAGE_NAME)}/${version}`;

  const body = await httpGet(url);
  let data: { dist?: { tarball?: string }; error?: string };

  try {
    data = JSON.parse(body);
  } catch {
    throw new Error(
      `Failed to parse npm registry response for version ${version}.`
    );
  }

  if (data.error) {
    // npm returns { error: "Not found" } for non-existent versions
    throw new Error(
      `Yo version ${version} is not available on npm.\n` +
        `Run \`yo version list --remote\` or check https://www.npmjs.com/package/@shd101wyy/yo`
    );
  }

  const tarball = data.dist?.tarball;
  if (!tarball) {
    throw new Error(
      `No tarball URL found for @shd101wyy/yo@${version} in npm registry.`
    );
  }

  return tarball;
}

/**
 * Fetch all available versions of @shd101wyy/yo from the npm registry.
 * Returns sorted array of version strings.
 */
export async function fetchRemoteVersions(): Promise<string[]> {
  const url = `${NPM_REGISTRY_URL}/${encodeURIComponent(NPM_PACKAGE_NAME)}`;

  const body = await httpGet(url);
  let data: { versions?: Record<string, unknown> };

  try {
    data = JSON.parse(body);
  } catch {
    throw new Error("Failed to parse npm registry response.");
  }

  if (!data.versions) {
    throw new Error("No versions found in npm registry response.");
  }

  return Object.keys(data.versions).sort(compareSemver);
}

// ── Dependency installation ─────────────────────────────────────────────

/**
 * Install production dependencies for a cached version.
 * Uses npm if available, falls back to bun.
 * Only runs if package.json has non-empty "dependencies".
 */
function installDependencies(versionDir: string): void {
  const pkgJsonPath = path.join(versionDir, "package.json");
  if (!fs.existsSync(pkgJsonPath)) return;

  let pkgJson: { dependencies?: Record<string, string> };
  try {
    pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));
  } catch {
    return;
  }

  if (!pkgJson.dependencies || Object.keys(pkgJson.dependencies).length === 0) {
    return;
  }

  console.log("Installing dependencies...");

  // Try npm first (most common), then bun
  const runtimes = [
    {
      cmd: "npm",
      args: ["install", "--production", "--no-audit", "--no-fund"],
    },
    { cmd: "bun", args: ["install", "--production"] },
  ];

  for (const rt of runtimes) {
    try {
      execFileSync(rt.cmd, rt.args, {
        cwd: versionDir,
        stdio: "pipe",
      });
      return;
    } catch {
      // Try next runtime
    }
  }

  console.warn(
    "Warning: Could not install dependencies for cached version. " +
      "Some features may not work. Install npm or bun to resolve this."
  );
}

// ── HTTP helpers ────────────────────────────────────────────────────────

/**
 * HTTP GET that follows redirects (npm registry often redirects).
 * Returns the response body as a string.
 */
function httpGet(url: string, maxRedirects = 5): Promise<string> {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith("https") ? https : http;

    protocol
      .get(url, { headers: { Accept: "application/json" } }, (res) => {
        // Follow redirects
        if (
          (res.statusCode === 301 || res.statusCode === 302) &&
          res.headers.location
        ) {
          if (maxRedirects <= 0) {
            reject(new Error("Too many redirects"));
            return;
          }
          resolve(httpGet(res.headers.location, maxRedirects - 1));
          return;
        }

        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
          return;
        }

        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
        res.on("error", reject);
      })
      .on("error", reject);
  });
}

/**
 * Download a file from a URL to a local path. Follows redirects.
 */
function downloadFile(
  url: string,
  destPath: string,
  maxRedirects = 5
): Promise<void> {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith("https") ? https : http;

    protocol
      .get(url, (res) => {
        if (
          (res.statusCode === 301 || res.statusCode === 302) &&
          res.headers.location
        ) {
          if (maxRedirects <= 0) {
            reject(new Error("Too many redirects"));
            return;
          }
          resolve(
            downloadFile(res.headers.location, destPath, maxRedirects - 1)
          );
          return;
        }

        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode} downloading ${url}`));
          return;
        }

        const file = fs.createWriteStream(destPath);
        res.pipe(file);
        file.on("finish", () => {
          file.close();
          resolve();
        });
        file.on("error", (err) => {
          fs.unlinkSync(destPath);
          reject(err);
        });
      })
      .on("error", reject);
  });
}

// ── Semver comparison ───────────────────────────────────────────────────

function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);

  for (let i = 0; i < 3; i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}

// ── Runtime detection ───────────────────────────────────────────────────

/**
 * Find a JavaScript runtime (node or bun) available on the system.
 * Returns the runtime command name.
 * Throws if neither is found.
 */
export function findJsRuntime(): string {
  // Try node first
  try {
    execFileSync("node", ["--version"], { stdio: "pipe" });
    return "node";
  } catch {
    // node not available
  }

  // Try bun
  try {
    execFileSync("bun", ["--version"], { stdio: "pipe" });
    return "bun";
  } catch {
    // bun not available
  }

  throw new Error(
    "No JavaScript runtime found. Install Node.js (https://nodejs.org) or Bun (https://bun.sh) to use version management."
  );
}
