# An inverted skip guard kills the specialized-body result-type check (E0604) for exactly its target case

**Severity:** S1 — the per-instantiation check that a specialized generic body has its declared
result type silently stopped firing, so `(fn(generic(T : Type), x : &T) -> i32)(true)`-shaped
programs compile and return a reinterpreted value
(`issues/fixed/generic-fn-body-is-not-checked-against-its-declared-result-type.md` regressed);
`comptime_expect_error` on such a call reports "evaluated successfully", which failed the whole
`tests/type_soundness.test.yo` batch (0 of 75 ran) on the v0.2.79 develop battery.

**Status:** OPEN, filed 2026-11-18. Introduced by #2001 (develop `b482d44d8`), the same commit that
landed the trap-and-re-raise fix for the dropped callsite-ensures restore: moving the E0604 check
from `create_specialized_function_inline`'s body into `_eval_and_check_specialized_body`
transcribed the `sb_skip` guard with `== usize(0)` where the original had `> usize(0)`.

## Symptom

The battery (run 44287686080, tip `b482d44d8`): `tests/type_soundness.test.yo` failed to compile on
every cross-emit leg (windows-latest, windows-11-arm, macos-latest, macos-26-intel, shard 1), with
the error the test EXPECTED to trap escaping instead and killing the batch:

```text
error: "Function body has type `bool`"
    --> tests/.yo_selftest_batch_<...>.yo:224:42
224 | ... begin(comptime_expect_error(_bad_ct(i32, i32(1)), "Function body has type `bool`"), ...
yo: error: test: tests/type_soundness.test.yo — 0 of 75 tests in this batch ran: the batch failed to compile (exit != 0).
```

The quoted message is `comptime_expect_error`'s own "no error was raised" throw (it re-raises the
expected-text argument as the diagnostic): the argument had evaluated WITHOUT the expected E0604.

## Reproducer

`yo check` on this file fails on `b482d44d8` and passes on `b482d44d8~1` and with the fix (the
module-level `::` matters: its lazy force runs the specialization INSIDE the builtin's argument
evaluation, where the missing throw is observable):

```yo
_bad_ct :: (fn(comptime(T) : Type, x : &T) -> i32)(true);

main :: (fn() -> unit)({
  comptime_expect_error(_bad_ct(i32, i32(1)), "Function body has type `bool`");
  ()
});
export(main);
```

## Root cause

`_eval_and_check_specialized_body` (`src/evaluator/calls/helper.yo`) skips the result-type
comparison while a side still carries an OPEN `SomeT` (an impl-level binder the call does not
bind); the original inline guard in `create_specialized_function_inline` read
`get_all_some_types(...).len() > usize(0)` for both sides. The move (#2001) transcribed both as
`== usize(0)`, inverting the guard: `sb_skip` is now true whenever either side is CONCRETE — the
one case the check exists for — and false only while BOTH sides still carry open `SomeT`s. The
comparison at the bottom of the helper is therefore unreachable for every specialization it was
written to judge, and E0604 ("Function body has type ...") is never raised.

The `== usize(0)` shape is correct in the projection-tail check six lines below (that check RUNS
when both sides are concrete) and in the never-adopt above it, which is how the transcription
slipped through review: three neighboring `len()` guards, two spelled `== 0` correctly, one
inverted.

`yo check ./src` stayed green (273/273) because the compiler's own tree contains no wrong-typed
generic body; the defect needed the language test that asserts the rejection.

## Fix

`src/evaluator/calls/helper.yo`, the `sb_skip` binding in `_eval_and_check_specialized_body`:
restore `> usize(0)` on both `get_all_some_types` length tests (with a comment pinning the
direction against the neighboring `== 0` guards).

## Verification

- The reproducer above: `yo check` fails on the pre-fix tree binary, passes with the fix.
- `yo test ./tests/type_soundness.test.yo --parallel 1` — 0/75 (batch compile escape) before,
  75/75 after, with a tree-built stage-1.
- `yo test ./tests/internal/verifier_callsite_self_drop.test.yo --parallel 1` (#2001's regression
  test) still passes — the trap-and-re-raise machinery itself is untouched, only the guard.
- `yo check ./src --std-path ./std` 273/273, `yo check ./std --std-path ./std` 171/171.
