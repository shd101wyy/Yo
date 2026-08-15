/**
 * Tests for build system infrastructure:
 * - Lock file parsing and serialization
 * - Target triple parsing and clang triple generation
 */

import { describe, test, expect } from "bun:test";
import { execSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { pathToFileURL } from "url";
import {
  parseLockFile,
  writeLockFileContent,
  findLockEntry,
  upsertLockEntry,
  type LockFile,
  type LockEntry,
} from "../lock-file";
import { parseTarget, clangTriple, type TargetInfo } from "../target";
import { getGlobalCacheDir } from "../cache";
import { selectStaticLibraryArchiver } from "../codegen";
import {
  areDependenciesCached,
  computeContentHash,
  fetchAllDependencies,
  resolveDependencyPath,
} from "../fetch";
import {
  type BuildArtifact,
  type BuildGitDependency,
  BuildRegistry,
  clearBuildRegistry,
  getBuildRegistry,
  swapBuildRegistry,
  getRootBuildProjectDir,
  setRootBuildProjectDir,
} from "../evaluator/builtins/build";
import { resolveSystemLibrary } from "../pkg-config";

function withTemporaryYoCache<T>(run: (cacheRoot: string) => T): T {
  const previousYoCacheDir = process.env.YO_CACHE_DIR;
  const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "yo-cache-"));

  process.env.YO_CACHE_DIR = cacheRoot;

  try {
    return run(cacheRoot);
  } finally {
    if (previousYoCacheDir === undefined) {
      delete process.env.YO_CACHE_DIR;
    } else {
      process.env.YO_CACHE_DIR = previousYoCacheDir;
    }
    fs.rmSync(cacheRoot, { recursive: true, force: true });
  }
}

function writeTestFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf-8");
}

function createCachedDependency(
  cacheRoot: string,
  depName: string,
  commit: string,
  files: Record<string, string>
): string {
  const depDir = path.join(
    cacheRoot,
    "deps",
    `${depName}-${commit.slice(0, 12)}`
  );
  fs.mkdirSync(depDir, { recursive: true });

  for (const [relativePath, content] of Object.entries(files)) {
    writeTestFile(path.join(depDir, relativePath), content);
  }

  return depDir;
}

function writeDependencyLockFile(projectDir: string, entry: LockEntry): void {
  fs.writeFileSync(
    path.join(projectDir, "yo.lock"),
    writeLockFileContent({ dependencies: [entry] }),
    "utf-8"
  );
}

function createTestDependency(
  name: string,
  url: string = "https://example.com/test-dep.git",
  ref: string = "main"
): BuildGitDependency {
  return {
    name,
    url,
    ref,
    path: "",
  };
}

function createTempGitRepo(files: Record<string, string>): {
  repoDir: string;
  url: string;
  commit: string;
} {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "yo-git-dep-"));

  for (const [relativePath, content] of Object.entries(files)) {
    writeTestFile(path.join(repoDir, relativePath), content);
  }

  execSync("git init", { cwd: repoDir, stdio: "pipe" });
  execSync('git config user.email "yo-tests@example.com"', {
    cwd: repoDir,
    stdio: "pipe",
  });
  execSync('git config user.name "Yo Tests"', {
    cwd: repoDir,
    stdio: "pipe",
  });
  execSync("git add .", { cwd: repoDir, stdio: "pipe" });
  execSync('git commit -m "Initial commit"', { cwd: repoDir, stdio: "pipe" });

  const commit = execSync("git rev-parse HEAD", {
    cwd: repoDir,
    encoding: "utf-8",
    stdio: "pipe",
  }).trim();

  return {
    repoDir,
    url: pathToFileURL(repoDir).href,
    commit,
  };
}

// ── Lock file tests ──────────────────────────────────────────────────

describe("Lock file parser", () => {
  test("parse empty content", () => {
    const result = parseLockFile("");
    expect(result.dependencies).toEqual([]);
  });

  test("parse single dependency", () => {
    const content = `
[[dependencies]]
name = "json-parser"
url = "https://github.com/user/json-parser.git"
ref = "v1.0.0"
commit = "abc123def456"
hash = "sha256-XXXXX"
`;
    const result = parseLockFile(content);
    expect(result.dependencies).toHaveLength(1);
    expect(result.dependencies[0]).toEqual({
      name: "json-parser",
      url: "https://github.com/user/json-parser.git",
      ref: "v1.0.0",
      commit: "abc123def456",
      hash: "sha256-XXXXX",
    });
  });

  test("parse multiple dependencies", () => {
    const content = `
[[dependencies]]
name = "dep-a"
url = "https://github.com/a.git"
ref = "main"
commit = "aaa111"
hash = "sha256-AAA"

[[dependencies]]
name = "dep-b"
url = "https://github.com/b.git"
ref = "v2.0"
commit = "bbb222"
hash = "sha256-BBB"
`;
    const result = parseLockFile(content);
    expect(result.dependencies).toHaveLength(2);
    expect(result.dependencies[0]!.name).toBe("dep-a");
    expect(result.dependencies[1]!.name).toBe("dep-b");
  });

  test("skip comments and blank lines", () => {
    const content = `# This is a comment
# Another comment

[[dependencies]]
name = "dep"
url = "https://example.com/dep.git"
ref = "main"
commit = "111"
hash = "sha256-111"
`;
    const result = parseLockFile(content);
    expect(result.dependencies).toHaveLength(1);
    expect(result.dependencies[0]!.name).toBe("dep");
  });

  test("handle quoted and unquoted values", () => {
    const content = `
[[dependencies]]
name = "quoted-dep"
url = https://example.com/dep.git
ref = "main"
commit = abc123
hash = sha256-XXX
`;
    const result = parseLockFile(content);
    expect(result.dependencies).toHaveLength(1);
    expect(result.dependencies[0]!.name).toBe("quoted-dep");
    expect(result.dependencies[0]!.url).toBe("https://example.com/dep.git");
    expect(result.dependencies[0]!.commit).toBe("abc123");
  });

  test("default missing fields", () => {
    const content = `
[[dependencies]]
name = "minimal"
`;
    const result = parseLockFile(content);
    expect(result.dependencies).toHaveLength(1);
    expect(result.dependencies[0]).toEqual({
      name: "minimal",
      url: "",
      ref: "HEAD",
      commit: "",
      hash: "",
    });
  });
});

describe("Lock file serialization", () => {
  test("roundtrip single dependency", () => {
    const lockFile: LockFile = {
      dependencies: [
        {
          name: "test-dep",
          url: "https://github.com/test.git",
          ref: "v1.0",
          commit: "abc123",
          hash: "sha256-XXX",
        },
      ],
    };

    const serialized = writeLockFileContent(lockFile);
    const parsed = parseLockFile(serialized);
    expect(parsed.dependencies).toHaveLength(1);
    expect(parsed.dependencies[0]).toEqual(lockFile.dependencies[0]);
  });

  test("roundtrip multiple dependencies", () => {
    const lockFile: LockFile = {
      dependencies: [
        {
          name: "dep-a",
          url: "https://a.git",
          ref: "main",
          commit: "aaa",
          hash: "sha256-A",
        },
        {
          name: "dep-b",
          url: "https://b.git",
          ref: "v2",
          commit: "bbb",
          hash: "sha256-B",
        },
      ],
    };

    const serialized = writeLockFileContent(lockFile);
    const parsed = parseLockFile(serialized);
    expect(parsed.dependencies).toHaveLength(2);
    expect(parsed.dependencies[0]!.name).toBe("dep-a");
    expect(parsed.dependencies[1]!.name).toBe("dep-b");
  });

  test("serialized format includes header comment", () => {
    const lockFile: LockFile = { dependencies: [] };
    const serialized = writeLockFileContent(lockFile);
    expect(serialized).toContain("# This file is auto-generated");
  });

  test("empty dependencies produces only header", () => {
    const lockFile: LockFile = { dependencies: [] };
    const serialized = writeLockFileContent(lockFile);
    const parsed = parseLockFile(serialized);
    expect(parsed.dependencies).toHaveLength(0);
  });
});

