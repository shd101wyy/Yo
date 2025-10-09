import { spawnSync } from "child_process";
import * as fs from "fs";
import { ModuleManager } from "../module-manager";

export class CodeGenerator {
  private moduleManager: ModuleManager;

  constructor() {
    this.moduleManager = new ModuleManager();
  }

  public compileModule(
    modulePath: string,
    options: {
      /**
       * Output file
       */
      output: string;
      /**
       * C Compiler to use
       */
      cCompiler: string;
      /**
       * Target language to compile to
       */
      target: "c";
      /**
       * External files to include in the compilation.
       */
      extern: string[];
      /**
       * Print C code generated.
       */
      emitC?: boolean;
      /**
       * Skip the code generation from Yo to the target.
       */
      skipCodegen?: boolean;
      /**
       * Skip the C compiler compilation.
       */
      skipCCompiler?: boolean;
      /**
       * Enable debug logging for Biased Reference Counting operations.
       */
      debugBrc?: boolean;
      /**
       * Enable debug logging for cooperative task scheduler operations.
       */
      debugConcurrency?: boolean;
    }
  ): void {
    if (!options.skipCodegen) {
      this.moduleManager.compileModule(modulePath, {
        emitC: options.emitC,
        debugBrc: options.debugBrc,
        debugConcurrency: options.debugConcurrency,
      });

      // Get the generated C code
      const compiledCode = this.moduleManager.getGeneratedCode();

      // Write the C code to a file
      const outputFile = options.output as string;
      const tempCFile = outputFile + ".c";
      fs.writeFileSync(tempCFile, compiledCode);

      console.log(`Generated C code written to ${tempCFile}`);

      // Compile the C code with the specified compiler (unless skipped)
      if (!options.skipCCompiler) {
        const compiler = options.cCompiler as string;
        const compileArgs = [
          "-std=c11",
          "-w", // Silence all warnings
          // "-Wall",
          // "-Wextra",
          tempCFile,
          "-o",
          outputFile,
        ];

        // Add external files from --extern option
        const externalFiles = options.extern;
        externalFiles.forEach((externFile) => {
          if (fs.existsSync(externFile)) {
            compileArgs.splice(-2, 0, externFile); // Insert before -o outputFile
          } else {
            console.warn(
              `External file ${externFile} does not exist and will be ignored`
            );
          }
        });

        // Always use bundled mimalloc
        const mimallocStaticPath = "vendor/mimalloc/src/static.c";
        const mimallocIncludePath = "vendor/mimalloc/include";

        if (fs.existsSync(mimallocStaticPath)) {
          compileArgs.splice(-2, 0, mimallocStaticPath); // Add mimalloc static.c
          compileArgs.splice(-2, 0, `-I${mimallocIncludePath}`); // Add include path
          console.log("Using bundled mimalloc");
        } else {
          console.warn(
            "Bundled mimalloc not found, falling back to standard malloc"
          );
        }

        // Always use bundled llco (Low-Level Coroutines)
        const llcoPath = "vendor/llco/llco.c";
        const llcoIncludePath = "vendor/llco";

        if (fs.existsSync(llcoPath)) {
          compileArgs.splice(-2, 0, llcoPath); // Add llco.c
          compileArgs.splice(-2, 0, `-I${llcoIncludePath}`); // Add include path for llco.h
          console.log("Using bundled llco");
        } else {
          console.warn(
            "Bundled llco not found, coroutines may not work properly"
          );
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
        console.log("Skipping C compiler (--skip-c-compiler flag set)");
      }
    } else {
      // Just load the module to check for errors
      const result = this.moduleManager.loadModule(modulePath);
      if (result.moduleError) {
        throw result.moduleError;
      }
    }
  }
}
