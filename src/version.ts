/**
 * `.yo-version` file discovery, parsing, and validation.
 *
 * The `.yo-version` file pins a project to a specific Yo version.
 * It contains a single line with a semver version (e.g., `0.1.12` or `v0.1.12`).
 *
 * Resolution: walk up from the given directory looking for `.yo-version`,
 * similar to `.nvmrc` or `.python-version`.
 */

import { existsSync, readFileSync } from "fs";
import * as path from "path";
import packageJson from "../package.json";

const YO_VERSION_FILE = ".yo-version";

/**
 * Get the current Yo version from package.json.
 */
export function getCurrentYoVersion(): string {
  return packageJson.version;
}

/**
 * Walk up from `startDir` to find a `.yo-version` file.
 * Returns the absolute path to the file, or null if not found.
 */
export function findYoVersionFile(startDir: string): string | null {
  let currentDir = path.resolve(startDir);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const candidate = path.join(currentDir, YO_VERSION_FILE);
    if (existsSync(candidate)) {
      return candidate;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      // Reached filesystem root
      return null;
    }
    currentDir = parentDir;
  }
}

/**
 * Parse and validate the contents of a `.yo-version` file.
 *
 * - Trims whitespace and trailing newlines
 * - Strips leading `v` or `V` prefix
 * - Validates basic semver format (major.minor.patch)
 *
 * Returns the normalized version string (e.g., "0.1.12").
 * Throws an error if the version is invalid.
 */
export function parseYoVersion(content: string): string {
  let version = content.trim();

  if (!version) {
    throw new Error(
      `Empty .yo-version file. Specify a concrete version number (e.g., ${getCurrentYoVersion()}).`
    );
  }

  // Strip leading v/V
  if (version.startsWith("v") || version.startsWith("V")) {
    version = version.slice(1);
  }

  // Reject "latest"
  if (version.toLowerCase() === "latest") {
    throw new Error(
      `Invalid version "latest" in .yo-version.\nSpecify a concrete version number (e.g., ${getCurrentYoVersion()}).`
    );
  }

  // Basic semver validation: major.minor.patch (optional pre-release/build metadata)
  const semverRegex = /^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?(\+[a-zA-Z0-9.]+)?$/;
  if (!semverRegex.test(version)) {
    throw new Error(
      `Invalid version "${version}" in .yo-version.\nExpected a semver version like "0.1.12" or "v0.1.12".`
    );
  }

  return version;
}

/**
 * Read and parse the `.yo-version` file starting from `startDir`.
 *
 * Returns the parsed version string, or null if no `.yo-version` file exists.
 * Throws on invalid version content.
 */
export function readYoVersion(startDir: string): string | null {
  const versionFile = findYoVersionFile(startDir);
  if (!versionFile) {
    return null;
  }

  const content = readFileSync(versionFile, "utf-8");
  return parseYoVersion(content);
}

/**
 * Check whether the pinned version matches the currently running version.
 */
export function isPinnedVersionCurrent(pinnedVersion: string): boolean {
  return pinnedVersion === getCurrentYoVersion();
}
