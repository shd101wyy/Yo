# Yo WASM Integration Cheatsheet

Patterns for building Yo libraries as WebAssembly modules and consuming them from JavaScript/TypeScript.

## Compilation targets

| Target               | Command                                            | Output                        |
| -------------------- | -------------------------------------------------- | ----------------------------- |
| Emscripten (browser) | `yo compile src/api.yo --cc emcc --release -o api` | `.js` + `.wasm`               |
| WASI (standalone)    | `yo compile src/api.yo --target wasm-wasi -o api`  | `.wasm` (runs via `wasmtime`) |
| Native (testing)     | `yo compile src/api.yo --release -o api`           | Native binary                 |

## WASM API design pattern

Export C-compatible functions that operate on linear memory:

```rust
// src/wasm_api.yo
open import "std/string";

// Allocate WASM memory for the caller
wasm_alloc :: (fn(size : usize) -> *(u8))(
  malloc(size)
);

// Free WASM memory
wasm_free :: (fn(ptr : *(u8)) -> unit)(
  free(ptr)
);

// Process input and return result pointer + length
render :: (fn(input_ptr : *(u8), input_len : usize, flags : i32) -> *(u8))({
  (input : str) = str.from_raw_parts(input_ptr, input_len);
  // ... process input ...
  result := do_work(input);
  // Write length to a known location, return pointer
  result_ptr
});

export wasm_alloc;
export wasm_free;
export render;
```

Key rules:

- Export only `fn` functions with primitive or pointer types
- Use `*(u8)` + `usize` for strings across the boundary
- Use `i32` bitmask flags for option sets (powers of 2)
- Always provide `wasm_alloc` / `wasm_free` for the JavaScript side

## Bitmask flags pattern

Pass multiple boolean options as a single `i32` using bit flags:

```rust
// Each option is a power of 2
// bit 0 = 1   : feature_a
// bit 1 = 2   : feature_b
// bit 2 = 4   : feature_c
// bit 3 = 8   : feature_d

parse_flags :: (fn(flags : i32) -> Options)({
  (opts : Options) = Options.default();
  opts.feature_a = ((flags & i32(1)) != i32(0));
  opts.feature_b = ((flags & i32(2)) != i32(0));
  opts.feature_c = ((flags & i32(4)) != i32(0));
  opts.feature_d = ((flags & i32(8)) != i32(0));
  opts
});
```

JavaScript side:

```javascript
function buildFlags(options) {
  let flags = 0;
  if (options.featureA) flags |= 1;
  if (options.featureB) flags |= 2;
  if (options.featureC) flags |= 4;
  if (options.featureD) flags |= 8;
  return flags;
}
```

## build.yo WASM target

The `Executable` struct accepts: `name`, `root`, `target`, `optimize`, `allocator`, `sanitize`.
Emscripten-specific flags go in `add_c_flags(...)` after creating the step.

```rust
build :: import "std/build";

wasm_api :: build.executable({
  name: "my_lib_wasm_api",
  root: "./src/wasm_api.yo",
  target: build.CompilationTarget.Wasm32_Emscripten,
  optimize: build.Optimize.ReleaseSmall,
  allocator: build.Allocator.Libc
});
wasm_api.add_c_flags("-O3 -flto -mbulk-memory -sALLOW_MEMORY_GROWTH -sENVIRONMENT=web,node -sMODULARIZE=1 -sEXPORT_NAME=createModule -sEXPORTED_FUNCTIONS=_wasm_alloc,_wasm_free,_render -sEXPORTED_RUNTIME_METHODS=HEAPU8");

install :: build.step("install", "Build WASM module");
install.depend_on(wasm_api);
```

Available targets: `Wasm32_Emscripten`, `Wasm32_Wasi`, `X86_64_Linux_Gnu`, `Aarch64_Macos`, etc.
Available optimizations: `Debug`, `ReleaseSafe`, `ReleaseFast`, `ReleaseSmall`.
Available allocators: `Mimalloc` (default), `Libc`.

## npm package structure

