/**
 * Target system for Yo compiler.
 *
 * Distinguishes between the **host** (machine running the compiler)
 * and the **target** (machine the compiled binary will run on).
 *
 * Target triples follow the standard `<arch>-<os>[-<abi>]` format,
 * compatible with clang's `--target=` flag.
 */

// ── Supported architectures ───────────────────────────────────────────

export type Arch = "x86_64" | "aarch64" | "x86" | "arm" | "wasm32";

// ── Supported operating systems ───────────────────────────────────────

export type Os = "linux" | "macos" | "windows" | "freebsd" | "wasi";

// ── Supported ABIs ────────────────────────────────────────────────────

export type Abi = "gnu" | "musl" | "msvc" | "none" | "wasm";

// ── Target info ───────────────────────────────────────────────────────

export interface TargetInfo {
  arch: Arch;
  os: Os;
  abi: Abi | undefined;
  pointerSizeBits: 32 | 64;
  /** Canonical triple string, e.g. "x86_64-linux-gnu" */
  triple: string;
}

// ── Host info ─────────────────────────────────────────────────────────

export interface HostInfo {
  platform: Os;
  arch: Arch;
}

// ── Pointer size derivation ───────────────────────────────────────────

export function pointerSizeForArch(arch: Arch): 32 | 64 {
  switch (arch) {
    case "x86_64":
    case "aarch64":
      return 64;
    case "x86":
    case "arm":
    case "wasm32":
      return 32;
  }
}

// ── Node.js → standard naming maps ───────────────────────────────────

const NODE_PLATFORM_MAP: Record<string, Os | undefined> = {
  darwin: "macos",
  linux: "linux",
  win32: "windows",
  freebsd: "freebsd",
};

const NODE_ARCH_MAP: Record<string, Arch | undefined> = {
  x64: "x86_64",
  arm64: "aarch64",
  ia32: "x86",
  arm: "arm",
};

// ── Host detection ────────────────────────────────────────────────────

let cachedHost: HostInfo | undefined;

/**
 * Detect the host machine's platform and architecture.
 * Uses Node.js `process.platform` and `process.arch` internally,
 * but maps them to our standard naming.
 */
export function detectHost(): HostInfo {
  if (cachedHost) return cachedHost;

  const platform = NODE_PLATFORM_MAP[process.platform];
  if (!platform) {
    throw new Error(
      `Unsupported host platform: ${process.platform}. ` +
        `Supported: ${Object.keys(NODE_PLATFORM_MAP).join(", ")}`
    );
  }

  const arch = NODE_ARCH_MAP[process.arch];
  if (!arch) {
    throw new Error(
      `Unsupported host architecture: ${process.arch}. ` +
        `Supported: ${Object.keys(NODE_ARCH_MAP).join(", ")}`
    );
  }

  cachedHost = { platform, arch };
  return cachedHost;
}

// ── Default ABI for a given OS ────────────────────────────────────────

function defaultAbi(os: Os): Abi | undefined {
  switch (os) {
    case "linux":
      return "gnu";
    case "windows":
      return "msvc";
    case "wasi":
      return "wasm";
    case "macos":
    case "freebsd":
      return undefined; // clang doesn't need ABI for macOS/FreeBSD
  }
}

// ── Build TargetInfo from parts ───────────────────────────────────────

function buildTriple(arch: Arch, os: Os, abi: Abi | undefined): string {
  return abi ? `${arch}-${os}-${abi}` : `${arch}-${os}`;
}

function buildTargetInfo(arch: Arch, os: Os, abi: Abi | undefined): TargetInfo {
  return {
    arch,
    os,
    abi,
    pointerSizeBits: pointerSizeForArch(arch),
    triple: buildTriple(arch, os, abi),
  };
}

// ── Target from host ──────────────────────────────────────────────────

/**
 * Return a TargetInfo representing the host machine (native compilation).
 */
export function hostTarget(): TargetInfo {
  const host = detectHost();
  const abi = defaultAbi(host.platform);
  return buildTargetInfo(host.arch, host.platform, abi);
}

// ── Parse target triple ───────────────────────────────────────────────

const VALID_ARCHES = new Set<string>([
  "x86_64",
  "aarch64",
  "x86",
  "arm",
  "wasm32",
]);

const VALID_OSES = new Set<string>([
  "linux",
  "macos",
  "windows",
  "freebsd",
  "wasi",
]);

const VALID_ABIS = new Set<string>(["gnu", "musl", "msvc", "none", "wasm"]);

