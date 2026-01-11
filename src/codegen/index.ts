import { execSync, spawnSync } from "child_process";
import * as fs from "fs";
import path from "path";
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
       * Include paths for header files (like gcc -I).
       */
      includePaths?: string[];
      /**
       * Library search paths (like gcc -L).
       */
      libraryPaths?: string[];
      /**
       * Libraries to link against (like gcc -l).
       */
      libraries?: string[];
      /**
       * Preprocessor definitions (like gcc -D).
       */
      defines?: string[];
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
       * Enable debug logging for GC and reference counting operations.
       */
      debugGc?: boolean;
      /**
       * Enable debug logging for parallel worker thread operations.
       */
      debugParallelism?: boolean;
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
      /**
       * Memory allocator to use: 'mimalloc' (default) or 'libc'.
       */
      allocator?: "mimalloc" | "libc";
      /**
       * Enable sanitizer for memory error detection.
       * 'address' - Full AddressSanitizer (memory errors + leaks)
       * 'leak' - Leak detection only
       */
      sanitize?: "address" | "leak";
      /**
       * Include debug symbols in the binary (like gcc -g).
       */
      debugSymbols?: boolean;
      /**
       * Strip symbols from the binary (like gcc -s).
       */
      strip?: boolean;
      /**
       * Produce a statically linked binary.
       */
      static?: boolean;
      /**
       * C standard version to use (c11, c17, c23).
       */
      std?: "c11" | "c17" | "c23";
      /**
       * Arbitrary flags to pass directly to the C compiler.
       */
      cflags?: string;
    }
  ): void {
    if (!options.skipCodegen) {
      this.moduleManager.compileModule(modulePath, {
        emitC: options.emitC,
        debugGc: options.debugGc,
        debugParallelism: options.debugParallelism,
        debugAsyncAwait: options.debugAsyncAwait,
        allocator: options.allocator ?? "mimalloc",
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
        let compiler = options.cCompiler as string;

        // Handle zig compiler: zig requires 'zig cc' to invoke its C compiler
        if (compiler === "zig") {
          compiler = "zig";
        }

        const isMSVC = compiler === "cl";

        // Determine optimization flags
        let optimizationFlags: string[];
        if (options.optimize !== undefined) {
          // Explicit --optimize flag takes precedence
          const level = options.optimize;
          if (level === "0") {
            optimizationFlags = isMSVC
              ? ["/Od", "/W4"]
              : ["-Wall", "-Wextra", "-O0"];
          } else {
            optimizationFlags = isMSVC
              ? ["/w", `/O${level}`]
              : ["-w", `-O${level}`];
          }
        } else if (options.release) {
          // --release uses -O2 and silences warnings
          optimizationFlags = isMSVC ? ["/w", "/O2"] : ["-w", "-O2"];
        } else {
          // Default: debug mode with no optimizations and all warnings
          optimizationFlags = isMSVC
            ? ["/Od", "/W4"]
            : ["-Wall", "-Wextra", "-O0"];
        }

        // Determine C standard to use
        const cStandard = options.std ?? "c11";
        const stdFlag = isMSVC ? `/std:${cStandard}` : `-std=${cStandard}`;

        const compileArgs = isMSVC
          ? [stdFlag, ...optimizationFlags, tempCFile, `/Fe${outputFile}`]
          : [
              ...(options.cCompiler === "zig" ? ["cc"] : []),
              stdFlag,
              ...optimizationFlags,
              tempCFile,
              "-o",
              outputFile,
            ];

        // Add debug symbols flag if requested
        if (options.debugSymbols) {
          if (isMSVC) {
            compileArgs.splice(-1, 0, "/Zi"); // MSVC debug info
          } else {
            compileArgs.splice(-2, 0, "-g");
          }
          console.log("Debug symbols enabled");
        }

        // Add strip flag if requested (conflicts with debug symbols)
        if (options.strip) {
          if (options.debugSymbols) {
            console.warn(
              "Warning: --strip and -g conflict; debug symbols will be stripped"
            );
          }
          if (!isMSVC) {
            compileArgs.splice(-2, 0, "-s");
            console.log("Symbol stripping enabled");
          } else {
            console.warn("Symbol stripping (-s) is not supported with MSVC");
          }
        }

        // Add static linking flag if requested
        if (options.static) {
          if (isMSVC) {
            compileArgs.splice(-1, 0, "/MT"); // Static runtime for MSVC
            console.log("Static linking enabled");
          } else {
            compileArgs.splice(-2, 0, "-static");
            console.log("Static linking enabled");
          }
        }

        // Add sanitizer flags if requested
        if (options.sanitize) {
          if (options.sanitize === "address") {
            if (isMSVC) {
              // MSVC uses /fsanitize=address
              compileArgs.splice(isMSVC ? -1 : -2, 0, "/fsanitize=address");
              console.log(
                "AddressSanitizer enabled (memory errors + leak detection)"
              );
            } else {
              compileArgs.splice(-2, 0, "-fsanitize=address");
              compileArgs.splice(-2, 0, "-fno-omit-frame-pointer");
              console.log(
                "AddressSanitizer enabled (memory errors + leak detection)"
              );
            }
          } else if (options.sanitize === "leak") {
            if (isMSVC) {
              console.warn(
                "LeakSanitizer is not supported by MSVC, use AddressSanitizer instead"
              );
            } else {
              compileArgs.splice(-2, 0, "-fsanitize=leak");
              console.log("LeakSanitizer enabled (leak detection only)");
            }
          }
        }

        // Add external files from --extern option
        const externalFiles = options.extern;
        externalFiles.forEach((externFile) => {
          if (fs.existsSync(externFile)) {
            compileArgs.splice(isMSVC ? -1 : -2, 0, externFile); // Insert before output file
          } else {
            console.warn(
              `External file ${externFile} does not exist and will be ignored`
            );
          }
        });

        // Add include paths from -I option
        const includePaths = options.includePaths ?? [];
        includePaths.forEach((includePath) => {
          const includeFlag = isMSVC ? `/I${includePath}` : `-I${includePath}`;
          compileArgs.splice(isMSVC ? -1 : -2, 0, includeFlag);
        });

        // Add preprocessor definitions from -D option
        const defines = options.defines ?? [];
        defines.forEach((define) => {
          const defineFlag = isMSVC ? `/D${define}` : `-D${define}`;
          compileArgs.splice(isMSVC ? -1 : -2, 0, defineFlag);
        });

        // Add library search paths from -L option
        const libraryPaths = options.libraryPaths ?? [];
        libraryPaths.forEach((libraryPath) => {
          if (isMSVC) {
            // MSVC uses /LIBPATH:
            compileArgs.splice(-1, 0, `/LIBPATH:${libraryPath}`);
          } else {
            compileArgs.splice(-2, 0, `-L${libraryPath}`);
          }
        });

        // Add libraries from -l option
        const libraries = options.libraries ?? [];
        libraries.forEach((library) => {
          if (isMSVC) {
            // MSVC uses library.lib format
            compileArgs.splice(-1, 0, `${library}.lib`);
          } else {
            compileArgs.splice(-2, 0, `-l${library}`);
          }
        });

        // Add mimalloc if using mimalloc allocator
        const allocator = options.allocator ?? "mimalloc";
        if (allocator === "mimalloc") {
          const stdPath = this.moduleManager.stdPath;
          const vendorPath = path.join(path.dirname(stdPath), "vendor");

          const mimallocStaticPath = path.join(
            vendorPath,
            "mimalloc/src/static.c"
          );
          const mimallocIncludePath = path.join(vendorPath, "mimalloc/include");

          if (fs.existsSync(mimallocStaticPath)) {
            compileArgs.splice(isMSVC ? -1 : -2, 0, mimallocStaticPath); // Add mimalloc static.c
            const includeFlag = isMSVC
              ? `/I${mimallocIncludePath}`
              : `-I${mimallocIncludePath}`;
            compileArgs.splice(isMSVC ? -1 : -2, 0, includeFlag); // Add include path
            console.log("Using bundled mimalloc");
          } else {
            console.warn(
              "Bundled mimalloc not found, falling back to standard malloc"
            );
          }
        } else {
          console.log("Using libc allocator");
        }

        // Add liburing on Linux for async I/O (uses system-installed liburing)
        if (process.platform === "linux" && !isMSVC) {
          try {
            // First check if pkg-config is available
            execSync("command -v pkg-config", { stdio: "ignore" });
            // Then check if liburing is installed
            execSync("pkg-config --exists liburing", { stdio: "ignore" });
            compileArgs.splice(-2, 0, "-luring");
            console.log("Using system liburing for async I/O");
          } catch (error) {
            console.warn(
              "⚠️  liburing not found - async I/O will not be available. Run 'npm run postinstall' for installation instructions."
            );
          }
        }

        // Add arbitrary custom compiler flags from --cflags option
        if (options.cflags) {
          const customFlags = options.cflags.trim().split(/\s+/);
          customFlags.forEach((flag) => {
            compileArgs.splice(isMSVC ? -1 : -2, 0, flag);
          });
          console.log(`Custom compiler flags added: ${options.cflags}`);
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
