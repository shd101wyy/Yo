import { execSync, spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * Information about the C compiler being used
 */
export interface CompilerInfo {
  /** The compiler command (e.g., "gcc", "clang", "cl") */
  compiler: string;
  /** Whether this is MSVC */
  isMSVC: boolean;
  /** Whether we're on Windows */
  isWindows: boolean;
  /** Whether this is GCC on Windows (MinGW) */
  isGccOnWindows: boolean;
  /** Whether this is Clang on Windows */
  isClangOnWindows: boolean;
  /** Whether this is Emscripten (emcc) for WASM */
  isEmcc: boolean;
}

/**
 * Get information about the C compiler
 */
export function getCompilerInfo(compiler: string): CompilerInfo {
  const isMSVC = compiler === "cl";
  const isWindows = process.platform === "win32";
  const isGccOnWindows = isWindows && (compiler === "gcc" || compiler === "cc");
  const isClangOnWindows = isWindows && compiler === "clang";
  const isEmcc = compiler === "emcc";

  return {
    compiler,
    isMSVC,
    isWindows,
    isGccOnWindows,
    isClangOnWindows,
    isEmcc,
  };
}

/**
 * Options for getting sanitizer compile flags
 */
export interface SanitizerOptions {
  /** The type of sanitizer to enable */
  sanitize: "address" | "leak" | "thread";
  /** Compiler information */
  compilerInfo: CompilerInfo;
}

/**
 * Result of getting sanitizer flags
 */
export interface SanitizerFlags {
  /** Flags to add to the compiler command */
  flags: string[];
  /** Warning message if sanitizer is not supported */
  warning?: string;
  /** Info message about what was enabled */
  info?: string;
}

export function checkCompilerAvailable(compiler: string): boolean {
  try {
    execSync(`${compiler} --version`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Find an available C compiler on the system
 * @returns
 */
export function findAvailableCompiler(): string | null {
  const compilers = ["clang", "cc", "gcc", "zig"];
  for (const compiler of compilers) {
    if (checkCompilerAvailable(compiler)) {
      return compiler;
    }
  }
  return null;
}

let _asanUsable: boolean | undefined;

/**
 * Smoke test: compile and run a minimal C program with ASAN to verify
 * the compiler and ASAN runtime are compatible. Caches the result so
 * the test runs at most once per process.
 */
function asanRuntimeIsUsable(): boolean {
  if (_asanUsable !== undefined) return _asanUsable;

  const tmpDir = os.tmpdir();
  const srcPath = path.join(tmpDir, `.yo_asan_test_${process.pid}.c`);
  const outPath = path.join(tmpDir, `.yo_asan_test_${process.pid}`);

  try {
    fs.writeFileSync(srcPath, "int main(void) { return 0; }\n");

    const compileResult = spawnSync(
      "cc",
      ["-x", "c", "-std=c11", "-fsanitize=address", "-o", outPath, srcPath],
      { timeout: 15000, encoding: "utf-8" }
    );

    if (compileResult.status !== 0 || compileResult.error) {
      _asanUsable = false;
      return false;
    }

    const runResult = spawnSync(outPath, [], {
      timeout: 3000,
      encoding: "utf-8",
      env: { ...process.env, ASAN_OPTIONS: "detect_leaks=0" },
    });

    // Exit code 0 or timing out (killed by signal) both indicate issues.
    // A healthy ASAN program exits quickly with code 0.
    if (runResult.error || runResult.signal || runResult.status !== 0) {
      _asanUsable = false;
      return false;
    }

    _asanUsable = true;
    return true;
  } catch {
    _asanUsable = false;
    return false;
  } finally {
    try {
      fs.unlinkSync(srcPath);
    } catch {
      /* ignore */
    }
    try {
      fs.unlinkSync(outPath);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Get the sanitizer flags for compilation.
 */
export function getSanitizerFlags(options: SanitizerOptions): SanitizerFlags {
  const { sanitize, compilerInfo } = options;
  const { isMSVC, isGccOnWindows, isClangOnWindows } = compilerInfo;

  if (sanitize === "address") {
    if (isMSVC) {
      return {
        flags: ["/fsanitize=address"],
        info: "AddressSanitizer enabled (memory errors + leak detection)",
      };
    } else if (isGccOnWindows) {
      // MinGW GCC typically doesn't have AddressSanitizer support
      // The libsanitizer is not included in standard MinGW distributions
      return {
        flags: [],
        warning:
          "AddressSanitizer is not supported by MinGW GCC on Windows. Use Clang (--cc clang) instead for sanitizer support.",
      };
    } else {
      // Smoke test: compile and run a minimal ASAN program to detect
      // clang/ASAN runtime mismatches (e.g., Nix clang 21 + Xcode ASAN 17).
      // If the test binary hangs, skip ASAN with a warning.
      if (!asanRuntimeIsUsable()) {
        return {
          flags: [],
          warning:
            "AddressSanitizer is not functional with this compiler setup (likely a version mismatch between clang and the ASAN runtime library). Skipping sanitizer. Install a matching ASAN runtime or use --cc with a compatible compiler.",
        };
      }
      const flags = ["-fsanitize=address", "-fno-omit-frame-pointer"];
      // On Windows with Clang, the ASAN DLL needs to be in PATH at runtime
      // (handled separately when running the executable)
      return {
        flags,
        info: "AddressSanitizer enabled (memory errors + leak detection)",
      };
    }
  } else if (sanitize === "leak") {
    if (isMSVC) {
      return {
        flags: [],
        warning:
          "LeakSanitizer is not supported by MSVC, use AddressSanitizer instead",
      };
    } else if (isGccOnWindows || isClangOnWindows) {
      return {
        flags: [],
        warning:
          "LeakSanitizer is not supported on Windows, use AddressSanitizer instead",
      };
    } else {
      return {
        flags: ["-fsanitize=leak"],
        info: "LeakSanitizer enabled (leak detection only)",
      };
    }
  } else if (sanitize === "thread") {
    if (isMSVC) {
      return {
        flags: [],
        warning:
          "ThreadSanitizer is not supported by MSVC. Use Linux/macOS with Clang for TSan support.",
      };
    } else if (isGccOnWindows || isClangOnWindows) {
      return {
        flags: [],
        warning:
          "ThreadSanitizer is not supported on Windows. Use Linux/macOS with Clang for TSan support.",
      };
    } else {
      return {
        flags: ["-fsanitize=thread", "-fno-omit-frame-pointer"],
        info: "ThreadSanitizer enabled (data-race detection)",
      };
    }
  }

  return { flags: [] };
}

/**
 * Find the ASAN DLL directory for Clang on Windows.
 * Returns undefined if not found or not applicable.
 */
export function findClangAsanDllPath(compiler: string): string | undefined {
  const isWindows = process.platform === "win32";
  if (!isWindows) {
    return undefined;
  }

  try {
    // Get the compiler's installation directory using where.exe
    // Use the actual compiler name, but if it's "cc", try "clang"
    const compilerToFind = compiler === "cc" ? "clang" : compiler;
    const compilerPath = execSync(`where.exe ${compilerToFind}`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    })
      .trim()
      .split(/\r?\n/)[0]
      ?.trim();

    if (!compilerPath) {
      return undefined;
    }

    const compilerDir = path.dirname(compilerPath);
    // ASAN DLL is typically in ../lib/clang/<version>/lib/windows/
    const llvmRoot = path.dirname(compilerDir);
    const clangLibDir = path.join(llvmRoot, "lib", "clang");

    if (!fs.existsSync(clangLibDir)) {
      return undefined;
    }

    // Find the version directory (e.g., "21")
    const versions = fs.readdirSync(clangLibDir);
    for (const version of versions) {
      const windowsLibDir = path.join(clangLibDir, version, "lib", "windows");
      if (fs.existsSync(windowsLibDir)) {
        return windowsLibDir;
      }
    }
  } catch {
    // Ignore errors finding ASAN DLL path
  }

  return undefined;
}

/**
 * Check if liburing is available on Linux
 */
export function isLiburingAvailable(): boolean {
  if (process.platform !== "linux") {
    return false;
  }

  try {
    // First check if pkg-config is available
    execSync("command -v pkg-config", { stdio: "ignore" });
    // Then check if liburing is installed
    execSync("pkg-config --exists liburing", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Build environment variables for running an ASAN-enabled executable
 */
export function buildAsanRunEnvironment(options: {
  compilerInfo: CompilerInfo;
  asanDllPath?: string;
  lsanSuppressionFile?: string;
  detectLeaks?: boolean;
}): NodeJS.ProcessEnv {
  const { asanDllPath, lsanSuppressionFile, detectLeaks = true } = options;

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ASAN_OPTIONS: `detect_leaks=${detectLeaks ? 1 : 0}`,
  };

  if (lsanSuppressionFile) {
    env.LSAN_OPTIONS = `suppressions=${lsanSuppressionFile}`;
  }

  if (asanDllPath) {
    // On Windows, the PATH variable might be named "Path" (case varies)
    // We need to find the actual key name and update it
    const pathKey =
      Object.keys(env).find((k) => k.toLowerCase() === "path") || "PATH";
    const currentPath = env[pathKey] || "";
    env[pathKey] = `${asanDllPath}${path.delimiter}${currentPath}`;
  }

  return env;
}

/**
 * Get macOS LSAN suppressions for system library leaks
 */
export function getMacOSLsanSuppressions(): string {
  if (process.platform !== "darwin") {
    return "";
  }
  return "leak:libobjc\nleak:libdyld\nleak:libxpc\nleak:libsystem_malloc\nleak:dyld";
}
