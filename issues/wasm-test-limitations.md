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

**Test-level: `cond` guard with `process.arch`**

For files where only some tests need skipping, add an architecture guard at the start of the test body.
Since `process.arch` is comptime, the guard is resolved at compile time — no runtime overhead on non-WASM targets.

```yo
{ arch, Arch } :: import "std/process";

test "my test", using(io : IO), {
  cond(
    (arch == Arch.Wasm32) => {
      printf("  skipped on wasm32\n");
    },
    true => {
      // ... test body runs only on non-WASM targets
    }
  );
};
```

## WASM I/O Architecture

The WASM runtime (`src/codegen/async/runtime-io-wasm.ts`) uses **synchronous POSIX calls wrapped in
immediately-completed IOFutures**, the same pattern as the macOS runtime for regular files. With
`-sNODERAWFS=1`, Emscripten uses Node.js's real filesystem instead of a virtual MEMFS, so all
file/directory operations work on actual files.

Key flags passed to emcc:

- `-sEMULATE_FUNCTION_POINTER_CASTS=1` — function pointer type compatibility
- `-sNODERAWFS=1` — real filesystem via Node.js
- `-pthread -sPTHREAD_POOL_SIZE=4 -sEXIT_RUNTIME=1` — when threading is used

### WASI errno numbering

**Critical:** Emscripten uses WASI errno values, NOT POSIX/Linux values:

- `ENOENT` = 44 (Linux: 2), `EACCES` = 2 (Linux: 13), `EBADF` = 8 (Linux: 9)
- `EINVAL` = 28 (Linux: 22), `ESPIPE` = 70 (Linux: 29), `ENOSYS` = 52 (Linux: 38)
- `EEXIST` = 20 (Linux: 17), `EWOULDBLOCK` differs

Tests and std library code **must** use errno constants from `std/libc/errno` instead of hardcoded
numbers. The constants are resolved at C compile time via `#include <errno.h>`.

## Categories of Unsupported Features

### 1. Networking (Sockets, DNS)

WASM has no native network stack. Socket/DNS operations return `-ENOSYS`.

**Affected test files (fully skipped):**

- `tests/net/dns.test.yo`, `tests/net/tcp.test.yo`, `tests/net/udp.test.yo`
- `tests/sys/socketpair.test.yo`, `tests/sys/sockinfo.test.yo`, `tests/sys/unix.test.yo`

### 2. OS-Specific Syscalls

**Affected test files (fully skipped):**

- `tests/sys/signal.test.yo` — POSIX signals (limited in WASM)
- `tests/sys/statfs.test.yo` — filesystem metadata syscall (not available)
- `tests/sys/tty.test.yo` — terminal ioctl syscalls (no terminal in WASM)
- `tests/sys/mmap.test.yo` — memory-mapped files (no mmap for files)
- `tests/sys/poll.test.yo` — poll/epoll (no async I/O backend)
- `tests/sys/fs_event.test.yo` — inotify/kqueue (no FS event watching)
- `tests/sys/process.test.yo` — process spawn/wait (no process model)
- `tests/sys/lock.test.yo` — flock() (not implemented in Emscripten)
- `tests/sys/timer.test.yo` — relies on async scheduling (usleep blocks synchronously)

### 3. Inline Assembly

WASM does not support x86/ARM inline assembly.

**Affected test files:**

- `tests/asm.test.yo`

### 4. Test-Level Skips (not file-level)

Some test files have individual tests skipped on WASM while the rest pass:

- `tests/sys/fcntl.test.yo` — `FD_CLOEXEC` test skipped (no exec() in WASM)
- `tests/sys/time.test.yo` — nanosecond precision test skipped (NODERAWFS has µs precision)
- `tests/sys/dir.test.yo` — hard link test skipped (NODERAWFS returns EMLINK for link())
- `tests/sys/advise.test.yo` — madvise test skipped (no mmap support)
- `tests/fs/dir.test.yo` — hard link test skipped (same NODERAWFS limitation)

## WASM Test Results Summary

**File-level skips:** 15 test files
**Test-level skips:** 5 individual tests (in 5 different files)
**Passing:** All remaining tests pass, including:

- Core language features, collections, encoding, regex, strings, closures
- Algebraic effects (57 tests), async/await (including escape), error handling
- Comptime, threading (via Emscripten pthreads), workers, Arc (cross-thread)
- Process (cwd, chdir), sync primitives (channel, once, rwlock, waitgroup)
- **sys/**: file, pipe, seek, iov, path, temp, bufio, sysinfo, umask, fallocate, copy,
  clock, time, dir, advise, fcntl, perm, constants
- **fs/**: file (13 tests), dir (12 tests), metadata (6), temp (7), walker (6),
  fs_convenience (9)
- **os/**: env (7 tests)

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

### ~~File System I/O~~ — FIXED (Phase 3)

All async file/directory/pipe/metadata I/O operations now work on WASM using NODERAWFS.
The `runtime-io-wasm.ts` was completely rewritten from stubs to real POSIX calls wrapped in
immediately-completed IOFutures (same pattern as macOS). Key changes:

- `-sNODERAWFS=1` enables real filesystem access via Node.js
- `runtime-io-common.ts` enabled for WASM (stat extractors, d_type, copyfile/sendfile)
- Errno constants used instead of hardcoded numbers throughout std library
- `std/fs/dir.yo` fixed hardcoded `EEXIST`/`ENOENT` values
- Tests: dangling pointer bug fixed in perm.test.yo's `make_test_file()` helper

### ~~os/env~~ — FIXED (Phase 3)

Environment variable operations (`env.get`, `env.set`, `env.remove`, `home_dir`, `config_dir`,
`temp_dir`) work on WASM through Emscripten's POSIX environment API.

## Known Limitations

- **Hard links**: NODERAWFS's `link()` returns EMLINK (errno 34). Tests gracefully skip.
- **flock()**: Not implemented in Emscripten. `lock.test.yo` is fully skipped.
- **Nanosecond timestamps**: NODERAWFS preserves only microsecond precision for file timestamps.
- **Timer/sleep**: `usleep()` blocks synchronously in WASM — no async interleaving.
- **WASM stack size**: Limited stack; large buffers (>8KB) may cause out-of-bounds errors.
  The sendfile fallback buffer was reduced from 64KB to 8KB.
- **mmap**: Not supported for file mapping in Emscripten.

## Future Work

- Add socket support via Emscripten's WebSocket proxy or POSIX over fetch
- Investigate WasmFS (Emscripten's next-gen FS) for better WASI compatibility
