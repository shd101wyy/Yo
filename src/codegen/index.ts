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
      debugGc?: boolean;
      /**
       * Enable debug logging for cooperative task scheduler operations.
       */
      debugConcurrency?: boolean;
      /**
       * Enable debug logging for async/await state machine operations.
       */
      debugAsyncAwait?: boolean;
      /**
       * Build in release mode with optimizations.
       */
      release?: boolean;
      /**
       * Set optimization level (0, 1, 2, 3). Overrides release.
       */
      optimize?: "0" | "1" | "2" | "3";
    }
  ): void {
    if (!options.skipCodegen) {
      this.moduleManager.compileModule(modulePath, {
        emitC: options.emitC,
        debugGc: options.debugGc,
        debugConcurrency: options.debugConcurrency,
        debugAsyncAwait: options.debugAsyncAwait,
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

        // Determine optimization flags
        let optimizationFlags: string[];
        if (options.optimize !== undefined) {
          // Explicit --optimize flag takes precedence
          const level = options.optimize;
          if (level === "0") {
            optimizationFlags = ["-Wall", "-Wextra", "-O0"];
          } else {
            optimizationFlags = ["-w", `-O${level}`];
          }
        } else if (options.release) {
          // --release uses -O2 and silences warnings
          optimizationFlags = ["-w", "-O2"];
        } else {
          // Default: debug mode with no optimizations and all warnings
          optimizationFlags = ["-Wall", "-Wextra", "-O0"];
        }

        const compileArgs = [
          "-std=c11",
          ...optimizationFlags,
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
