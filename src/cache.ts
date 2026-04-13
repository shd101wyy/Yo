/**
 * Global cache directory resolution for the Yo build system.
 *
 * Resolution order:
 * 1. $YO_CACHE_DIR (environment variable, highest priority)
 * 2. $XDG_CACHE_HOME/yo (XDG standard)
 * 3. ~/.cache/yo (Linux/macOS default)
 * 4. %LOCALAPPDATA%\yo\cache (Windows default)
 *
 * Cache structure:
 *   <cache_root>/
 *     deps/           — fetched dependency source trees (<name>-<commit12>/)
 *     versions/       — versioned Yo installations (<version>/)
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * Get the global cache root directory for Yo.
 */
export function getGlobalCacheDir(): string {
  // 1. Explicit env override
  const envOverride = process.env.YO_CACHE_DIR;
  if (envOverride) {
    return envOverride;
  }

  // 2. XDG_CACHE_HOME/yo
  const xdgCache = process.env.XDG_CACHE_HOME;
  if (xdgCache) {
    return path.join(xdgCache, "yo");
  }

  // 3. Platform default
  if (process.platform === "win32") {
    const localAppData =
      process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
    return path.join(localAppData, "yo", "cache");
  }

  // Linux/macOS: ~/.cache/yo
  return path.join(os.homedir(), ".cache", "yo");
}

/**
 * Get the global dependency cache directory.
 */
export function getGlobalDepsCacheDir(): string {
  return path.join(getGlobalCacheDir(), "deps");
}

/**
 * Ensure the global deps cache directory exists.
 */
export function ensureGlobalDepsCacheDir(): string {
  const dir = getGlobalDepsCacheDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Get the global versioned Yo installations cache directory.
 */
export function getGlobalVersionsCacheDir(): string {
  return path.join(getGlobalCacheDir(), "versions");
}

/**
 * Get the cache directory for a specific Yo version.
 */
export function getVersionCacheDir(version: string): string {
  return path.join(getGlobalVersionsCacheDir(), version);
}
