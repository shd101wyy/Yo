import * as fs from "fs";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import packageJson from "../package.json";
import { CodeGenerator } from "./index";

yargs(hideBin(process.argv))
  .usage(
    `Usage:

yo <file> [options]              Compile a '.yo' file
Example:
  $ yo hello.yo -o  hello
  $ yo hello.yo -cc clang -o hello
  $ yo hello.yo -t  wasm -o hello.wasm

yo --help                        Show this help message  
yo --version                     Show version number

yo install                       Install all packages
yo install <package>             Install a package
yo install <package>@<version>   Install a specific version of a package
yo uninstall <package>           Uninstall a package

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
    default: "clang",
  })
  .option("t", {
    alias: "target",
    describe: "Target language",
    type: "string",
    demandOption: false,
    default: "c",
  })
  .option("print-tokens", {
    describe: "Print tokens generated from lexer",
    type: "boolean",
    demandOption: false,
    default: false,
  })
  .option("print-ast", {
    describe: "Print AST generated from parser",
    type: "boolean",
    demandOption: false,
    default: false,
  })
  .option("skip-prelude", {
    describe: "Skip importing prelude module",
    type: "boolean",
    demandOption: false,
    default: false,
  })
  .option("print-c", {
    describe: "Print C code generated from AST",
    type: "boolean",
    demandOption: false,
    default: false,
  })
  .option("skip-codegen", {
    describe: "Do not compile the code",
    type: "boolean",
    demandOption: false,
    default: false,
  })
  .command(
    "$0 <file> [options]",
    "The default command",
    (yargs) => {
      yargs.positional("file", {
        describe: "File to compile",
        type: "string",
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

      const compiler = new CodeGenerator();
      compiler.loadModule(absolutePath, {
        printTokens: argv.printTokens,
        printAst: argv.printAst,
        printC: argv.printC,
        skipCodegen: argv.skipCodegen,
        skipPrelude: argv.skipPrelude,
      });
    }
  )
  .help()
  .version("version", "Show version number", `yo ${packageJson.version}`).argv;
