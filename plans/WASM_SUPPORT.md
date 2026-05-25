# WASM Support

Yo compiles to WebAssembly via two target modes: **Emscripten** (Node.js + browser) and
**standalone WASI** (wasmtime/wasmer). Both use `emcc` as the C compiler.

## Targets

| Target              | Shorthand         | Compiler | Output                    | Runtime           |
| ------------------- | ----------------- | -------- | ------------------------- | ----------------- |
| `wasm32-emscripten` | `wasm-emscripten` | emcc     | `.html` + `.js` + `.wasm` | Node.js + browser |
| `wasm32-wasi`       | `wasm-wasi`       | emcc     | `.wasm` (standalone)      | wasmtime/wasmer   |

- `--cc emcc` auto-selects `wasm32-emscripten` target
- `--target wasm-emscripten` or `--target wasm-wasi` auto-selects `emcc` compiler
- `process.platform` returns `"emscripten"` or `"wasi"` depending on target

```bash
# Emscripten target (Node.js + browser) — all equivalent:
yo compile hello.yo --cc emcc -o app          # → app.html + app.js + app.wasm
yo compile hello.yo --target wasm-emscripten  # same (auto-selects emcc)

# Run in Node.js or open in browser:
node app.js          # Node.js
open app.html        # browser (simple programs)

# Standalone WASI target:
yo compile hello.yo --target wasm-wasi        # → app.wasm (standalone, no JS glue)
wasmtime app.wasm                             # run in WASI runtime

# Override output format:
yo compile hello.yo --cc emcc -o app.js       # → app.js + app.wasm (no HTML)
```

## Emscripten Flags

| Flag                                 | Purpose                             | When used                 |
| ------------------------------------ | ----------------------------------- | ------------------------- |
| `-sEMULATE_FUNCTION_POINTER_CASTS=1` | Function pointer type compatibility | Always (emscripten)       |
| `-sNODERAWFS=1`                      | Real filesystem via Node.js         | Emscripten target only    |
| `-sSTANDALONE_WASM`                  | Produce WASI-compatible `.wasm`     | WASI target only          |
| `-pthread -sPTHREAD_POOL_SIZE=4`     | Threading support                   | When program uses threads |
| `-sEXIT_RUNTIME=1`                   | Clean shutdown for pthread          | With `-pthread`           |

### WASI errno numbering

**Critical:** Emscripten uses WASI errno values, NOT POSIX/Linux values:

- `ENOENT` = 44 (Linux: 2), `EACCES` = 2 (Linux: 13), `EBADF` = 8 (Linux: 9)
- `EINVAL` = 28 (Linux: 22), `ESPIPE` = 70 (Linux: 29), `ENOSYS` = 52 (Linux: 38)
- `EEXIST` = 20 (Linux: 17), `EWOULDBLOCK` differs

Tests and std library code **must** use errno constants from `std/libc/errno` instead of hardcoded
numbers. The constants are resolved at C compile time via `#include <errno.h>`.

## I/O Architecture

The WASM runtime (`src/codegen/async/runtime-io-wasm.ts`) uses **synchronous POSIX calls wrapped in
immediately-completed IoFutures**, the same pattern as the macOS runtime for regular files. With
`-sNODERAWFS=1`, Emscripten uses Node.js's real filesystem instead of a virtual MEMFS, so all
file/directory operations work on actual files.

The async timer/sleep uses a **sorted linked list timer queue** (same pattern as Windows runtime).
Timers are registered as pending IoFutures with due times, and the event loop polls/waits for them
via `__yo_io_poll`/`__yo_io_wait`. This enables cooperative scheduling during sleep.

### WASI-specific runtime

For standalone WASI targets, the `__yo_io_wait` function uses `__wasi_poll_oneoff` instead of
`usleep()` for blocking timer waits. This is the WASI standard mechanism for clock-based blocking:

```c
// WASI poll_oneoff replaces usleep for timer-based blocking
__wasi_subscription_t sub;
sub.type = __WASI_EVENTTYPE_CLOCK;
sub.u.clock.id = __WASI_CLOCKID_MONOTONIC;
sub.u.clock.timeout = wait_ms * 1000000ULL; // ms -> ns
__wasi_poll_oneoff(&sub, &event, 1, &nevents);
```

