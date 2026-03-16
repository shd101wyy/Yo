/**
 * Tests for build system infrastructure:
 * - Lock file parsing and serialization
 * - Target triple parsing and clang triple generation
 */

import { describe, test, expect } from "bun:test";
import * as os from "os";
import * as path from "path";
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
    expect(getGlobalCacheDir()).toBe("/xdg/cache/yo");
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

// ── BuildRegistry tests ──────────────────────────────────────────────

import { BuildRegistry } from "../evaluator/builtins/build";

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
    linkedArtifacts: [] as string[],
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

  test("link_system_library adds to linkLibraries", () => {
    const reg = new BuildRegistry();
    reg.registerExecutable({ name: "app", ...makeDefaultArtifactConfig() });
    const artifact = reg.findArtifact("app")!;
    artifact.linkLibraries.push("z");
    expect(artifact.linkLibraries).toEqual(["z"]);
  });

  test("link_system_library does not duplicate", () => {
    const reg = new BuildRegistry();
    reg.registerExecutable({ name: "app", ...makeDefaultArtifactConfig() });
    const artifact = reg.findArtifact("app")!;
    if (!artifact.linkLibraries.includes("z")) {
      artifact.linkLibraries.push("z");
    }
    if (!artifact.linkLibraries.includes("z")) {
      artifact.linkLibraries.push("z");
    }
    expect(artifact.linkLibraries).toEqual(["z"]);
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
    });
    expect(reg.testSuites).toHaveLength(1);
    expect(reg.testSuites[0]!.name).toBe("tests");
  });

  test("register run step", () => {
    const reg = new BuildRegistry();
    reg.registerRun("my-app", []);
    expect(reg.runSteps).toHaveLength(1);
    expect(reg.runSteps[0]!.name).toBe("run:my-app");
    expect(reg.runSteps[0]!.artifactName).toBe("my-app");
  });

  test("register project metadata", () => {
    const reg = new BuildRegistry();
    reg.registerProject("my-app", "1.0.0");
    expect(reg.project).toBeDefined();
    expect(reg.project!.name).toBe("my-app");
    expect(reg.project!.version).toBe("1.0.0");
  });
});
