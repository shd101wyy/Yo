import * as fs from "fs";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import packageJson from "../package.json";
import { CodeGenerator } from "./codegen";

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
    default: "clang",
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
  .option("extern", {
    describe: "External C files to link with. eg: --extern extern1.c extern2.c",
    type: "array",
    demandOption: false,
    default: [],
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

      const codeGenerator = new CodeGenerator();
      codeGenerator.compileModule(absolutePath, {
        output: argv.o,
        cCompiler: argv.cc,
        target: argv.t as "c",
        extern: (argv.extern ?? []) as string[],
        emitC: argv.emitC,
        skipCodegen: argv.skipCodegen,
        skipCCompiler: argv.skipCCompiler,
      });
    }
  )
  .help()
  .version("version", "Show version number", `yo ${packageJson.version}`).argv;
