/**
 * Implementation for the `yo fetch` CLI command.
 *
 * Evaluates build.yo to discover declared dependencies,
 * then fetches all git dependencies and updates yo.lock.
 */

import * as fs from "fs";
import * as path from "path";
import {
  getBuildRegistry,
  clearBuildRegistry,
} from "./evaluator/builtins/build";
import { fetchAllDependencies } from "./fetch";
import { ModuleManager } from "./module-manager";

export interface FetchOptions {
  buildFile: string;
  verbose: boolean;
}

export async function runFetch(options: FetchOptions): Promise<void> {
  const { buildFile, verbose } = options;

  const userCwd = process.env.YO_ORIGINAL_CWD ?? process.cwd();
  const resolvedBuildFile = path.resolve(userCwd, buildFile);
  if (!fs.existsSync(resolvedBuildFile)) {
    console.error(`Error: Build file not found: ${resolvedBuildFile}`);
    console.error(`Run 'yo init' to create a project with a build.yo file.`);
    process.exit(1);
  }

  const projectDir = path.dirname(resolvedBuildFile);

  // Evaluate build.yo to populate the BuildRegistry
  if (verbose) {
    console.log(`Evaluating ${buildFile}...`);
  }

  clearBuildRegistry();
  const modulePath = `file://${fs.realpathSync(resolvedBuildFile)}`;

  try {
    const moduleManager = new ModuleManager();
    moduleManager.loadModule(modulePath);
    moduleManager.resetAllState();
  } catch {
    // The evaluator populates the registry during compile-time evaluation.
    // Some errors are expected if the build file has runtime components.
  }

  const registry = getBuildRegistry();
  const dependencies = registry.dependencies;

  if (dependencies.length === 0) {
    console.log("No dependencies declared in build.yo.");
    return;
  }

  console.log(`Found ${dependencies.length} dependency(ies) in ${buildFile}:`);
  for (const dep of dependencies) {
    console.log(`  - ${dep.name} (${dep.url} @ ${dep.ref})`);
  }
  console.log();

  const result = fetchAllDependencies(projectDir, dependencies, verbose);

  console.log("\nResolved dependencies:");
  for (const [name, depPath] of result.resolvedPaths) {
    console.log(`  ${name} → ${path.relative(projectDir, depPath)}`);
  }

  // Ensure .yo-cache is in .gitignore
  ensureGitignore(projectDir);

  console.log("\nDone. Lock file updated: yo.lock");
}

/**
 * Ensure .yo-cache/ is in .gitignore.
 */
function ensureGitignore(projectDir: string): void {
  const gitignorePath = path.join(projectDir, ".gitignore");
  const entry = ".yo-cache/";

  if (fs.existsSync(gitignorePath)) {
    const content = fs.readFileSync(gitignorePath, "utf-8");
    if (content.includes(entry)) return;
    fs.appendFileSync(gitignorePath, `\n${entry}\n`);
  } else {
    fs.writeFileSync(gitignorePath, `${entry}\n`);
  }
}
