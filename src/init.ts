/**
 * `yo init` — project scaffolding.
 *
 * Creates a new Yo project with:
 *   build.yo, src/main.yo (or src/lib.yo), tests/main.test.yo, .gitignore, README.md
 */

import * as fs from "fs";
import * as path from "path";

export interface InitOptions {
  /** Directory to initialize (default: cwd) */
  dir: string;
  /** Project name (default: directory basename) */
  name?: string;
  /** Create a library project instead of executable */
  lib?: boolean;
}

export function initProject(options: InitOptions): void {
  const userCwd = process.env.YO_ORIGINAL_CWD ?? process.cwd();
  const projectDir = path.resolve(userCwd, options.dir);
  const projectName =
    options.name ?? path.basename(projectDir).replace(/[^a-zA-Z0-9_-]/g, "-");
  const isLib = options.lib ?? false;

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
  const buildYo = isLib
    ? generateLibBuildYo(projectName)
    : generateExeBuildYo(projectName);
  fs.writeFileSync(buildYoPath, buildYo);

  // Generate source file
  const srcFile = isLib ? "src/lib.yo" : "src/main.yo";
  const srcPath = path.join(projectDir, srcFile);
  if (!fs.existsSync(srcPath)) {
    const srcContent = isLib ? generateLibSource() : generateMainSource();
    fs.writeFileSync(srcPath, srcContent);
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
  console.log(`    ${srcFile}`);
  console.log(`    tests/main.test.yo`);
  console.log(`    .gitignore`);
  console.log(`    README.md`);
  console.log();
  console.log("  Get started:");
  if (projectDir !== process.cwd()) {
    console.log(`    cd ${path.relative(process.cwd(), projectDir)}`);
  }
  console.log(`    yo build run`);
  console.log();
}

// ── Template generators ───────────────────────────────────────────────

function generateExeBuildYo(name: string): string {
  return `{ build } :: import "std/build";

project :: build.project(
  name: "${name}",
  version: "0.1.0"
);

app :: build.executable(
  name: "${name}",
  root: "./src/main.yo"
);

tests :: build.test(
  name: "tests",
  root: "./tests/"
);

run :: build.run(app);

install :: build.step("install", "Install build artifacts",
  depends_on: ComptimeList(build.Step)(app)
);

run_step :: build.step("run", "Run the application",
  depends_on: ComptimeList(build.Step)(run)
);

test_step :: build.step("test", "Run unit tests",
  depends_on: ComptimeList(build.Step)(tests)
);

export project;
export install;
export run_step;
export test_step;
`;
}

function generateLibBuildYo(name: string): string {
  return `{ build } :: import "std/build";

project :: build.project(
  name: "${name}",
  version: "0.1.0"
);

lib :: build.static_library(
  name: "${name}",
  root: "./src/lib.yo"
);

tests :: build.test(
  name: "tests",
  root: "./tests/"
);

install :: build.step("install", "Install build artifacts",
  depends_on: ComptimeList(build.Step)(lib)
);

test_step :: build.step("test", "Run unit tests",
  depends_on: ComptimeList(build.Step)(tests)
);

export project;
export install;
export test_step;
`;
}

function generateMainSource(): string {
  return `{ println } :: import "std/fmt";

main :: (fn() -> unit)({
  println("Hello, world!");
});

export main;
`;
}

function generateLibSource(): string {
  return `// Library root module

add :: (fn(a: i32, b: i32) -> i32)(
  (a + b)
);
export add;
`;
}

function generateTestFile(): string {
  return `test "it works", {
  assert(((1 + 1) == 2), "math is broken");
};
`;
}

function generateGitignore(): string {
  return `# Build output
yo-out/
.yo-cache/

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

A [Yo](https://github.com/nicholasgasior/yo) project.

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
`;
}
