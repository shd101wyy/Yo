/**
 * Git dependency fetching for the Yo build system.
 *
 * Handles cloning git repos, resolving refs, computing content hashes,
 * and managing the global dependency cache (~/.cache/yo/deps/).
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { execSync } from "child_process";
import type { BuildGitDependency } from "./evaluator/builtins/build";
import {
  type LockFile,
  type LockEntry,
  readLockFile,
  saveLockFile,
  findLockEntry,
  upsertLockEntry,
} from "./lock-file";
import { ensureGlobalDepsCacheDir, getGlobalDepsCacheDir } from "./cache";

/**
 * Get the cache directory for dependencies (global).
 */
export function getCacheDir(_projectDir?: string): string {
  return getGlobalDepsCacheDir();
}

/**
 * Ensure the cache directory structure exists.
 */
function ensureCacheDir(): string {
  return ensureGlobalDepsCacheDir();
}

/**
 * Resolve a git ref to a concrete commit SHA.
 */
function resolveGitRef(url: string, ref: string): string {
  try {
    const output = execSync(`git ls-remote "${url}" "${ref}"`, {
      encoding: "utf-8",
      timeout: 30000,
    }).trim();

    if (output === "") {
      // ref might be a commit SHA — try HEAD as fallback
      if (ref === "HEAD") {
        throw new Error(`Could not resolve HEAD for ${url}`);
      }
      // Assume it's a commit SHA
      return ref;
    }

    // ls-remote output: "<sha>\t<ref>"
    const sha = output.split("\t")[0];
    if (!sha) {
      throw new Error(`Could not parse git ls-remote output for ${url} ${ref}`);
    }
    return sha;
  } catch (err) {
    throw new Error(
      `Failed to resolve git ref "${ref}" for ${url}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Clone a git repo at a specific commit into the cache directory.
 * Returns the path to the cloned directory.
 */
function cloneRepo(
  cacheDir: string,
  url: string,
  commit: string,
  depName: string
): string {
  const tempDir = path.join(cacheDir, `_tmp_${depName}_${Date.now()}`);
  const targetDir = path.join(cacheDir, `${depName}-${commit.slice(0, 12)}`);

  if (fs.existsSync(targetDir)) {
    return targetDir;
  }

  try {
    // Shallow clone at specific commit
    execSync(`git clone --depth 1 "${url}" "${tempDir}"`, {
      encoding: "utf-8",
      timeout: 120000,
      stdio: "pipe",
    });

    // Try to checkout the specific commit (may fail for shallow clone)
    try {
      execSync(`git -C "${tempDir}" checkout "${commit}"`, {
        encoding: "utf-8",
        timeout: 30000,
        stdio: "pipe",
      });
    } catch {
      // If the commit is not in the shallow clone, fetch it
      execSync(`git -C "${tempDir}" fetch --depth 1 origin "${commit}"`, {
        encoding: "utf-8",
        timeout: 60000,
        stdio: "pipe",
      });
      execSync(`git -C "${tempDir}" checkout "${commit}"`, {
        encoding: "utf-8",
        timeout: 30000,
        stdio: "pipe",
      });
    }

    // Remove .git directory to save space
    const gitDir = path.join(tempDir, ".git");
    if (fs.existsSync(gitDir)) {
      fs.rmSync(gitDir, { recursive: true, force: true });
    }

    // Rename to final location
    fs.renameSync(tempDir, targetDir);

    return targetDir;
  } catch (err) {
    // Cleanup on failure
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    throw new Error(
      `Failed to clone ${url}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Compute a content hash for a directory (SHA-256 of all file contents).
 */
function computeContentHash(dirPath: string): string {
  const hash = crypto.createHash("sha256");
  hashDirectory(hash, dirPath, "");
  return `sha256-${hash.digest("hex")}`;
}

function hashDirectory(
  hash: crypto.Hash,
  basePath: string,
  relativePath: string
): void {
  const fullPath = relativePath ? path.join(basePath, relativePath) : basePath;
  const entries = fs.readdirSync(fullPath, { withFileTypes: true });
  // Sort for deterministic hashing
  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    const entryRelative = relativePath
      ? `${relativePath}/${entry.name}`
      : entry.name;

    if (entry.isDirectory()) {
      // Skip hidden directories
      if (entry.name.startsWith(".")) continue;
      hash.update(`dir:${entryRelative}\n`);
      hashDirectory(hash, basePath, entryRelative);
    } else if (entry.isFile()) {
      hash.update(`file:${entryRelative}\n`);
      const content = fs.readFileSync(path.join(basePath, entryRelative));
      hash.update(content);
    }
  }
}

/**
 * Fetch a single dependency: resolve ref, clone, hash, update lock.
 */
function fetchDependency(
  cacheDir: string,
  dep: BuildGitDependency,
  lockFile: LockFile,
  verbose: boolean
): { lockFile: LockFile; depPath: string } {
  const existingEntry = findLockEntry(lockFile, dep.name);

  // Resolve the git ref to a commit SHA
  if (verbose) {
    console.log(`  Resolving ${dep.name} (${dep.url} @ ${dep.ref})...`);
  }
  const commit = resolveGitRef(dep.url, dep.ref);

  // If lock file has the same commit, check if cache exists
  if (existingEntry && existingEntry.commit === commit) {
    const cachedPath = path.join(
      cacheDir,
      `${dep.name}-${commit.slice(0, 12)}`
    );
    if (fs.existsSync(cachedPath)) {
      if (verbose) {
        console.log(`  ${dep.name}: up to date (${commit.slice(0, 8)})`);
      }
      const subPath = dep.path ? path.join(cachedPath, dep.path) : cachedPath;
      return { lockFile, depPath: subPath };
    }
  }

  // Clone the repo
  if (verbose) {
    console.log(`  Fetching ${dep.name} @ ${commit.slice(0, 8)}...`);
  }
  const clonedPath = cloneRepo(cacheDir, dep.url, commit, dep.name);

  // Compute content hash
  const contentHash = computeContentHash(clonedPath);

  // Update lock entry
  const entry: LockEntry = {
    name: dep.name,
    url: dep.url,
    ref: dep.ref,
    commit,
    hash: contentHash,
  };
  const updatedLock = upsertLockEntry(lockFile, entry);

  const subPath = dep.path ? path.join(clonedPath, dep.path) : clonedPath;

  return { lockFile: updatedLock, depPath: subPath };
}

/**
 * Result of fetching all dependencies.
 */
export interface FetchResult {
  /** Map from dependency name to resolved local path */
  resolvedPaths: Map<string, string>;
  /** Updated lock file */
  lockFile: LockFile;
}

/**
 * Fetch all git dependencies declared in the build registry.
 * Updates `yo.lock` and populates the global cache.
 */
export function fetchAllDependencies(
  projectDir: string,
  dependencies: BuildGitDependency[],
  verbose: boolean = false
): FetchResult {
  if (dependencies.length === 0) {
    return { resolvedPaths: new Map(), lockFile: { dependencies: [] } };
  }

  const cacheDir = ensureCacheDir();
  let lockFile = readLockFile(projectDir);
  const resolvedPaths = new Map<string, string>();

  if (verbose) {
    console.log(`Fetching ${dependencies.length} dependency(ies)...`);
    console.log(`  Cache: ${cacheDir}`);
  }

  for (const dep of dependencies) {
    const result = fetchDependency(cacheDir, dep, lockFile, verbose);
    lockFile = result.lockFile;
    resolvedPaths.set(dep.name, result.depPath);
  }

  // Write updated lock file
  saveLockFile(projectDir, lockFile);

  if (verbose) {
    console.log("Dependencies fetched successfully.");
  }

  return { resolvedPaths, lockFile };
}

/**
 * Check if all dependencies are already cached according to the lock file.
 */
export function areDependenciesCached(
  projectDir: string,
  dependencies: BuildGitDependency[]
): boolean {
  if (dependencies.length === 0) return true;

  const lockFile = readLockFile(projectDir);
  const cacheDir = getCacheDir();

  for (const dep of dependencies) {
    const entry = findLockEntry(lockFile, dep.name);
    if (!entry || !entry.commit) return false;

    const cachedPath = path.join(
      cacheDir,
      `${dep.name}-${entry.commit.slice(0, 12)}`
    );
    if (!fs.existsSync(cachedPath)) return false;
  }

  return true;
}

/**
 * Resolve a dependency name to its cached local path using the lock file.
 * Returns undefined if the dependency is not cached.
 */
export function resolveDependencyPath(
  projectDir: string,
  depName: string,
  depPath: string = ""
): string | undefined {
  const lockFile = readLockFile(projectDir);
  const entry = findLockEntry(lockFile, depName);
  if (!entry || !entry.commit) return undefined;

  const cacheDir = getCacheDir();
  const cachedDir = path.join(
    cacheDir,
    `${depName}-${entry.commit.slice(0, 12)}`
  );
  if (!fs.existsSync(cachedDir)) return undefined;

  return depPath ? path.join(cachedDir, depPath) : cachedDir;
}
