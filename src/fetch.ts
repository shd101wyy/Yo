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

const NON_INTERACTIVE_GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
};

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
      env: NON_INTERACTIVE_GIT_ENV,
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
      env: NON_INTERACTIVE_GIT_ENV,
    });

    // Try to checkout the specific commit (may fail for shallow clone)
    try {
      execSync(`git -C "${tempDir}" checkout "${commit}"`, {
        encoding: "utf-8",
        timeout: 30000,
        stdio: "pipe",
        env: NON_INTERACTIVE_GIT_ENV,
      });
    } catch {
      // If the commit is not in the shallow clone, fetch it
      execSync(`git -C "${tempDir}" fetch --depth 1 origin "${commit}"`, {
        encoding: "utf-8",
        timeout: 60000,
        stdio: "pipe",
        env: NON_INTERACTIVE_GIT_ENV,
      });
      execSync(`git -C "${tempDir}" checkout "${commit}"`, {
        encoding: "utf-8",
        timeout: 30000,
        stdio: "pipe",
        env: NON_INTERACTIVE_GIT_ENV,
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
export function computeContentHash(dirPath: string): string {
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
  // Use locale-independent ordering so hashes stay stable across platforms
  // and process locales without forcing a one-time rewrite for common
  // ASCII-only dependency trees.
  entries.sort((a, b) => comparePathNames(a.name, b.name));

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
      // Skip the sidecar hash file itself so it doesn't affect the hash.
      if (entry.name === SIDECAR_FILENAME) continue;
      hash.update(`file:${entryRelative}\n`);
      const content = fs.readFileSync(path.join(basePath, entryRelative));
      // Normalize \r\n → \n so the hash is identical on Windows and Linux
      // regardless of git's core.autocrlf setting.
      hash.update(normalizeLineEndings(content));
    }
  }
}

function comparePathNames(a: string, b: string): number {
  const normalizedA = a.toLowerCase();
  const normalizedB = b.toLowerCase();
  if (normalizedA < normalizedB) return -1;
  if (normalizedA > normalizedB) return 1;
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

const CR = 0x0d; // \r
const LF = 0x0a; // \n

/**
 * Strip \r from \r\n sequences in a Buffer so the same git tree
 * hashes identically on Windows (CRLF checkout) and Linux (LF).
 */
function normalizeLineEndings(buf: Buffer): Buffer {
  // Quick scan: if there's no \r, return as-is (common on Linux).
  if (!buf.includes(CR)) return buf;

  // Build a new buffer with \r removed before \n.
  const out: number[] = [];
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === CR && i + 1 < buf.length && buf[i + 1] === LF) {
      continue; // skip \r, the next iteration writes \n
    }
    out.push(buf[i]!);
  }
  return Buffer.from(out);
}

const SIDECAR_FILENAME = ".yo-content-hash";

function writeSidecarHash(cachedPath: string, contentHash: string): void {
  fs.writeFileSync(
    path.join(cachedPath, SIDECAR_FILENAME),
    contentHash + "\n",
    "utf-8"
  );
}

function getCachedDependencyDir(
  cacheDir: string,
  depName: string,
  commit: string
): string {
  return path.join(cacheDir, `${depName}-${commit.slice(0, 12)}`);
}

interface CachedDependencyState {
  status: "ok" | "missing_path" | "missing_hash" | "hash_mismatch";
  cachedPath: string;
  actualHash?: string;
}

function inspectCachedDependency(
  cacheDir: string,
  depName: string,
  entry: Pick<LockEntry, "commit" | "hash">
): CachedDependencyState {
  const cachedPath = getCachedDependencyDir(cacheDir, depName, entry.commit);
  if (!fs.existsSync(cachedPath)) {
    return { status: "missing_path", cachedPath };
  }

  if (!entry.hash) {
    return { status: "missing_hash", cachedPath };
  }

  // Read the sidecar hash file (written at fetch time) for O(1) verification.
  const sidecarPath = path.join(cachedPath, SIDECAR_FILENAME);
  let actualHash: string | undefined;
  try {
    actualHash = fs.readFileSync(sidecarPath, "utf-8").trim();
  } catch {
    // Sidecar missing — fall back to full re-hash.
    actualHash = computeContentHash(cachedPath);
    writeSidecarHash(cachedPath, actualHash);
  }

  if (actualHash !== entry.hash) {
    return {
      status: "hash_mismatch",
      cachedPath,
      actualHash,
    };
  }

  return { status: "ok", cachedPath, actualHash };
}

function formatIntegrityErrorMessage(
  depName: string,
  expectedHash: string,
  actualHash: string,
  cachedPath: string
): string {
  return (
    `Cached dependency "${depName}" failed integrity check.\n` +
    `Expected: ${expectedHash}\n` +
    `Actual:   ${actualHash}\n` +
    `Path: ${cachedPath}\n` +
    `Run 'yo fetch' to refetch this dependency.`
  );
}

/**
 * Fetch a single dependency: resolve ref, clone, hash, update lock.
 */
