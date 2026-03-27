# Plan: Compile tetris_yo to WASM with Raylib

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

## Required Work

### Phase 1: Build Raylib for Emscripten

Build raylib as a static library targeting `wasm32-emscripten` and install it into the Emscripten sysroot.

```bash
# Clone raylib
git clone https://github.com/raysan5/raylib.git
cd raylib

# Build for Emscripten
mkdir build-web && cd build-web
emcmake cmake .. -DPLATFORM=Web -DCMAKE_BUILD_TYPE=Release
emmake make

# Install to Emscripten sysroot
emmake make install
# This installs:
#   <sysroot>/include/raylib.h (and friends)
#   <sysroot>/lib/libraylib.a
```

After installation, `emcc -lraylib` should find the library automatically.

### Phase 2: Add per-artifact C flags API to the build system

The build system needs a way for users to pass extra C compiler/linker flags per-artifact. This is needed for Emscripten-specific flags like `-sUSE_GLFW=3`.

#### 2a. Add `add_c_flags` and `add_link_flags` methods to `Step`

In `std/build.yo`:

```rust
impl(Step,
  // ... existing methods ...
  add_c_flags : (fn(comptime(self) : Self, comptime(flags) : comptime_string) -> comptime(unit))({
    __yo_build_add_c_flags(self.name, flags);
  }),
  add_link_flags : (fn(comptime(self) : Self, comptime(flags) : comptime_string) -> comptime(unit))({
    __yo_build_add_link_flags(self.name, flags);
  })
);
```

#### 2b. Add evaluator builtins

In `src/evaluator/builtins/build.ts`:

- Register `__yo_build_add_c_flags(artifact_name, flags)` — splits the space-separated flags and appends to `artifact.cFlags`.
- Register `__yo_build_add_link_flags(artifact_name, flags)` — splits and appends to a new `artifact.linkFlags` array.

In `src/expr.ts`:

- Add `__yo_build_add_c_flags` and `__yo_build_add_link_flags` to `BuiltinFunctions`.

#### 2c. Pass `artifact.cFlags` through to CodeGenerator

In `src/build-runner.ts`, the `compileArtifact` function currently does NOT pass `artifact.cFlags` to `codeGenerator.compileModule()`. Fix:

```typescript
codeGenerator.compileModule(absolutePath, {
  // ...existing options...
  cflags: artifact.cFlags.join(" "), // ADD THIS
});
```

Same fix needed in `compileDependencyArtifact`.

#### 2d. Add `linkFlags` support to CodeGenerator

In `src/codegen/index.ts`, ensure link flags (like `-sUSE_GLFW=3`) are appended to the compiler command when using emcc (emcc combines compile+link in one step).

### Phase 3: Update `tetris_yo/build.yo` and `raylib_yo/build.yo`

Once the per-artifact flags API exists:

```rust
// tetris_yo/build.yo
build :: import "std/build";

raylib_yo :: build.dependency({ name: "raylib_yo", url: "https://github.com/shd101wyy/raylib_yo.git", ref: "v0.0.4" });

exe :: build.executable({
  name: "tetris_yo",
  root: "./src/main.yo",
  optimize: build.Optimize.ReleaseFast
});

exe_wasm :: build.executable({
  name: "tetris_yo_wasm",
  root: "./src/main.yo",
  optimize: build.Optimize.ReleaseFast,
  target: build.CompilationTarget.Wasm32_Emscripten
});

// Emscripten-specific flags for the WASM artifact
exe_wasm.add_c_flags("-DPLATFORM_WEB");
exe_wasm.add_link_flags("-sUSE_GLFW=3 -sASYNCIFY -lraylib");

import_list :: ComptimeList(build.ImportEntry)({
  name: "raylib_yo",
  module: raylib_yo.module("")
});

exe.add_import_list(import_list);
exe_wasm.add_import_list(import_list);

install :: build.step("install", "Build all artifacts");
install.depend_on(exe);
install.depend_on(exe_wasm);

run_step :: build.step("run", "Run the application");
run_step.depend_on(build.run(exe));
```

### Phase 4: Platform-conditional Yo code in tetris_yo

The game's main loop needs to differ between native and WASM:

- **Native**: standard `while !WindowShouldClose()` loop
- **WASM**: use `emscripten_set_main_loop` callback pattern (or `-sASYNCIFY` which allows the normal loop to work)

With `-sASYNCIFY`, the normal raylib loop works unchanged on WASM. Without it, the code needs `emscripten_set_main_loop`.

## Dependencies Between Phases

```
Phase 1 (build raylib for emcc) ──┐
                                   ├── Phase 3 (update build.yo files)
Phase 2 (add C flags API)  ───────┘        │
                                            └── Phase 4 (conditional Yo code, if needed)
```

Phase 1 and Phase 2 can be done in parallel. Phase 3 depends on both.

## Open Questions

1. Should `raylib_yo/build.yo` detect the target and configure system library flags differently for WASM vs native? This would require comptime platform detection in `build.yo`.

2. Should the build system support per-target system library definitions? e.g., `build.system_library({ name: "raylib", target: "wasm32-emscripten", ... })` for different configurations per target.

3. Is `-sASYNCIFY` sufficient for the tetris game loop, or does it need the `emscripten_set_main_loop` pattern? With `ASYNCIFY`, standard blocking loops work but add ~10% code size overhead.