describe("Lock file utilities", () => {
  const lockFile: LockFile = {
    dependencies: [
      {
        name: "dep-a",
        url: "https://a.git",
        ref: "main",
        commit: "aaa",
        hash: "sha256-A",
      },
      {
        name: "dep-b",
        url: "https://b.git",
        ref: "v1",
        commit: "bbb",
        hash: "sha256-B",
      },
    ],
  };

  test("findLockEntry finds existing", () => {
    const entry = findLockEntry(lockFile, "dep-a");
    expect(entry).toBeDefined();
    expect(entry!.url).toBe("https://a.git");
  });

  test("findLockEntry returns undefined for missing", () => {
    const entry = findLockEntry(lockFile, "nonexistent");
    expect(entry).toBeUndefined();
  });

  test("upsertLockEntry inserts new", () => {
    const newEntry: LockEntry = {
      name: "dep-c",
      url: "https://c.git",
      ref: "v3",
      commit: "ccc",
      hash: "sha256-C",
    };
    const updated = upsertLockEntry(lockFile, newEntry);
    expect(updated.dependencies).toHaveLength(3);
    expect(findLockEntry(updated, "dep-c")).toEqual(newEntry);
  });

  test("upsertLockEntry updates existing", () => {
    const updatedEntry: LockEntry = {
      name: "dep-a",
      url: "https://a-new.git",
      ref: "v2",
      commit: "aaa-new",
      hash: "sha256-A-NEW",
    };
    const updated = upsertLockEntry(lockFile, updatedEntry);
    expect(updated.dependencies).toHaveLength(2);
    expect(findLockEntry(updated, "dep-a")!.url).toBe("https://a-new.git");
  });

  test("upsertLockEntry does not mutate original", () => {
    const newEntry: LockEntry = {
      name: "dep-d",
      url: "https://d.git",
      ref: "main",
      commit: "ddd",
      hash: "sha256-D",
    };
    upsertLockEntry(lockFile, newEntry);
    expect(lockFile.dependencies).toHaveLength(2);
  });
});

// ── Target triple tests ──────────────────────────────────────────────

describe("Target triple parsing", () => {
  test("parse x86_64-linux-gnu", () => {
    const t = parseTarget("x86_64-linux-gnu");
    expect(t.arch).toBe("x86_64");
    expect(t.os).toBe("linux");
    expect(t.abi).toBe("gnu");
    expect(t.pointerSizeBits).toBe(64);
  });

  test("parse aarch64-linux-musl", () => {
    const t = parseTarget("aarch64-linux-musl");
    expect(t.arch).toBe("aarch64");
    expect(t.os).toBe("linux");
    expect(t.abi).toBe("musl");
    expect(t.pointerSizeBits).toBe(64);
  });

  test("parse x86_64-macos", () => {
    const t = parseTarget("x86_64-macos");
    expect(t.arch).toBe("x86_64");
    expect(t.os).toBe("macos");
    expect(t.pointerSizeBits).toBe(64);
  });

  test("parse aarch64-macos", () => {
    const t = parseTarget("aarch64-macos");
    expect(t.arch).toBe("aarch64");
    expect(t.os).toBe("macos");
    expect(t.pointerSizeBits).toBe(64);
  });

  test("parse x86_64-windows-msvc", () => {
    const t = parseTarget("x86_64-windows-msvc");
    expect(t.arch).toBe("x86_64");
    expect(t.os).toBe("windows");
    expect(t.abi).toBe("msvc");
    expect(t.pointerSizeBits).toBe(64);
  });

  test("parse wasm32-wasi", () => {
    const t = parseTarget("wasm32-wasi");
    expect(t.arch).toBe("wasm32");
    expect(t.os).toBe("wasi");
    expect(t.pointerSizeBits).toBe(32);
  });

  test("parse wasm32-emscripten", () => {
    const t = parseTarget("wasm32-emscripten");
    expect(t.arch).toBe("wasm32");
    expect(t.os).toBe("emscripten");
    expect(t.pointerSizeBits).toBe(32);
  });

  test("parse wasm-emscripten shorthand", () => {
    const t = parseTarget("wasm-emscripten");
    expect(t.arch).toBe("wasm32");
    expect(t.os).toBe("emscripten");
    expect(t.triple).toBe("wasm32-emscripten-wasm");
    expect(t.pointerSizeBits).toBe(32);
  });

  test("parse wasm-wasi shorthand", () => {
    const t = parseTarget("wasm-wasi");
    expect(t.arch).toBe("wasm32");
    expect(t.os).toBe("wasi");
    expect(t.pointerSizeBits).toBe(32);
  });

  test("parse x86-linux-gnu (32-bit)", () => {
    const t = parseTarget("x86-linux-gnu");
    expect(t.arch).toBe("x86");
    expect(t.pointerSizeBits).toBe(32);
  });

  test("parse arm-linux-gnu (32-bit)", () => {
    const t = parseTarget("arm-linux-gnu");
    expect(t.arch).toBe("arm");
    expect(t.pointerSizeBits).toBe(32);
  });

  test("triple string preserved", () => {
    const t = parseTarget("x86_64-linux-gnu");
    expect(t.triple).toBe("x86_64-linux-gnu");
  });
});

describe("Clang triple generation", () => {
  test("x86_64 linux gnu", () => {
    const t: TargetInfo = {
      arch: "x86_64",
      os: "linux",
      abi: "gnu",
      pointerSizeBits: 64,
      triple: "x86_64-linux-gnu",
    };
    expect(clangTriple(t)).toBe("x86_64-linux-gnu");
  });

  test("aarch64 linux musl", () => {
    const t: TargetInfo = {
      arch: "aarch64",
      os: "linux",
      abi: "musl",
      pointerSizeBits: 64,
      triple: "aarch64-linux-musl",
    };
    expect(clangTriple(t)).toBe("aarch64-linux-musl");
  });

  test("x86_64 macOS → apple-darwin", () => {
    const t: TargetInfo = {
      arch: "x86_64",
      os: "macos",
      abi: undefined,
      pointerSizeBits: 64,
      triple: "x86_64-macos",
    };
    expect(clangTriple(t)).toBe("x86_64-apple-darwin");
  });

  test("aarch64 macOS → apple-darwin", () => {
    const t: TargetInfo = {
      arch: "aarch64",
      os: "macos",
      abi: undefined,
      pointerSizeBits: 64,
      triple: "aarch64-macos",
    };
    expect(clangTriple(t)).toBe("aarch64-apple-darwin");
  });

  test("x86_64 windows msvc", () => {
    const t: TargetInfo = {
      arch: "x86_64",
      os: "windows",
      abi: "msvc",
      pointerSizeBits: 64,
      triple: "x86_64-windows-msvc",
    };
    expect(clangTriple(t)).toBe("x86_64-pc-windows-msvc");
  });

  test("x86_64 windows gnu → mingw", () => {
    const t: TargetInfo = {
      arch: "x86_64",
      os: "windows",
      abi: "gnu",
      pointerSizeBits: 64,
      triple: "x86_64-windows-gnu",
    };
    expect(clangTriple(t)).toBe("x86_64-w64-mingw32");
  });

  test("wasm32-wasi", () => {
    const t: TargetInfo = {
      arch: "wasm32",
      os: "wasi",
      abi: undefined,
      pointerSizeBits: 32,
      triple: "wasm32-wasi",
    };
    expect(clangTriple(t)).toBe("wasm32-wasi");
  });

  test("wasm32-emscripten", () => {
    const t: TargetInfo = {
      arch: "wasm32",
      os: "emscripten",
      abi: undefined,
      pointerSizeBits: 32,
      triple: "wasm32-emscripten",
    };
    expect(clangTriple(t)).toBe("wasm32-emscripten");
  });

  test("x86_64 freebsd", () => {
    const t: TargetInfo = {
      arch: "x86_64",
      os: "freebsd",
      abi: undefined,
      pointerSizeBits: 64,
      triple: "x86_64-freebsd",
    };
    expect(clangTriple(t)).toBe("x86_64-unknown-freebsd");
  });
});

// ── Global cache tests ───────────────────────────────────────────────

