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

- All `tests/sys/` except: `signal.test.yo`, `statfs.test.yo`, `tty.test.yo`
- All `tests/fs/`: `dir`, `file`, `fs_convenience`, `metadata`, `temp`, `walker`
- `tests/net/dns.test.yo`, `tests/net/tcp.test.yo`, `tests/net/udp.test.yo`

### 2. Inline Assembly

WASM does not support x86/ARM inline assembly.

**Affected test files:**

- `tests/asm.test.yo`

### 3. Compile-time Integer Overflow (32-bit)

WASM targets use 32-bit `isize`/`usize`. Some compile-time tests perform arithmetic that
overflows 32-bit range (e.g., `100000 * 25000 = 2,500,000,000 > i32 MAX`).

**Affected tests (individual skip by name):**

- `tests/comptime.test.yo` — `Test comptime isize`

### 4. Threading (pthread)

WASM/Emscripten's default compilation does not support pthreads. Tests that spawn OS threads
or Workers fail at runtime. Tests using async tasks (cooperative scheduling) work fine.

**Affected tests (individual skip by name):**

- `tests/sync/channel.test.yo`: All thread/Worker-based tests (8 tests)
- `tests/sync/once.test.yo`: All thread/Worker-based tests (4 tests)
- `tests/sync/rwlock.test.yo`: All thread-based tests (6 tests)
- `tests/sync/waitgroup.test.yo`: All thread/Worker-based tests (5 tests)

## WASM Test Results Summary

**File-level skips:** 40 test files (I/O, asm)
**Test-name skips:** 24 individual tests (threading, overflow)
**Passing:** All remaining tests pass — core language features, collections, encoding, regex,
strings, closures, algebraic effects, async/await (including escape), error handling, comptime,
sync primitives (non-threaded), time, crypto/random, and more.

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

## Future Work

- Add WASI I/O backend for file operations (would enable fs/ tests)
- Consider `-pthread` flag for Emscripten thread support
