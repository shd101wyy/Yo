/**
 * Version cache management for Yo.
 *
 * Downloads and caches specific versions of Yo as NATIVE RELEASE BUNDLES
 * from GitHub Releases (npm publishing stopped at v0.2.0 — the npm channel
 * is dead for every later version; see plans/P3_DISTRIBUTION.md item 2).
 * Cached versions are stored in `~/.cache/yo/versions/<version>/` as a plain
 * bundle extraction: `bin/yo` (+`.exe` on Windows), `std/`, `vendor/`,
 * LICENSE — exactly the layout `scripts/install.sh` installs, so the two
 * mechanisms share one shape and the bundle self-locates its std.
 *
 * Download flow:
 *   1. Resolve the host platform's bundle name (yo-v<v>-<os>-<arch>).
 *   2. Download `https://github.com/<repo>/releases/download/v<v>/<bundle>.tar.gz`.
 *   3. Extract; the tarball root is a `<bundle>/` directory — move it to the
 *      version cache directory.
 */

import { execFileSync } from "child_process";
import * as fs from "fs";
import * as https from "https";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { getGlobalVersionsCacheDir, getVersionCacheDir } from "./cache";

/** Overridable for forks/tests — matches scripts/install.sh's YO_REPO. */
const GITHUB_REPO = process.env.YO_REPO ?? "shd101wyy/Yo";
const RELEASES_API_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases`;
const RELEASES_DOWNLOAD_URL = `https://github.com/${GITHUB_REPO}/releases/download`;

/** The first release that ships native bundles for all platforms. */
const MIN_BUNDLE_VERSION = "0.2.1";

/** The cached compiler binary inside a version directory. */
export function cachedBinaryPath(versionDir: string): string {
  return path.join(
    versionDir,
    "bin",
    process.platform === "win32" ? "yo.exe" : "yo"
  );
}

/**
 * The release-bundle basename for a version on the HOST platform,
 * e.g. `yo-v0.2.4-macos-arm64`. Mirrors scripts/install.sh's detect_osarch.
 */
export function hostBundleName(version: string): string {
  let osName: string;
  switch (process.platform) {
    case "darwin":
      osName = "macos";
      break;
    case "linux":
      osName = "linux";
      break;
    case "win32":
      osName = "windows";
      break;
    default:
      throw new Error(
        `Unsupported platform for Yo release bundles: ${process.platform}. ` +
          `Available targets: linux-x64, linux-arm64, macos-arm64, macos-x64, windows-x64.`
      );
  }
  let arch: string;
  switch (process.arch) {
    case "x64":
      arch = "x64";
      break;
    case "arm64":
      arch = "arm64";
      break;
    default:
      throw new Error(
        `Unsupported CPU architecture for Yo release bundles: ${process.arch}. ` +
          `Available: x64, arm64.`
      );
  }
  return `yo-v${version}-${osName}-${arch}`;
}

/**
 * Check if a specific Yo version is already cached locally.
 * A cached version is a bundle extraction whose `bin/yo` exists.
 */
export function isVersionCached(version: string): boolean {
  const versionDir = getVersionCacheDir(version);
  return fs.existsSync(cachedBinaryPath(versionDir));
}

/**
 * List all locally cached Yo versions (directories holding a `bin/yo`).
 * Returns a semver-sorted array of version strings. Old npm-shaped cache
 * entries (package.json + node_modules) are ignored — that channel is dead.
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
        fs.existsSync(cachedBinaryPath(entryPath))
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
 * Download a specific Yo version's native bundle from GitHub Releases and
 * cache it. Returns the path to the cached version directory.
 */
