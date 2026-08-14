// yo doc — documentation generation CLI command
//
// Usage:
//   yo doc [path]                 Generate docs for a file or project
//   yo doc ./src/main.yo          Document a single file
//   yo doc ./src/                 Document all .yo files in a directory
//   yo doc                        Document current project (finds .yo files)

import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import { tokenize } from "./lexer";
import { ModuleManager, canonicalizeModulePath } from "./module-manager";
import { extractDocComments } from "./doc/extractor";
import {
  buildDocModule,
  buildDocModuleFromTokens,
  buildCrossReferences,
} from "./doc/builder";
import { renderDocSite, destroyMarkdownRenderer } from "./doc/render-html";
import { renderDocMarkdown } from "./doc/render-markdown";
import { renderDocJson } from "./doc/render-json";
import type { DocModel, DocModule } from "./doc/model";
import type { StructValue } from "./value";

export type DocFormat = "html" | "markdown" | "json";

/**
 * Detect version from git: prefer tag on HEAD, fall back to short commit hash.
 * Returns undefined if git is unavailable or not in a repo.
 */
export function detectGitVersion(cwd?: string): string | undefined {
  function git(...gitArgs: string[]): string | undefined {
    try {
      return (
        execFileSync("git", gitArgs, {
          cwd,
          encoding: "utf-8",
          timeout: 5000,
        }).trim() || undefined
      );
    } catch {
      return undefined;
    }
  }
  // Show exact tag only if HEAD is exactly at that tag; otherwise show short commit hash
  return (
    git("describe", "--tags", "--exact-match", "HEAD") ??
    git("rev-parse", "--short", "HEAD")
  );
}

export interface DocCommandOptions {
  /** File or directory to document (default: current directory) */
  input: string;
  /** Output directory for generated docs (default: yo-out/doc) */
  outputDir: string;
  /** Whether to include private (non-exported) items */
  includePrivate: boolean;
  /** Verbose output */
  verbose: boolean;
  /** Doc site title override */
  title?: string;
  /** Output format (default: html) */
  format?: DocFormat;
  /** Release version to display (e.g., "v0.1.12") */
  version?: string;
}

/**
 * Find all .yo source files to document.
 * Excludes test files, build files, and hidden directories.
 */
function findYoFiles(inputPath: string): string[] {
  const absPath = path.resolve(inputPath);

  if (!fs.existsSync(absPath)) {
    throw new Error(`Path does not exist: ${absPath}`);
  }

  const stat = fs.statSync(absPath);
  if (stat.isFile()) {
    if (!absPath.endsWith(".yo")) {
      throw new Error(`Not a .yo file: ${absPath}`);
    }
    return [absPath];
  }

  if (!stat.isDirectory()) {
    throw new Error(`Not a file or directory: ${absPath}`);
  }

  const files: string[] = [];
  collectYoFiles(absPath, files);
  return files.sort();
}

function collectYoFiles(dir: string, files: string[]): void {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    // Skip hidden dirs, node_modules, test dirs, build artifacts
    if (entry.name.startsWith(".")) continue;
    if (entry.name === "node_modules") continue;
    if (entry.name === "yo-out") continue;
    if (entry.name === "out") continue;
    if (entry.name === "tmp") continue;

    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectYoFiles(fullPath, files);
    } else if (
      entry.isFile() &&
      entry.name.endsWith(".yo") &&
      !entry.name.endsWith(".test.yo")
    ) {
      files.push(fullPath);
    }
  }
}

/**
 * Derive a module name from a file path relative to the project root.
 */
function moduleNameFromPath(filePath: string, basePath: string): string {
  const rel = path.relative(basePath, filePath);
  // Remove .yo extension and convert path separators to /
  return rel.replace(/\.yo$/, "").replace(/\\/g, "/");
}

/**
 * Derive the project name from the current directory or package.json.
 */
function inferProjectName(basePath: string): string {
  // Try package.json
  const pkgPath = path.join(basePath, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as {
        name?: string;
      };
      if (pkg.name) return pkg.name;
    } catch {
      // ignore
    }
  }

  // Try build.yo header
  const buildPath = path.join(basePath, "build.yo");
  if (fs.existsSync(buildPath)) {
    const content = fs.readFileSync(buildPath, "utf-8");
    const match = content.match(/\.name\s*=\s*"([^"]+)"/);
    if (match) return match[1]!;
  }

  // Fall back to directory name
  return path.basename(basePath);
}

/**
 * Document a single .yo file and return a DocModule.
 */
