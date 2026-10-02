# Yo to WebAssembly: integration guide

This guide is about shipping a Yo library to JavaScript: what the exported API
looks like, who owns which memory, how the npm package is laid out, and how the
JavaScript and TypeScript wrappers talk to the module.

- Installing Emscripten and compiling a first program:
  [INSTALL_WASM.md](./INSTALL_WASM.md).
- Build-file reference (`build.executable`, `target`, `add_c_flags`, the
  `.html`/`.js` output rule, `Platform.Emscripten` / `Platform.Wasi`):
  [BUILD_SYSTEM.md](./BUILD_SYSTEM.md), sections *Cross-Compilation* and *WASM
  Emscripten Environment*.

The examples below were verified with yo 0.2.49, Emscripten 4.0.12, Node.js 24
and wasmtime 38.

## Choosing a target

| Target | Command | Output | Runs under |
| --- | --- | --- | --- |
| `wasm32-unknown-emscripten` | `yo compile src/main.yo --cc emcc --optimize 2 -o app` | `app.html` + `app.js` + `app.wasm` | a browser, or `node app.js` |
| `wasm32-unknown-emscripten`, library | the same with `-o api.js` and `--cflags '-sMODULARIZE=1 ...'` (below) | `api.js` + `api.wasm` | imported from JavaScript |
| `wasm32-wasip1` | `yo compile src/main.yo --target wasm32-wasip1 --optimize 2 -o app.wasm` | `app.wasm` | `wasmtime app.wasm` |

`--cc emcc` selects `wasm32-unknown-emscripten`, and `--target
wasm32-unknown-emscripten` selects `emcc`. Use Emscripten for a library
JavaScript calls into; use WASI for a standalone program with a `main`.

## The API boundary

### Exported functions

A WebAssembly module talks to JavaScript through plain C functions. Yo's `str`,
`String`, `ArrayList` and every other managed type stay inside the module: the
boundary carries only integers, floats and raw pointers.

- **`export(...)` every function JavaScript calls.** An exported function keeps
  its own name in the generated C, so `-sEXPORTED_FUNCTIONS=_transform` finds
  it. A function you forget to export gets a mangled name, and the link fails
  with `wasm-ld: error: symbol exported via --export not found: transform`.
- **A library needs no `main`.** Export the API functions and nothing else.
- **Raw pointer types need `pragma(Pragma.AllowUnsafe);`** at the top of the
  file, and every dereference or pointer offset sits inside `unsafe(...)`
  ([MEMORY_SAFETY.md](./MEMORY_SAFETY.md)).

On `wasm32` the parameter types map to C, and from there to JavaScript numbers,
like this:

| Yo | C | JavaScript |
| --- | --- | --- |
| `i32`, `u32` | `int32_t`, `uint32_t` | `number` |
| `usize` | `size_t` (4 bytes on wasm32) | `number` |
| `*u8`, `*usize` | `uint8_t*`, `size_t*` | `number`, a byte offset into `HEAPU8` |
| `?*u8` | `uint8_t*`, where `.None` is `NULL` | `number`, `0` for `.None` |

### Memory ownership

The rules that keep a JavaScript caller from leaking or double-freeing:

1. **The module owns the allocator.** JavaScript allocates through an exported
   `wasm_alloc` and frees through `wasm_free`, never through anything else.
2. **Input buffers belong to the caller.** JavaScript allocates, copies its
   bytes in, calls, and frees the buffer afterwards. A Yo function must not keep
   a pointer to an input buffer past the call.
3. **A returned buffer belongs to the caller too.** A function that returns a
   new block says so in its doc comment, and JavaScript frees it with
   `wasm_free` once it has copied the result out.
4. **Lengths come back through an out-parameter.** The caller passes a pointer
   to a `usize` slot and reads the length from it after the call.

Here is a complete library that follows them:

