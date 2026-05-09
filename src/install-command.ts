/**
 * Implementation for the `yo install` CLI command.
 *
 * Installs a git or path dependency by:
 * 1. Parsing the package specifier (e.g., "github.com/user/repo@v1.0.0")
 * 2. Resolving the latest semver tag (or falling back to the default branch)
 * 3. Appending a build.dependency(...) or build.path_dependency(...) call to deps.yo
 * 4. Regenerating the `imports` ComptimeList in deps.yo
 * 5. Running yo fetch to populate the cache and lock file
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
import { generateDepsYo } from "./init";

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
 * Check if a dependency already exists in deps.yo content.
 */
function dependencyExistsInDepsFile(content: string, name: string): boolean {
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
 * Parse all dependency names from deps.yo content.
 * Finds patterns like: `name :: build.dependency(...)` or `name :: build.path_dependency(...)`
 */
function parseDependencyNames(content: string): string[] {
  const names: string[] = [];
  const pattern =
    /^([a-zA-Z_]\w*)\s*::\s*build\.(dependency|path_dependency)\s*\(/gm;
  let match;
  while ((match = pattern.exec(content)) !== null) {
    if (match[1]) {
      names.push(match[1]);
    }
  }
  return names;
}

/**
 * Regenerate the `imports :: ComptimeList(...)` and `export imports;` block
 * in deps.yo content based on all dependency declarations found.
 * Preserves any content the user added after `export imports;`.
 */
function regenerateImportsList(content: string): string {
  const depNames = parseDependencyNames(content);

  // Build the new imports block
  let importsBlock: string;
  if (depNames.length === 0) {
    importsBlock = `imports :: ComptimeList(build.ImportEntry)();\nexport imports;\n`;
  } else {
    const entries = depNames
      .map((name) => `  { name: "${name}", module: ${name}.module() }`)
      .join(",\n");
    importsBlock = `imports :: ComptimeList(build.ImportEntry)(\n${entries}\n);\nexport imports;\n`;
  }

  // Replace existing imports block (between "// --- Import list ---" and "export imports;")
  // Preserve any user content after "export imports;"
  const importListMarker = "// --- Import list ---";
  const markerIdx = content.indexOf(importListMarker);
  if (markerIdx !== -1) {
    const exportImportsPattern = /export imports;\n?/;
    const afterMarker = content.slice(markerIdx);
    const exportMatch = exportImportsPattern.exec(afterMarker);
    if (exportMatch) {
      const endOfBlock = markerIdx + exportMatch.index + exportMatch[0].length;
      const tail = content.slice(endOfBlock);
      return (
        content.slice(0, markerIdx) +
        importListMarker +
        "\n" +
        importsBlock +
        tail
      );
    }
    // No "export imports;" found — replace to end
    return content.slice(0, markerIdx) + importListMarker + "\n" + importsBlock;
  }

  // Fallback: append at end
  if (!content.endsWith("\n")) {
    content += "\n";
  }
  return content + "\n" + importListMarker + "\n" + importsBlock;
}

/**
 * Insert a dependency declaration into deps.yo and regenerate the imports list.
 * Creates deps.yo from template if it doesn't exist.
 */
function appendDependencyToDepsFile(
  depsFilePath: string,
  parsed: ParsedPackage | ParsedLocalPackage,
  ref?: string
): boolean {
  // Create deps.yo from template if it doesn't exist
  if (!fs.existsSync(depsFilePath)) {
    fs.writeFileSync(depsFilePath, generateDepsYo(), "utf-8");
    console.log(`Created ${path.basename(depsFilePath)}`);
  }

  let content = fs.readFileSync(depsFilePath, "utf-8");

  // Check if already exists
  if (dependencyExistsInDepsFile(content, parsed.name)) {
    console.log(
      `Dependency "${parsed.name}" already exists in ${path.basename(depsFilePath)}. ` +
        `Update it manually if needed.`
    );
    return false;
  }

  // Build the dependency declaration line
  let depLine: string;
  if (parsed.kind === "path") {
    depLine = `${parsed.name} :: build.path_dependency({ name: "${parsed.name}", path: "${parsed.path}" });\n`;
  } else {
    depLine = `${parsed.name} :: build.dependency({ name: "${parsed.name}", url: "${parsed.url}", ref: "${ref!}" });\n`;
  }

  // Insert after "// --- Dependencies ---" marker
  const depMarker = "// --- Dependencies ---";
  const depMarkerIdx = content.indexOf(depMarker);
  if (depMarkerIdx !== -1) {
    const insertPos = depMarkerIdx + depMarker.length + 1; // after the marker line
    content = content.slice(0, insertPos) + depLine + content.slice(insertPos);
  } else {
    // Fallback: insert before imports marker or append
    const importMarkerIdx = content.indexOf("// --- Import list ---");
    if (importMarkerIdx !== -1) {
      content =
        content.slice(0, importMarkerIdx) +
        depLine +
        "\n" +
        content.slice(importMarkerIdx);
    } else {
      if (!content.endsWith("\n")) content += "\n";
      content += "\n" + depLine;
    }
  }

  // Regenerate the imports list
  content = regenerateImportsList(content);

  fs.writeFileSync(depsFilePath, content, "utf-8");

  if (parsed.kind === "path") {
    console.log(
      `Added path dependency "${parsed.name}" (${parsed.path}) to ${path.basename(depsFilePath)}`
    );
  } else {
    console.log(
      `Added dependency "${parsed.name}" @ ${ref} to ${path.basename(depsFilePath)}`
    );
  }
  return true;
}

export async function runInstall(options: InstallOptions): Promise<void> {
  const { package: packageSpec, buildFile, verbose } = options;

  // 1. Parse the package specifier
  const parsed = parsePackageSpecifier(packageSpec);

  // 2. Locate and validate build.yo (ensures project exists)
  const userCwd = process.env.YO_ORIGINAL_CWD ?? process.cwd();
  const resolvedBuildFile = path.resolve(userCwd, buildFile);
  if (!fs.existsSync(resolvedBuildFile)) {
    console.error(`Error: Build file not found: ${resolvedBuildFile}`);
    console.error("Run 'yo init' to create a project with a build.yo file.");
    process.exit(1);
  }

  // deps.yo lives alongside build.yo
  const projectDir = path.dirname(resolvedBuildFile);
  const depsFilePath = path.join(projectDir, "deps.yo");

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
    appendDependencyToDepsFile(depsFilePath, parsed);
    printAddImportGuidance(depsFilePath, resolvedBuildFile);
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

  // 4. Append dependency to deps.yo
  const added = appendDependencyToDepsFile(depsFilePath, parsed, ref);
  if (!added) return;

  // 5. Fetch the dependency by evaluating deps.yo to discover all deps
  clearBuildRegistry();
  const modulePath = `file://${fs.realpathSync(depsFilePath)}`;
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

  printAddImportGuidance(depsFilePath, resolvedBuildFile);
}

/**
 * Check if build.yo already imports deps.yo.
 */
function buildFileImportsDeps(buildFilePath: string): boolean {
  if (!fs.existsSync(buildFilePath)) return false;
  const content = fs.readFileSync(buildFilePath, "utf-8");
  return (
    content.includes('import("./deps.yo")') ||
    content.includes('import "./deps.yo"')
  );
}

function printAddImportGuidance(
  depsFilePath: string,
  buildFilePath: string
): void {
  console.log();

  if (!buildFileImportsDeps(buildFilePath)) {
    console.log("Add the following to your build.yo:");
    console.log('  { imports } :: import("./deps.yo");');
    console.log("  exe.add_import_list(imports);");
  } else {
    console.log(
      `Dependencies updated in ${path.basename(depsFilePath)}. ` +
        `Your build.yo already imports deps.yo — no further changes needed.`
    );
  }
}