describe("Global cache directory", () => {
  // Save and restore env to avoid interference
  const savedEnv = { ...process.env };

  test("YO_CACHE_DIR env override", () => {
    process.env.YO_CACHE_DIR = "/custom/cache";
    delete process.env.XDG_CACHE_HOME;
    expect(getGlobalCacheDir()).toBe("/custom/cache");
    // Restore
    if (savedEnv.YO_CACHE_DIR) {
      process.env.YO_CACHE_DIR = savedEnv.YO_CACHE_DIR;
    } else {
      delete process.env.YO_CACHE_DIR;
    }
  });

  test("XDG_CACHE_HOME fallback", () => {
    delete process.env.YO_CACHE_DIR;
    process.env.XDG_CACHE_HOME = "/xdg/cache";
    expect(getGlobalCacheDir()).toBe(path.join("/xdg/cache", "yo"));
    // Restore
    if (savedEnv.XDG_CACHE_HOME) {
      process.env.XDG_CACHE_HOME = savedEnv.XDG_CACHE_HOME;
    } else {
      delete process.env.XDG_CACHE_HOME;
    }
    if (savedEnv.YO_CACHE_DIR) {
      process.env.YO_CACHE_DIR = savedEnv.YO_CACHE_DIR;
    }
  });

  test("default falls back to ~/.cache/yo", () => {
    delete process.env.YO_CACHE_DIR;
    delete process.env.XDG_CACHE_HOME;
    // On macOS/Linux, defaults to ~/.cache/yo
    if (process.platform !== "win32") {
      expect(getGlobalCacheDir()).toBe(path.join(os.homedir(), ".cache", "yo"));
    }
    // Restore
    if (savedEnv.YO_CACHE_DIR) {
      process.env.YO_CACHE_DIR = savedEnv.YO_CACHE_DIR;
    }
    if (savedEnv.XDG_CACHE_HOME) {
      process.env.XDG_CACHE_HOME = savedEnv.XDG_CACHE_HOME;
    }
  });
});

describe("Dependency cache integrity", () => {
  test("areDependenciesCached returns true when the cached hash matches yo.lock", () => {
    withTemporaryYoCache((cacheRoot) => {
      const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "yo-project-"));
      const dep = createTestDependency("demo-dep");
      const commit = "0123456789abcdef0123456789abcdef01234567";

      try {
        const cachedDir = createCachedDependency(cacheRoot, dep.name, commit, {
          "build.yo": 'build :: import("std/build");\n',
          "src/lib.yo": "value :: i32(1);\n",
        });
        const hash = computeContentHash(cachedDir);

        writeDependencyLockFile(projectDir, {
          name: dep.name,
          url: dep.url,
          ref: dep.ref,
          commit,
          hash,
        });

        expect(areDependenciesCached(projectDir, [dep])).toBe(true);
      } finally {
        fs.rmSync(projectDir, { recursive: true, force: true });
      }
    });
  });

  test("areDependenciesCached returns false when the cached hash mismatches yo.lock", () => {
    withTemporaryYoCache((cacheRoot) => {
      const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "yo-project-"));
      const dep = createTestDependency("demo-dep");
      const commit = "fedcba9876543210fedcba9876543210fedcba98";

      try {
        createCachedDependency(cacheRoot, dep.name, commit, {
          "build.yo": 'build :: import("std/build");\n',
        });

        writeDependencyLockFile(projectDir, {
          name: dep.name,
          url: dep.url,
          ref: dep.ref,
          commit,
          hash: "sha256-not-the-real-hash",
        });

        expect(areDependenciesCached(projectDir, [dep])).toBe(false);
      } finally {
        fs.rmSync(projectDir, { recursive: true, force: true });
      }
    });
  });

  test("resolveDependencyPath throws on an integrity mismatch", () => {
    withTemporaryYoCache((cacheRoot) => {
      const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "yo-project-"));
      const dep = createTestDependency("demo-dep");
      const commit = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

      try {
        createCachedDependency(cacheRoot, dep.name, commit, {
          "build.yo": 'build :: import("std/build");\n',
        });

        writeDependencyLockFile(projectDir, {
          name: dep.name,
          url: dep.url,
          ref: dep.ref,
          commit,
          hash: "sha256-bad-hash",
        });

        expect(() => resolveDependencyPath(projectDir, dep.name)).toThrow(
          /failed integrity check/i
        );
      } finally {
        fs.rmSync(projectDir, { recursive: true, force: true });
      }
    });
  });

  test("fetchAllDependencies refetches a cached dependency after a hash mismatch", () => {
    withTemporaryYoCache((cacheRoot) => {
      const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "yo-project-"));
      const repo = createTempGitRepo({
        "build.yo": 'build :: import("std/build");\n',
        "src/lib.yo": "answer :: i32(42);\n",
      });
      const dep = createTestDependency("demo-dep", repo.url, "HEAD");

      try {
        const firstResult = fetchAllDependencies(projectDir, [dep]);
        const firstEntry = findLockEntry(firstResult.lockFile, dep.name);
        const cachedDir = firstResult.resolvedPaths.get(dep.name);

        expect(firstEntry).toBeDefined();
        expect(cachedDir).toBeDefined();

        writeTestFile(path.join(cachedDir!, "tampered.txt"), "tampered\n");
        // Remove the sidecar so the next check falls back to full re-hash
        // and detects the tampering.
        const sidecarPath = path.join(cachedDir!, ".yo-content-hash");
        if (fs.existsSync(sidecarPath)) fs.unlinkSync(sidecarPath);

        expect(areDependenciesCached(projectDir, [dep])).toBe(false);
        expect(() => resolveDependencyPath(projectDir, dep.name)).toThrow(
          /failed integrity check/i
        );

        const secondResult = fetchAllDependencies(projectDir, [dep]);
        const secondEntry = findLockEntry(secondResult.lockFile, dep.name);
        const repairedDir = secondResult.resolvedPaths.get(dep.name);

        expect(secondEntry).toBeDefined();
        expect(secondEntry!.commit).toBe(repo.commit);
        expect(secondEntry!.hash).toBe(firstEntry!.hash);
        expect(repairedDir).toBeDefined();
        expect(fs.existsSync(path.join(repairedDir!, "tampered.txt"))).toBe(
          false
        );
        expect(
          fs
            .readFileSync(path.join(repairedDir!, "src/lib.yo"), "utf-8")
            .replace(/\r\n/g, "\n")
        ).toBe("answer :: i32(42);\n");
      } finally {
        fs.rmSync(projectDir, { recursive: true, force: true });
        fs.rmSync(repo.repoDir, { recursive: true, force: true });
        fs.rmSync(path.join(cacheRoot, "deps"), {
          recursive: true,
          force: true,
        });
      }
    });
  });
});