```rust
// src/wasm_api.yo
//! `transform`: bytes in, freshly allocated bytes out.
pragma(Pragma.AllowUnsafe);

{ GlobalAllocator } :: import("std/allocator");

wasm_alloc :: (fn(size : usize) -> ?*u8)(
  match(
    GlobalAllocator.malloc(size),
    .Some(p) => .Some((*u8)(p)),
    .None => .None
  )
);

wasm_free :: (fn(ptr : ?*u8) -> unit)(
  match(
    ptr,
    .Some(p) => GlobalAllocator.free(.Some((*void)(p))),
    .None => ()
  )
);

// Option bits; the JavaScript wrapper builds the same mask.
FLAG_UPPER :: i32(1);
FLAG_UNDERSCORE :: i32(2);

/// Transform `input_len` bytes at `input_ptr`. The result is a new block the
/// caller frees with `wasm_free`; its length is written to `out_len`.
/// Returns NULL when allocation fails.
transform :: (
  fn(input_ptr : *u8, input_len : usize, flags : i32, out_len : *usize) -> ?*u8
)({
  upper := ((flags & FLAG_UPPER) != i32(0));
  underscore := ((flags & FLAG_UNDERSCORE) != i32(0));
  // `malloc(0)` may return NULL, so ask for at least one byte.
  size := cond(
    (input_len == usize(0)) => usize(1),
    true => input_len
  );
  match(
    wasm_alloc(size),
    .Some(out) => {
      (i : usize) = usize(0);
      while(i < input_len, {
        (b : u8) = unsafe(input_ptr.add(i).*);
        // Only ASCII bytes change, so UTF-8 input stays valid UTF-8.
        cond(
          (upper && ((b >= u8(97)) && (b <= u8(122)))) => {
            b = (b - u8(32));
          },
          (underscore && (b == u8(32))) => {
            b = u8(95);
          },
          true => ()
        );
        unsafe(out.add(i).* = b);
        i = (i + usize(1));
      });
      unsafe(out_len.* = input_len);
      .Some(out)
    },
    .None => .None
  )
});

export(wasm_alloc, wasm_free, transform);
```

`GlobalAllocator.malloc` and `.free` work in `?*void`: `malloc` returns `.None`
on failure, and `free(.None)` does nothing. `wasm_free` taking `?*u8` means
JavaScript may pass `0` safely.

### Borrowing the input as a `str`

`str.from_raw_parts(ptr, len)` wraps the caller's bytes in a `str` without
copying, so a function can use the `str` API on them. The view is only as
valid as the buffer behind it: use it during the call, and copy it
(`String.from(view)`) if anything must outlive the call.

```rust
//! Borrow the caller's bytes as a `str` for the length of one call.
pragma(Pragma.AllowUnsafe);

/// Count the bytes equal to `needle` in the `input_len` bytes at `input_ptr`.
count_byte :: (fn(input_ptr : *u8, input_len : usize, needle : u8) -> usize)({
  // A view, not a copy: valid only until the caller frees `input_ptr`.
  view := str.from_raw_parts(input_ptr, input_len);
  (n : usize) = usize(0);
  (i : usize) = usize(0);
  while(i < view.len(), {
    cond(
      (view.bytes(i) == needle) => {
        n = (n + usize(1));
      },
      true => ()
    );
    i = (i + usize(1));
  });
  n
});

export(count_byte);
```

### Option sets as bit flags

Pass a set of boolean options as one `i32` where each option is a power of two
(`FLAG_UPPER = 1`, `FLAG_UNDERSCORE = 2`, the next one `4`, …). The Yo side
tests a bit with `((flags & FLAG_X) != i32(0))`, as `transform` does, and the
JavaScript side builds the mask with `|=`. Keep the two lists of constants in
the same order, in one place each.

## Building the module

A library build needs `-sMODULARIZE=1`, which makes the glue a factory
function instead of a script that runs on load, and an explicit list of the
exported functions and runtime views:

```bash
yo compile src/wasm_api.yo --target wasm32-unknown-emscripten --optimize 2 \
  --cflags '-sMODULARIZE=1 -sEXPORT_NAME=createModule -sENVIRONMENT=web,node -sALLOW_MEMORY_GROWTH=1 -sEXPORTED_FUNCTIONS=_wasm_alloc,_wasm_free,_transform -sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAPU32' \
  -o npm/my_lib_wasm_api.js
```

The same artifact as a `build.yo` step (the fields and the output-format rule
are in [BUILD_SYSTEM.md](./BUILD_SYSTEM.md)):

