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

## Which prelude-cache failure this is (for the third instance)

The prelude has been the vector twice, in two DIFFERENT shapes:

1. **The removed lookup cache** (commit `641a5d8d4`, removed in `0b3c77296`):
   `get_variables_from_env` assumed an env's bottom `preludeFrameCount`
   frames were the unmodified prelude frames and skipped scanning them. That
   design was unsound (fresh callee envs have their own bottom frames; cloned
   module frames diverge from the snapshot) and gave no measurable speedup, so
   it is gone and must not come back.
2. **This one — list-identity aliasing into `g_cached_prelude_env`.** The
   cache itself is a plain env that `mm_fresh_module_env` CLONES per load
   (fresh frame lists, fresh Frame objects, shared Variable handles) — that
   part is sound. What broke it was a write INTO the cached env's own frame
   list from outside: the evaluator's env-threading idiom
   `env.frames = <ExprInfo>.env.frames` can adopt a list that is the cached
   env's, and any later `push` on that env (here `comptime_expect_error`'s
   re-push) lands in the cache. Nothing guards the cached env against that.

So the cache is not fundamentally unsafe; its sharp edge is that frame LISTS
are shared by identity across the evaluator's env reassignments while the
cache assumes its list is private. A third instance will again look like
"a loaded module sees the entry module's bindings". Two hardenings are open:
make `mm_load_prelude_file` cache a `snapshot_env` copy rather than the
prelude's live env, and/or record the cached frame count and treat growth as
an internal error at clone time (turning silent contamination into a loud
failure). Neither is in the fix above, which restores the identity only on
the one path measured to break.
