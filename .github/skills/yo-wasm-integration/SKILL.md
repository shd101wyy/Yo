---
name: yo-wasm-integration
description: Build Yo libraries for WebAssembly and publish as npm packages. Use this when working with WASM targets, Emscripten, WASI, npm packaging, JavaScript/TypeScript wrappers, or browser/Node.js integration.
argument-hint: "[WASM task, target, or integration question]"
---

# Yo WASM Integration

Use this skill for compiling Yo projects to WebAssembly and packaging them for JavaScript/TypeScript consumption via npm.

## When to use this skill

Use this skill when you need to:

- compile a Yo project to WebAssembly (Emscripten or WASI)
- set up an `npm/` package directory with JavaScript/TypeScript wrappers
- expose Yo functions to JavaScript via WASM memory and C ABI
- integrate a Yo WASM module into a Node.js or browser project
- debug WASM-specific compilation or runtime issues
- publish a Yo-backed npm package

## Workflow

1. Decide on target: Emscripten (browser + Node.js) or WASI (standalone/server).
2. Define WASM build steps in `build.yo` using `build.executable` with `target: build.CompilationTarget.Wasm32_Emscripten` and `add_c_flags(...)` for Emscripten settings.
3. Create a JavaScript wrapper in `npm/` that loads the WASM module and exposes a clean API.
4. Add TypeScript declarations (`index.d.ts`) for type safety.
5. Test the WASM module from both Node.js and browser contexts.
6. Consult the [WASM integration cheatsheet](./wasm-integration-cheatsheet.md) for patterns.

## High-signal rules

- In `build.yo`, use `target: build.CompilationTarget.Wasm32_Emscripten` for Emscripten WASM builds. Use `step.add_c_flags(...)` for Emscripten `-s` options.
- For single-file compilation, use `yo compile --cc emcc` or `yo compile --target wasm-wasi`.
- WASM functions communicate through linear memory — pass pointers and lengths, not Yo types.
- JavaScript wrappers handle the string encoding/decoding boundary (`TextEncoder`/`TextDecoder`).
- Use bitmask flags (powers of 2) to pass option sets through a single `i32` parameter.
- Yo's `str` and `String` types are internal — export raw `*(u8)` + `usize` pairs for WASM APIs.
- Always test with `--sanitize address` on native first, then verify WASM behavior matches.
- Emscripten exports are controlled by `-sEXPORTED_FUNCTIONS` and `-sEXPORTED_RUNTIME_METHODS`.
- WASM modules can be loaded in Node.js using `WebAssembly.instantiate` or Emscripten's generated JS glue.
- Errno values differ on WASM — use constants from `std/libc/errno`, never hardcode numbers.

## Resource

- [WASM integration cheatsheet](./wasm-integration-cheatsheet.md)
