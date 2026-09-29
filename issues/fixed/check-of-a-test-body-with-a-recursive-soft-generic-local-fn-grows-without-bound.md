# `check` of a test body with a recursive soft-generic local fn grows without bound

**Severity:** S2 — `yo check` of a `.test.yo` whose test defines a recursive local function with an `Impl(Fn)` parameter runs out of memory (48 GB footprint measured); `yo test` of the same file passes

**Status:** FIXED 2026-09-29 (branch `tss/impl-self-operator`; the `imm_*` SIGBUS files to be re-checked with the build).
**Found:** 2026-09-29, the `yo check --test-bodies` census (`plans/TYPE_SYSTEM_SOUNDNESS_HANDOVER.md`
§3.3): PLAIN `check` of `tests/closure_param_forwarding.test.yo` was killed at a 48 GB peak footprint
(7.1 GB RSS). The `imm_*.test.yo` files die with SIGBUS (rc 138) at about 6 GB RSS. They are not yet
narrowed and may be the same bug.

## Reproducer (measured with a 2.5 GB RSS cap)

```rust
{ ArrayList } :: import("std/collections/array_list");
test("t", {
  w2 :: (fn(depth : i32, get_info : Impl(Fn(k : i32) -> i32)) -> i32)(
    cond((depth <= i32(0)) => i32(0), true => (get_info(depth) + recur(depth - i32(1), get_info)))
  );
  x := w2(i32(2), (k : i32) => (k + i32(1)));
});
```

| Variant | `check` |
| --- | --- |
| as above (develop `b6b828772` binary, and the Phase 3 step 7 branch) | killed past the cap |
| the same body in `main :: (fn() -> unit)({ … })` | 88 MB, rc 0 |
| no `recur` (the soft-generic fn called once) | rc 0 |
| `recur` in a fn with no `Impl(Fn)` parameter | rc 0 |

`YO_DEBUG_SWALLOW=1` shows two trials only (the test body and the closure), so the growth is inside
one evaluation.

## Root cause

`evaluate_test` (`src/evaluator/exprs/test.yo`) trial-evaluates a test body with the MODULE's
context, whose `is_executing` is set. A function body's trial runs with `is_executing : false` and
`is_validating_function_definition : true` (`create_function_body_evaluation_context`). In
that mode `recur` type-checks its arguments instead of executing (`evaluate_recur`'s
short-circuit), and calls are not run at compile time. In the test block the call to `w2` was
executed at compile time, and `recur` recursed on an unknown `depth` whose `cond` never decided.

## Fix

The test-body trial sets the same two flags a function body's trial has, and restores them after.
A test body runs at run time: the runner compiles it as the body of a synthesized `main`.

## Test

`tests/cli-cases/check-test-body-recursive-soft-generic-local-fn`: `check` of the reproducer (with an
assertion on the result) exits 0 inside the case's timeout.
