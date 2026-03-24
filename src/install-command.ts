/**
 * Implementation for the `yo install` CLI command.
 *
 * Installs a git dependency by:
 * 1. Parsing the package specifier (e.g., "github.com/user/repo@v1.0.0")
 * 2. Resolving the latest semver tag (or falling back to the default branch)
 * 3. Appending a build.dependency(...) call to build.yo
 * 4. Running yo fetch to populate the cache and lock file
 */

import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import {
  getBuildRegistry,
  clearBuildRegistry,
} from "./evaluator/builtins/build";
import { fetchAllDependencies } from "./fetch";
import { ModuleManager } from "./module-manager";

export interface InstallOptions {
  /** Package specifier: "github.com/user/repo" or "github.com/user/repo@v1.0.0" */
  package: string;
  /** Path to build file */
  buildFile: string;
  /** Verbose output */
  verbose: boolean;
}

interface ParsedPackage {
  kind: "git";
  /** Inferred dependency name (repo name) */
  name: string;
  /** Full git URL */
  url: string;
  /** Pinned version/ref, or undefined for "latest" */
  pinnedRef: string | undefined;
}

interface ParsedLocalPackage {
  kind: "path";
  /** Inferred dependency name (directory name) */
  name: string;
  /** Relative or absolute path */
  path: string;
}

/**
 * Check if a specifier looks like a local path.
 */
function isLocalPath(spec: string): boolean {
  return (
    spec.startsWith("./") ||
    spec.startsWith("../") ||
    spec.startsWith("/") ||
    spec === "."
  );
}

/**
 * Parse a package specifier like "github.com/user/repo" or "../local-lib".
 */
function parsePackageSpecifier(
  spec: string
): ParsedPackage | ParsedLocalPackage {
  // Check if it's a local path
  if (isLocalPath(spec)) {
    const name = path.basename(path.resolve(spec));
    return { kind: "path", name, path: spec };
  }

  // Split off @version if present
  let urlPart = spec;
  let pinnedRef: string | undefined;

  const atIdx = spec.lastIndexOf("@");
  if (atIdx > 0) {
    urlPart = spec.slice(0, atIdx);
    pinnedRef = spec.slice(atIdx + 1);
  }

  // Support shorthand "github.com/user/repo" → "https://github.com/user/repo.git"
  // Also support full URLs "https://github.com/user/repo.git"
  let url: string;
  if (urlPart.startsWith("https://") || urlPart.startsWith("http://")) {
    url = urlPart;
    if (!url.endsWith(".git")) {
      url += ".git";
    }
  } else if (urlPart.startsWith("github.com/")) {
    url = `https://${urlPart}.git`;
  } else {
    // Assume it's a short form like "user/repo" → GitHub
    const parts = urlPart.split("/");
    if (parts.length === 2) {
      url = `https://github.com/${urlPart}.git`;
    } else {
      throw new Error(
        `Invalid package specifier: "${spec}". ` +
          `Expected format: github.com/user/repo, user/repo, ./path, or https://... URL`
      );
    }
  }

  // Infer name from the last path segment
  const urlPath = url.replace(/\.git$/, "");
  const name = path.basename(urlPath);

  return { kind: "git", name, url, pinnedRef };
}

/**
 * Verify that a git repository exists and is accessible.
 * Throws if the repository cannot be reached.
 */
