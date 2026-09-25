# A failed pattern-equality probe re-raised its argument error: E0601 where E0609 belongs

**Status:** FIXED 2026-09-25. A regression from Phase 2.5 of `plans/TYPE_SYSTEM_SOUNDNESS.md` (#905),
caught by develop's `Compiler internal tests` shard 1
(`tests/internal/diagnostics_registry_examples.test.yo`: "E0609: the bad example must fail with
E0609, got E0601").

## Repro

```rust
f :: (fn(n : i32) -> i32)(match(n, "a" => i32(1), _ => i32(0)));
```

`yo check` reported

```
error[E0601]: Cannot unify incompatible types:
Expected: "i32"
Given: "comptime_str"
```

instead of E0609 `Pattern "a" cannot match a value of type i32 (no `==` between them)`.

## Mechanism

A constant pattern compiles to the test `(subject == "a")`, evaluated by
`_bind_subject_and_eval_test` (`src/evaluator/exprs/pattern_compile.yo`); when that evaluation leaves
no ExprInfo, the site reports E0609. Phase 2.5 made the comptime-literal fit rule
(`check_argument_for_parameter`, `src/evaluator/calls/helper.yo`) apply on the method path too, so
the operator candidate `(==)(lhs : i32, rhs : i32)` now rejects `"a"` there — and that rule, like
every hard argument error, also FLAGS the flow-violation channel so a def-time swallow re-raises it at
`check` time. The probe's failure was reported as E0609, but the flag stayed pending, and the
enclosing definition re-raised the operator's argument error on top of it.

## Fix

`_bind_subject_and_eval_test` clears a flow violation its own failed probe raised (one that was not
already pending before the probe) before throwing E0609. The argument rule is unchanged: outside a
pattern probe a misfitting literal is still a hard error.

## Test

`tests/cli-cases/pattern-without-eq-is-a-pattern-error/` (`check` must report `error[E0609]`), and the
registry example test that caught it.
