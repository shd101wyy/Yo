import { spawnSync } from "child_process";
import * as fs from "fs";
import path from "path";
import {
  getCompilerInfo,
  getSanitizerFlags,
  isLiburingAvailable,
} from "../compiler-utils";
import { ModuleManager } from "../module-manager";
import {
  type TargetInfo,
  clangTriple,
  hostTarget,
  isTargetLinux,
  isTargetWindows,
  parseTarget,
  setCurrentTarget,
} from "../target";
import { setTargetPointerSize } from "../types/utils";

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
       * Target triple for cross-compilation (e.g. "x86_64-linux-gnu").
       * Defaults to host target if not specified.
       */
      targetTriple?: string;
      /**
       * Sysroot for cross-compilation.
       */
      sysroot?: string;
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
       * Arbitrary flags to pass directly to the C compiler.
       */
      cflags?: string;
    }
  ): void {
    // Resolve the compilation target
    const targetInfo: TargetInfo = options.targetTriple
      ? parseTarget(options.targetTriple)
      : hostTarget();
    setCurrentTarget(targetInfo);
    setTargetPointerSize(targetInfo.pointerSizeBits);

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

        // Yo compiles to C11 standard
        const compileArgs = isMSVC
          ? ["/std:c11", ...optimizationFlags, tempCFile, `/Fe${outputFile}`]
          : [
              ...(options.cCompiler === "zig" ? ["cc"] : []),
              "-std=c11",
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
          const compilerInfo = getCompilerInfo(compiler);
          const sanitizerResult = getSanitizerFlags({
            sanitize: options.sanitize,
            compilerInfo,
          });
          if (sanitizerResult.warning) {
            console.warn(sanitizerResult.warning);
          }
          if (sanitizerResult.flags.length > 0) {
            for (const flag of sanitizerResult.flags) {
              compileArgs.splice(isMSVC ? -1 : -2, 0, flag);
            }
            if (sanitizerResult.info) {
              console.log(sanitizerResult.info);
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
        const libraries = [...(options.libraries ?? [])];
        if (isTargetWindows(targetInfo) && !libraries.includes("ws2_32")) {
          libraries.push("ws2_32");
        }
        if (isTargetWindows(targetInfo) && !libraries.includes("bcrypt")) {
          libraries.push("bcrypt");
        }
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
        if (!isMSVC && isTargetLinux(targetInfo) && isLiburingAvailable()) {
          compileArgs.splice(-2, 0, "-luring");
          console.log("Using system liburing for async I/O");
        } else if (isTargetLinux(targetInfo) && !isMSVC) {
          console.warn(
            "⚠️  liburing not found - async I/O will not be available. Run 'npm run postinstall' for installation instructions."
          );
        }

        // Add arbitrary custom compiler flags from --cflags option
        if (options.cflags) {
          const customFlags = options.cflags.trim().split(/\s+/);
          customFlags.forEach((flag) => {
            compileArgs.splice(isMSVC ? -1 : -2, 0, flag);
          });
          console.log(`Custom compiler flags added: ${options.cflags}`);
        }

        // Cross-compilation: add --target= and --sysroot= for clang/gcc
        const host = hostTarget();
        if (!isMSVC && targetInfo.triple !== host.triple) {
          const triple = clangTriple(targetInfo);
          compileArgs.splice(isMSVC ? -1 : -2, 0, `--target=${triple}`);
          console.log(`Cross-compiling for target: ${triple}`);
          if (options.sysroot) {
            compileArgs.splice(-2, 0, `--sysroot=${options.sysroot}`);
          }
        }

        console.log(`Compiling with: ${compiler} ${compileArgs.join(" ")}`);

        const result = spawnSync(compiler, compileArgs, { stdio: "inherit" });

        if (result.error) {
          console.error(`Compilation failed: ${result.error.message}`);
          process.exit(1);
        } else if (result.status === 0) {
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
