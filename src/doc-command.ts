// yo doc — documentation generation CLI command
//
// Usage:
//   yo doc [path]                 Generate docs for a file or project
//   yo doc ./src/main.yo          Document a single file
//   yo doc ./src/                 Document all .yo files in a directory
//   yo doc                        Document current project (finds .yo files)

import * as fs from "fs";
import * as path from "path";
import { tokenize } from "./lexer";
import { ModuleManager } from "./module-manager";
import { extractDocComments } from "./doc/extractor";
import { buildDocModule, buildCrossReferences } from "./doc/builder";
import { renderDocSite, destroyMarkdownRenderer } from "./doc/render-html";
import { renderDocMarkdown } from "./doc/render-markdown";
import { renderDocJson } from "./doc/render-json";
import type { DocModel, DocModule } from "./doc/model";

export type DocFormat = "html" | "markdown" | "json";

export interface DocCommandOptions {
  /** File or directory to document (default: current directory) */
  input: string;
  /** Output directory for generated docs (default: yo-out/doc) */
  outputDir: string;
  /** Whether to include private (non-exported) items */
  includePrivate: boolean;
  /** Verbose output */
  verbose: boolean;
  /** Project name override */
  name?: string;
  /** Output format (default: html) */
  format?: DocFormat;
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
      !entry.name.endsWith(".test.yo") &&
      entry.name !== "build.yo"
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
  const modulePath = `file://${filePath}`;

  if (verbose) {
    console.log(`  Documenting: ${moduleName}`);
  }

  try {
    // Read source and tokenize for doc extraction
    const source = fs.readFileSync(filePath, "utf-8");
    const tokens = tokenize(source, modulePath);
    const extraction = extractDocComments(tokens);

    // Evaluate the module to get type information
    const { moduleValue, moduleError } = moduleManager.loadModule(modulePath);

    if (moduleError) {
      if (verbose) {
        console.warn(
          `  Warning: ${moduleName} has evaluation errors — documenting with available info`
        );
      }
    }

    // Build the doc module
    return buildDocModule({
      name: moduleName,
      path: moduleName,
      moduleValue,
      extraction,
      tokens,
      includePrivate: false,
    });
  } catch (err) {
    console.warn(
      `  Warning: Failed to document ${moduleName}: ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
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
    name,
    format = "html",
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
  const projectName = name ?? inferProjectName(basePath);

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

  // Build the doc model
  const model: DocModel = {
    name: projectName,
    modules,
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
