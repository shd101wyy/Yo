import * as fs from "fs";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { CodeGenerator } from "./index";

yargs(hideBin(process.argv))
  .usage(
    `Usage:

mo <file> [options]              Compile a '.mo' file
Example:
  $ mo hello.mo -o hello
  $ mo hello.mo -c clang -o hello
  $ mo hello.mo -t wasm -o hello.wasm

mo --help                        Show this help message  
mo --version                     Show version number

mo install                       Install all packages
mo install <package>             Install a package
mo install <package>@<version>   Install a specific version of a package
mo uninstall <package>           Uninstall a package

mo run <script>                  Run a script defined in 'mo.json'
`
  )
  .option("o", {
    alias: "output",
    describe: "Output file",
    type: "string",
    demandOption: false,
    default: "a.out",
  })
  .option("c", {
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
  .option("print-c", {
    describe: "Print C code generated from AST",
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
      });
    }
  )
  .help()
  .version("version", "Show version number", "mo 0.0.1").argv;
