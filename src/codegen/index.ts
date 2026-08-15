import { spawnSync, type SpawnSyncOptions } from "child_process";
import * as fs from "fs";
import path from "path";
import {
  checkCompilerAvailable,
  getCompilerInfo,
  getSanitizerFlags,
  isLiburingAvailable,
} from "../compiler-utils";
import { ModuleManager } from "../module-manager";

// On Windows, .bat/.cmd scripts require shell:true for spawnSync to find them.
const spawnShellOption: SpawnSyncOptions =
  process.platform === "win32" ? { shell: true } : {};
import {
  type TargetInfo,
  clangTriple,
  hostTarget,
  isTargetLinux,
  isTargetStandaloneWasi,
  isTargetWasm,
  isTargetWindows,
  parseTarget,
  setCurrentTarget,
} from "../target";
import { setTargetPointerSize } from "../types/utils";

export interface StaticLibraryArchiver {
  tool: string;
  argsPrefix: string[];
}

export function selectStaticLibraryArchiver(options: {
  compiler: string;
  targetInfo: TargetInfo;
  hasLlvmAr?: boolean;
}): StaticLibraryArchiver {
  const { compiler, targetInfo, hasLlvmAr } = options;

  if (compiler === "cl") {
    return { tool: "lib", argsPrefix: [] };
  }

  if (isTargetWindows(targetInfo)) {
    if (compiler === "zig") {
      return { tool: "zig", argsPrefix: ["ar"] };
    }

    if (hasLlvmAr ?? checkCompilerAvailable("llvm-ar")) {
      return { tool: "llvm-ar", argsPrefix: [] };
    }
  }

  return { tool: "ar", argsPrefix: [] };
}

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
       * Write the single generated C file to this exact path instead of the
       * default `<output>.c` sidecar. Redirects (does not duplicate) the
       * file, so the C compiler consumes the same path; parent directories
       * are created. Independent of `emitC`, which prints to stdout.
       */
      emitCTo?: string;
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
       * 'thread' - ThreadSanitizer for data-race detection in multi-threaded code
       */
      sanitize?: "address" | "leak" | "thread";
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
       * Produce a shared library (.so/.dylib/.dll).
       */
      shared?: boolean;
      /**
       * Produce a static library (.a).
       * Compiles to .o then creates archive with ar.
       */
      staticLibrary?: boolean;
      /**
       * Arbitrary flags to pass directly to the C compiler.
       */
      cflags?: string;
      /**
       * Emscripten environment: "web" skips -sNODERAWFS (browser target),
       * "node" adds -sNODERAWFS (default for tests/CLI).
       */
      emccEnvironment?: "web" | "node";
    }
  ): void {
    // Resolve the compilation target
    const targetInfo: TargetInfo = options.targetTriple
      ? parseTarget(options.targetTriple)
      : hostTarget();
    setCurrentTarget(targetInfo);
    setTargetPointerSize(targetInfo.pointerSizeBits);

    const isLibrary = !!(options.staticLibrary || options.shared);
    const isWasm = isTargetWasm(targetInfo);
    const requestedAllocator = options.allocator ?? "libc";
    // mimalloc isn't available on WASM (no malloc implementation
    // strategy that fits the WASM target). On every other target —
    // including Windows now that the bundled submodule has been
    // updated past the prior crash — mimalloc is used when
    // requested.
    const effectiveAllocator =
      requestedAllocator === "mimalloc" && !isWasm ? "mimalloc" : "libc";

    if (!options.skipCodegen) {
      this.moduleManager.compileModule(modulePath, {
        emitC: options.emitC,
        debugGc: options.debugGc,
        debugParallelism: options.debugParallelism,
        debugAsyncAwait: options.debugAsyncAwait,
        allocator: effectiveAllocator,
        isLibrary,
      });

      // Get the generated C code
      let compiledCode = this.moduleManager.getGeneratedCode();

      // In library mode, make all non-exported functions static to avoid
      // duplicate symbol errors when linking with executables
      if (isLibrary) {
        const exportedNames = this.moduleManager.getExportedFunctionNames();
        compiledCode = makeNonExportedFunctionsStatic(
          compiledCode,
          exportedNames
        );
      }

      // Write the C code to a file
      const outputFile = options.output as string;
      // Strip output extension to derive the C file name (e.g., app.html → app.c)
      const outputBase = outputFile.replace(/\.(html|js|wasm|exe)$/, "");
      // `--emit-c-to` REDIRECTS the sidecar rather than adding a second copy,
      // so the C compiler below consumes this same path and exactly one C file
      // ever exists. Parent directories are created: the point of the flag is
      // to place the file somewhere deliberate (e.g. dist/yo.c).
      const tempCFile = options.emitCTo ? options.emitCTo : outputBase + ".c";
      const tempCFileDir = path.dirname(tempCFile);
      if (tempCFileDir && !fs.existsSync(tempCFileDir)) {
        fs.mkdirSync(tempCFileDir, { recursive: true });
      }
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
        const isEmcc = compiler === "emcc";

        // Static library: compile to .o then create .a archive
        if (options.staticLibrary) {
          const objectFile = outputFile + ".o";
          const needsPositionIndependentCode = !isTargetWindows(targetInfo);

          // Step 1: Compile .c to .o (see comment at the main compileArgs
          // site for the rationale on `-fwrapv`).
          const compileToObjArgs = isMSVC
            ? ["/std:c11", "/c", tempCFile, `/Fo${objectFile}`]
            : [
                ...(compiler === "zig" ? ["cc"] : []),
                "-std=c11",
                "-fno-strict-aliasing",
                "-fwrapv",
                "-c",
                ...(needsPositionIndependentCode ? ["-fPIC"] : []),
                "-w",
                tempCFile,
                "-o",
                objectFile,
              ];

          // Add optimization
          if (options.release) {
            compileToObjArgs.splice(
              isMSVC ? 1 : compiler === "zig" ? 2 : 1,
              0,
              isMSVC ? "/O2" : "-O2"
            );
          }

          // Add cross-compilation flags (skip for emcc).
          const host = hostTarget();
          if (!isMSVC && !isEmcc && targetInfo.triple !== host.triple) {
            const triple = clangTriple(targetInfo);
            compileToObjArgs.splice(-2, 0, `--target=${triple}`);
            if (options.sysroot) {
              compileToObjArgs.splice(-2, 0, `--sysroot=${options.sysroot}`);
            }
          }

          console.log(
            `Compiling to object: ${compiler} ${compileToObjArgs.join(" ")}`
          );
          const objResult = spawnSync(compiler, compileToObjArgs, {
            stdio: "inherit",
            ...spawnShellOption,
          });
          if (objResult.error || objResult.status !== 0) {
            console.error(`Object compilation failed`);
            process.exit(objResult.status || 1);
          }

          // Step 2: Create static library archive
          const archiveFile = outputFile.endsWith(".a")
            ? outputFile
            : `${outputFile}.a`;
          const archiver = selectStaticLibraryArchiver({
            compiler,
            targetInfo,
          });
          const arTool = archiver.tool;
          const arArgs = isMSVC
            ? [`/OUT:${archiveFile}`, objectFile]
            : [...archiver.argsPrefix, "rcs", archiveFile, objectFile];

          console.log(`Creating archive: ${arTool} ${arArgs.join(" ")}`);
          const arResult = spawnSync(arTool, arArgs, {
            stdio: "inherit",
            ...spawnShellOption,
          });
          if (arResult.error || arResult.status !== 0) {
            console.error(`Archive creation failed`);
            process.exit(arResult.status || 1);
          }

          // Clean up intermediate .o file
          if (fs.existsSync(objectFile)) {
            fs.unlinkSync(objectFile);
          }

          console.log(`Successfully created static library ${archiveFile}`);
          return;
        }

        // Determine optimization flags
        let optimizationFlags: string[];
        if (options.optimize !== undefined) {
          // Explicit --optimize flag takes precedence
          const level = options.optimize;
          if (level === "0") {
            optimizationFlags = isMSVC
              ? ["/Od", "/W4", "/wd4100", "/wd4101", "/wd4189", "/wd4505"]
              : [
                  "-Wall",
                  "-Wextra",
                  "-Wno-unused-variable",
                  "-Wno-unused-parameter",
                  "-Wno-unused-function",
                  "-Wno-unused-but-set-variable",
                  "-Wno-unused-label",
                  "-Wno-unused-value",
                  "-Wno-parentheses-equality",
                  "-O0",
                ];
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
            ? ["/Od", "/W4", "/wd4100", "/wd4101", "/wd4189", "/wd4505"]
            : [
                "-Wall",
                "-Wextra",
                "-Wno-unused-variable",
                "-Wno-unused-parameter",
                "-Wno-unused-function",
                "-Wno-unused-but-set-variable",
                "-Wno-unused-label",
                "-Wno-unused-value",
                "-Wno-parentheses-equality",
                "-O0",
              ];
        }

        // Yo compiles to C11 standard.
        //
        // `-fwrapv` defines signed-integer overflow as two's-complement
        // wrap-around (matches MEMORY_SAFETY.md Limitation #6 mitigation).
        // Without it, signed overflow is UB and the optimizer can exploit
        // that to eliminate bounds checks, hoist loop invariants past
        // overflowing arithmetic, etc. — silently miscompiling code that
        // looks safe in source form. Defined-wrap costs a few percent on
        // some tight numeric loops; users who measure a regression can
        // opt out with `--cflags='-fno-wrapv'`.
        const compileArgs = isMSVC
          ? ["/std:c11", ...optimizationFlags, tempCFile, `/Fe${outputFile}`]
          : [
              ...(options.cCompiler === "zig" ? ["cc"] : []),
              "-std=c11",
              "-fno-strict-aliasing",
              "-fwrapv",
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

        // Add shared library flags if requested
        if (options.shared) {
          if (!isMSVC) {
            const sharedFlags = ["-shared"];
            if (!isTargetWindows(targetInfo)) {
              sharedFlags.push("-fPIC");
            }
            compileArgs.splice(-2, 0, ...sharedFlags);
            console.log("Shared library mode enabled");
          } else {
            compileArgs.splice(-1, 0, "/LD"); // DLL mode for MSVC
            console.log("Shared library mode enabled (DLL)");
          }
        }

        // Add sanitizer flags if requested (not supported for emcc/WASM)
        if (options.sanitize && !isEmcc) {
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

        // Platform-specific system libraries (skip for WASM)
        if (!isWasm) {
          if (isTargetWindows(targetInfo) && !libraries.includes("ws2_32")) {
            libraries.push("ws2_32");
          }
          if (isTargetWindows(targetInfo) && !libraries.includes("bcrypt")) {
            libraries.push("bcrypt");
          }
          // mimalloc's Windows large-page support pulls OpenProcessToken/
          // LookupPrivilegeValueA (LNK2019 on the first native-Windows
          // compiler build); harmless when unused.
          if (isTargetWindows(targetInfo) && !libraries.includes("advapi32")) {
            libraries.push("advapi32");
          }
        }
        libraries.forEach((library) => {
          if (isMSVC) {
            // MSVC uses library.lib format
            compileArgs.splice(-1, 0, `${library}.lib`);
          } else {
            compileArgs.splice(-2, 0, `-l${library}`);
          }
        });

        if (effectiveAllocator === "mimalloc") {
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

        // Add liburing on Linux for async I/O. Since only native targets are
        // supported (not cross-compilation), whatever liburing is installed on
        // the host is the correct one to link against.
        if (
          !isWasm &&
          !isMSVC &&
          isTargetLinux(targetInfo) &&
          isLiburingAvailable()
        ) {
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

        // Add -masm=intel when inline assembly uses Intel syntax (not for emcc/WASM)
        if (!isMSVC && !isEmcc && this.moduleManager.needsIntelAsmSyntax) {
          compileArgs.splice(-2, 0, "-masm=intel");
        }

        // Emscripten: allow function pointer casts (WASM call_indirect requires
        // exact signature matches, but the codegen casts void* to fn pointers)
        if (isEmcc) {
          compileArgs.splice(-2, 0, "-sEMULATE_FUNCTION_POINTER_CASTS=1");

          // Yo generates C11, not C++ — disable C++ exception handling to avoid
          // linker errors on Emscripten 4.0.23+ where the JS symbols library
          // references __cxa_increment_exception_refcount.
          compileArgs.splice(-2, 0, "-fno-exceptions");

          if (isTargetStandaloneWasi(targetInfo)) {
            // Standalone WASI: produce a .wasm file without JS glue
            compileArgs.splice(-2, 0, "-sSTANDALONE_WASM");
          } else if (options.emccEnvironment !== "web") {
            // Emscripten Node.js target: use Node.js's real filesystem instead of MEMFS
            // Skip for web targets — NODERAWFS uses require('fs') which doesn't exist in browsers
            compileArgs.splice(-2, 0, "-sNODERAWFS=1");
          }

          // Enable pthreads when the program uses threading
          if (this.moduleManager.usesParallelism) {
            compileArgs.splice(
              -2,
              0,
              "-pthread",
              "-sPTHREAD_POOL_SIZE=4",
              "-sEXIT_RUNTIME=1"
            );
          }
        }

        // Cross-compilation: add --target= for clang when the target differs
        // from the host. Skip for emcc — it handles its own target internally.
        //
        // NOTE: True cross-compilation (different arch or OS) is NOT supported.
        // Only WASM and native targets are supported.
        const host = hostTarget();
        if (!isMSVC && !isEmcc && targetInfo.triple !== host.triple) {
          const sameArchOs =
            targetInfo.arch === host.arch && targetInfo.os === host.os;
          if (!sameArchOs) {
            console.warn(
              `⚠️  Cross-compilation to a different architecture or OS is not supported.\n` +
                `   Host: ${host.triple}  →  Target: ${targetInfo.triple}\n` +
                `   Only native targets and WASM are supported.`
            );
          }

          const triple = clangTriple(targetInfo);
          compileArgs.splice(isMSVC ? -1 : -2, 0, `--target=${triple}`);
          if (options.sysroot) {
            compileArgs.splice(-2, 0, `--sysroot=${options.sysroot}`);
          }
        }

        console.log(`Compiling with: ${compiler} ${compileArgs.join(" ")}`);

        const result = spawnSync(compiler, compileArgs, {
          stdio: "inherit",
          ...spawnShellOption,
        });

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

/**
 * In library mode, make all non-exported, non-static C function definitions
 * static to avoid duplicate symbol errors when linking multiple Yo modules.
 *
 * This post-processes the generated C code by:
 * 1. Identifying function definition lines (return_type function_name(...))
 * 2. Skipping lines already marked static, inline, extern, or typedef
 * 3. Skipping the main() function (shouldn't exist in library mode, but just in case)
 * 4. Only keeping exported function names as global (non-static) symbols
 */
function makeNonExportedFunctionsStatic(
  cCode: string,
  exportedNames: Set<string>
): string {
  const lines = cCode.split("\n");
  const result: string[] = [];

  // Match function declarations/definitions at column 0.
  // Pattern: optional return type, then function_name, then '('
  // We extract the function name and check if it's exported.
  // This handles complex signatures like: void __yo_fn(void (*cb)(void*), void* data) {
  //
  // Strategy: find lines that start at column 0 with a type+name pattern
  // and end with either '{' (definition) or ';' (declaration, possibly on next line)
  const funcLineRegex =
    /^([a-zA-Z_][a-zA-Z0-9_*\s]*?)\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trimStart();

    // Skip lines that are already static, inline, extern, typedef, preprocessor, or empty
    if (
      trimmed.startsWith("static ") ||
      trimmed.startsWith("static\t") ||
      trimmed.startsWith("inline ") ||
      trimmed.startsWith("extern ") ||
      trimmed.startsWith("typedef ") ||
      trimmed.startsWith("#") ||
      trimmed.startsWith("//") ||
      trimmed.startsWith("/*") ||
      trimmed.startsWith("*") ||
      trimmed === "" ||
      trimmed === "}" ||
      trimmed === "{" ||
      trimmed.startsWith("struct ") ||
      trimmed.startsWith("union ") ||
      trimmed.startsWith("enum ")
    ) {
      result.push(line);
      continue;
    }

    // Skip lines starting with C keywords that could be falsely matched as function declarations
    const cKeywords = [
      "return",
      "if",
      "else",
      "while",
      "for",
      "do",
      "switch",
      "case",
      "break",
      "continue",
      "goto",
      "default",
      "sizeof",
      "typeof",
    ];
    const firstWord = trimmed.split(/[\s(]/)[0] ?? "";
    if (cKeywords.includes(firstWord)) {
      result.push(line);
      continue;
    }

    // Skip indented lines (inside a function body, not a top-level definition)
    if (line.startsWith("  ") || line.startsWith("\t")) {
      result.push(line);
      continue;
    }

    // Try to match a function declaration or definition at column 0
    const match = funcLineRegex.exec(trimmed);

    if (match) {
      const funcName = match[2]!;

      // Don't make exported functions static — they need to be visible
      if (exportedNames.has(funcName)) {
        result.push(line);
        continue;
      }

      // Don't make main static (shouldn't exist in library mode, but safety check)
      if (funcName === "main") {
        result.push(line);
        continue;
      }

      // Make this function static
      result.push("static inline " + line);
      continue;
    }

    result.push(line);
  }

  return result.join("\n");
}
