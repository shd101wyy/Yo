# `comptime_expect_error` re-pushed the module frame into the cached prelude env

**Status:** FIXED 2026-09-15 (`feat/c-include-module-value`).
**Area:** evaluator — `src/evaluator/builtins/comptime_expect_error.yo` env restore.
**Surfaced by:** the destructurer's new no-shadowing rule
(plans/C_INCLUDE_EXTERN_MODULE_VALUE.md §3.3): the fast suite went red at
`tests/safe_code_structural_gates.test.yo` with

```
error: Failed to define variable "assert":
   --> std/async/index.yo:40:3
note: Variable "assert" is already defined here (variable shadowing is not allowed):
   --> tests/.yo_selftest_batch_193_0.yo:1:12
```

— `std/async`'s own import preamble was rejected against a binding of the
ENTRY module.

## Minimal reproducer (compile path; `check` does not show it)

```rust
{ ArrayList } :: import("std/collections/array_list");
comptime_expect_error((p : *(i32)) = i32(0));   // any failing TYPED binding
{ yield } :: import("std/async");                // any module loaded afterwards that binds ArrayList
main :: (fn() -> unit)(());
export(main);
```

Bisected from the 28-line generated batch one statement at a time: only the
typed-binding shape triggers it (`p := &(x)`, `unsafe(...)`, `asm(...)`,
`extern(...)`, `c_include(...)` inside `comptime_expect_error` do not).

## Root cause (measured with a gated probe in `mm_fresh_module_env`)

`mm_fresh_module_env` clones `g_cached_prelude_env` for every demand load.
Until the expected error it cloned 2 frames; from the next load on it cloned
3 — the third being the entry module's LIVE frame (1 variable, `ArrayList`;
a binding made AFTER the `comptime_expect_error` leaked too, so it was the
frame handle, not a copy).

The evaluator threads envs by reassigning `env.frames = <ExprInfo>.env.frames`
after a sub-evaluation (`initialization_assignment.yo`, the typed-binding
path). The prelude's own evaluation did the same, so a prelude node's
recorded frame list IS `g_cached_prelude_env.frames`; an inline builtin
(`i32(0)`) hands its prelude body node back as the evaluated RHS, so the entry
env's `frames` became the prelude env's list. The expected throw then unwound,
and `comptime_expect_error`'s restore — which pops back to the saved depth and
RE-PUSHES the saved frame handles (added 2026-09 for the "module frame
vanished" case) — pushed the entry's module frame into the prelude's list.

## Fix

Snapshot the frame LIST OBJECT before the argument evaluation and restore it
(`env.frames = saved_frames_list`) before the depth/content restore, so the
re-push and truncation always operate on the module's own list.

## Gates

`tests/expected_error_keeps_prelude_env_clean.test.yo` (the reproducer as a
test), `tests/safe_code_structural_gates.test.yo` (the original red), and the
fast suite.
