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
import {
  type BuildArtifact,
  BuildRegistry,
  clearBuildRegistry,
  getBuildRegistry,
  swapBuildRegistry,
  getRootBuildProjectDir,
  setRootBuildProjectDir,
} from "../evaluator/builtins/build";

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
    linkedArtifacts: [] as string[],
    linkedSystemLibraries: [] as string[],
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
    reg.registerProject("my-app", "./src/lib.yo");
    expect(reg.project).toBeDefined();
    expect(reg.project!.name).toBe("my-app");
    expect(reg.project!.root).toBe("./src/lib.yo");
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
    original.registerProject("root", "./src/lib.yo");

    const fresh = new BuildRegistry();
    fresh.registerProject("dep", "./src/lib.yo");

    const prev = swapBuildRegistry(fresh);
    expect(prev).toBe(original);
    expect(getBuildRegistry()).toBe(fresh);
    expect(getBuildRegistry().project?.name).toBe("dep");

    // Restore
    swapBuildRegistry(prev);
    expect(getBuildRegistry()).toBe(original);
    expect(getBuildRegistry().project?.name).toBe("root");

    // Clean up
    clearBuildRegistry();
  });
});

// ── DAG builder tests ────────────────────────────────────────────────

import { buildDAG, detectCycle, computeDependencyHash } from "../build-runner";

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
    cSources: [],
    includePaths: [],
    libraryPaths: [],
    linkLibraries: [],
    linkedArtifacts: [],
    linkedSystemLibraries: [],
    defines: [],
    cFlags: [],
  };
}

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
