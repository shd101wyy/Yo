/**
 * pkg-config integration for the Yo build system.
 *
 * Discovers system C libraries via `pkg-config` on Unix-like systems.
 * Falls back to user-provided paths when `pkg-config` is not available
 * (common on Windows).
 */

import { execSync } from "child_process";
import type { BuildSystemLibrary } from "./evaluator/builtins/build";

export interface PkgConfigResult {
  cFlags: string[];
  ldFlags: string[];
  includePaths: string[];
  libraryPaths: string[];
  linkLibraries: string[];
}

/**
 * Check if `pkg-config` is available on this system.
 */
export function isPkgConfigAvailable(): boolean {
  try {
    execSync("pkg-config --version", {
      encoding: "utf-8",
      timeout: 5000,
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Query pkg-config for a library's compile and link flags.
 */
function queryPkgConfig(pkgName: string): PkgConfigResult | undefined {
  try {
    const cFlagsRaw = execSync(`pkg-config --cflags "${pkgName}"`, {
      encoding: "utf-8",
      timeout: 10000,
      stdio: "pipe",
    }).trim();

    const ldFlagsRaw = execSync(`pkg-config --libs "${pkgName}"`, {
      encoding: "utf-8",
      timeout: 10000,
      stdio: "pipe",
    }).trim();

    const result: PkgConfigResult = {
      cFlags: [],
      ldFlags: [],
      includePaths: [],
      libraryPaths: [],
      linkLibraries: [],
    };

    // Parse cflags
    for (const flag of cFlagsRaw.split(/\s+/).filter(Boolean)) {
      if (flag.startsWith("-I")) {
        result.includePaths.push(flag.slice(2));
      } else {
        result.cFlags.push(flag);
      }
    }

    // Parse ldflags
    for (const flag of ldFlagsRaw.split(/\s+/).filter(Boolean)) {
      if (flag.startsWith("-L")) {
        result.libraryPaths.push(flag.slice(2));
      } else if (flag.startsWith("-l")) {
        result.linkLibraries.push(flag.slice(2));
      } else {
        result.ldFlags.push(flag);
      }
    }

    return result;
  } catch {
    return undefined;
  }
}

/**
 * Build a fallback result from user-provided paths.
 */
function buildFallback(lib: BuildSystemLibrary): PkgConfigResult {
  const result: PkgConfigResult = {
    cFlags: [],
    ldFlags: [],
    includePaths: [],
    libraryPaths: [],
    linkLibraries: [],
  };

  if (lib.fallbackInclude) {
    result.includePaths.push(lib.fallbackInclude);
  }
  if (lib.fallbackLib) {
    result.libraryPaths.push(lib.fallbackLib);
  }
  if (lib.fallbackLink) {
    // May contain multiple libs separated by spaces
    for (const l of lib.fallbackLink.split(/\s+/).filter(Boolean)) {
      result.linkLibraries.push(l);
    }
  }

  return result;
}

/**
 * Resolve a system library, trying pkg-config first then falling back.
 */
export function resolveSystemLibrary(
  lib: BuildSystemLibrary,
  verbose: boolean = false
): PkgConfigResult {
  if (isPkgConfigAvailable()) {
    const result = queryPkgConfig(lib.pkgConfig);
    if (result) {
      if (verbose) {
        console.log(`  ${lib.name}: found via pkg-config (${lib.pkgConfig})`);
      }
      return result;
    }
    if (verbose) {
      console.log(
        `  ${lib.name}: pkg-config query failed for "${lib.pkgConfig}", using fallback`
      );
    }
  } else if (verbose) {
    console.log(`  ${lib.name}: pkg-config not available, using fallback`);
  }

  return buildFallback(lib);
}

/**
 * Resolve all system libraries and merge their flags into a single result.
 */
export function resolveAllSystemLibraries(
  libraries: BuildSystemLibrary[],
  verbose: boolean = false
): PkgConfigResult {
  const merged: PkgConfigResult = {
    cFlags: [],
    ldFlags: [],
    includePaths: [],
    libraryPaths: [],
    linkLibraries: [],
  };

  if (libraries.length === 0) return merged;

  if (verbose) {
    console.log(`Resolving ${libraries.length} system library(ies)...`);
  }

  for (const lib of libraries) {
    const result = resolveSystemLibrary(lib, verbose);
    merged.cFlags.push(...result.cFlags);
    merged.ldFlags.push(...result.ldFlags);
    merged.includePaths.push(...result.includePaths);
    merged.libraryPaths.push(...result.libraryPaths);
    merged.linkLibraries.push(...result.linkLibraries);
  }

  return merged;
}