describe("System library resolution", () => {
  function writeTestDll(filePath: string, importedDllNames: string[]): void {
    const sectionRva = 0x1000;
    const sectionFileOffset = 0x200;
    const descriptorSize = 20;
    const descriptorTableSize = descriptorSize * (importedDllNames.length + 1);
    let nextStringRva = sectionRva + descriptorTableSize;
    const importStrings = importedDllNames.map((importedDllName) => {
      const currentRva = nextStringRva;
      nextStringRva += Buffer.byteLength(importedDllName, "ascii") + 1;
      return { importedDllName, rva: currentRva };
    });
    const sectionSize = Math.ceil((nextStringRva - sectionRva) / 0x200) * 0x200;
    const buffer = Buffer.alloc(sectionFileOffset + sectionSize, 0);

    buffer.write("MZ", 0, "ascii");
    buffer.writeUInt32LE(0x80, 0x3c);
    buffer.write("PE\0\0", 0x80, "ascii");

    const fileHeaderOffset = 0x84;
    buffer.writeUInt16LE(0x8664, fileHeaderOffset);
    buffer.writeUInt16LE(1, fileHeaderOffset + 2);
    buffer.writeUInt16LE(0xf0, fileHeaderOffset + 16);
    buffer.writeUInt16LE(0x2022, fileHeaderOffset + 18);

    const optionalHeaderOffset = 0x98;
    buffer.writeUInt16LE(0x20b, optionalHeaderOffset);
    buffer.writeUInt32LE(16, optionalHeaderOffset + 108);
    if (importedDllNames.length > 0) {
      buffer.writeUInt32LE(sectionRva, optionalHeaderOffset + 120);
      buffer.writeUInt32LE(descriptorTableSize, optionalHeaderOffset + 124);
    }

    const sectionHeaderOffset = optionalHeaderOffset + 0xf0;
    buffer.write(".rdata", sectionHeaderOffset, "ascii");
    buffer.writeUInt32LE(sectionSize, sectionHeaderOffset + 8);
    buffer.writeUInt32LE(sectionRva, sectionHeaderOffset + 12);
    buffer.writeUInt32LE(sectionSize, sectionHeaderOffset + 16);
    buffer.writeUInt32LE(sectionFileOffset, sectionHeaderOffset + 20);
    buffer.writeUInt32LE(0x40000040, sectionHeaderOffset + 36);

    importStrings.forEach((importString, index) => {
      const descriptorOffset = sectionFileOffset + index * descriptorSize;
      buffer.writeUInt32LE(importString.rva, descriptorOffset + 12);
      buffer.write(
        importString.importedDllName,
        sectionFileOffset + (importString.rva - sectionRva),
        "ascii"
      );
    });

    fs.writeFileSync(filePath, buffer);
  }

  test("resolves vcpkg libraries by matching a library file", () => {
    const previousVcpkgRoot = process.env.VCPKG_ROOT;
    const previousTriplet = process.env.VCPKG_DEFAULT_TRIPLET;
    const vcpkgRoot = fs.mkdtempSync(path.join(os.tmpdir(), "yo-vcpkg-"));
    const triplet = "x64-windows";
    const includeDir = path.join(vcpkgRoot, "installed", triplet, "include");
    const libDir = path.join(vcpkgRoot, "installed", triplet, "lib");
    const binDir = path.join(vcpkgRoot, "installed", triplet, "bin");
    const runtimeDll = path.join(binDir, "yo_fake_lib.dll");

    try {
      fs.mkdirSync(includeDir, { recursive: true });
      fs.mkdirSync(libDir, { recursive: true });
      fs.mkdirSync(binDir, { recursive: true });
      fs.writeFileSync(path.join(libDir, "yo_fake_lib.lib"), "");
      fs.writeFileSync(runtimeDll, "");

      process.env.VCPKG_ROOT = vcpkgRoot;
      process.env.VCPKG_DEFAULT_TRIPLET = triplet;

      const result = resolveSystemLibrary(
        {
          name: "yo_fake_lib",
          fallbackInclude: "",
          fallbackLib: "",
          fallbackLink: "",
        },
        false
      );

      expect(result.includePaths).toEqual([includeDir]);
      expect(result.libraryPaths).toEqual([libDir]);
      expect(result.linkLibraries).toEqual(["yo_fake_lib"]);
      expect(result.defines).toEqual([]);
      expect(result.runtimeFiles).toEqual([runtimeDll]);
    } finally {
      if (previousVcpkgRoot === undefined) {
        delete process.env.VCPKG_ROOT;
      } else {
        process.env.VCPKG_ROOT = previousVcpkgRoot;
      }
      if (previousTriplet === undefined) {
        delete process.env.VCPKG_DEFAULT_TRIPLET;
      } else {
        process.env.VCPKG_DEFAULT_TRIPLET = previousTriplet;
      }
      fs.rmSync(vcpkgRoot, { recursive: true, force: true });
    }
  });

  test("falls back when vcpkg root exists but the library is not installed", () => {
    const previousVcpkgRoot = process.env.VCPKG_ROOT;
    const previousTriplet = process.env.VCPKG_DEFAULT_TRIPLET;
    const vcpkgRoot = fs.mkdtempSync(path.join(os.tmpdir(), "yo-vcpkg-"));
    const triplet = "x64-windows";
    const includeDir = path.join(vcpkgRoot, "installed", triplet, "include");
    const libDir = path.join(vcpkgRoot, "installed", triplet, "lib");
    const fallbackInclude = path.join("fallback", "include");
    const fallbackLib = path.join("fallback", "lib");

    try {
      fs.mkdirSync(includeDir, { recursive: true });
      fs.mkdirSync(libDir, { recursive: true });

      process.env.VCPKG_ROOT = vcpkgRoot;
      process.env.VCPKG_DEFAULT_TRIPLET = triplet;

      const result = resolveSystemLibrary(
        {
          name: "yo_missing_lib",
          fallbackInclude,
          fallbackLib,
          fallbackLink: "yo_missing_lib",
        },
        false
      );

      expect(result.includePaths).toEqual([fallbackInclude]);
      expect(result.libraryPaths).toEqual([fallbackLib]);
      expect(result.linkLibraries).toEqual(["yo_missing_lib"]);
      expect(result.defines).toEqual([]);
      expect(result.runtimeFiles).toEqual([]);
    } finally {
      if (previousVcpkgRoot === undefined) {
        delete process.env.VCPKG_ROOT;
      } else {
        process.env.VCPKG_ROOT = previousVcpkgRoot;
      }
      if (previousTriplet === undefined) {
        delete process.env.VCPKG_DEFAULT_TRIPLET;
      } else {
        process.env.VCPKG_DEFAULT_TRIPLET = previousTriplet;
      }
      fs.rmSync(vcpkgRoot, { recursive: true, force: true });
    }
  });

  test("prefers debug vcpkg runtime files for debug builds", () => {
    const previousVcpkgRoot = process.env.VCPKG_ROOT;
    const previousTriplet = process.env.VCPKG_DEFAULT_TRIPLET;
    const vcpkgRoot = fs.mkdtempSync(path.join(os.tmpdir(), "yo-vcpkg-"));
    const triplet = "x64-windows";
    const includeDir = path.join(vcpkgRoot, "installed", triplet, "include");
    const releaseLibDir = path.join(vcpkgRoot, "installed", triplet, "lib");
    const debugLibDir = path.join(
      vcpkgRoot,
      "installed",
      triplet,
      "debug",
      "lib"
    );
    const releaseBinDir = path.join(vcpkgRoot, "installed", triplet, "bin");
    const debugBinDir = path.join(
      vcpkgRoot,
      "installed",
      triplet,
      "debug",
      "bin"
    );
    const releaseDll = path.join(releaseBinDir, "yo_debug_pref.dll");
    const debugDll = path.join(debugBinDir, "yo_debug_pref.dll");

    try {
      fs.mkdirSync(includeDir, { recursive: true });
      fs.mkdirSync(releaseLibDir, { recursive: true });
      fs.mkdirSync(debugLibDir, { recursive: true });
      fs.mkdirSync(releaseBinDir, { recursive: true });
      fs.mkdirSync(debugBinDir, { recursive: true });
      fs.writeFileSync(path.join(releaseLibDir, "yo_debug_pref.lib"), "");
      fs.writeFileSync(path.join(debugLibDir, "yo_debug_pref.lib"), "");
      fs.writeFileSync(releaseDll, "");
      fs.writeFileSync(debugDll, "");

      process.env.VCPKG_ROOT = vcpkgRoot;
      process.env.VCPKG_DEFAULT_TRIPLET = triplet;

      const result = resolveSystemLibrary(
        {
          name: "yo_debug_pref",
          fallbackInclude: "",
          fallbackLib: "",
          fallbackLink: "",
        },
        false,
        { preferDebugRuntime: true }
      );

      expect(result.includePaths).toEqual([includeDir]);
      expect(result.libraryPaths).toEqual([debugLibDir]);
      expect(result.linkLibraries).toEqual(["yo_debug_pref"]);
      expect(result.defines).toEqual([]);
      expect(result.runtimeFiles).toEqual([debugDll]);
    } finally {
      if (previousVcpkgRoot === undefined) {
        delete process.env.VCPKG_ROOT;
      } else {
        process.env.VCPKG_ROOT = previousVcpkgRoot;
      }
      if (previousTriplet === undefined) {
        delete process.env.VCPKG_DEFAULT_TRIPLET;
      } else {
        process.env.VCPKG_DEFAULT_TRIPLET = previousTriplet;
      }
      fs.rmSync(vcpkgRoot, { recursive: true, force: true });
    }
  });

  test("discovers transitive vcpkg runtime DLL dependencies", () => {
    const previousVcpkgRoot = process.env.VCPKG_ROOT;
    const previousTriplet = process.env.VCPKG_DEFAULT_TRIPLET;
    const vcpkgRoot = fs.mkdtempSync(path.join(os.tmpdir(), "yo-vcpkg-"));
    const triplet = "x64-windows";
    const includeDir = path.join(vcpkgRoot, "installed", triplet, "include");
    const libDir = path.join(vcpkgRoot, "installed", triplet, "lib");
    const binDir = path.join(vcpkgRoot, "installed", triplet, "bin");
    const runtimeDll = path.join(binDir, "yo_fake_lib.dll");
    const transitiveDll = path.join(binDir, "yo_dependency.dll");

    try {
      fs.mkdirSync(includeDir, { recursive: true });
      fs.mkdirSync(libDir, { recursive: true });
      fs.mkdirSync(binDir, { recursive: true });
      fs.writeFileSync(path.join(libDir, "yo_fake_lib.lib"), "");
      writeTestDll(runtimeDll, ["yo_dependency.dll"]);
      writeTestDll(transitiveDll, []);

      process.env.VCPKG_ROOT = vcpkgRoot;
      process.env.VCPKG_DEFAULT_TRIPLET = triplet;

      const result = resolveSystemLibrary(
        {
          name: "yo_fake_lib",
          fallbackInclude: "",
          fallbackLib: "",
          fallbackLink: "",
        },
        false
      );

      expect(result.includePaths).toEqual([includeDir]);
      expect(result.libraryPaths).toEqual([libDir]);
      expect(result.linkLibraries).toEqual(["yo_fake_lib"]);
      expect(result.defines).toEqual([]);
      expect(result.runtimeFiles).toEqual([runtimeDll, transitiveDll]);
    } finally {
      if (previousVcpkgRoot === undefined) {
        delete process.env.VCPKG_ROOT;
      } else {
        process.env.VCPKG_ROOT = previousVcpkgRoot;
      }
      if (previousTriplet === undefined) {
        delete process.env.VCPKG_DEFAULT_TRIPLET;
      } else {
        process.env.VCPKG_DEFAULT_TRIPLET = previousTriplet;
      }
      fs.rmSync(vcpkgRoot, { recursive: true, force: true });
    }
  });

  test("preserves explicit system-library defines metadata", () => {
    const result = resolveSystemLibrary(
      {
        name: "yo_metadata_lib",
        fallbackInclude: "",
        fallbackLib: "",
        fallbackLink: "yo_metadata_lib",
        defines: ["YO_HEADER_FIXUP", "YO_EXTRA_DEFINE"],
      },
      false
    );

    expect(result.linkLibraries).toEqual(["yo_metadata_lib"]);
    expect(result.defines).toEqual(["YO_HEADER_FIXUP", "YO_EXTRA_DEFINE"]);
  });
});

