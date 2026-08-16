# yo-self's cond collapse-to-direct path emits an early-return's drops but discards the `return;` for unit conds — double-drop

**Status: FIXED 2026-08-16** (the `test-wasm32_wasi` leg's second `--bail`
casualty wave on PR #127: `tests/sync/atomic.test.yo` "AtomicI32 cross-thread
counter", wasm `unreachable` trap).

## Symptom

The test guards itself with `if(arch == Arch.Wasm32, return(()))`. Under a
wasm target the guard folds comptime-TRUE; the emitted batch C for that test
arm contained the early-return's "Drop local variables before early return"
block (releasing the test-dispatch RC locals) **but no `return;`** —
execution fell through, the function's normal scope-end drops released the
same locals AGAIN, and the double-decr panicked (`unreachable`). Native legs
never see it because the guard folds true only on wasm32.

## Root cause

`generate_return` emits the drop preamble as an EMITTER SIDE EFFECT and
returns the `return` statement as a STRING for the caller to emit.
`generate_cond_expression`'s collapse-to-direct path (first non-false arm is
comptime-true) generated the arm value — landing the side-effect drops — but
its emission of `value_code` was guarded by `temp_var_opt.is_some() &&
!is_unit`: for a UNIT cond the control-flow string was silently discarded and
the function returned `""`.

(TS's collapse path has the same textual guard, but its evaluation/codegen
never routes this shape through it with drops pending — its wasi run passes;
the standalone small-form does not reproduce under yo-self either
(`issues/repros/wasm-comptime-return-drop-only.yo` — kept as the shape
record), only the multi-arm batch dispatch does.)

## Fix

`yo-self/codegen/exprs/cond.yo`, collapse path: when the generated arm value
is control-flow code and the cond is unit (or has no result temp), emit it as
a statement line before the unit return. The non-unit path already handled CF
at its own site.

Verified: `tests/sync/atomic.test.yo` 15/15 under `--target wasm-wasi`
(previously 14/1 with the trap).