export async function downloadVersion(version: string): Promise<string> {
  if (compareSemver(version, MIN_BUNDLE_VERSION) < 0) {
    throw new Error(
      `Yo v${version} predates the native release bundles (first bundled ` +
        `release: v${MIN_BUNDLE_VERSION}) and is no longer distributed — npm ` +
        `publishing stopped at v0.2.0. Pin v${MIN_BUNDLE_VERSION} or later.`
    );
  }

  const bundleName = hostBundleName(version);
  const url = `${RELEASES_DOWNLOAD_URL}/v${version}/${bundleName}.tar.gz`;
  const versionDir = getVersionCacheDir(version);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "yo-version-"));
  const tarballPath = path.join(tmpDir, `${bundleName}.tar.gz`);

  try {
    console.log(
      `Downloading Yo v${version} (${bundleName}) from GitHub Releases...`
    );
    try {
      await downloadFile(url, tarballPath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("HTTP 404")) {
        throw new Error(
          `Yo v${version} has no ${bundleName}.tar.gz release asset.\n` +
            `Run \`yo version list --remote\` to see the published releases, or check ` +
            `https://github.com/${GITHUB_REPO}/releases`
        );
      }
      throw err;
    }

    // Extract; the tarball root is a `<bundleName>/` directory holding
    // bin/, std/ and vendor/ as SIBLINGS (the compiler resolves its std by
    // walking up from the executable, and mimalloc as <std>/../vendor).
    execFileSync("tar", ["xzf", tarballPath, "-C", tmpDir], {
      stdio: "pipe",
    });

    const extractedDir = path.join(tmpDir, bundleName);
    if (
      !fs.existsSync(path.join(extractedDir, "bin")) ||
      !fs.existsSync(path.join(extractedDir, "std"))
    ) {
      throw new Error(
        `Unexpected bundle layout in ${bundleName}.tar.gz (missing bin/ or std/).`
      );
    }

    // Remove any existing partial extraction (or a dead npm-shaped entry).
    if (fs.existsSync(versionDir)) {
      fs.rmSync(versionDir, { recursive: true, force: true });
    }
    fs.mkdirSync(path.dirname(versionDir), { recursive: true });
    fs.renameSync(extractedDir, versionDir);

    console.log(`Installed Yo v${version} to ${versionDir}`);

    return versionDir;
  } catch (err) {
    if (fs.existsSync(versionDir)) {
      fs.rmSync(versionDir, { recursive: true, force: true });
    }
    throw err;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Fetch all published Yo versions from the GitHub Releases API.
 * Returns a semver-sorted array of version strings (tags with the `v`
 * prefix stripped); drafts and prereleases are excluded.
 */
export async function fetchRemoteVersions(): Promise<string[]> {
  const versions: string[] = [];
  // The API pages at 100 releases; three pages is far beyond the horizon.
  for (let page = 1; page <= 3; page++) {
    const body = await httpGet(`${RELEASES_API_URL}?per_page=100&page=${page}`);
    let data: Array<{
      tag_name?: string;
      draft?: boolean;
      prerelease?: boolean;
    }>;
    try {
      data = JSON.parse(body);
    } catch {
      throw new Error("Failed to parse the GitHub Releases API response.");
    }
    if (!Array.isArray(data)) {
      throw new Error("Unexpected GitHub Releases API response shape.");
    }
    for (const rel of data) {
      if (rel.draft || rel.prerelease || !rel.tag_name) continue;
      versions.push(
        rel.tag_name.startsWith("v") ? rel.tag_name.slice(1) : rel.tag_name
      );
    }
    if (data.length < 100) break;
  }
  return versions.sort(compareSemver);
}

// ── HTTP helpers ────────────────────────────────────────────────────────

function httpGet(url: string, maxRedirects = 5): Promise<string> {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith("https") ? https : http;

    protocol
      .get(
        url,
        {
          headers: {
            // GitHub's API rejects requests without a User-Agent.
            "User-Agent": "yo-version-cache",
            Accept: "application/vnd.github+json",
          },
        },
        (res) => {
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

          if (res.statusCode === 403) {
            // Unauthenticated GitHub API rate limit (60 requests/hour/IP).
            reject(
              new Error(
                `GitHub API rate limit reached (HTTP 403). Wait a bit and retry, ` +
                  `or check https://github.com/${GITHUB_REPO}/releases in a browser.`
              )
            );
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
        }
      )
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
      .get(url, { headers: { "User-Agent": "yo-version-cache" } }, (res) => {
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
