/**
 * Tests for `.yo-version` file parsing, discovery, and version cache management.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  findYoVersionFile,
  parseYoVersion,
  readYoVersion,
  getCurrentYoVersion,
  isPinnedVersionCurrent,
} from "../version";

// ── parseYoVersion tests ────────────────────────────────────────────────

describe("parseYoVersion", () => {
  test("parses plain semver", () => {
    expect(parseYoVersion("0.1.12")).toBe("0.1.12");
  });

  test("parses with v prefix", () => {
    expect(parseYoVersion("v0.1.12")).toBe("0.1.12");
  });

  test("parses with V prefix", () => {
    expect(parseYoVersion("V1.2.3")).toBe("1.2.3");
  });

  test("trims whitespace and newlines", () => {
    expect(parseYoVersion("  0.1.12\n")).toBe("0.1.12");
    expect(parseYoVersion("v0.1.12\r\n")).toBe("0.1.12");
  });

  test("parses pre-release version", () => {
    expect(parseYoVersion("0.1.12-beta.1")).toBe("0.1.12-beta.1");
  });

  test("parses version with build metadata", () => {
    expect(parseYoVersion("0.1.12+build.123")).toBe("0.1.12+build.123");
  });

  test("rejects empty content", () => {
    expect(() => parseYoVersion("")).toThrow("Empty .yo-version");
    expect(() => parseYoVersion("  \n")).toThrow("Empty .yo-version");
  });

  test("rejects 'latest'", () => {
    expect(() => parseYoVersion("latest")).toThrow('Invalid version "latest"');
    expect(() => parseYoVersion("LATEST")).toThrow('Invalid version "latest"');
  });

  test("rejects non-semver strings", () => {
    expect(() => parseYoVersion("abc")).toThrow('Invalid version "abc"');
    expect(() => parseYoVersion("1.2")).toThrow('Invalid version "1.2"');
    expect(() => parseYoVersion("1")).toThrow('Invalid version "1"');
    expect(() => parseYoVersion("1.2.3.4")).toThrow(
      'Invalid version "1.2.3.4"'
    );
  });
});

// ── findYoVersionFile + readYoVersion tests ─────────────────────────────

describe("findYoVersionFile", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "yo-version-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("finds .yo-version in current directory", () => {
    fs.writeFileSync(path.join(tmpDir, ".yo-version"), "0.1.12\n");
    const result = findYoVersionFile(tmpDir);
    expect(result).toBe(path.join(tmpDir, ".yo-version"));
  });

  test("finds .yo-version in parent directory", () => {
    fs.writeFileSync(path.join(tmpDir, ".yo-version"), "0.1.12\n");
    const childDir = path.join(tmpDir, "src", "lib");
    fs.mkdirSync(childDir, { recursive: true });
    const result = findYoVersionFile(childDir);
    expect(result).toBe(path.join(tmpDir, ".yo-version"));
  });

  test("returns null when no .yo-version exists", () => {
    const childDir = path.join(tmpDir, "project");
    fs.mkdirSync(childDir, { recursive: true });
    // Don't create .yo-version, but the walk-up will eventually reach /
    // where there's no .yo-version either
    const result = findYoVersionFile(childDir);
    expect(result).toBeNull();
  });

  test("picks nearest .yo-version in directory hierarchy", () => {
    // Parent has 0.1.10
    fs.writeFileSync(path.join(tmpDir, ".yo-version"), "0.1.10\n");
    // Child has 0.1.12
    const childDir = path.join(tmpDir, "sub");
    fs.mkdirSync(childDir);
    fs.writeFileSync(path.join(childDir, ".yo-version"), "0.1.12\n");

    const result = readYoVersion(childDir);
    expect(result).toBe("0.1.12");
  });
});

describe("readYoVersion", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "yo-version-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("reads and parses .yo-version", () => {
    fs.writeFileSync(path.join(tmpDir, ".yo-version"), "v0.1.14\n");
    expect(readYoVersion(tmpDir)).toBe("0.1.14");
  });

  test("returns null when no file exists", () => {
    expect(readYoVersion(tmpDir)).toBeNull();
  });

  test("throws on invalid content", () => {
    fs.writeFileSync(path.join(tmpDir, ".yo-version"), "not-a-version\n");
    expect(() => readYoVersion(tmpDir)).toThrow("Invalid version");
  });
});

// ── getCurrentYoVersion + isPinnedVersionCurrent tests ──────────────────

describe("getCurrentYoVersion", () => {
  test("returns a valid semver string", () => {
    const version = getCurrentYoVersion();
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe("isPinnedVersionCurrent", () => {
  test("returns true when versions match", () => {
    expect(isPinnedVersionCurrent(getCurrentYoVersion())).toBe(true);
  });

  test("returns false when versions differ", () => {
    expect(isPinnedVersionCurrent("0.0.1")).toBe(false);
  });
});
