/**
 * pkg-config integration for the Yo build system.
 *
 * Discovers system C libraries via `pkg-config` on Unix-like systems.
 * Falls back to user-provided paths when `pkg-config` is not available
 * (common on Windows).
 */

import { execSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import type { BuildSystemLibrary } from "./evaluator/builtins/build";

export interface PkgConfigResult {
  cFlags: string[];
  ldFlags: string[];
  includePaths: string[];
  libraryPaths: string[];
  linkLibraries: string[];
  runtimeFiles: string[];
}

export interface ResolveSystemLibraryOptions {
  preferDebugRuntime?: boolean;
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
      runtimeFiles: [],
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
    runtimeFiles: [],
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
 * Try to resolve a library via vcpkg on Windows.
 */
function findVcpkgLibraryPath(
  libraryDir: string,
  libraryNames: readonly string[]
): string | undefined {
  for (const libraryName of libraryNames) {
    const candidates = [
      `${libraryName}.lib`,
      `lib${libraryName}.lib`,
      `${libraryName}.a`,
      `lib${libraryName}.a`,
    ];
    for (const candidate of candidates) {
      if (existsSync(join(libraryDir, candidate))) {
        return libraryDir;
      }
    }
  }

  return undefined;
}

function findVcpkgRuntimeFiles(
  runtimeDir: string,
  libraryNames: readonly string[]
): string[] {
  const runtimeFiles: string[] = [];

  for (const libraryName of libraryNames) {
    const candidates = [`${libraryName}.dll`, `lib${libraryName}.dll`];
    for (const candidate of candidates) {
      const runtimeFile = join(runtimeDir, candidate);
      if (existsSync(runtimeFile)) {
        runtimeFiles.push(runtimeFile);
        break;
      }
    }
  }

  return runtimeFiles;
}

function readNullTerminatedAscii(
  buffer: Buffer,
  offset: number
): string | undefined {
  let end = offset;
  while (end < buffer.length && buffer[end] !== 0) {
    end++;
  }

  if (end >= buffer.length) {
    return undefined;
  }

  return buffer.toString("ascii", offset, end);
}

function convertPeRvaToFileOffset(
  buffer: Buffer,
  rva: number,
  sectionsOffset: number,
  sectionCount: number
): number | undefined {
  for (let i = 0; i < sectionCount; i++) {
    const sectionOffset = sectionsOffset + i * 40;
    if (sectionOffset + 40 > buffer.length) {
      return undefined;
    }

    const virtualSize = buffer.readUInt32LE(sectionOffset + 8);
    const virtualAddress = buffer.readUInt32LE(sectionOffset + 12);
    const rawSize = buffer.readUInt32LE(sectionOffset + 16);
    const rawPointer = buffer.readUInt32LE(sectionOffset + 20);
    const sectionSize = Math.max(virtualSize, rawSize);

    if (rva >= virtualAddress && rva < virtualAddress + sectionSize) {
      return rawPointer + (rva - virtualAddress);
    }
  }

  return undefined;
}

function getPeImportedDllNames(filePath: string): string[] {
  const buffer = readFileSync(filePath);
  if (buffer.length < 0x40 || buffer.toString("ascii", 0, 2) !== "MZ") {
    return [];
  }

  const peHeaderOffset = buffer.readUInt32LE(0x3c);
  if (peHeaderOffset + 24 > buffer.length) {
    return [];
  }

  if (
    buffer.toString("ascii", peHeaderOffset, peHeaderOffset + 4) !== "PE\0\0"
  ) {
    return [];
  }

  const fileHeaderOffset = peHeaderOffset + 4;
  const sectionCount = buffer.readUInt16LE(fileHeaderOffset + 2);
  const optionalHeaderSize = buffer.readUInt16LE(fileHeaderOffset + 16);
  const optionalHeaderOffset = fileHeaderOffset + 20;
  if (optionalHeaderOffset + optionalHeaderSize > buffer.length) {
    return [];
  }

  const optionalHeaderMagic = buffer.readUInt16LE(optionalHeaderOffset);
  const dataDirectoryOffset =
    optionalHeaderMagic === 0x10b
      ? optionalHeaderOffset + 96
      : optionalHeaderMagic === 0x20b
        ? optionalHeaderOffset + 112
        : undefined;
  if (
    dataDirectoryOffset === undefined ||
    dataDirectoryOffset + 16 > buffer.length
  ) {
    return [];
  }

  const importDirectoryRva = buffer.readUInt32LE(dataDirectoryOffset + 8);
  if (importDirectoryRva === 0) {
    return [];
  }

  const sectionsOffset = optionalHeaderOffset + optionalHeaderSize;
  const importDirectoryOffset = convertPeRvaToFileOffset(
    buffer,
    importDirectoryRva,
    sectionsOffset,
    sectionCount
  );
  if (importDirectoryOffset === undefined) {
    return [];
  }

  const importedDllNames: string[] = [];
  for (
    let descriptorOffset = importDirectoryOffset;
    descriptorOffset + 20 <= buffer.length;
    descriptorOffset += 20
  ) {
    const originalFirstThunk = buffer.readUInt32LE(descriptorOffset);
    const timeDateStamp = buffer.readUInt32LE(descriptorOffset + 4);
    const forwarderChain = buffer.readUInt32LE(descriptorOffset + 8);
    const nameRva = buffer.readUInt32LE(descriptorOffset + 12);
    const firstThunk = buffer.readUInt32LE(descriptorOffset + 16);

    if (
      originalFirstThunk === 0 &&
      timeDateStamp === 0 &&
      forwarderChain === 0 &&
      nameRva === 0 &&
      firstThunk === 0
    ) {
      break;
    }

    const nameOffset = convertPeRvaToFileOffset(
      buffer,
      nameRva,
      sectionsOffset,
      sectionCount
    );
    if (nameOffset === undefined) {
      continue;
    }

    const importedDllName = readNullTerminatedAscii(buffer, nameOffset);
    if (importedDllName !== undefined) {
      importedDllNames.push(importedDllName);
    }
  }

  return [...new Set(importedDllNames)];
}

function findRuntimeDependencyPath(
  runtimeDirs: readonly string[],
  dllName: string
): string | undefined {
  for (const runtimeDir of runtimeDirs) {
    const candidatePath = join(runtimeDir, dllName);
    if (existsSync(candidatePath)) {
      return candidatePath;
    }
  }

  return undefined;
}

function collectTransitiveRuntimeFiles(
  runtimeFiles: readonly string[],
  runtimeDirs: readonly string[]
): string[] {
  const collectedRuntimeFiles = [...runtimeFiles];
  const queue = [...runtimeFiles];
  const seenRuntimeFiles = new Set(
    runtimeFiles.map((runtimeFile) => runtimeFile.toLowerCase())
  );

  while (queue.length > 0) {
    const currentRuntimeFile = queue.shift()!;
    for (const importedDllName of getPeImportedDllNames(currentRuntimeFile)) {
      const dependencyPath = findRuntimeDependencyPath(
        runtimeDirs,
        importedDllName
      );
      if (!dependencyPath) {
        continue;
      }

      const normalizedDependencyPath = dependencyPath.toLowerCase();
      if (seenRuntimeFiles.has(normalizedDependencyPath)) {
        continue;
      }

      seenRuntimeFiles.add(normalizedDependencyPath);
      collectedRuntimeFiles.push(dependencyPath);
      queue.push(dependencyPath);
    }
  }

  return collectedRuntimeFiles;
}

function resolveVcpkgRuntimeFiles(
  runtimeDirs: readonly string[],
  libraryNames: readonly string[]
): string[] {
  for (const runtimeDir of runtimeDirs) {
    const runtimeFiles = findVcpkgRuntimeFiles(runtimeDir, libraryNames);
    if (runtimeFiles.length > 0) {
      return collectTransitiveRuntimeFiles(runtimeFiles, runtimeDirs);
    }
  }

  return [];
}

function resolveVcpkgLibrary(
  lib: BuildSystemLibrary,
  verbose: boolean,
  options: ResolveSystemLibraryOptions
): PkgConfigResult | undefined {
  const vcpkgRoot = process.env.VCPKG_ROOT;
  if (!vcpkgRoot) return undefined;

  const triplets = [
    ...new Set(
      [
        process.env.VCPKG_DEFAULT_TRIPLET,
        "x64-windows",
        "x64-windows-static",
        "x86-windows",
      ].filter((t): t is string => !!t)
    ),
  ];

  const linkLibraries = lib.fallbackLink
    ? lib.fallbackLink.split(/\s+/).filter(Boolean)
    : [lib.name];
  const searchNames = [...new Set([lib.name, ...linkLibraries])];
  const preferDebugRuntime = options.preferDebugRuntime === true;

  for (const triplet of triplets) {
    const includePath = join(vcpkgRoot, "installed", triplet, "include");
    const releaseLibPath = join(vcpkgRoot, "installed", triplet, "lib");
    const debugLibPath = join(vcpkgRoot, "installed", triplet, "debug", "lib");
    const runtimeSearchDirs = preferDebugRuntime
      ? [
          join(vcpkgRoot, "installed", triplet, "debug", "bin"),
          join(vcpkgRoot, "installed", triplet, "bin"),
        ]
      : [
          join(vcpkgRoot, "installed", triplet, "bin"),
          join(vcpkgRoot, "installed", triplet, "debug", "bin"),
        ];
    const librarySearchDirs = preferDebugRuntime
      ? [debugLibPath, releaseLibPath]
      : [releaseLibPath, debugLibPath];
    const libraryPath = librarySearchDirs.find((candidatePath) =>
      findVcpkgLibraryPath(candidatePath, searchNames)
    );

    if (existsSync(includePath) && libraryPath) {
      if (verbose) {
        console.log(`  ${lib.name}: found via vcpkg (${triplet})`);
      }
      return {
        cFlags: [],
        ldFlags: [],
        includePaths: [includePath],
        libraryPaths: [libraryPath],
        linkLibraries,
        runtimeFiles: resolveVcpkgRuntimeFiles(runtimeSearchDirs, searchNames),
      };
    }
  }

  return undefined;
}

/**
 * Resolve a system library, trying pkg-config first then falling back.
 */
export function resolveSystemLibrary(
  lib: BuildSystemLibrary,
  verbose: boolean = false,
  options: ResolveSystemLibraryOptions = {}
): PkgConfigResult {
  if (isPkgConfigAvailable()) {
    const result = queryPkgConfig(lib.name);
    if (result) {
      if (verbose) {
        console.log(`  ${lib.name}: found via pkg-config (${lib.name})`);
      }
      return result;
    }
    if (verbose) {
      console.log(
        `  ${lib.name}: pkg-config query failed for "${lib.name}", trying vcpkg/fallback`
      );
    }
  } else if (verbose) {
    console.log(
      `  ${lib.name}: pkg-config not available, trying vcpkg/fallback`
    );
  }

  // Try vcpkg
  const vcpkgResult = resolveVcpkgLibrary(lib, verbose, options);
  if (vcpkgResult) return vcpkgResult;

  return buildFallback(lib);
}

/**
 * Resolve all system libraries and merge their flags into a single result.
 */
export function resolveAllSystemLibraries(
  libraries: BuildSystemLibrary[],
  verbose: boolean = false,
  options: ResolveSystemLibraryOptions = {}
): PkgConfigResult {
  const merged: PkgConfigResult = {
    cFlags: [],
    ldFlags: [],
    includePaths: [],
    libraryPaths: [],
    linkLibraries: [],
    runtimeFiles: [],
  };

  if (libraries.length === 0) return merged;

  if (verbose) {
    console.log(`Resolving ${libraries.length} system library(ies)...`);
  }

  for (const lib of libraries) {
    const result = resolveSystemLibrary(lib, verbose, options);
    merged.cFlags.push(...result.cFlags);
    merged.ldFlags.push(...result.ldFlags);
    merged.includePaths.push(...result.includePaths);
    merged.libraryPaths.push(...result.libraryPaths);
    merged.linkLibraries.push(...result.linkLibraries);
    for (const runtimeFile of result.runtimeFiles) {
      if (!merged.runtimeFiles.includes(runtimeFile)) {
        merged.runtimeFiles.push(runtimeFile);
      }
    }
  }

  return merged;
}
