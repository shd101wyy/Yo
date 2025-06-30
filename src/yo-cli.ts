import { spawnSync } from "child_process";
import * as fs from "fs";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import packageJson from "../package.json";
import { ModuleManager } from "./module-manager";

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
  .option("print-c", {
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

      const moduleManager = new ModuleManager();

      if (!argv.skipCodegen) {
        moduleManager.compileModule(absolutePath, { printC: argv.printC });

        // Get the generated C code
        const compiledCode = moduleManager.getGeneratedCode();

        // Write the C code to a file
        const outputFile = argv.output as string;
        const tempCFile = outputFile + ".c";
        fs.writeFileSync(tempCFile, compiledCode);

        console.log(`Generated C code written to ${tempCFile}`);

        // Compile the C code with the specified compiler
        const compiler = argv.cc as string;
        const compileArgs = [
          "-std=c11",
          "-Wall",
          "-Wextra",
          tempCFile,
          "-o",
          outputFile,
        ];

        // Check if extern.c exists and add it to compilation
        const externCFile = "extern.c";
        if (fs.existsSync(externCFile)) {
          compileArgs.splice(-2, 0, externCFile); // Insert before -o outputFile
        }

        console.log(`Compiling with: ${compiler} ${compileArgs.join(" ")}`);

        const result = spawnSync(compiler, compileArgs, { stdio: "inherit" });

        if (result.status === 0) {
          console.log(`Successfully compiled to ${outputFile}`);
        } else {
          console.error(`Compilation failed with exit code ${result.status}`);
          process.exit(result.status || 1);
        }
      } else {
        // Just load the module to check for errors
        const result = moduleManager.loadModule(absolutePath);
        if (result.moduleError) {
          throw result.moduleError;
        }
      }
    }
  )
  .help()
  .version("version", "Show version number", `yo ${packageJson.version}`).argv;