describe("Windows static library archiver selection", () => {
  const windowsTarget: TargetInfo = {
    arch: "x86_64",
    os: "windows",
    abi: "msvc",
    pointerSizeBits: 64,
    triple: "x86_64-windows-msvc",
  };

  test("prefers llvm-ar for clang Windows builds when available", () => {
    expect(
      selectStaticLibraryArchiver({
        compiler: "clang",
        targetInfo: windowsTarget,
        hasLlvmAr: true,
      })
    ).toEqual({
      tool: "llvm-ar",
      argsPrefix: [],
    });
  });

  test("falls back to ar when llvm-ar is unavailable", () => {
    expect(
      selectStaticLibraryArchiver({
        compiler: "clang",
        targetInfo: windowsTarget,
        hasLlvmAr: false,
      })
    ).toEqual({
      tool: "ar",
      argsPrefix: [],
    });
  });

  test("uses zig ar for zig Windows builds", () => {
    expect(
      selectStaticLibraryArchiver({
        compiler: "zig",
        targetInfo: windowsTarget,
      })
    ).toEqual({
      tool: "zig",
      argsPrefix: ["ar"],
    });
  });
});

// ── BuildRegistry tests ──────────────────────────────────────────────

function makeDefaultArtifactConfig() {
  return {
    root: "./src/main.yo",
    target: "x86_64-linux-gnu",
    optimize: "debug",
    allocator: "mimalloc",
    sanitize: "none",
    linkLibraries: [] as string[],
    includePaths: [] as string[],
    libraryPaths: [] as string[],
    cSources: [] as string[],
    cFlags: [] as string[],
    defines: [] as string[],
    strip: false,
    staticLink: false,
    runtimeFiles: [] as string[],
    linkedArtifacts: [] as string[],
    linkedSystemLibraries: [] as string[],
    importedModules: [],
  };
}

describe("BuildRegistry", () => {
  test("register and find executable", () => {
    const reg = new BuildRegistry();
    reg.registerExecutable({ name: "my-app", ...makeDefaultArtifactConfig() });
    const found = reg.findArtifact("my-app");
    expect(found).toBeDefined();
    expect(found!.kind).toBe("executable");
    expect(found!.name).toBe("my-app");
  });

  test("register and find static library", () => {
    const reg = new BuildRegistry();
    reg.registerStaticLibrary({
      name: "mylib",
      ...makeDefaultArtifactConfig(),
    });
    const found = reg.findArtifact("mylib");
    expect(found).toBeDefined();
    expect(found!.kind).toBe("static_library");
  });

  test("register and find shared library", () => {
    const reg = new BuildRegistry();
    reg.registerSharedLibrary({
      name: "myshared",
      ...makeDefaultArtifactConfig(),
    });
    const found = reg.findArtifact("myshared");
    expect(found).toBeDefined();
    expect(found!.kind).toBe("shared_library");
  });

  test("findArtifact returns undefined for unknown name", () => {
    const reg = new BuildRegistry();
    expect(reg.findArtifact("nonexistent")).toBeUndefined();
  });

  test("registerLink adds to linkedArtifacts", () => {
    const reg = new BuildRegistry();
    reg.registerExecutable({ name: "app", ...makeDefaultArtifactConfig() });
    reg.registerStaticLibrary({ name: "lib", ...makeDefaultArtifactConfig() });
    reg.registerLink("app", "lib");
    const app = reg.findArtifact("app");
    expect(app!.linkedArtifacts).toEqual(["lib"]);
  });

  test("registerLink does not duplicate", () => {
    const reg = new BuildRegistry();
    reg.registerExecutable({ name: "app", ...makeDefaultArtifactConfig() });
    reg.registerLink("app", "lib");
    reg.registerLink("app", "lib");
    const app = reg.findArtifact("app");
    expect(app!.linkedArtifacts).toEqual(["lib"]);
  });

  test("link_system_library adds to linkedSystemLibraries", () => {
    const reg = new BuildRegistry();
    reg.registerExecutable({ name: "app", ...makeDefaultArtifactConfig() });
    const artifact = reg.findArtifact("app")!;
    if (!artifact.linkedSystemLibraries.includes("z")) {
      artifact.linkedSystemLibraries.push("z");
    }
    expect(artifact.linkedSystemLibraries).toEqual(["z"]);
  });

  test("link_system_library does not duplicate", () => {
    const reg = new BuildRegistry();
    reg.registerExecutable({ name: "app", ...makeDefaultArtifactConfig() });
    const artifact = reg.findArtifact("app")!;
    if (!artifact.linkedSystemLibraries.includes("z")) {
      artifact.linkedSystemLibraries.push("z");
    }
    if (!artifact.linkedSystemLibraries.includes("z")) {
      artifact.linkedSystemLibraries.push("z");
    }
    expect(artifact.linkedSystemLibraries).toEqual(["z"]);
  });

  test("register and find path dependency", () => {
    const reg = new BuildRegistry();
    reg.registerPathDependency({ name: "mylib", path: "../mylib" });
    const found = reg.findPathDependency("mylib");
    expect(found).toBeDefined();
    expect(found!.name).toBe("mylib");
    expect(found!.path).toBe("../mylib");
  });

  test("findPathDependency returns undefined for unknown name", () => {
    const reg = new BuildRegistry();
    expect(reg.findPathDependency("nonexistent")).toBeUndefined();
  });

  test("clear resets path dependencies", () => {
    const reg = new BuildRegistry();
    reg.registerPathDependency({ name: "mylib", path: "../mylib" });
    reg.clear();
    expect(reg.pathDependencies).toEqual([]);
  });
});

describe("BuildRegistry CLI options", () => {
  test("setCliOptions stores options", () => {
    const reg = new BuildRegistry();
    const opts = new Map([
      ["strip", "true"],
      ["opt", "release-fast"],
    ]);
    reg.setCliOptions(opts);
    expect(reg.cliOptions.get("strip")).toBe("true");
    expect(reg.cliOptions.get("opt")).toBe("release-fast");
  });

  test("declared options store description and default", () => {
    const reg = new BuildRegistry();
    reg.declaredOptions.set("strip", {
      description: "Strip debug symbols",
      defaultValue: "false",
    });
    const opt = reg.declaredOptions.get("strip");
    expect(opt).toBeDefined();
    expect(opt!.description).toBe("Strip debug symbols");
    expect(opt!.defaultValue).toBe("false");
  });

  test("CLI option overrides default", () => {
    const reg = new BuildRegistry();
    reg.setCliOptions(new Map([["strip", "true"]]));
    reg.declaredOptions.set("strip", {
      description: "Strip",
      defaultValue: "false",
    });
    const value = reg.cliOptions.get("strip") ?? "false";
    expect(value).toBe("true");
  });

  test("missing CLI option falls back to default", () => {
    const reg = new BuildRegistry();
    reg.setCliOptions(new Map());
    reg.declaredOptions.set("strip", {
      description: "Strip",
      defaultValue: "false",
    });
    const value = reg.cliOptions.get("strip") ?? "false";
    expect(value).toBe("false");
  });
});

