/**
 * `yo init` — project scaffolding.
 *
 * Creates a new Yo project with:
 *   build.yo, src/main.yo, src/lib.yo, tests/main.test.yo, .gitignore, README.md
 *
 * All projects get both main.yo and lib.yo — the user chooses what to build
 * via build.yo steps. No separate --lib flag needed.
 */

import * as fs from "fs";
import * as path from "path";

export interface InitOptions {
  /** Directory to initialize (default: cwd) */
  dir: string;
  /** Project name (default: directory basename) */
  name?: string;
}

export function initProject(options: InitOptions): void {
  const userCwd = process.env.YO_ORIGINAL_CWD ?? process.cwd();
  const projectDir = path.resolve(userCwd, options.dir);
  const projectName =
    options.name ?? path.basename(projectDir).replace(/[^a-zA-Z0-9_-]/g, "-");

  // Create directories
  const dirs = [
    projectDir,
    path.join(projectDir, "src"),
    path.join(projectDir, "tests"),
  ];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  // Don't overwrite existing build.yo
  const buildYoPath = path.join(projectDir, "build.yo");
  if (fs.existsSync(buildYoPath)) {
    console.error(`Error: ${buildYoPath} already exists. Aborting.`);
    process.exit(1);
  }

  // Generate build.yo
  fs.writeFileSync(buildYoPath, generateBuildYo(projectName));

  // Generate deps.yo
  const depsYoPath = path.join(projectDir, "deps.yo");
  if (!fs.existsSync(depsYoPath)) {
    fs.writeFileSync(depsYoPath, generateDepsYo());
  }

  // Generate both source files
  const mainPath = path.join(projectDir, "src/main.yo");
  if (!fs.existsSync(mainPath)) {
    fs.writeFileSync(mainPath, generateMainSource());
  }
  const libPath = path.join(projectDir, "src/lib.yo");
  if (!fs.existsSync(libPath)) {
    fs.writeFileSync(libPath, generateLibSource());
  }

  // Generate test file
  const testPath = path.join(projectDir, "tests/main.test.yo");
  if (!fs.existsSync(testPath)) {
    fs.writeFileSync(testPath, generateTestFile());
  }

  // Generate .gitignore
  const gitignorePath = path.join(projectDir, ".gitignore");
  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(gitignorePath, generateGitignore());
  }

  // Generate README.md
  const readmePath = path.join(projectDir, "README.md");
  if (!fs.existsSync(readmePath)) {
    fs.writeFileSync(readmePath, generateReadme(projectName));
  }

  console.log(`\nInitialized Yo project "${projectName}" in ${projectDir}`);
  console.log();
  console.log("  Created:");
  console.log(`    build.yo`);
  console.log(`    deps.yo`);
  console.log(`    src/main.yo`);
  console.log(`    src/lib.yo`);
  console.log(`    tests/main.test.yo`);
  console.log(`    .gitignore`);
  console.log(`    README.md`);
  console.log();
  console.log("  Get started:");
  // Echo the directory as the user typed it, and compare against the user's cwd
  // — not `process.cwd()`, which yo-cli may have already changed (that is what
  // YO_ORIGINAL_CWD exists to record). `path.relative(process.cwd(), …)` was
  // both a different question and unportable to the self-hosted scaffolder,
  // which has no `path.relative`.
  if (projectDir !== path.resolve(userCwd)) {
    console.log(`    cd ${options.dir}`);
  }
  console.log(`    yo build run`);
  console.log();
}

// ── Template generators ───────────────────────────────────────────────

function generateBuildYo(name: string): string {
  return `build :: import("std/build");
{ imports } :: import("./deps.yo");
{ assert, panic } :: import("std/assert");

mod :: build.module({ name: "${name}", root: "./src/lib.yo" });

exe :: build.executable({ name: "${name}", root: "./src/main.yo" });
exe.add_import_list(imports);

lib :: build.static_library({ name: "${name}-lib", root: "./src/lib.yo" });

tests :: build.test({ name: "tests", root: "./tests/" });

run_exe :: build.run(exe);

docs :: build.doc({ name: "docs", root: "./src" });

install :: build.step("install", "Build all artifacts");
install.depend_on(exe);
install.depend_on(lib);

run_step :: build.step("run", "Run the application");
run_step.depend_on(run_exe);

test_step :: build.step("test", "Run unit tests");
test_step.depend_on(tests);

doc_step :: build.step("doc", "Generate documentation");
doc_step.depend_on(docs);
`;
}

function generateMainSource(): string {
  return `{ println } :: import("std/fmt");

main :: (fn() -> unit)({
  println("Hello, world!");
});

export(main);
`;
}

function generateLibSource(): string {
  return `// Library root module

add :: (fn(a: i32, b: i32) -> i32)(
  (a + b)
);
export(add);
`;
}

function generateTestFile(): string {
  return `test("it works", {
  assert(((1 + 1) == 2), "math is broken");
});
`;
}

function generateDepsYo(): string {
  return `// Dependencies for this project.
// Managed by \`yo install\`. Manual edits are preserved.
//
// Usage in build.yo:
//   { imports } :: import("./deps.yo");
//   exe.add_import_list(imports);
//
// Add a dependency:
//   yo install user/repo
//   yo install user/repo@v1.0.0
//   yo install ./local-path
//
// Note: The section between "--- Import list ---" and "export(imports);"
// is auto-regenerated by \`yo install\`. All other content is preserved.

build :: import("std/build");

// --- Dependencies ---

// --- Import list ---
imports :: ComptimeList(build.ImportEntry)();
export(imports);
`;
}

// Exported for use by install-command.ts
export { generateDepsYo };

function generateGitignore(): string {
  return `# Build output
yo-out/

# Generated files
*.o
a.out
a.out.c

# OS files
.DS_Store
Thumbs.db
`;
}

function generateReadme(name: string): string {
  return `# ${name}

A project written in Yo programming language.

## Build

\`\`\`bash
yo build
\`\`\`

## Run

\`\`\`bash
yo build run
\`\`\`

## Test

\`\`\`bash
yo build test
\`\`\`

## Documentation

\`\`\`bash
yo build doc
\`\`\`
`;
}
