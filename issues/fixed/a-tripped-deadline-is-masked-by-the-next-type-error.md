# A tripped evaluator deadline is masked by the next type error, which blames innocent code

**Status: FIXED 2026-09-09** (`src/evaluator/exprs/_expr.yo`,
`src/module_manager.yo`, `src/main.yo`). Found while adding the integer
arithmetic batteries, whose extra prelude lines moved WHERE a 1 ms budget
expires.

## Symptom

```
$ yo compile main.yo --compile-timeout-ms 1 --emit-c --skip-c-compiler
error: Array element at index 1 has incompatible type:
- Expected: u8
- Given   : Type(1)
     --> std/prelude.yo:5584:7
     |
5584 |       u8((v >> u32(8)) & u32(255)),
```

The timeout message never printed. The control settles that the cited code is
innocent:

```
$ yo compile main.yo --emit-c --skip-c-compiler                     ; echo $?   # 0, no output
$ yo compile main.yo --compile-timeout-ms 5000 --emit-c --skip-c-compiler ; echo $?   # 0
```

Same file, same prelude — clean with no deadline and with a generous one. Only
the 1 ms budget produces the "type error".

## Root cause

The cooperative deadline is LATCHED: `_g_eval_deadline_tripped` is set on the
first trip and `_check_evaluator_deadline` then throws on EVERY dispatch, so
that a swallowing handler cannot outrun it
(`issues/fixed/evaluator-deadline-error-swallowed-by-trial-eval.md`).

The latch only wins if the next thing that happens IS a dispatch. It need not
be: a half-evaluated expression can FORMAT ITS OWN DIAGNOSTIC without
dispatching again — here an array-literal element type check, comparing an
element whose evaluation the deadline interrupted mid-flight. That error
propagates to the reporting edge and is printed as if it were the fault.

So after a trip, whatever surfaces next is noise. The latch cannot fix that by
itself, because the race is with error FORMATTING rather than with evaluation.

## Fix

Make the REPORTING EDGES prefer the deadline. `_expr.yo` exposes
`evaluator_deadline_tripped()` and `evaluator_deadline_message()`, and both
places that report a failed module evaluation consult it first:

- `mm_preload_prelude` (`src/module_manager.yo`) — the prelude edge.
- the `compile` entry-eval failure path (`src/main.yo`) — the module edge.

Once the deadline has tripped the evaluator's state is unreliable, so
preferring the timeout is not merely cosmetic: it is the only diagnostic that
is still true.

## Why it kept moving

Twice now a change to `std/prelude.yo`'s SIZE has relocated where a 1 ms budget
expires and exposed a different defect at the reporting edge — first
`issues/fixed/failed-prelude-load-prints-twice-and-continues.md` (the prelude
error printed and execution continued, so the same fault was reported twice),
now this. `tests/cli-cases/compile-timeout` is the case that catches both, and
it is worth keeping exactly as written: its `stdout_keep_match` asserts THE
failure rather than A failure, which is what turned this into a `NO-GOLDEN`
vacuous match instead of a silent pass.

## Gate

`tests/cli-cases/compile-timeout` passes with **no golden re-record** — the
golden was right and the behaviour was wrong, the same shape as the previous
fix.