describe("BuildRegistry steps", () => {
  test("register and find step", () => {
    const reg = new BuildRegistry();
    reg.registerStep("install", "Build all artifacts", ["app", "lib"]);
    const step = reg.findStep("install");
    expect(step).toBeDefined();
    expect(step!.name).toBe("install");
    expect(step!.dependencyNames).toEqual(["app", "lib"]);
  });

  test("getStepNames returns all step names", () => {
    const reg = new BuildRegistry();
    reg.registerStep("install", "Build", []);
    reg.registerStep("test", "Test", []);
    reg.registerStep("run", "Run", []);
    expect(reg.getStepNames()).toEqual(["install", "test", "run"]);
  });

  test("register test suite", () => {
    const reg = new BuildRegistry();
    reg.registerTest({
      name: "tests",
      root: "./tests/",
      target: "x86_64-linux-gnu",
      verbose: false,
      bail: false,
      parallel: 1,
      exclude: [],
    });
    expect(reg.testSuites).toHaveLength(1);
    expect(reg.testSuites[0]!.name).toBe("tests");
  });

  test("register run step", () => {
    const reg = new BuildRegistry();
    reg.runSteps.push({
      name: "run:my-app",
      artifactName: "my-app",
      args: [],
    });
    expect(reg.runSteps).toHaveLength(1);
    expect(reg.runSteps[0]!.name).toBe("run:my-app");
    expect(reg.runSteps[0]!.artifactName).toBe("my-app");
  });

  test("addStepDependency adds dependency to existing step", () => {
    const reg = new BuildRegistry();
    reg.registerStep("install", "Build all");
    reg.addStepDependency("install", "my-app");
    reg.addStepDependency("install", "my-lib");
    const step = reg.findStep("install");
    expect(step).toBeDefined();
    expect(step!.dependencyNames).toEqual(["my-app", "my-lib"]);
  });

  test("addStepDependency does not duplicate", () => {
    const reg = new BuildRegistry();
    reg.registerStep("install", "Build all");
    reg.addStepDependency("install", "my-app");
    reg.addStepDependency("install", "my-app");
    const step = reg.findStep("install");
    expect(step!.dependencyNames).toEqual(["my-app"]);
  });
});

// ── Dependency artifact ref tests ────────────────────────────────────

describe("BuildRegistry dependency artifacts", () => {
  test("registerDependencyArtifact stores refs", () => {
    const reg = new BuildRegistry();
    reg.registerDependencyArtifact({
      dependencyName: "mylib",
      artifactName: "add",
    });
    expect(reg.dependencyArtifacts).toHaveLength(1);
    expect(reg.dependencyArtifacts[0]!.dependencyName).toBe("mylib");
    expect(reg.dependencyArtifacts[0]!.artifactName).toBe("add");
  });

  test("registerDependencyArtifact deduplicates", () => {
    const reg = new BuildRegistry();
    reg.registerDependencyArtifact({
      dependencyName: "mylib",
      artifactName: "add",
    });
    reg.registerDependencyArtifact({
      dependencyName: "mylib",
      artifactName: "add",
    });
    expect(reg.dependencyArtifacts).toHaveLength(1);
  });

  test("registerDependencyArtifact allows different artifacts from same dep", () => {
    const reg = new BuildRegistry();
    reg.registerDependencyArtifact({
      dependencyName: "mylib",
      artifactName: "add",
    });
    reg.registerDependencyArtifact({
      dependencyName: "mylib",
      artifactName: "multiply",
    });
    expect(reg.dependencyArtifacts).toHaveLength(2);
  });

  test("clear resets dependency artifacts", () => {
    const reg = new BuildRegistry();
    reg.registerDependencyArtifact({
      dependencyName: "mylib",
      artifactName: "add",
    });
    reg.clear();
    expect(reg.dependencyArtifacts).toHaveLength(0);
  });
});

// ── swapBuildRegistry tests ──────────────────────────────────────────

describe("swapBuildRegistry", () => {
  test("swaps and returns previous registry", () => {
    // Start clean
    clearBuildRegistry();
    const original = getBuildRegistry();
    original.registerModule({
      name: "root",
      root: "./src/lib.yo",
      linkedSystemLibraries: [],
    });

    const fresh = new BuildRegistry();
    fresh.registerModule({
      name: "dep",
      root: "./src/lib.yo",
      linkedSystemLibraries: [],
    });

    const prev = swapBuildRegistry(fresh);
    expect(prev).toBe(original);
    expect(getBuildRegistry()).toBe(fresh);
    expect(getBuildRegistry().modules[0]?.name).toBe("dep");

    // Restore
    swapBuildRegistry(prev);
    expect(getBuildRegistry()).toBe(original);
    expect(getBuildRegistry().modules[0]?.name).toBe("root");

    // Clean up
    clearBuildRegistry();
  });
});

// ── DAG builder tests ────────────────────────────────────────────────

import {
  buildDAG,
  detectCycle,
  computeDependencyHash,
  getArtifactOutputFileName,
  stageRuntimeFiles,
} from "../build-runner";

describe("buildDAG", () => {
  test("empty step produces empty DAG", () => {
    const reg = new BuildRegistry();
    reg.registerStep("install", "Build all");
    const dag = buildDAG(reg, "install");
    // Root step itself is in the DAG, but with no deps
    expect(dag).toHaveLength(1);
    expect(dag[0]!.name).toBe("install");
    expect(dag[0]!.dependsOn).toEqual([]);
  });

  test("step with artifact dependencies", () => {
    const reg = new BuildRegistry();
    reg.registerExecutable(makeArtifact("app", "./src/main.yo"));
    reg.registerStaticLibrary(makeArtifact("lib-a", "./src/a.yo"));
    reg.registerStep("install", "Build all");
    reg.addStepDependency("install", "app");
    reg.addStepDependency("install", "lib-a");

    const dag = buildDAG(reg, "install");
    expect(dag).toHaveLength(3); // install, app, lib-a
    const names = dag.map((n) => n.name).sort();
    expect(names).toEqual(["app", "install", "lib-a"]);
  });

  test("linked artifacts create edges", () => {
    const reg = new BuildRegistry();
    reg.registerExecutable(makeArtifact("app", "./src/main.yo"));
    reg.registerStaticLibrary(makeArtifact("mylib", "./src/lib.yo"));
    reg.registerLink("app", "mylib");
    reg.registerStep("install", "Build all");
    reg.addStepDependency("install", "app");

    const dag = buildDAG(reg, "install");
    const appNode = dag.find((n) => n.name === "app");
    expect(appNode).toBeDefined();
    expect(appNode!.dependsOn).toContain("mylib");
  });

  test("run step depends on its artifact", () => {
    const reg = new BuildRegistry();
    reg.registerExecutable(makeArtifact("app", "./src/main.yo"));
    reg.registerRun("app", []);
    reg.registerStep("run", "Run the app");
    reg.addStepDependency("run", "run:app");

    const dag = buildDAG(reg, "run");
    const runNode = dag.find((n) => n.name === "run:app");
    expect(runNode).toBeDefined();
    expect(runNode!.kind).toBe("run");
    expect(runNode!.dependsOn).toContain("app");
  });

  test("nested steps are walked transitively", () => {
    const reg = new BuildRegistry();
    reg.registerExecutable(makeArtifact("app", "./src/main.yo"));
    reg.registerStep("compile", "Compile step");
    reg.addStepDependency("compile", "app");
    reg.registerStep("install", "Install step");
    reg.addStepDependency("install", "compile");

    const dag = buildDAG(reg, "install");
    expect(dag).toHaveLength(3); // install, compile, app
    const installNode = dag.find((n) => n.name === "install");
    expect(installNode!.dependsOn).toContain("compile");
  });

  test("deduplicates shared dependencies", () => {
    const reg = new BuildRegistry();
    reg.registerStaticLibrary(makeArtifact("common", "./src/common.yo"));
    reg.registerExecutable(makeArtifact("app-a", "./src/a.yo"));
    reg.registerExecutable(makeArtifact("app-b", "./src/b.yo"));
    reg.registerLink("app-a", "common");
    reg.registerLink("app-b", "common");
    reg.registerStep("install", "Build all");
    reg.addStepDependency("install", "app-a");
    reg.addStepDependency("install", "app-b");

    const dag = buildDAG(reg, "install");
    // common should appear only once
    const commonNodes = dag.filter((n) => n.name === "common");
    expect(commonNodes).toHaveLength(1);
  });
});