function documentFile(
  filePath: string,
  basePath: string,
  moduleManager: ModuleManager,
  verbose: boolean
): DocModule | null {
  const moduleName = moduleNameFromPath(filePath, basePath);
  // Canonical, so the modules.get() below agrees with the canonical key
  // loadModule stores under.
  const modulePath = canonicalizeModulePath(`file://${filePath}`);

  if (verbose) {
    console.log(`  Documenting: ${moduleName}`);
  }

  // Read source and tokenize for doc extraction
  let source: string;
  let tokens: ReturnType<typeof tokenize>;
  try {
    source = fs.readFileSync(filePath, "utf-8");
    tokens = tokenize(source, modulePath);
  } catch (err) {
    console.warn(
      `  Warning: Failed to read/tokenize ${moduleName}: ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }

  const extraction = extractDocComments(tokens);

  // Try to evaluate the module to get type information
  let moduleValue: StructValue | undefined;

  try {
    const result = moduleManager.loadModule(modulePath);
    moduleValue = result.moduleValue;
    if (result.moduleError && verbose) {
      console.warn(
        `  Warning: ${moduleName} has evaluation errors — documenting with available info`
      );
    }
  } catch {
    // Shared evaluator state may cause failures — retry with a fresh ModuleManager
    // Reset global state first so the fresh manager starts clean
    moduleManager.resetAllState();
    try {
      const freshManager = new ModuleManager();
      const result = freshManager.loadModule(modulePath);
      moduleValue = result.moduleValue;
      freshManager.resetAllState();
      if (verbose) {
        console.log(`  Retried ${moduleName} with fresh evaluator — success`);
      }
    } catch (retryErr) {
      console.warn(
        `  Warning: ${moduleName} evaluation failed, using token-only docs: ${retryErr instanceof Error ? retryErr.message.split("\n")[0] : String(retryErr)}`
      );
    }
  }

  if (moduleValue) {
    try {
      const evaluator = moduleManager.modules.get(modulePath)?.evaluator;
      return buildDocModule({
        name: moduleName,
        path: moduleName,
        moduleValue,
        extraction,
        tokens,
        env: evaluator?.getEnv(),
        includePrivate: false,
      });
    } catch (err) {
      console.warn(
        `  Warning: ${moduleName} doc build failed, using token-only docs: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`
      );
    }
  }

  // Fallback: build a minimal doc module from token extraction only
  return buildDocModuleFromTokens({
    name: moduleName,
    path: moduleName,
    extraction,
    tokens,
  });
}

/**
 * Main entry point for the `yo doc` command.
 */
export async function runDoc(options: DocCommandOptions): Promise<void> {
  const startTime = Date.now();
  const {
    input,
    outputDir,
    includePrivate: _includePrivate,
    verbose,
    title,
    format = "html",
    version,
  } = options;

  const basePath = path.resolve(
    fs.statSync(path.resolve(input)).isDirectory() ? input : path.dirname(input)
  );

  // Find files
  console.log("Finding .yo source files...");
  const files = findYoFiles(input);
  if (files.length === 0) {
    console.log("No .yo files found to document.");
    return;
  }
  console.log(`Found ${files.length} file${files.length === 1 ? "" : "s"}`);

  // Determine project name
  const projectName = title ?? inferProjectName(basePath);

  // Create module manager for evaluation
  const moduleManager = new ModuleManager();

  // Document each file
  console.log("Generating documentation...");
  const modules: DocModule[] = [];
  for (const file of files) {
    const doc = documentFile(file, basePath, moduleManager, verbose);
    if (doc) {
      modules.push(doc);
    }
  }

  if (modules.length === 0) {
    console.log("No documentable modules found.");
    return;
  }

  // Build cross-references (trait → implementors)
  buildCrossReferences(modules);

  // Auto-detect version from git if not provided
  const resolvedVersion = version || detectGitVersion(basePath);

  // Build the doc model
  const model: DocModel = {
    name: projectName,
    modules,
    version: resolvedVersion,
  };

  // Render output in the chosen format
  const absOutputDir = path.resolve(outputDir);
  let outputFile: string;
  switch (format) {
    case "markdown":
      console.log(`Rendering Markdown to ${absOutputDir}...`);
      renderDocMarkdown({ model, outputDir: absOutputDir });
      outputFile = "README.md";
      break;
    case "json":
      console.log(`Rendering JSON to ${absOutputDir}...`);
      renderDocJson({ model, outputDir: absOutputDir });
      outputFile = "doc.json";
      break;
    case "html":
    default:
      console.log(`Rendering HTML to ${absOutputDir}...`);
      await renderDocSite({ model, outputDir: absOutputDir });
      destroyMarkdownRenderer();
      outputFile = "index.html";
      break;
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const totalItems = modules.reduce(
    (sum, m) =>
      sum +
      m.functions.length +
      m.types.length +
      m.traits.length +
      m.constants.length,
    0
  );

  console.log(`\nDocumentation generated successfully!`);
  console.log(
    `  ${modules.length} module${modules.length === 1 ? "" : "s"}, ${totalItems} item${totalItems === 1 ? "" : "s"} documented in ${elapsed}s`
  );
  console.log(`  Output: ${absOutputDir}/${outputFile}`);

  // Reset evaluator state
  moduleManager.resetAllState();
}
