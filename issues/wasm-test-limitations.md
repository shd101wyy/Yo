# WASM Test Limitations

## Summary

When running the Yo test suite with `--cc emcc` (targeting WASM via Emscripten), certain tests
are skipped because they rely on platform features unavailable in WASM environments.

### Skip mechanisms

**File-level: `// @skip_wasm` directive**

Add `// @skip_wasm` as the first line of a test file to skip the entire file when compiling with emcc.
The test runner scans the first 20 lines for this directive and skips the file before evaluation.

```yo
// @skip_wasm
open import "std/libc/stdio";
// ... rest of test file
```

**Test-level: `if` guard with `process.arch`**

For files where only some tests need skipping, add an architecture guard at the start of the test body.
Since `process.arch` is comptime, the guard is resolved at compile time — no runtime overhead on non-WASM targets.

```yo
{ arch, Arch } :: import "std/process";

test "my thread test", {
  if((arch == Arch.Wasm32), return ());
  // ... test body runs only on non-WASM targets
};
```

## Categories of Unsupported Features

### 1. Async I/O Operations (File, Socket, Network)

WASM has no native async I/O backend (no io_uring, kqueue, or IOCP). The codegen emits stub
functions (in `src/codegen/async/runtime-io-wasm.ts`) that return `-ENOSYS` so programs compile,
but I/O operations fail at runtime.

**Affected test files (fully skipped):**

- All `tests/fs/`: `dir`, `file`, `fs_convenience`, `metadata`, `temp`, `walker`
- `tests/net/dns.test.yo`, `tests/net/tcp.test.yo`, `tests/net/udp.test.yo`

### 2. POSIX Syscalls

WASM does not support POSIX-specific syscalls like signals, filesystem metadata, or terminal control.

**Affected test files (fully skipped):**

- `tests/sys/signal.test.yo` (POSIX signals)
- `tests/sys/statfs.test.yo` (filesystem metadata syscall)
- `tests/sys/tty.test.yo` (terminal ioctl syscalls)
- `tests/os/env.test.yo` (uses `home_dir`, `config_dir`, `cache_dir`, `temp_dir`)

### 3. Inline Assembly

WASM does not support x86/ARM inline assembly.

**Affected test files:**

- `tests/asm.test.yo`

### 4. Sync Primitives (threading-based tests)

All sync primitive concurrent tests now pass with Emscripten pthreads enabled.
No individual test-level skip guards remain for sync primitives.

## WASM Test Results Summary

**File-level skips:** 44 test files (I/O, asm, signals, tty, statfs, os/env)
**Test-name skips:** 0 individual tests
**Passing:** All remaining tests pass — core language features, collections, encoding, regex,
strings, closures, algebraic effects, async/await (including escape), error handling, comptime,
threading (via Emscripten pthreads), workers, Arc (including cross-thread), process (cwd, chdir),
sync primitives (channel, once, rwlock, waitgroup — including concurrent tests), time,
crypto/random, and more.

## CI

The `.github/workflows/test.yml` includes a `test-wasm` job that runs `./yo-cli test ./tests --cc emcc`
on `ubuntu-latest` with Emscripten installed via `mymindstorm/setup-emsdk@v14`.

## Resolved Issues

The following categories were previously unsupported but have been fixed:

### ~~Clock (clock_gettime stub)~~ — FIXED

Emscripten provides `clock_gettime()` via JS `performance.now()` (monotonic) and `Date.now()`
(realtime). The WASM codegen now uses the real POSIX wrapper instead of a stub.

### ~~System Random (getrandom)~~ — FIXED

WASM/Emscripten now uses `getentropy()` (via WASI `random_get`, available since Emscripten
3.1.67+). The `std/crypto/random.yo` module has a `Platform.Wasi` branch that calls
`getentropy()` in a loop for buffers larger than 256 bytes.

### ~~Async Escape (Function Pointer Table Mismatch)~~ — FIXED

The codegen now passes `-sEMULATE_FUNCTION_POINTER_CASTS=1` to emcc, which generates JS shims
to handle function pointer type mismatches at indirect call sites. This fixes the
`RuntimeError: null function or function signature mismatch` errors in async escape tests.

### ~~Compile-time Integer Overflow (32-bit)~~ — FIXED

The `Test comptime isize` test used values (`100000 * 25000 = 2.5B`) that overflowed 32-bit
`isize` on wasm32. The test values were reduced to fit within i32 range while preserving
the same arithmetic coverage (same operations, ratios, and edge cases).

### ~~Threading (pthread)~~ — FIXED

Emscripten supports POSIX threads via the `-pthread` flag. The compiler now automatically adds
`-pthread -sPTHREAD_POOL_SIZE=4 -sEXIT_RUNTIME=1` when the program uses threading. The test
runner also passes these flags when compiling with emcc. All thread and worker tests now pass on
WASM, as do Arc cross-thread tests and process filesystem tests (cwd, chdir).

### ~~Process Filesystem (cwd, chdir)~~ — FIXED

Emscripten provides a virtual filesystem with working `getcwd()` and `chdir()`. These operations
work out of the box — no special flags needed.

### ~~Sync Primitive Concurrent Tests~~ — FIXED

All sync primitive tests (channel, once, rwlock, waitgroup) including their thread/worker-based
concurrent variants now pass with Emscripten pthread support. The Wasm32 skip guards were removed
from 23 individual tests across 4 files.

## Future Work

- Add WASI I/O backend for file operations (would enable fs/ tests)