```rust
build :: import("std/build");

wasm_api :: build.executable({
  name : "my_lib_wasm_api",
  root : "./src/wasm_api.yo",
  target : build.CompilationTarget.Wasm32_Unknown_Emscripten,
  optimize : build.Optimize.ReleaseSmall,
  allocator : build.Allocator.System
});
wasm_api.add_c_flags("-sMODULARIZE=1 -sEXPORT_NAME=createModule -sENVIRONMENT=web,node -sALLOW_MEMORY_GROWTH=1 -sEXPORTED_FUNCTIONS=_wasm_alloc,_wasm_free,_transform -sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAPU32");

install :: build.step("install", "Build the WASM module");
install.depend_on(wasm_api);
```

`yo build` writes `yo-out/wasm32-unknown-emscripten/bin/my_lib_wasm_api.js`
and `.wasm`; copy both into `npm/`.

What each flag is for:

| Flag | Why |
| --- | --- |
| `-sMODULARIZE=1 -sEXPORT_NAME=createModule` | the glue exports a `createModule()` factory that returns a Promise of the module |
| `-sENVIRONMENT=web,node` | one build loads in both; `node` alone drops the browser code |
| `-sALLOW_MEMORY_GROWTH=1` | without it the heap is fixed (16 MiB by default) and a large input fails to allocate |
| `-sEXPORTED_FUNCTIONS=_name,...` | each exported Yo function, with a leading `_` |
| `-sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAPU32` | the memory views the wrapper reads; export every view it uses |

## npm package layout

```text
npm/
├── package.json          # package metadata
├── index.js              # the wrapper: loads the module, exposes the API
├── index.d.ts            # TypeScript declarations
├── my_lib_wasm_api.js    # Emscripten glue (build artifact)
└── my_lib_wasm_api.wasm  # the module (build artifact)
```

`yo compile` also leaves the generated C (`my_lib_wasm_api.c`) beside its
output; the `files` list keeps it out of the published package.

```json
{
  "name": "my-yo-lib",
  "version": "0.1.0",
  "main": "index.js",
  "types": "index.d.ts",
  "files": ["index.js", "index.d.ts", "my_lib_wasm_api.js", "my_lib_wasm_api.wasm"]
}
```

## The JavaScript wrapper

The wrapper hides the boundary: it loads the module once, encodes the string,
manages every allocation, and returns a plain JavaScript value.

```javascript
// npm/index.js
const createModule = require("./my_lib_wasm_api.js");

const FLAG_UPPER = 1;
const FLAG_UNDERSCORE = 2;

let modulePromise = null;

// Emscripten instantiates asynchronously: start once, share the promise.
function loadModule() {
  if (!modulePromise) modulePromise = createModule();
  return modulePromise;
}

function buildFlags(options) {
  let flags = 0;
  if (options.upper) flags |= FLAG_UPPER;
  if (options.underscore) flags |= FLAG_UNDERSCORE;
  return flags;
}

async function transform(input, options = {}) {
  const mod = await loadModule();
  const bytes = new TextEncoder().encode(input);

  // malloc(0) may return NULL, so always ask for at least one byte.
  const inputPtr = mod._wasm_alloc(Math.max(bytes.length, 1));
  const outLenPtr = mod._wasm_alloc(4); // one wasm32 usize
  if (inputPtr === 0 || outLenPtr === 0) {
    mod._wasm_free(inputPtr);
    mod._wasm_free(outLenPtr);
    throw new Error("wasm_alloc failed");
  }
  try {
    mod.HEAPU8.set(bytes, inputPtr);
    const outPtr = mod._transform(inputPtr, bytes.length, buildFlags(options), outLenPtr);
    if (outPtr === 0) throw new Error("transform: out of memory");
    // Read the views AFTER the call: memory growth replaces mod.HEAPU8.
    const outLen = mod.HEAPU32[outLenPtr >> 2];
    const result = new TextDecoder().decode(mod.HEAPU8.subarray(outPtr, outPtr + outLen));
    mod._wasm_free(outPtr);
    return result;
  } finally {
    mod._wasm_free(inputPtr);
    mod._wasm_free(outLenPtr);
  }
}

module.exports = { transform };
```

```bash
$ cd npm && node -e "require('.').transform('hello, wasm', { upper: true, underscore: true }).then(console.log)"
HELLO,_WASM
```

## TypeScript declarations

```typescript
// npm/index.d.ts
export interface TransformOptions {
  /** ASCII-uppercase the result. */
  upper?: boolean;
  /** Replace each space with `_`. */
  underscore?: boolean;
}

export function transform(input: string, options?: TransformOptions): Promise<string>;
```

The function is `async` because module instantiation is.

