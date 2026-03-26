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
immediately-completed IOFutures**, the same pattern as the macOS runtime for regular files. With
`-sNODERAWFS=1`, Emscripten uses Node.js's real filesystem instead of a virtual MEMFS, so all
file/directory operations work on actual files.

The async timer/sleep uses a **sorted linked list timer queue** (same pattern as Windows runtime).
Timers are registered as pending IOFutures with due times, and the event loop polls/waits for them
via `__yo_io_poll`/`__yo_io_wait`. This enables cooperative scheduling during sleep.

## Test Skip Mechanisms

**File-level: `// @skip_wasm` directive**

Add `// @skip_wasm` as the first line of a test file to skip the entire file when compiling with emcc.
The test runner scans the first 20 lines for this directive and skips the file before evaluation.

```yo
// @skip_wasm
open import "std/libc/stdio";
// ... rest of test file
```

**Test-level: `if` guard with `process.arch`**

For files where only some tests need skipping, use an `if` early-return at the start of the test body.
Since `process.arch` is comptime, the guard is resolved at compile time — no runtime overhead on non-WASM targets.

```yo
{ arch, Arch } :: import "std/process";

test "my test", using(io : IO), {
  if((arch == Arch.Wasm32), {
    printf("  skipped on wasm32\n");
    return ();
  });

  // ... test body runs only on non-WASM targets
};
```

## Unsupported Features (Skipped Tests)

### File-level skips (14 files)

**Networking (6):** `tests/net/dns.test.yo`, `tests/net/tcp.test.yo`, `tests/net/udp.test.yo`,
`tests/sys/socketpair.test.yo`, `tests/sys/sockinfo.test.yo`, `tests/sys/unix.test.yo`
— WASM has no native network stack.

**OS-specific syscalls (7):** `tests/sys/signal.test.yo` (POSIX signals),
`tests/sys/statfs.test.yo` (filesystem metadata), `tests/sys/tty.test.yo` (terminal ioctl),
`tests/sys/mmap.test.yo` (memory-mapped files), `tests/sys/poll.test.yo` (poll/epoll),
`tests/sys/fs_event.test.yo` (inotify/kqueue), `tests/sys/process.test.yo` (process spawn/wait),
`tests/sys/lock.test.yo` (flock() not implemented in Emscripten)

**Inline assembly (1):** `tests/asm.test.yo` — WASM does not support x86/ARM inline assembly.

### Test-level skips (5 individual tests)

- `tests/sys/fcntl.test.yo` — `FD_CLOEXEC` test (no exec() in WASM)
- `tests/sys/time.test.yo` — nanosecond precision test (NODERAWFS has µs precision)
- `tests/sys/dir.test.yo` — hard link test (NODERAWFS returns EMLINK for link())
- `tests/sys/advise.test.yo` — madvise test (no mmap support)
- `tests/fs/dir.test.yo` — hard link test (same NODERAWFS limitation)

### Passing tests

All remaining tests pass, including:

- Core language features, collections, encoding, regex, strings, closures
- Algebraic effects (57 tests), async/await (114 tests), error handling
- Comptime, threading (via Emscripten pthreads), workers, Arc (cross-thread)
- Process (cwd, chdir), sync primitives (channel, once, rwlock, waitgroup)
- **sys/**: file, pipe, seek, iov, path, temp, bufio, sysinfo, umask, fallocate, copy,
  clock, time, dir, advise, fcntl, perm, constants, timer
- **fs/**: file (13), dir (12), metadata (6), temp (7), walker (6), fs_convenience (9)
- **os/**: env (7)

## CI

The `.github/workflows/test.yml` includes a `test-wasm` job that runs `./yo-cli test ./tests --cc emcc`
on `ubuntu-latest` with Emscripten installed via `mymindstorm/setup-emsdk@v14`.

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

### Async Escape (Function Pointer Table Mismatch)

The codegen now passes `-sEMULATE_FUNCTION_POINTER_CASTS=1` to emcc, which generates JS shims
to handle function pointer type mismatches at indirect call sites.

### Compile-time Integer Overflow (32-bit)

The `Test comptime isize` test used values (`100000 * 25000 = 2.5B`) that overflowed 32-bit
`isize` on wasm32. The test values were reduced to fit within i32 range.

### Threading (pthread)

Emscripten supports POSIX threads via the `-pthread` flag. The compiler automatically adds
`-pthread -sPTHREAD_POOL_SIZE=4 -sEXIT_RUNTIME=1` when the program uses threading.

### File System I/O

All async file/directory/pipe/metadata I/O operations now work on WASM using NODERAWFS.
The `runtime-io-wasm.ts` was rewritten from stubs to real POSIX calls wrapped in
immediately-completed IOFutures (same pattern as macOS).

### Async Timer/Sleep

Timer queue (sorted linked list, same as Windows runtime) replaces blocking `usleep()`.
The WASM event loop now has full I/O infrastructure (`__yo_io_init`, `__yo_io_poll`,
`__yo_io_wait`, `__yo_has_pending_io`).

### Target Naming

Renamed from misleading `wasm32-wasi` to `wasm32-emscripten`. Added `wasm32-wasi` as a
separate standalone WASI target with `-sSTANDALONE_WASM`. Added `Platform.Emscripten` to
the Yo standard library.

</details>

## See also

- `src/codegen/async/runtime-io-wasm.ts` — WASM I/O runtime (timer queue, POSIX stubs)
- `src/target.ts` — Target triple definitions
- `.github/instructions/testing.instructions.md` — Testing instructions including WASM section
