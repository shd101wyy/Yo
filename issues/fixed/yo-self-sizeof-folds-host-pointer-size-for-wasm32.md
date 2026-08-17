# yo-self folds `sizeof`/`alignof` with the HOST pointer size on wasm32 targets — mixed strides corrupt pointer-array containers

**Status: FIXED 2026-08-16** (found minutes after the era-split fix landed —
it was the next `--bail` casualty on the converted wasi leg, PR #127).

## Symptom

`tests/imm_map.test.yo` under yo-self + `--target wasm-wasi`: 9 of 21 tests
fail with `"Called unwrap on a None value"` (wasm `unreachable` trap). The
same file passes 21/21 under yo-self native AND under the TS compiler +
wasm-wasi. CI saw exactly one failure (`Map insert multiple entries`) because
`--bail` stops at the first.

Reproducer: `issues/repros/imm-map-wasm32-unwrap-none.yo` (insert 3, get 3).

## Root cause

`set_target_pointer_size` (types/utils.yo:65) had **no caller anywhere in
yo-self** — `g_target_pointer_size_bits` stayed at its default 64 for every
target. TS pairs `setCurrentTarget(targetInfo)` with
`setTargetPointerSize(targetInfo.pointerSizeBits)` at the compile driver
(src/codegen/index.ts:194-195); the #127 target-awareness fix ported only the
first of the two.

Consequence: `get_size_of_type` — the `sizeof`/`alignof` folding — computed
64-bit pointer layouts into wasm32 C. Measured in the emitted C for the
repro: `std/imm/map.yo`'s `_copy_children` folds
`node_sz = sizeof(MapNode(K,V))` to **16** (host layout: 8-byte tag padding +
8-byte pointer), while typed-pointer `.add()` arithmetic in the same
container compiles to C pointer arithmetic that scales by the REAL wasm32
element size (**8**: 4-byte tag + 4-byte pointer). Manual-offset writes and
typed reads disagree → garbage children → `get` returns `.None` → unwrap
panic. On native the folded 16 equals the real 16, so the strides agree and
nothing ever surfaced. TS folds `node_sz = 8ULL` for wasm32 (target-aware)
and both its stride families agree.

## Fix

`yo-self/main.yo` `run_compile`: call
`set_target_pointer_size(target.pointer_size_bits)` immediately after
`set_current_target(target)` — the exact TS pairing. The test runner shells
out to `self compile --target ...` per batch, so one call site covers both
the compile and test paths.

## Class note

This is the second member of the cross-emit-host-constants family
(`issues/yo-self-cross-emit-host-constants.md` fixed
`platform`/`arch`/`__yo_pointer_size_bits`; this one is the `sizeof` folding
global). Anything else keyed off a "default 64" global should be audited when
a new target-width divergence appears: `grep -rn "u32(64)" yo-self/types/`.