The codegen conditionally emits the WASI or Emscripten variant based on the target info.

## Test Skip Mechanisms

**File-level skip pragmas** are target-specific `pragma(Pragma.SkipWasm*)` calls in the first 50 lines of a test file:

- `pragma(Pragma.SkipWasm32Emscripten);` — skip when running with `--cc emcc` (Emscripten/Node.js)
- `pragma(Pragma.SkipWasm32Wasi);` — skip when running with `--target wasm-wasi` (standalone WASI)
- `pragma(Pragma.SkipWasm);` — skip on ALL WASM targets (generic catch-all)

A file can have one or both target-specific pragmas, or the generic one. The test runner scans the file for the matching pragma call and skips the file before compilation. Pragmas are validated by the evaluator against the `Pragma` enum in `std/prelude.yo`, so typos are caught at compile time.

```rust
pragma(Pragma.SkipWasm32Emscripten); // no network stack in WASM
pragma(Pragma.SkipWasm32Wasi); // no network stack in WASM
open import "std/libc/stdio";
// ... rest of test file
```

**Test-level: `if` guard with `process.arch`**

For files where only some tests need skipping, use an `if` early-return at the start of the test body.
Since `process.arch` is comptime, the guard is resolved at compile time — no runtime overhead on non-WASM targets.

```rust
{ arch, Arch } :: import "std/process";

test "my test", using(io : Io), {
  if((arch == Arch.Wasm32), {
    printf("  skipped on wasm32\n");
    return ();
  });

  // ... test body runs only on non-WASM targets
};
```

## Unsupported Features (Skipped Tests)

### Skipped on both Emscripten and WASI (18 files)

**Networking (6):** `tests/net/dns.test.yo`, `tests/net/tcp.test.yo`, `tests/net/udp.test.yo`,
`tests/sys/socketpair.test.yo`, `tests/sys/sockinfo.test.yo`, `tests/sys/unix.test.yo`
— WASM has no native network stack.

**OS-specific syscalls (7):** `tests/sys/signal.test.yo` (POSIX signals),
`tests/sys/statfs.test.yo` (filesystem metadata), `tests/sys/tty.test.yo` (terminal ioctl),
`tests/sys/mmap.test.yo` (memory-mapped files), `tests/sys/poll.test.yo` (poll/epoll),
`tests/sys/fs_event.test.yo` (inotify/kqueue), `tests/sys/process.test.yo` (process spawn/wait),
`tests/sys/lock.test.yo` (flock() not implemented)

**Other (5):** `tests/asm.test.yo` (inline assembly), `tests/sys/dns.test.yo`,
`tests/sys/tcp.test.yo`, `tests/sys/udp.test.yo` (network), `tests/sys/dns.test.yo` (DNS)

### Skipped on WASI only (28 additional files)

**Threading (6):** `tests/thread.test.yo`, `tests/arc.test.yo`,
`tests/sync/channel.test.yo`, `tests/sync/once.test.yo`, `tests/sync/rwlock.test.yo`,
`tests/sync/waitgroup.test.yo` — standalone WASI has no pthread support.

**Environment (1):** `tests/process.test.yo` — environment variables require explicit WASI grants.

**Filesystem syscalls (21):** These tests use Emscripten-specific `__syscall_*` imports
(`__syscall_unlinkat`, `__syscall_rmdir`, `__syscall_pipe`, `__syscall_getcwd`, etc.) that are not
available in standalone WASI. The Emscripten target provides these via NODERAWFS + JS glue code.