function verifyRepoExists(url: string): void {
  try {
    execSync(`git ls-remote --exit-code "${url}" HEAD`, {
      encoding: "utf-8",
      timeout: 30000,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
  } catch {
    throw new Error(`Repository not found or not accessible: ${url}`);
  }
}

/**
 * Resolve the latest semver tag from a git repository.
 * Falls back to the default branch if no semver tags are found.
 */
function resolveLatestRef(url: string, verbose: boolean): string {
  // First verify the repo exists
  verifyRepoExists(url);

  // Fetch all tags
  const output = execSync(`git ls-remote --tags "${url}"`, {
    encoding: "utf-8",
    timeout: 30000,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  }).trim();

  if (output) {
    // Parse tags and find semver versions
    const semverPattern = /^v?(\d+)\.(\d+)\.(\d+)$/;
    const tags: { tag: string; major: number; minor: number; patch: number }[] =
      [];

    for (const line of output.split("\n")) {
      const parts = line.split("\t");
      if (parts.length < 2) continue;
      const refPath = parts[1]!.trim();

      // Skip ^{} (dereferenced tags)
      if (refPath.endsWith("^{}")) continue;

      // Extract tag name from refs/tags/xxx
      const tagName = refPath.replace("refs/tags/", "");
      const match = semverPattern.exec(tagName);
      if (match) {
        tags.push({
          tag: tagName,
          major: parseInt(match[1]!, 10),
          minor: parseInt(match[2]!, 10),
          patch: parseInt(match[3]!, 10),
        });
      }
    }

    if (tags.length > 0) {
      // Sort descending by semver
      tags.sort((a, b) => {
        if (a.major !== b.major) return b.major - a.major;
        if (a.minor !== b.minor) return b.minor - a.minor;
        return b.patch - a.patch;
      });

      const latest = tags[0]!.tag;
      if (verbose) {
        console.log(`  Found ${tags.length} semver tag(s), latest: ${latest}`);
      }
      return latest;
    }
  }

  // No semver tags — resolve default branch
  if (verbose) {
    console.log("  No semver tags found, resolving default branch...");
  }
  return resolveDefaultBranch(url);
}

/**
 * Resolve the default branch name (usually "main" or "master").
 */
function resolveDefaultBranch(url: string): string {
  try {
    const output = execSync(`git ls-remote --symref "${url}" HEAD`, {
      encoding: "utf-8",
      timeout: 30000,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    }).trim();

    // Parse: "ref: refs/heads/main\tHEAD"
    const match = /ref: refs\/heads\/(\S+)\tHEAD/.exec(output);
    if (match?.[1]) {
      return match[1];
    }
  } catch {
    // Ignore
  }

  // Fallback to "main"
  return "main";
}

/**
 * Check if a dependency already exists in build.yo content.
 */
function dependencyExistsInBuildFile(content: string, name: string): boolean {
  const escaped = escapeRegex(name);
  const gitPattern = new RegExp(
    `build\\.dependency\\(\\{[^}]*name:\\s*"${escaped}"`,
    "s"
  );
  const pathPattern = new RegExp(
    `build\\.path_dependency\\(\\{[^}]*name:\\s*"${escaped}"`,
    "s"
  );
  return gitPattern.test(content) || pathPattern.test(content);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Append a build.dependency() or build.path_dependency() call to build.yo.
 */
function appendDependencyToBuildFile(
  buildFilePath: string,
  parsed: ParsedPackage | ParsedLocalPackage,
  ref?: string
): boolean {
  let content = fs.readFileSync(buildFilePath, "utf-8");

  // Check if already exists
  if (dependencyExistsInBuildFile(content, parsed.name)) {
    console.log(
      `Dependency "${parsed.name}" already exists in ${path.basename(buildFilePath)}. ` +
        `Update it manually if needed.`
    );
    return false;
  }

  // Build the dependency declaration
  let depLine: string;
  if (parsed.kind === "path") {
    depLine = `\n// Added by yo install\n${parsed.name} :: build.path_dependency({ name: "${parsed.name}", path: "${parsed.path}" });\n`;
  } else {
    depLine = `\n// Added by yo install\n${parsed.name} :: build.dependency({ name: "${parsed.name}", url: "${parsed.url}", ref: "${ref!}" });\n`;
  }

  // Append at end of file
  if (!content.endsWith("\n")) {
    content += "\n";
  }
  content += depLine;

  fs.writeFileSync(buildFilePath, content, "utf-8");

  if (parsed.kind === "path") {
    console.log(
      `Added path dependency "${parsed.name}" (${parsed.path}) to ${path.basename(buildFilePath)}`
    );
  } else {
    console.log(
      `Added dependency "${parsed.name}" @ ${ref} to ${path.basename(buildFilePath)}`
    );
  }
  return true;
}

export async function runInstall(options: InstallOptions): Promise<void> {
  const { package: packageSpec, buildFile, verbose } = options;

  // 1. Parse the package specifier
  const parsed = parsePackageSpecifier(packageSpec);

  // 2. Locate and validate build.yo
  const userCwd = process.env.YO_ORIGINAL_CWD ?? process.cwd();
  const resolvedBuildFile = path.resolve(userCwd, buildFile);
  if (!fs.existsSync(resolvedBuildFile)) {
    console.error(`Error: Build file not found: ${resolvedBuildFile}`);
    console.error("Run 'yo init' to create a project with a build.yo file.");
    process.exit(1);
  }

  if (parsed.kind === "path") {
    // Local path dependency
    const resolvedPath = path.resolve(userCwd, parsed.path);
    if (!fs.existsSync(resolvedPath)) {
      console.error(`Error: Path does not exist: ${resolvedPath}`);
      process.exit(1);
    }

    if (verbose) {
      console.log(`Package: ${parsed.name} (local path)`);
      console.log(`Path: ${parsed.path}`);
    }

    console.log(
      `Installing local dependency "${parsed.name}" from ${parsed.path}...`
    );
    appendDependencyToBuildFile(resolvedBuildFile, parsed);
    printAddImportGuidance(parsed.name);
    console.log("Done.");
    return;
  }

  // Git dependency
  if (verbose) {
    console.log(`Package: ${parsed.name}`);
    console.log(`URL: ${parsed.url}`);
    if (parsed.pinnedRef) {
      console.log(`Pinned ref: ${parsed.pinnedRef}`);
    }
  }

  // 3. Resolve the ref
  let ref: string;
  if (parsed.pinnedRef) {
    ref = parsed.pinnedRef;
    console.log(`Installing ${parsed.name} @ ${ref} ...`);
  } else {
    console.log(`Resolving latest version for ${parsed.name}...`);
    try {
      ref = resolveLatestRef(parsed.url, verbose);
    } catch (err) {
      console.error(`Error: Could not resolve package "${packageSpec}".`);
      console.error(
        `Ensure the repository exists and is accessible: ${parsed.url}`
      );
      if (verbose && err instanceof Error) {
        console.error(`Details: ${err.message}`);
      }
      process.exit(1);
    }
    console.log(`Installing ${parsed.name} @ ${ref} ...`);
  }

  // 4. Append dependency to build.yo
  const added = appendDependencyToBuildFile(resolvedBuildFile, parsed, ref);
  if (!added) return;

  // 5. Fetch the dependency
  const projectDir = path.dirname(resolvedBuildFile);

  // Re-evaluate build.yo to get all dependencies
  clearBuildRegistry();
  const modulePath = `file://${fs.realpathSync(resolvedBuildFile)}`;
  try {
    const moduleManager = new ModuleManager();
    moduleManager.loadModule(modulePath);
    moduleManager.resetAllState();
  } catch {
    // Expected for build files with runtime components
  }

  const registry = getBuildRegistry();
  const dependencies = registry.dependencies;

  if (dependencies.length > 0) {
    console.log("\nFetching dependencies...");
    fetchAllDependencies(projectDir, dependencies, verbose);
    console.log("Done. Lock file updated: yo.lock");
  }

  printAddImportGuidance(parsed.name);
}

function printAddImportGuidance(depName: string): void {
  console.log();
  console.log("To use this dependency in your project, add to your build.yo:");
  console.log(
    `  exe.add_import({ name: "${depName}", module: ${depName}.module("") });`
  );
}