/**
 * Parse a target triple string like "x86_64-linux-gnu" into a TargetInfo.
 *
 * Accepted formats:
 *   - `<arch>-<os>`          — ABI defaults per OS
 *   - `<arch>-<os>-<abi>`    — explicit ABI
 */
export function parseTarget(triple: string): TargetInfo {
  const parts = triple.split("-");
  if (parts.length < 2 || parts.length > 3) {
    throw new Error(
      `Invalid target triple "${triple}". ` +
        `Expected format: <arch>-<os> or <arch>-<os>-<abi>. ` +
        `Example: x86_64-linux-gnu`
    );
  }

  const archStr = parts[0]!;
  const osStr = parts[1]!;
  const abiStr = parts[2];

  if (!VALID_ARCHES.has(archStr)) {
    throw new Error(
      `Unknown architecture "${archStr}" in target triple "${triple}". ` +
        `Supported: ${[...VALID_ARCHES].join(", ")}`
    );
  }

  if (!VALID_OSES.has(osStr)) {
    throw new Error(
      `Unknown OS "${osStr}" in target triple "${triple}". ` +
        `Supported: ${[...VALID_OSES].join(", ")}`
    );
  }

  const arch = archStr as Arch;
  const os = osStr as Os;

  let abi: Abi | undefined;
  if (abiStr !== undefined) {
    if (abiStr === "none") {
      abi = undefined;
    } else if (!VALID_ABIS.has(abiStr)) {
      throw new Error(
        `Unknown ABI "${abiStr}" in target triple "${triple}". ` +
          `Supported: ${[...VALID_ABIS].join(", ")}`
      );
    } else {
      abi = abiStr as Abi;
    }
  } else {
    abi = defaultAbi(os);
  }

  return buildTargetInfo(arch, os, abi);
}

// ── Clang-compatible triple ───────────────────────────────────────────

/**
 * Convert a TargetInfo to the triple format clang expects for `--target=`.
 *
 * clang uses LLVM triples which look like `<arch>-<vendor>-<os>[-<env>]`.
 * We insert the appropriate vendor and map our OS names to LLVM's.
 */
export function clangTriple(target: TargetInfo): string {
  const arch = target.arch;

  switch (target.os) {
    case "linux":
      // e.g. x86_64-linux-gnu, aarch64-linux-musl
      return `${arch}-linux-${target.abi ?? "gnu"}`;
    case "macos":
      // e.g. x86_64-apple-darwin, aarch64-apple-darwin
      return `${arch}-apple-darwin`;
    case "windows":
      if (target.abi === "gnu") {
        // MinGW: x86_64-w64-mingw32
        return `${arch}-w64-mingw32`;
      }
      // MSVC: x86_64-pc-windows-msvc
      return `${arch}-pc-windows-msvc`;
    case "freebsd":
      return `${arch}-unknown-freebsd`;
    case "wasi":
      // WASI: wasm32-wasi (LLVM triple)
      return `${arch}-wasi`;
  }
}

// ── Global current target ─────────────────────────────────────────────

let currentTarget: TargetInfo | undefined;

/**
 * Set the target for the current compilation.
 * This should be called early in the compile pipeline, before
 * the evaluator or codegen runs.
 */
export function setCurrentTarget(target: TargetInfo): void {
  currentTarget = target;
}

/**
 * Get the current compilation target.
 * Falls back to host target if not explicitly set.
 */
export function getCurrentTarget(): TargetInfo {
  if (!currentTarget) {
    currentTarget = hostTarget();
  }
  return currentTarget;
}

// ── Yo-side platform/arch string mappings ─────────────────────────────

/**
 * Map our target OS to the string that Yo's `__yo_process_platform()` returns.
 * This is the standard naming used in std/process.yo.
 */
export function targetOsToYoString(os: Os): string {
  return os; // Our naming is already standard: "linux", "macos", "windows", "freebsd"
}

/**
 * Map our target arch to the string that Yo's `__yo_process_arch()` returns.
 * This is the standard naming used in std/process.yo.
 */
export function targetArchToYoString(arch: Arch): string {
  return arch; // Our naming is already standard: "x86_64", "aarch64", etc.
}

// ── Convenience queries ───────────────────────────────────────────────

export function isTargetWindows(target: TargetInfo): boolean {
  return target.os === "windows";
}

export function isTargetLinux(target: TargetInfo): boolean {
  return target.os === "linux";
}

export function isTargetMacos(target: TargetInfo): boolean {
  return target.os === "macos";
}

export function isTargetMSVC(target: TargetInfo): boolean {
  return target.os === "windows" && target.abi === "msvc";
}

export function isTargetWasm(target: TargetInfo): boolean {
  return target.arch === "wasm32" || target.os === "wasi";
}
