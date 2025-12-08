import * as fs from "fs";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import packageJson from "../package.json";
import { CodeGenerator } from "./codegen";
import { findTestFiles, runTests } from "./test-runner";

yargs(hideBin(process.argv))
  .wrap(null)
  .usage(
    `Usage:

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
    describe: "C Compiler to use",
    type: "string",
    demandOption: false,
    default: "cc",
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
  .option("debug-brc", {
    describe: "Enable debug logging for Biased Reference Counting operations.",
    type: "boolean",
    demandOption: false,
    default: false,
  })
  .option("debug-concurrency", {
    describe: "Enable debug logging for cooperative task scheduler operations.",
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
      // console.log(argv);
      const file = argv.file as string;
      if (!fs.existsSync(file)) {
        console.log(`File ${file} does not exist`);
        return;
      }

      // Get the absolute path of the file
      const absolutePath = `file://` + fs.realpathSync(file);
      // Add file:// to the path

      const codeGenerator = new CodeGenerator();
      codeGenerator.compileModule(absolutePath, {
        output: argv.o,
        cCompiler: argv.cc,
        target: argv.t as "c",
        extern: (argv.extern ?? []) as string[],
        emitC: argv.emitC,
        skipCodegen: argv.skipCodegen,
        skipCCompiler: argv.skipCCompiler,
        debugBrc: argv.debugBrc,
        debugConcurrency: argv.debugConcurrency,
        debugAsyncAwait: argv.debugAsyncAwait,
        release: argv.release,
        optimize: argv.optimize as "0" | "1" | "2" | "3" | undefined,
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
        .option("test-name-pattern", {
          describe: "Only run tests with names matching this regex pattern",
          type: "string",
        });
    },
    (argv) => {
      const targetPath = argv.path as string;
      const testFiles = findTestFiles(targetPath);

      if (testFiles.length === 0) {
        console.log("No test files found.");
        process.exit(0);
      }

      const summary = runTests(testFiles, {
        cCompiler: argv.cc,
        verbose: argv.verbose as boolean,
        testNamePattern: argv.testNamePattern as string | undefined,
      });

      // Exit with non-zero code if any tests failed
      process.exit(summary.failed > 0 ? 1 : 0);
    }
  )
  .demandCommand(1, "You need to specify a command (e.g., 'compile')")
  .strict()
  .help()
  .version("version", "Show version number", `yo ${packageJson.version}`).argv;
