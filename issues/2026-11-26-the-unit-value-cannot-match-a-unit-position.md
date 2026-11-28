# The unit value `()` cannot match a `unit` position in a pattern

**Severity:** S3 — `.Tick(())` on a variant whose field is `unit` fails with the uncoded "Pattern () needs a tuple to match against, but this position has type unit": `()` is read as an empty tuple pattern, so the one value of `unit` has no pattern spelling except `_` or a binding.

- Filed: 2026-11-26 (lane `v81-bare-variant`, from VERDICTS-88 §9, probe `e5`), with the v0.2.80 seed.

## Reproducer

```yo ignore
U :: enum(Tick(u : unit), N(n : i32));
a :: (fn(e : &U) -> i32)(match(e, .Tick(()) => i32(1), .N(_) => i32(2)));
export(a);
```

```text
error: Pattern () needs a tuple to match against, but this position has type unit
  --> tmp/fixme.yo:2:41
```

## Root cause

`()` parses as the empty `BK_TUPLE` call; `compile_pattern` sends every `BK_TUPLE` call to `_compile_tuple` (`src/evaluator/exprs/pattern-compile.yo`), which requires a `Tuple` position type and never considers `unit`.

## Fix direction

In `_compile_tuple`, an empty tuple pattern at a `unit` position is the (irrefutable) unit constant: compile it to `Wildcard` (or a `Const` of the unit value). Any other position keeps the error, coded E0609. A test beside the tuple cases in `tests/match-tuples.test.yo`.
