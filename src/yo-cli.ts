import { execSync } from "child_process";
import * as fs from "fs";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import packageJson from "../package.json";
import { CodeGenerator } from "./codegen";
import { findTestFiles, runTests } from "./test-runner";

function checkCompilerAvailable(compiler: string): boolean {
  try {
    execSync(`${compiler} --version`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function findAvailableCompiler(): string | null {
  const compilers = ["cc", "gcc", "clang", "zig", "cl"];
  for (const compiler of compilers) {
    if (checkCompilerAvailable(compiler)) {
      return compiler;
    }
  }
  return null;
}

yargs(hideBin(process.argv))
  .wrap(null)
  .usage(
    `The Yo Programming Language ${packageJson.version}
Usage:

yo compile <file> [options]      Compile a '.yo' file
Example:
  $ yo compile hello.yo -o hello
  $ yo compile hello.yo -cc clang -o hello
  $ yo compile hello.yo -t wasm -o hello.wasm

yo test [path] [options]         Run tests
Example:
  $ yo test                      Run all *.test.yo files in the workspace
  $ yo test ./tests              Run all *.test.yo files in ./tests directory
  $ yo test ./some-file.yo       Run tests in some-file.yo

yo --help                        Show this help message
yo --version                     Show version number

yo install                       Install all packages
yo add <package>                 Install a package
yo add <package>@<version>       Install a specific version of a package
yo remove <package>              Uninstall a package

yo run <script>                  Run a script defined in 'yo.json'
`
  )
  .option("o", {
    alias: "output",
    describe: "Output file",
    type: "string",
    demandOption: false,
    default: "a.out",
  })
  .option("cc", {
    alias: "c-compiler",
    describe: "C Compiler to use: 'cc', 'gcc', 'clang', 'zig', or 'cl' (MSVC)",
    type: "string",
    demandOption: false,
    choices: ["cc", "gcc", "clang", "zig", "cl"],
  })
  .option("t", {
    alias: "target",
    describe: "Target language",
    type: "string",
    demandOption: false,
    default: "c",
  })
  .option("emit-c", {
    describe: "Print C code generated.",
    type: "boolean",
    demandOption: false,
    default: false,
  })
  .option("skip-codegen", {
    describe: "Do not compile the code.",
    type: "boolean",
    demandOption: false,
    default: false,
  })
  .option("skip-c-compiler", {
    describe: "Generate C code but skip running the C compiler.",
    type: "boolean",
    demandOption: false,
    default: false,
  })
  .option("debug-gc", {
    describe: "Enable debug logging for GC and reference counting operations.",
    type: "boolean",
    demandOption: false,
    default: false,
  })
  .option("debug-parallelism", {
    describe: "Enable debug logging for parallel worker thread operations.",
    type: "boolean",
    demandOption: false,
    default: false,
  })
  .option("debug-async-await", {
    describe: "Enable debug logging for async/await state machine operations.",
    type: "boolean",
    demandOption: false,
    default: false,
  })
  .option("allocator", {
    describe: "Memory allocator to use: 'libc' (default) or 'mimalloc'.",
    type: "string",
    demandOption: false,
    default: "libc",
    choices: ["mimalloc", "libc"],
  })
  .option("release", {
    describe: "Build in release mode with optimizations (-O2, no warnings).",
    type: "boolean",
    demandOption: false,
    default: false,
  })
  .option("optimize", {
    describe: "Set optimization level (0, 1, 2, 3). Overrides --release.",
    type: "string",
    demandOption: false,
    choices: ["0", "1", "2", "3"],
  })
  .option("extern", {
    describe: "External C files to link with. eg: --extern extern1.c extern2.c",
    type: "array",
    demandOption: false,
    default: [],
  })
  .option("sanitize", {
    describe:
      "Enable AddressSanitizer for memory leak and error detection. Use 'address' for full sanitizer or 'leak' for leak detection only.",
    type: "string",
    demandOption: false,
    choices: ["address", "leak"],
  })
  .command(
    "compile <file>",
    "Compile a '.yo' file",
    (yargs) => {
      yargs.positional("file", {
        describe: "File to compile",
        type: "string",
        demandOption: true,
      });
    },
    (argv) => {
      const file = argv.file as string;
      if (!fs.existsSync(file)) {
        console.log(`File ${file} does not exist`);
        return;
      }

      let cCompiler = argv.cc as string | undefined;
      if (!cCompiler) {
        const availableCompiler = findAvailableCompiler();
        if (!availableCompiler) {
          console.error(
            "Error: No C compiler found. Please install a C compiler (cc, gcc, clang, zig, or cl) or specify one using the -cc/--c-compiler flag."
          );
          process.exit(1);
        }
        cCompiler = availableCompiler;
      }

      const absolutePath = `file://` + fs.realpathSync(file);

      const codeGenerator = new CodeGenerator();
      codeGenerator.compileModule(absolutePath, {
        output: argv.o,
        cCompiler,
        target: argv.t as "c",
        extern: (argv.extern ?? []) as string[],
        emitC: argv.emitC,
        skipCodegen: argv.skipCodegen,
        skipCCompiler: argv.skipCCompiler,
        debugGc: argv.debugGc,
        debugParallelism: argv.debugParallelism,
        debugAsyncAwait: argv.debugAsyncAwait,
        release: argv.release,
        optimize: argv.optimize as "0" | "1" | "2" | "3" | undefined,
        allocator: argv.allocator as "mimalloc" | "libc",
        sanitize: argv.sanitize as "address" | "leak" | undefined,
      });
    }
  )
  .command(
    "test [path]",
    "Run tests in .test.yo files",
    (yargs) => {
      yargs
        .positional("path", {
          describe:
            "Path to test file or directory (default: current directory)",
          type: "string",
          default: ".",
        })
        .option("verbose", {
          alias: "v",
          describe: "Show detailed error messages",
          type: "boolean",
          default: false,
        })
        .option("bail", {
          alias: "b",
          describe: "Stop running tests after the first failure",
          type: "boolean",
          default: false,
        })
        .option("test-name-pattern", {
          describe: "Only run tests with names matching this regex pattern",
          type: "string",
        })
        .option("parallel", {
          alias: "p",
          describe:
            "Number of tests to run in parallel (0 = auto/max CPUs, 1 = sequential)",
          type: "number",
          default: 1,
        });
    },
    async (argv) => {
      const targetPath = argv.path as string;
      const testFiles = findTestFiles(targetPath);

      if (testFiles.length === 0) {
        console.log("No test files found.");
        process.exit(0);
      }

      const parallel = argv.parallel as number;
      if (parallel < 0) {
        console.error("Error: --parallel value cannot be negative");
        process.exit(1);
      }

      let cCompiler = argv.cc as string | undefined;
      if (!cCompiler) {
        const availableCompiler = findAvailableCompiler();
        if (!availableCompiler) {
          console.error(
            "Error: No C compiler found. Please install a C compiler (cc, gcc, clang, zig, or cl) or specify one using the -cc/--c-compiler flag."
          );
          process.exit(1);
        }
        cCompiler = availableCompiler;
      }

      const summary = await runTests(testFiles, {
        cCompiler,
        verbose: argv.verbose as boolean,
        bail: argv.bail as boolean,
        testNamePattern: argv.testNamePattern as string | undefined,
        parallel,
      });

      process.exit(summary.failed > 0 ? 1 : 0);
    }
  )
  .demandCommand(1, "You need to specify a command (e.g., 'compile')")
  .strict()
  .help()
  .version("version", "Show version number", `yo ${packageJson.version}`).argv;