function fetchDependency(
  cacheDir: string,
  dep: BuildGitDependency,
  lockFile: LockFile,
  verbose: boolean,
  update: boolean = false
): { lockFile: LockFile; depPath: string } {
  const existingEntry = findLockEntry(lockFile, dep.name);
  const existingCachedState =
    !update && existingEntry && existingEntry.commit
      ? inspectCachedDependency(cacheDir, dep.name, existingEntry)
      : undefined;

  const refChanged = existingEntry ? existingEntry.ref !== dep.ref : false;

  if (
    !update &&
    !refChanged &&
    existingEntry &&
    existingEntry.commit &&
    existingCachedState?.status === "ok"
  ) {
    if (verbose) {
      console.log(
        `  ${dep.name}: up to date (${existingEntry.commit.slice(0, 8)})`
      );
    }
    const subPath = dep.path
      ? path.join(existingCachedState.cachedPath, dep.path)
      : existingCachedState.cachedPath;
    return { lockFile, depPath: subPath };
  }

  // Resolve the git ref to a commit SHA
  if (verbose) {
    console.log(`  Resolving ${dep.name} (${dep.url} @ ${dep.ref})...`);
  }
  const commit = resolveGitRef(dep.url, dep.ref);

  // If lock file has the same commit, check if cache exists (skip in update mode)
  if (!update && existingEntry && existingEntry.commit === commit) {
    const cachedState =
      existingCachedState ??
      inspectCachedDependency(cacheDir, dep.name, existingEntry);
    if (cachedState.status === "ok") {
      if (verbose) {
        console.log(`  ${dep.name}: up to date (${commit.slice(0, 8)})`);
      }
      // If the ref changed but resolves to the same commit (e.g. re-tag),
      // update the lock entry to reflect the new ref.
      let updatedLock = lockFile;
      if (refChanged) {
        updatedLock = upsertLockEntry(lockFile, {
          ...existingEntry,
          ref: dep.ref,
        });
      }
      const subPath = dep.path
        ? path.join(cachedState.cachedPath, dep.path)
        : cachedState.cachedPath;
      return { lockFile: updatedLock, depPath: subPath };
    }

    if (verbose) {
      if (cachedState.status === "missing_hash") {
        console.log(
          `  ${dep.name}: cache exists but yo.lock is missing its content hash; refetching...`
        );
      } else if (cachedState.status === "hash_mismatch") {
        console.log(
          `  ${dep.name}: cache hash mismatch (${existingEntry.hash} != ${cachedState.actualHash}); refetching...`
        );
      }
    }

    if (cachedState.status !== "missing_path") {
      fs.rmSync(cachedState.cachedPath, { recursive: true, force: true });
    }
  }

  // Clone the repo
  if (verbose) {
    console.log(`  Fetching ${dep.name} @ ${commit.slice(0, 8)}...`);
  }
  const clonedPath = cloneRepo(cacheDir, dep.url, commit, dep.name);

  // Compute content hash and write sidecar for fast verification later
  const contentHash = computeContentHash(clonedPath);
  writeSidecarHash(clonedPath, contentHash);

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
  verbose: boolean = false,
  update: boolean = false
): FetchResult {
  if (dependencies.length === 0) {
    // Even with no deps, prune stale lock entries
    const existingLock = readLockFile(projectDir);
    if (existingLock.dependencies.length > 0) {
      const emptyLock: LockFile = { dependencies: [] };
      saveLockFile(projectDir, emptyLock);
      console.log(
        `Pruned ${existingLock.dependencies.length} stale dependency(ies) from yo.lock`
      );
    }
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
    const result = fetchDependency(cacheDir, dep, lockFile, verbose, update);
    lockFile = result.lockFile;
    resolvedPaths.set(dep.name, result.depPath);
  }

  // Prune stale lock entries (deps removed from build.yo)
  const declaredNames = new Set(dependencies.map((d) => d.name));
  const staleEntries = lockFile.dependencies.filter(
    (entry) => !declaredNames.has(entry.name)
  );
  if (staleEntries.length > 0) {
    lockFile = {
      dependencies: lockFile.dependencies.filter((entry) =>
        declaredNames.has(entry.name)
      ),
    };
    for (const stale of staleEntries) {
      if (verbose) {
        console.log(`  Pruned stale lock entry: ${stale.name}`);
      }
    }
    console.log(
      `Pruned ${staleEntries.length} stale dependency(ies) from yo.lock`
    );
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
    if (!entry || !entry.commit || !entry.hash) return false;
    if (inspectCachedDependency(cacheDir, dep.name, entry).status !== "ok") {
      return false;
    }
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
  const cachedState = inspectCachedDependency(cacheDir, depName, entry);
  if (cachedState.status === "missing_path") {
    return undefined;
  }
  if (cachedState.status === "missing_hash") {
    throw new Error(
      `Dependency "${depName}" is cached at "${cachedState.cachedPath}" but its yo.lock entry is missing a content hash. Run 'yo fetch' to refresh yo.lock.`
    );
  }
  if (cachedState.status === "hash_mismatch") {
    throw new Error(
      formatIntegrityErrorMessage(
        depName,
        entry.hash,
        cachedState.actualHash ?? "<unknown>",
        cachedState.cachedPath
      )
    );
  }

  return depPath
    ? path.join(cachedState.cachedPath, depPath)
    : cachedState.cachedPath;
}
