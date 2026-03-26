# WASM Test Limitations

## Summary

When running the Yo test suite with `--cc emcc` (targeting WASM via Emscripten), certain tests
are skipped because they rely on platform features unavailable in WASM environments.

The test runner automatically skips these tests when `isEmcc` is true. Skip lists are defined
in `src/test-runner.ts` as `WASM_SKIP_FILES` (file-level) and `WASM_SKIP_TEST_NAMES` (test-level).

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

### 3. System Random (`getrandom` syscall)

Emscripten does not provide the `getrandom` syscall. The linker reports
`undefined symbol: getrandom`.

**Affected test files:**

- `tests/crypto/random.test.yo`

### 4. Compile-time Integer Overflow (32-bit)

WASM targets use 32-bit `isize`/`usize`. Some compile-time tests perform arithmetic that
overflows 32-bit range (e.g., `100000 * 25000 = 2,500,000,000 > i32 MAX`).

**Affected tests (individual skip by name):**

- `tests/comptime.test.yo` — `Test comptime isize`

### 5. Async Escape (Function Pointer Table Mismatch)

Async escape operations (which discard continuations) trigger WASM `RuntimeError: null function
or function signature mismatch` due to indirect function call table issues. The escape mechanism
uses function pointers that WASM tables cannot resolve correctly in some contexts.

**Affected tests (individual skip by name):**

- `tests/async_await.test.yo`: `Test escape in async closure`, `Test JoinHandle await returns None on escape`, `Test JoinHandle two tasks one escapes`, `Test JoinHandle escape via spawn-injected effect`

### 6. Threading (pthread)

WASM/Emscripten's default compilation does not support pthreads. Tests that spawn OS threads
or Workers fail at runtime. Tests using async tasks (cooperative scheduling) work fine.

**Affected tests (individual skip by name):**

- `tests/sync/channel.test.yo`: All thread/Worker-based tests (8 tests)
- `tests/sync/once.test.yo`: All thread/Worker-based tests (4 tests)
- `tests/sync/rwlock.test.yo`: All thread-based tests (6 tests)
- `tests/sync/waitgroup.test.yo`: All thread/Worker-based tests (5 tests)

### 7. Clock (clock_gettime stub)

The WASM stub for `clock_gettime` returns zeros. Tests that assert non-zero time values fail.

**Affected tests (individual skip by name):**

- `tests/time/instant.test.yo`: `Instant.now returns non-zero time`
- `tests/time/datetime.test.yo`: `DateTime.now_utc returns valid date`

## WASM Test Results Summary

**File-level skips:** 41 test files (I/O, asm, crypto)
**Test-name skips:** 30 individual tests (threading, escape, clock, overflow)
**Passing:** All remaining tests pass — core language features, collections, encoding, regex,
strings, closures, algebraic effects, async/await (non-I/O), error handling, comptime, sync
primitives (non-threaded), time (non-clock), and more.

## CI

The `.github/workflows/test.yml` includes a `test-wasm` job that runs `./yo-cli test ./tests --cc emcc`
on `ubuntu-latest` with Emscripten installed via `mymindstorm/setup-emsdk@v14`.

## Future Work

- Add WASI I/O backend for file operations (would enable fs/ tests)
- Add Emscripten `getentropy()` wrapper for crypto/random
- Investigate WASM function table issues with async escape
- Consider `-pthread` flag for Emscripten thread support
- Provide real `clock_gettime` via Emscripten's POSIX emulation layer