## Passing strings

WebAssembly sees bytes. Encode and decode UTF-8 at the boundary, in
JavaScript, and pass a pointer and a byte length; never a JavaScript string
length, which counts UTF-16 units.

JavaScript to the module:

```javascript
const bytes = new TextEncoder().encode(str);
const ptr = mod._wasm_alloc(Math.max(bytes.length, 1));
mod.HEAPU8.set(bytes, ptr);
// pass ptr and bytes.length; free ptr after the call
```

The module to JavaScript:

```javascript
// The result is a pointer plus a length.
function readString(mod, ptr, len) {
  return new TextDecoder().decode(mod.HEAPU8.subarray(ptr, ptr + len));
}

// The length was written to a usize slot at lenPtr (4 bytes on wasm32).
function readStringWithStoredLength(mod, ptr, lenPtr) {
  return readString(mod, ptr, mod.HEAPU32[lenPtr >> 2]);
}
```

If a Yo function writes a NUL-terminated string instead, the reader has to
scan for the `0` byte itself; an explicit length is simpler and allows NUL
inside the data.

## Testing

Debug natively first. The same API compiles for the host, where
AddressSanitizer reports a bad pointer at its source; a wasm build has no
sanitizer (`--sanitize` is ignored when the C compiler is `emcc`). A native
smoke test calls the API the way JavaScript will:

```rust
// src/smoke.yo
//! Native smoke test for the WASM API: run it under AddressSanitizer first.
pragma(Pragma.AllowUnsafe);

{ println } :: import("std/fmt");
{ wasm_free, transform } :: import("./wasm_api.yo");

main :: (fn() -> unit)({
  input := "hello wasm";
  (out_len : usize) = usize(0);
  match(
    transform(input.ptr(), input.len(), i32(3), &out_len),
    .Some(p) => {
      println(str.from_raw_parts(p, out_len));
      wasm_free(.Some(p));
    },
    .None => println("out of memory")
  );
});

export(main);
```

```bash
# native, with AddressSanitizer
yo compile src/smoke.yo --optimize 2 --sanitize address --allocator system -o smoke && ./smoke

# the same program as a standalone WASI module
yo compile src/smoke.yo --target wasm32-wasip1 --optimize 2 -o smoke.wasm && wasmtime smoke.wasm

# the library through the npm wrapper
cd npm && node -e "require('.').transform('hello').then(console.log)"
```

The native and the WASI build both print `HELLO_WASM`.

## Pitfalls

- **Free every allocation.** Each `_wasm_alloc` needs a `_wasm_free`, and so
  does each block a function returns. A `try`/`finally` in the wrapper keeps an
  exception from leaking the input buffers.
- **Do not cache a memory view across a call.** With `-sALLOW_MEMORY_GROWTH`,
  growing the heap replaces the `ArrayBuffer`, and a `HEAPU8` saved before the
  call goes stale. Read `mod.HEAPU8` / `mod.HEAPU32` after the call.
- **`malloc(0)` may return NULL.** Allocate at least one byte, on both sides of
  the boundary, so an empty input is not mistaken for an allocation failure.
- **`usize` is 4 bytes on wasm32 and 8 on a 64-bit host.** A length slot the
  wrapper reads with `HEAPU32` is wasm32-specific.
- **Module initialization is asynchronous.** `createModule()` returns a
  Promise: create it once and share it.
- **`-sENVIRONMENT`** decides where the glue loads: `web,node` for both,
  `node` for Node.js only.
- **The output extension picks emcc's output format, not `--target`.**
  `-o out.js` gives glue plus a sibling `.wasm`, and `-o out.wasm` a standalone
  module. With no extension, an Emscripten build writes `out.html` + `out.js` +
  `out.wasm` and a WASI build writes `out.wasm`. An unrecognized extension such
  as `-o out.bin` is JavaScript even under `--target wasm32-wasip1`, and fails
  much later as `permission denied` when something tries to execute it. Check
  with `file <artifact>`.
- **A wasm artifact is not an executable.** Run WASI under `wasmtime`, which
  denies everything by default: grant each directory with `--dir` and pass
  environment variables with `--env`. Run Emscripten glue with `node`.
- **errno values differ between WASI and POSIX.** Use the constants from
  `std/libc/errno`, or the `IoError` that `std/sys/errors` maps them to, never
  a hard-coded number.
