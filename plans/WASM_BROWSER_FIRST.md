# WASM Browser-First Plan

## Background

Yo compiles natively on Linux/macOS/Windows, so WASM-on-server is redundant. The unique value
of WASM is **running in the browser** where native code can't go.

### Current state (after Phase 1)

The Yo WASM target uses Emscripten (`emcc`) and supports two target modes:

| Target              | Shorthand         | Compiler | Output                    | Runtime           |
| ------------------- | ----------------- | -------- | ------------------------- | ----------------- |
| `wasm32-emscripten` | `wasm-emscripten` | emcc     | `.html` + `.js` + `.wasm` | Node.js + browser |
| `wasm32-wasi`       | `wasm-wasi`       | emcc     | `.wasm` (standalone)      | wasmtime/wasmer   |

- `--cc emcc` auto-selects `wasm32-emscripten` target
- `--target wasm-emscripten` or `--target wasm-wasi` auto-selects `emcc` compiler
- Default output is `.html` (emcc generates `.html` + `.js` + `.wasm`)
- Tests use `.js` output for Node.js execution
- `wasm32-wasi` adds `-sSTANDALONE_WASM` to emcc flags for WASI-compatible `.wasm` output
- **14 files `@skip_wasm`**: networking (6), OS-specific (7), inline assembly (1)
- **5 test-level skips**: FD_CLOEXEC, nanosecond timestamps, hard links, madvise
- Emscripten flags: `-sEMULATE_FUNCTION_POINTER_CASTS=1 -sNODERAWFS=1` + pthread flags

```bash
# Emscripten target (Node.js + browser) — all equivalent:
yo compile hello.yo --cc emcc -o app         # → app.html + app.js + app.wasm
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

## Approach: Incremental Browser Support

Keep the existing Node.js testing infrastructure working (it's excellent for CI), but add
browser build mode that produces browser-ready output.

### Phase 1: Target rename + HTML output ✅

- [x] Add `emscripten` OS to `target.ts` (alongside existing `wasi`)
- [x] Support shorthand targets: `wasm-emscripten`, `wasm-wasi`
- [x] `--cc emcc` defaults to `wasm32-emscripten` (was `wasm32-wasi`)
- [x] `--target wasm-*` auto-selects `emcc` compiler
- [x] Default output: `.html` for emscripten target (`.html` + `.js` + `.wasm`)
- [x] `wasm32-wasi` uses `-sSTANDALONE_WASM` flag
- [x] Add `Platform.Emscripten` to `std/process.yo`
- [x] Update `std/crypto/random.yo` to use `Platform.Emscripten`
- [x] Update `std/build.yo` with `Wasm32_Emscripten` target
- [x] All tests pass on both native and WASM

### Phase 2: Browser I/O runtime

- [ ] Timer: Evaluate Asyncify (`-sASYNCIFY`) vs timer queue for browser sleep.
      Current timer queue uses `usleep` in `__yo_io_wait` which may block the browser thread.
- [ ] Console output: `printf` → browser console (Emscripten does this by default)
- [ ] File I/O: MEMFS for in-memory files (no persistence needed for most use cases)
- [ ] Persistence: OPFS (Origin Private File System) via WasmFS mount (future)
- [ ] Networking: `emscripten_fetch()` for HTTP requests (replaces POSIX sockets)
- [ ] WebSocket: `emscripten_websocket_*` for bidirectional communication

### Phase 3: JS interop & DOM

- [ ] Design FFI for calling JS from Yo (`extern "js"` or similar)
- [ ] DOM manipulation API (Yo wrapper over `emscripten_run_script` or EM_JS)
- [ ] Canvas/WebGL bindings for graphics
- [ ] Event handling (click, keypress, resize, etc.)

### Phase 4: Developer experience

- [ ] `yo serve` — local dev server with live reload (COOP/COEP headers for SharedArrayBuffer)
- [ ] Source maps for debugging in browser DevTools
- [ ] Bundle optimization (tree-shaking, code splitting)
- [ ] Browser test runner (Playwright or Puppeteer-based)

## Key Technical Decisions

### NODERAWFS vs MEMFS vs OPFS

| Mode        | Filesystem        | Real disk?    | Browser? | Threading?             |
| ----------- | ----------------- | ------------- | -------- | ---------------------- |
| NODERAWFS   | Node.js fs        | ✅ Yes        | ❌ No    | ✅ (main thread proxy) |
| MEMFS       | In-memory         | ❌ No         | ✅ Yes   | ❌ (main thread only)  |
| WasmFS+OPFS | Origin Private FS | ✅ Persistent | ✅ Yes   | ✅ (Worker thread)     |

**Decision**: Keep NODERAWFS for Node.js environment (testing/CI). Use MEMFS for browser
environment (simple, works everywhere). Add OPFS support later for persistence.

### Asyncify vs timer queue

The current timer queue (sorted linked list, same as Windows runtime) works well for
cooperative scheduling. For browser, two options:

- **Keep timer queue**: Works, but `usleep` in `__yo_io_wait` blocks the browser thread
- **Asyncify**: `-sASYNCIFY` lets C code yield to the browser event loop. Adds ~5-10% code
  size but enables true non-blocking sleep and I/O. Recommended for browser target.

### SharedArrayBuffer / pthreads in browser

Requires COOP/COEP headers on the web server. Not all hosting supports this. Options:

- Default to single-threaded browser builds (no `-pthread`)
- Optional `--threads` flag that adds pthread + SAB requirements

## Stubs that become browser APIs

| Current stub (-ENOSYS)                   | Browser replacement                        |
| ---------------------------------------- | ------------------------------------------ |
| Socket create/bind/listen/accept/connect | WebSocket API                              |
| send/recv/sendto/recvfrom                | WebSocket send/receive                     |
| DNS getaddrinfo/getnameinfo              | N/A (WebSocket handles resolution)         |
| Process spawn/waitpid                    | Web Workers (limited)                      |
| HTTP fetch                               | `emscripten_fetch()` (**NEW** capability!) |

## See also

- `plans/WASM_SUPPORT.md` — Current WASM status, resolved issues, known limitations
- `src/codegen/async/runtime-io-wasm.ts` — WASM I/O runtime (timer queue, POSIX stubs)
- `src/target.ts` — Target triple definitions
