# Plan: Compile tetris_yo to WASM with Raylib
> **ARCHIVED 2026-09-04 — ONE-OFF ENABLEMENT RECORD (TS-era).** The WASM
> flag/host-leak fix it drove shipped with the build runner; the emscripten
> raylib toolchain stays an external environment concern.


## Problem

`tetris_yo` has a WASM target (`wasm32-emscripten`) in its `build.yo`, but compilation fails because:

1. **Host system library flags leak into cross-compiled WASM builds** — Windows vcpkg include/library paths were passed to `emcc`. **Fixed** in `src/build-runner.ts` by skipping system library resolution for WASM targets.

2. **Raylib is not installed for Emscripten** — `emcc` cannot find `raylib.h` because the Emscripten sysroot has no raylib headers or `libraylib.a`.

3. **Emscripten-specific flags are missing** — raylib WASM builds require `-sUSE_GLFW=3`, `-DPLATFORM_WEB`, and optionally `-sASYNCIFY` which the build system does not currently pass.

4. **No per-artifact C flags API** — the build system has no way for users to add custom C compiler flags per-artifact from `build.yo`.

## Current State

- `tetris_yo/build.yo` declares two artifacts: `tetris_yo` (Windows) and `tetris_yo_wasm` (Emscripten).
- `raylib_yo/build.yo` declares `build.system_library({ name: "raylib" })` which resolves via vcpkg on Windows.
- The WASM build correctly skips host vcpkg flags (fix applied), but then has no raylib at all.
- Emscripten 5.0.4 is installed but does not include raylib in its sysroot.

## Completed Work

### Phase 1: Build Raylib for Emscripten ✅

Built raylib 5.5 as a static library for `wasm32-emscripten` and installed to the Emscripten sysroot.

```bash
git clone --depth 1 --branch 5.5 https://github.com/raysan5/raylib.git raylib-wasm-build
cd raylib-wasm-build && mkdir build-web && cd build-web
emcmake cmake .. -G Ninja -DPLATFORM=Web -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INSTALL_PREFIX="<emscripten_sysroot>"
emmake ninja -j8 && emmake ninja install
```

**Note:** `libraylib.a` installs to `sysroot/lib/` but emcc's linker searches `sysroot/lib/wasm32-emscripten/`. Copy the file:

```bash
cp sysroot/lib/libraylib.a sysroot/lib/wasm32-emscripten/libraylib.a
```

### Phase 2: Add per-artifact C flags API ✅

Added `Step.add_c_flags(flags: comptime_string)` method to the build system:

- `std/build.yo`: New `add_c_flags` method on `Step` impl block
- `src/expr.ts`: Added `__yo_build_add_cflags` to `BuiltinFunctions`
- `src/evaluator/builtins/build.ts`: Evaluator handler — splits space-separated flags and pushes to `artifact.cFlags`
- `src/evaluator/exprs/_expr.ts`: Added to builtin dispatch list
- `src/build-runner.ts`: Fixed `artifact.cFlags` passthrough to `compileModule()` (both `compileArtifact` and `compileDependencyArtifact`)

### Phase 3: Update `tetris_yo/build.yo` ✅

Added WASM-specific flags via `add_c_flags`:

```rust
exe_wasm.add_c_flags("-lraylib -sUSE_GLFW=3 -sASYNCIFY -DPLATFORM_WEB");
```

### Phase 4: Platform-conditional code — Not needed ✅

With `-sASYNCIFY`, the standard raylib game loop (`while !WindowShouldClose()`) works unchanged on WASM. No `emscripten_set_main_loop` refactoring was needed.

## Build Results

Both targets compile successfully:

- **Windows**: `tetris_yo.exe` (120 KB) + runtime DLLs (raylib.dll, glfw3.dll)
- **WASM**: `tetris_yo_wasm.js` (182 KB) + `tetris_yo_wasm.wasm` (163 KB)

## Remaining Considerations

1. **`raylib_yo/build.yo`** does not need changes — its `system_library` declaration works for native builds, and WASM builds skip system library resolution by design (flags are specified per-artifact via `add_c_flags`).

2. **Per-target system library definitions** — A potential future enhancement: `build.system_library({ name: "raylib", target: "wasm32-emscripten", ... })` for automatic per-target resolution. Not needed now since `add_c_flags` covers the use case.

3. **HTML shell** — To run the WASM build in a browser, an HTML file is needed that loads `tetris_yo_wasm.js`. Emscripten generates a default shell, or a custom `--shell-file` can be provided via `add_c_flags("--shell-file shell.html")`.