```text
npm/
├── package.json          # npm package metadata
├── index.js              # JavaScript wrapper (loads WASM, exposes clean API)
├── index.d.ts            # TypeScript declarations
├── my_lib_wasm_api.js    # Emscripten-generated JS glue (build artifact)
└── my_lib_wasm_api.wasm  # WASM binary (build artifact)
```

## JavaScript wrapper pattern

```javascript
// npm/index.js
const createModule = require("./my_lib_wasm_api.js");

let moduleInstance = null;

async function initModule() {
  if (!moduleInstance) {
    moduleInstance = await createModule();
  }
  return moduleInstance;
}

function createRenderer() {
  let mod = null;

  return {
    async render(input, options = {}) {
      if (!mod) mod = await initModule();

      const flags = buildFlags(options);
      const encoder = new TextEncoder();
      const inputBytes = encoder.encode(input);
      const inputLen = inputBytes.length;

      // Allocate WASM memory and copy input
      const inputPtr = mod._wasm_alloc(inputLen);
      mod.HEAPU8.set(inputBytes, inputPtr);

      // Call the WASM function
      const resultPtr = mod._render(inputPtr, inputLen, flags);

      // Read result (assuming null-terminated or length-prefixed)
      const result = readString(mod, resultPtr);

      // Free memory
      mod._wasm_free(inputPtr);
      mod._wasm_free(resultPtr);

      return result;
    },
  };
}

function buildFlags(options) {
  let flags = 0;
  if (options.featureA) flags |= 1;
  if (options.featureB) flags |= 2;
  return flags;
}

module.exports = { createRenderer };
```

## TypeScript declarations

```typescript
// npm/index.d.ts
export interface RenderOptions {
  /** Enable feature A */
  featureA?: boolean;
  /** Enable feature B */
  featureB?: boolean;
}

export interface Renderer {
  render(input: string, options?: RenderOptions): Promise<string>;
}

export function createRenderer(): Renderer;
```

## String passing across WASM boundary

JavaScript → WASM:

```javascript
const encoder = new TextEncoder();
const bytes = encoder.encode(str);
const ptr = mod._wasm_alloc(bytes.length);
mod.HEAPU8.set(bytes, ptr);
// Pass ptr and bytes.length to WASM function
```

WASM → JavaScript:

```javascript
// If result is pointer + length
function readString(mod, ptr, len) {
  const bytes = mod.HEAPU8.subarray(ptr, ptr + len);
  return new TextDecoder().decode(bytes);
}

// If result stores length at a known offset
function readStringWithStoredLength(mod, ptr, lenPtr) {
  const len = mod.HEAPU32[lenPtr >> 2];
  return readString(mod, ptr, len);
}
```

## Testing WASM modules

```bash
# Test native first (fast iteration, AddressSanitizer)
yo compile src/wasm_api.yo --release --sanitize address -o test && ./test

# Test Emscripten WASM
yo compile src/wasm_api.yo --cc emcc --release -o npm/my_lib_wasm_api

# Test WASI
yo compile src/wasm_api.yo --target wasm-wasi -o test.wasm && wasmtime test.wasm

# Run npm package tests
cd npm && node -e "const m = require('.'); m.createRenderer().render('hello').then(console.log)"
```

## Common WASM pitfalls

- **Memory leaks**: Always `_wasm_free` every `_wasm_alloc` on the JavaScript side.
- **String encoding**: WASM only sees bytes — use `TextEncoder`/`TextDecoder` for UTF-8.
- **Errno differences**: WASI errno values differ from POSIX. Use `std/libc/errno` constants.
- **No `main` needed**: Library WASM modules don't need `main` or `export main;` — just export the API functions.
- **Emscripten environment**: Set `-sENVIRONMENT='web,node'` to support both contexts, or `'node'` for Node.js only.
- **Module initialization is async**: Emscripten's `createModule()` returns a Promise. Initialize once and reuse.
- **WASM memory growth**: Always use `-sALLOW_MEMORY_GROWTH=1` for dynamic allocations.
- **Trailing null bytes**: If your Yo code writes null-terminated strings, the JavaScript reader must know to stop at `\0` or use explicit length.
- **Native testing first**: Always debug with `--sanitize address` on native before switching to WASM — error messages are much clearer.