- **fs/**: `dir`, `file`, `metadata`, `fs_convenience`, `temp`, `walker`
- **sys/**: `advise`, `bufio`, `copy`, `dir`, `fallocate`, `fcntl`, `file`, `iov`, `path`,
  `perm`, `pipe`, `seek`, `temp`, `time`, `umask`

### Test-level skips (6 individual tests)

- `tests/sys/fcntl.test.yo` — `FD_CLOEXEC` test (no exec() in WASM)
- `tests/sys/time.test.yo` — nanosecond precision test (NODERAWFS has µs precision)
- `tests/sys/time.test.yo` — lutime symlink test (NODERAWFS doesn't support `AT_SYMLINK_NOFOLLOW`)
- `tests/sys/dir.test.yo` — hard link test (NODERAWFS returns EMLINK for link())
- `tests/sys/advise.test.yo` — madvise test (no mmap support)
- `tests/fs/dir.test.yo` — hard link test (same NODERAWFS limitation)

### Passing tests on Emscripten

All remaining tests pass, including:

- Core language features, collections, encoding, regex, strings, closures
- Algebraic effects (57 tests), async/await (114 tests), error handling
- Comptime, threading (via Emscripten pthreads), workers, Arc (cross-thread)
- Process (cwd, chdir), sync primitives (channel, once, rwlock, waitgroup)
- **sys/**: file, pipe, seek, iov, path, temp, bufio, sysinfo, umask, fallocate, copy,
  clock, time, dir, advise, fcntl, perm, constants, timer
- **fs/**: file (13), dir (12), metadata (6), temp (7), walker (6), fs_convenience (9)
- **os/**: env (7)

### Passing tests on standalone WASI (750+ tests across 37 files)

All non-skipped tests pass on standalone WASI via wasmtime:

- **Core language (281):** basic (28), comptime (26), comptime_option_result (12), fn (16),
  closure (8), array (12), ptr (2), str (7), impl (3), rc (4), error (7), dyn (8),
  prelude (4), fmt (3), path (67), iso (3), cycle_collector (11), worker (8)
- **Async/effects (171):** async_await (114), algebraic_effects (57)
- **Collections (310):** array_list (76), array_list_convenience (16), btree_map (25),
  hash_map (57), hash_set (63), linked_list (69), deque (38), priority_queue (21)
- **Encoding (82):** base64 (24), hex (11), json (35), utf16 (12)
- **sys/ (6):** constants (1), clock (2), sysinfo (2), timer (1)
- **net/ (22):** addr (13), errors (9)

## CI

The `.github/workflows/test.yml` includes two WASM test jobs:

- **`test-wasm32_emscripten`**: Runs `./yo-cli test ./tests --cc emcc` on Ubuntu with Emscripten.
- **`test-wasm32_wasi`**: Runs `./yo-cli test ./tests --target wasm-wasi` on Ubuntu with
  Emscripten (for compilation) and wasmtime (for execution).

### Running WASI tests

```bash
# Run a specific test on WASI:
./yo-cli test ./tests/comptime.test.yo --target wasm-wasi --bail -v

# Run all tests on WASI (skipped tests are filtered by pragma(Pragma.SkipWasm32Wasi);):
./yo-cli test ./tests --target wasm-wasi
```

The WASI test runner uses `wasmtime` with `--dir` grants for filesystem access.

## Known Limitations

- **Hard links**: NODERAWFS's `link()` returns EMLINK (errno 34). Tests gracefully skip.
- **flock()**: Not implemented in Emscripten. `lock.test.yo` is fully skipped.
- **Nanosecond timestamps**: NODERAWFS preserves only microsecond precision for file timestamps.
- **WASM stack size**: Limited stack; large buffers (>8KB) may cause out-of-bounds errors.
  The sendfile fallback buffer was reduced from 64KB to 8KB.
- **mmap**: Not supported for file mapping in Emscripten.

## Future Work

### Browser support

The Emscripten target generates `.html` output that can be opened in a browser. For simple
programs (console output, computation), this works out of the box. For browser-specific features:

- **Timer**: Evaluate Asyncify (`-sASYNCIFY`) vs timer queue for browser sleep.
  Current timer queue uses `usleep` in `__yo_io_wait` which may block the browser thread.
- **File I/O**: MEMFS for in-memory files (browser has no real filesystem).
  OPFS (Origin Private File System) for persistent storage.
- **Networking**: `emscripten_fetch()` for HTTP, `emscripten_websocket_*` for WebSocket.
- **JS interop**: Design FFI for calling JS from Yo (`extern "js"` or similar).
- **DOM**: Yo wrapper over `emscripten_run_script` or EM_JS.
- **Dev server**: `yo serve` with live reload, COOP/COEP headers for SharedArrayBuffer.

### Filesystem

| Mode        | Filesystem        | Real disk?    | Browser? | Threading?             |
| ----------- | ----------------- | ------------- | -------- | ---------------------- |
| NODERAWFS   | Node.js fs        | ✅ Yes        | ❌ No    | ✅ (main thread proxy) |
| MEMFS       | In-memory         | ❌ No         | ✅ Yes   | ❌ (main thread only)  |
| WasmFS+OPFS | Origin Private FS | ✅ Persistent | ✅ Yes   | ✅ (Worker thread)     |

**WasmFS**: Emscripten's next-gen C++ filesystem (`-sWASMFS`) is not yet compatible with our
use case. Tested in March 2026 — the WasmFS + NODERAWFS combo has a critical issue where
absolute paths (`/tmp/...`) route to in-memory MEMFS instead of real disk, and `getcwd()`
returns `/` instead of the real working directory ([emscripten#24830](https://github.com/emscripten-core/emscripten/issues/24830)).
Revisit when the Emscripten team resolves the root directory routing.

## Resolved Issues

<details>
<summary>Click to expand history of resolved issues</summary>

### Clock (clock_gettime stub)

Emscripten provides `clock_gettime()` via JS `performance.now()` (monotonic) and `Date.now()`
(realtime). The WASM codegen now uses the real POSIX wrapper instead of a stub.

### System Random (getrandom)

WASM/Emscripten now uses `getentropy()` (via WASI `random_get`, available since Emscripten
3.1.67+). The `std/crypto/random.yo` module checks for both `Platform.Emscripten` and
`Platform.Wasi` and calls `getentropy()` in a loop for buffers larger than 256 bytes.

### Async Escape (Function Pointer Table Mismatch) — RESOLVED

The codegen passes `-sEMULATE_FUNCTION_POINTER_CASTS=1` to emcc, which generates JS shims
to handle function pointer type mismatches at indirect call sites. All async escape tests
(including `Test escape in async closure`, `JoinHandle await returns None on escape`,
`JoinHandle two tasks one escapes`, `JoinHandle escape via spawn-injected effect`) now pass
on both emscripten and native targets. The `if((arch == Arch.Wasm32), return ())` guards
have been removed.

### Compile-time Integer Overflow (32-bit) — RESOLVED

The `Test comptime isize` test originally used values (`100000 * 25000 = 2.5B`) that
overflowed 32-bit `isize` on wasm32. The test values were reduced to fit within i32 range
and the test now passes on WASM without any arch guard.

### Threading (pthread)

Emscripten supports POSIX threads via the `-pthread` flag. The compiler automatically adds
`-pthread -sPTHREAD_POOL_SIZE=4 -sEXIT_RUNTIME=1` when the program uses threading.

### File System I/O

All async file/directory/pipe/metadata I/O operations now work on WASM using NODERAWFS.
The `runtime-io-wasm.ts` was rewritten from stubs to real POSIX calls wrapped in
immediately-completed IoFutures (same pattern as macOS).

### Async Timer/Sleep

Timer queue (sorted linked list, same as Windows runtime) replaces blocking `usleep()`.
The WASM event loop now has full I/O infrastructure (`__yo_io_init`, `__yo_io_poll`,
`__yo_io_wait`, `__yo_has_pending_io`).

### Target Naming

Renamed from misleading `wasm32-wasi` to `wasm32-emscripten`. Added `wasm32-wasi` as a
separate standalone WASI target with `-sSTANDALONE_WASM`. Added `Platform.Emscripten` to
the Yo standard library.

### Standalone WASI Support

Added standalone WASI target (`--target wasm-wasi`) that compiles to a pure `.wasm` file
runnable via `wasmtime`. Key changes:

- Target-specific skip pragmas (`pragma(Pragma.SkipWasm32Emscripten);`, `pragma(Pragma.SkipWasm32Wasi);`)
- `__wasi_poll_oneoff` replaces `usleep()` in the async timer runtime for WASI targets
- Test runner executes WASI binaries via `wasmtime --dir <dirs>` with filesystem grants
- 750+ tests pass on standalone WASI (all non-filesystem, non-threading tests)

</details>

## See also

- `src/codegen/async/runtime-io-wasm.ts` — WASM I/O runtime (timer queue, POSIX stubs)
- `src/target.ts` — Target triple definitions
- `.github/instructions/testing.instructions.md` — Testing instructions including WASM section