describe("detectCycle", () => {
  test("no cycle returns null", () => {
    const dag = [
      { name: "a", kind: "artifact" as const, dependsOn: [] },
      { name: "b", kind: "artifact" as const, dependsOn: ["a"] },
      { name: "c", kind: "step" as const, dependsOn: ["b"] },
    ];
    expect(detectCycle(dag)).toBeNull();
  });

  test("direct cycle is detected", () => {
    const dag = [
      { name: "a", kind: "artifact" as const, dependsOn: ["b"] },
      { name: "b", kind: "artifact" as const, dependsOn: ["a"] },
    ];
    const cycle = detectCycle(dag);
    expect(cycle).not.toBeNull();
    expect(cycle!.length).toBeGreaterThanOrEqual(2);
  });

  test("indirect cycle is detected", () => {
    const dag = [
      { name: "a", kind: "artifact" as const, dependsOn: ["b"] },
      { name: "b", kind: "artifact" as const, dependsOn: ["c"] },
      { name: "c", kind: "artifact" as const, dependsOn: ["a"] },
    ];
    const cycle = detectCycle(dag);
    expect(cycle).not.toBeNull();
  });

  test("self-loop is detected", () => {
    const dag = [{ name: "a", kind: "artifact" as const, dependsOn: ["a"] }];
    const cycle = detectCycle(dag);
    expect(cycle).not.toBeNull();
  });
});

// ── Dependency hash tests ────────────────────────────────────────────

describe("computeDependencyHash", () => {
  test("path dep produces consistent hash", () => {
    const reg = new BuildRegistry();
    reg.registerPathDependency({ name: "mylib", path: "../mylib" });
    const hash1 = computeDependencyHash(reg, "mylib", "/project");
    const hash2 = computeDependencyHash(reg, "mylib", "/project");
    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(12);
  });

  test("different paths produce different hashes", () => {
    const reg = new BuildRegistry();
    reg.registerPathDependency({ name: "lib-a", path: "../lib-a" });
    reg.registerPathDependency({ name: "lib-b", path: "../lib-b" });
    const hashA = computeDependencyHash(reg, "lib-a", "/project");
    const hashB = computeDependencyHash(reg, "lib-b", "/project");
    expect(hashA).not.toBe(hashB);
  });

  test("git dep produces consistent hash", () => {
    const reg = new BuildRegistry();
    reg.registerDependency({
      name: "json",
      url: "https://github.com/user/json.git",
      ref: "v1.0.0",
      path: "",
    });
    const hash1 = computeDependencyHash(reg, "json", "/project");
    const hash2 = computeDependencyHash(reg, "json", "/project");
    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(12);
  });

  test("same path from different project dirs produces same hash", () => {
    const reg = new BuildRegistry();
    reg.registerPathDependency({ name: "mylib", path: "/absolute/mylib" });
    const hash1 = computeDependencyHash(reg, "mylib", "/project-a");
    const hash2 = computeDependencyHash(reg, "mylib", "/project-b");
    // Absolute path → same hash regardless of project dir
    expect(hash1).toBe(hash2);
  });

  test("unknown dep falls back to name hash", () => {
    const reg = new BuildRegistry();
    const hash = computeDependencyHash(reg, "unknown", "/project");
    expect(hash).toHaveLength(12);
  });
});

// ── Helper for creating test artifacts ───────────────────────────────

function makeArtifact(name: string, root: string): Omit<BuildArtifact, "kind"> {
  return {
    name,
    root,
    target: "",
    optimize: "debug",
    allocator: "mimalloc",
    sanitize: "none",
    strip: false,
    staticLink: false,
    runtimeFiles: [],
    cSources: [],
    includePaths: [],
    libraryPaths: [],
    linkLibraries: [],
    linkedArtifacts: [],
    linkedSystemLibraries: [],
    importedModules: [],
    defines: [],
    cFlags: [],
  };
}

describe("Artifact output naming", () => {
  test("appends .exe for Windows executables", () => {
    expect(
      getArtifactOutputFileName(
        {
          kind: "executable",
          name: "app",
          target: "x86_64-linux-gnu",
        },
        "x86_64-windows-msvc"
      )
    ).toBe("app.exe");
  });

  test("keeps bare executable name on non-Windows targets", () => {
    expect(
      getArtifactOutputFileName({
        kind: "executable",
        name: "app",
        target: "x86_64-linux-gnu",
      })
    ).toBe("app");
  });

  test("keeps static library base name unchanged", () => {
    expect(
      getArtifactOutputFileName({
        kind: "static_library",
        name: "mylib",
        target: "x86_64-windows-msvc",
      })
    ).toBe("libmylib");
  });

  test("uses .html for WASM executables by default", () => {
    expect(
      getArtifactOutputFileName({
        kind: "executable",
        name: "app",
        target: "wasm32-emscripten",
      })
    ).toBe("app.html");
  });

  test("uses .js for WASM executables with -sMODULARIZE", () => {
    expect(
      getArtifactOutputFileName({
        kind: "executable",
        name: "app",
        target: "wasm32-emscripten",
        cFlags: ["-O3 -sMODULARIZE=1 -sEXPORT_NAME=createApp"],
      })
    ).toBe("app.js");
  });
});

