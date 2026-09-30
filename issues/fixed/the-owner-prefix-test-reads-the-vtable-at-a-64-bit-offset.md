# The owner-prefix test reads the vtable at a 64-bit offset (fails on wasm32)

**Severity:** S3 — a test bug; develop's `test-wasm32_emscripten` job is red on it (run 36668559416)

**Status:** FIXED 2026-09-30.
**Found:** reported by a peer session from develop's CI: `tests/arena.test.yo`, "The owner prefix is
ctx then vtable, 16 bytes before the block", `RuntimeError: Aborted()` on wasm32.

## Root cause

The owner prefix is 16 bytes on every target, with `ctx` at offset 0 and `vtable` at
`sizeof(*void)` (`std/allocator.yo`'s `_AllocPrefix`, codegen's `__yo_alloc_prefix_t`). The test
read the vtable at `p.sub(8)`, prefix offset 8, which is right only where a pointer is 8 bytes. On
wasm32 that word is the prefix's unused tail.

## Measured

The test body as a standalone program, compiled with `--c-compiler emcc` and run with node:

| Read | wasm32 | macOS arm64 |
| --- | --- | --- |
| `p.sub(usize(8))` (before) | `vtable ok=false` | `vtable ok=true` |
| `prefix.add(sizeof(*void))` (after) | `vtable ok=true` | `vtable ok=true` |

(`sizeof(*void)` folds to 4 under emcc.)

## Fix

The test reads the second word at `prefix + sizeof(*void)`. The layout is unchanged.

## Note

On this macOS machine every test in `tests/arena.test.yo` aborts in its pthread workers under
`yo test --c-compiler emcc` (nix emscripten 4.0.12), while CI failed only this one; the local emcc
test runner does not match CI here, so the standalone node run above is the check.