describe("Runtime dependency staging", () => {
  test("copies unique runtime files into the output directory", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "yo-runtime-stage-"));
    const runtimeDir = path.join(tempDir, "runtime");
    const outputDir = path.join(tempDir, "out");
    const runtimeDll = path.join(runtimeDir, "raylib.dll");

    try {
      fs.mkdirSync(runtimeDir, { recursive: true });
      fs.mkdirSync(outputDir, { recursive: true });
      fs.writeFileSync(runtimeDll, "runtime");

      const stagedFiles = stageRuntimeFiles(
        [runtimeDll, runtimeDll],
        outputDir,
        false
      );
      const stagedDll = path.join(outputDir, "raylib.dll");

      expect(stagedFiles).toEqual([stagedDll]);
      expect(fs.readFileSync(stagedDll, "utf8")).toBe("runtime");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
// ── Root build project dir (transitive import resolution) ────────────

describe("rootBuildProjectDir", () => {
  test("initially undefined", () => {
    setRootBuildProjectDir(undefined);
    expect(getRootBuildProjectDir()).toBeUndefined();
  });

  test("set and get", () => {
    setRootBuildProjectDir("/my/project");
    expect(getRootBuildProjectDir()).toBe("/my/project");
    setRootBuildProjectDir(undefined); // cleanup
  });

  test("can be overwritten", () => {
    setRootBuildProjectDir("/project-a");
    expect(getRootBuildProjectDir()).toBe("/project-a");
    setRootBuildProjectDir("/project-b");
    expect(getRootBuildProjectDir()).toBe("/project-b");
    setRootBuildProjectDir(undefined); // cleanup
  });
});

// ── Transitive dependency registry support ───────────────────────────

describe("Transitive dependency support", () => {
  test("dependency registry captures sub-deps", () => {
    // Simulate: depA's build.yo declares a git dependency on depB
    const depARegistry = new BuildRegistry();
    depARegistry.registerDependency({
      name: "depB",
      url: "https://github.com/user/depB.git",
      ref: "v1.0.0",
      path: "",
    });
    expect(depARegistry.dependencies).toHaveLength(1);
    expect(depARegistry.dependencies[0]!.name).toBe("depB");
  });

  test("dependency registry captures sub-dep artifact refs", () => {
    // Simulate: depA's build.yo calls depB.artifact("math")
    const depARegistry = new BuildRegistry();
    depARegistry.registerDependency({
      name: "depB",
      url: "https://github.com/user/depB.git",
      ref: "v1.0.0",
      path: "",
    });
    depARegistry.registerDependencyArtifact({
      dependencyName: "depB",
      artifactName: "math",
    });
    expect(depARegistry.dependencyArtifacts).toHaveLength(1);
    expect(depARegistry.dependencyArtifacts[0]!.dependencyName).toBe("depB");
    expect(depARegistry.dependencyArtifacts[0]!.artifactName).toBe("math");
  });

  test("swap preserves transitive dep info", () => {
    // Setup: root registry with depA
    clearBuildRegistry();
    const rootReg = getBuildRegistry();
    rootReg.registerDependency({
      name: "depA",
      url: "https://github.com/user/depA.git",
      ref: "main",
      path: "",
    });

    // Simulate evaluateDependencyBuildFile: swap in fresh registry for dep
    const savedRoot = swapBuildRegistry(new BuildRegistry());
    const depReg = getBuildRegistry();
    depReg.registerDependency({
      name: "depB",
      url: "https://github.com/user/depB.git",
      ref: "v1.0.0",
      path: "",
    });

    // Capture dep's registry
    const depResult = getBuildRegistry();

    // Restore root registry
    swapBuildRegistry(savedRoot);

    // depResult should have depB only
    expect(depResult.dependencies).toHaveLength(1);
    expect(depResult.dependencies[0]!.name).toBe("depB");

    // Root registry should still have depA only
    const restored = getBuildRegistry();
    expect(restored.dependencies).toHaveLength(1);
    expect(restored.dependencies[0]!.name).toBe("depA");

    clearBuildRegistry();
  });

  test("content-addressed cache prevents duplicate compilation", () => {
    // Two deps referencing same sub-dep artifact should share cache
    const reg1 = new BuildRegistry();
    reg1.registerPathDependency({ name: "shared", path: "../shared_lib" });
    const hash1 = computeDependencyHash(reg1, "shared", "/project1");

    const reg2 = new BuildRegistry();
    reg2.registerPathDependency({ name: "shared", path: "../shared_lib" });
    const hash2 = computeDependencyHash(reg2, "shared", "/project1");

    // Same absolute path → same hash
    expect(hash1).toBe(hash2);
  });

  test("different sub-dep versions produce different hashes", () => {
    const reg1 = new BuildRegistry();
    reg1.registerDependency({
      name: "util",
      url: "https://github.com/user/util.git",
      ref: "v1.0.0",
      path: "",
    });
    const hash1 = computeDependencyHash(reg1, "util", "/project");

    const reg2 = new BuildRegistry();
    reg2.registerDependency({
      name: "util",
      url: "https://github.com/user/util.git",
      ref: "v2.0.0",
      path: "",
    });
    const hash2 = computeDependencyHash(reg2, "util", "/project");

    expect(hash1).not.toBe(hash2);
  });

  test("linked artifacts propagate through transitive resolution", () => {
    // Simulate: depA's artifact links depB's artifact
    const depARegistry = new BuildRegistry();
    const libA = {
      ...makeArtifact("libA", "./src/lib.yo"),
      kind: "static_library" as const,
    };
    libA.linkedArtifacts.push("libB");
    depARegistry.artifacts.push(libA);
    depARegistry.registerDependencyArtifact({
      dependencyName: "depB",
      artifactName: "libB",
    });

    // Verify the setup
    expect(depARegistry.dependencyArtifacts).toHaveLength(1);
    expect(depARegistry.findArtifact("libA")?.linkedArtifacts).toContain(
      "libB"
    );
  });
});

// ── Module system tests ──────────────────────────────────────────────

describe("Module registration", () => {
  test("register and find module", () => {
    const reg = new BuildRegistry();
    reg.registerModule({
      name: "my-module",
      root: "./src/lib.yo",
      linkedSystemLibraries: [],
    });
    const found = reg.findModule("my-module");
    expect(found).toBeDefined();
    expect(found!.name).toBe("my-module");
    expect(found!.root).toBe("./src/lib.yo");
    expect(found!.linkedSystemLibraries).toEqual([]);
  });

  test("register module with linked system libraries", () => {
    const reg = new BuildRegistry();
    reg.registerModule({
      name: "raylib_yo",
      root: "./src/lib.yo",
      linkedSystemLibraries: [],
    });
    reg.registerModuleLink("raylib_yo", "raylib");
    const found = reg.findModule("raylib_yo");
    expect(found).toBeDefined();
    expect(found!.linkedSystemLibraries).toEqual(["raylib"]);
  });

  test("duplicate module link is ignored", () => {
    const reg = new BuildRegistry();
    reg.registerModule({
      name: "my-mod",
      root: "./src/lib.yo",
      linkedSystemLibraries: [],
    });
    reg.registerModuleLink("my-mod", "raylib");
    reg.registerModuleLink("my-mod", "raylib");
    const found = reg.findModule("my-mod");
    expect(found!.linkedSystemLibraries).toEqual(["raylib"]);
  });

  test("multiple system libraries can be linked to a module", () => {
    const reg = new BuildRegistry();
    reg.registerModule({
      name: "my-mod",
      root: "./src/lib.yo",
      linkedSystemLibraries: [],
    });
    reg.registerModuleLink("my-mod", "raylib");
    reg.registerModuleLink("my-mod", "openssl");
    const found = reg.findModule("my-mod");
    expect(found!.linkedSystemLibraries).toEqual(["raylib", "openssl"]);
  });

  test("duplicate module registration is ignored", () => {
    const reg = new BuildRegistry();
    reg.registerModule({
      name: "my-mod",
      root: "./src/lib.yo",
      linkedSystemLibraries: [],
    });
    reg.registerModule({
      name: "my-mod",
      root: "./src/other.yo",
      linkedSystemLibraries: [],
    });
    expect(reg.modules).toHaveLength(1);
    expect(reg.findModule("my-mod")!.root).toBe("./src/lib.yo");
  });

  test("findModule returns undefined for non-existent module", () => {
    const reg = new BuildRegistry();
    expect(reg.findModule("non-existent")).toBeUndefined();
  });
});

describe("Imported modules on artifacts", () => {
  test("register imported module on artifact", () => {
    const reg = new BuildRegistry();
    reg.registerExecutable({ name: "app", ...makeDefaultArtifactConfig() });
    reg.registerImportedModule("app", {
      importName: "raylib_yo",
      moduleName: "",
      dependencyName: "raylib_yo",
    });
    const artifact = reg.findArtifact("app");
    expect(artifact!.importedModules).toHaveLength(1);
    expect(artifact!.importedModules[0]!.importName).toBe("raylib_yo");
    expect(artifact!.importedModules[0]!.dependencyName).toBe("raylib_yo");
  });

  test("duplicate import name is ignored", () => {
    const reg = new BuildRegistry();
    reg.registerExecutable({ name: "app", ...makeDefaultArtifactConfig() });
    reg.registerImportedModule("app", {
      importName: "raylib_yo",
      moduleName: "",
      dependencyName: "raylib_yo",
    });
    reg.registerImportedModule("app", {
      importName: "raylib_yo",
      moduleName: "other",
      dependencyName: "raylib_yo",
    });
    const artifact = reg.findArtifact("app");
    expect(artifact!.importedModules).toHaveLength(1);
  });

  test("multiple imported modules on same artifact", () => {
    const reg = new BuildRegistry();
    reg.registerExecutable({ name: "app", ...makeDefaultArtifactConfig() });
    reg.registerImportedModule("app", {
      importName: "raylib_yo",
      moduleName: "",
      dependencyName: "raylib_yo",
    });
    reg.registerImportedModule("app", {
      importName: "math_lib",
      moduleName: "math",
      dependencyName: "math_lib",
    });
    const artifact = reg.findArtifact("app");
    expect(artifact!.importedModules).toHaveLength(2);
  });

  test("imported module on non-existent artifact is silently ignored", () => {
    const reg = new BuildRegistry();
    reg.registerImportedModule("non-existent", {
      importName: "raylib_yo",
      moduleName: "",
      dependencyName: "raylib_yo",
    });
    // No error thrown
  });

  test("swap preserves imported modules", () => {
    clearBuildRegistry();
    const reg = getBuildRegistry();
    reg.registerExecutable({ name: "app", ...makeDefaultArtifactConfig() });
    reg.registerImportedModule("app", {
      importName: "raylib_yo",
      moduleName: "",
      dependencyName: "raylib_yo",
    });
    reg.registerModule({
      name: "my-mod",
      root: "./src/lib.yo",
      linkedSystemLibraries: ["raylib"],
    });

    const saved = swapBuildRegistry(new BuildRegistry());
    expect(saved).toBeDefined();
    expect(saved!.findArtifact("app")!.importedModules).toHaveLength(1);
    expect(saved!.modules).toHaveLength(1);
    expect(saved!.findModule("my-mod")!.linkedSystemLibraries).toEqual([
      "raylib",
    ]);

    // Current registry is fresh
    const current = getBuildRegistry();
    expect(current.modules).toHaveLength(0);

    // Cleanup
    clearBuildRegistry();
  });
});
