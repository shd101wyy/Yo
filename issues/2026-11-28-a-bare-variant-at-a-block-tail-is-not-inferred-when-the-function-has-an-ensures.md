# A bare variant at a block tail is not inferred when the function has an `ensures`

**Severity:** S2 — a valid program is rejected: in a function with an `ensures`, a bare variant (`.Ok(...)`) at the tail of a block body, or in an arm of a `cond` or `match` body, is "Failed to infer enum variant type". Without the `ensures` it is accepted, and `yo verify` accepts the same function.

- Filed: 2026-11-28, finding F10 of VERDICTS-96 (Fable 5.2, §9), with its probes `v10`, `v10b` and `v10c`.
- Status: open. The test lands with E-0b of [`plans/backlog/ERRORS_AS_VALUES.md`](../plans/backlog/ERRORS_AS_VALUES.md) (v0.2.82), which rewrites the same contract wrapper.

## Reproducer

`issues/repros/2026-11-28-a-bare-variant-at-a-block-tail-is-not-inferred-when-the-function-has-an-ensures.yo`:

```yo
// F10 (VERDICTS-96 probe v10c): a bare `.Ok(...)` block tail in a function with an `ensures`.
c :: (fn(x : i32, ensures(match(result, .Ok(_) => true, .Err(_) => true))) -> (result : Result(i32, i32)))({
  y := x;
  .Ok(y + i32(1))
});
main :: (fn() -> unit)(());
export(main);
```

`yo check` and `yo compile` (v0.2.80, its bundled std, 2026-11-28):

```text
error: Failed to infer enum variant type.
  --> 2026-11-28-a-bare-variant-at-a-block-tail-is-not-inferred-when-the-function-has-an-ensures.yo:4:3
  |
4 |   .Ok(y + i32(1))
  |   ^
help: name the enum: `MyEnum.Variant(...)`, annotate the binding: `(x : MyEnum) = .Variant(...)`, or return the value directly
yo: error: check: 1 file(s) failed evaluator coverage
```

`yo verify` on the same file: `ok … 1 obligation(s) proved`.

The scope, measured the same day:

| Body | With the `ensures` | Without |
| --- | --- | --- |
| a block whose tail is `.Ok(...)` (this file; `v10c`) | rejected | accepted (`v10`) |
| a block that returns `.Ok(...)` early and ends in a bare variant (`v10b`) | — | accepted |
| `cond((x > i32(1)) => .Ok(x), true => .Err(x))` as the whole body | rejected at the first arm | accepted |
| `.Ok(x)` as the whole body | accepted | accepted |

VERDICTS-96 §9 says an expression body is accepted (its `v04`). That holds for `yo verify` only: `yo check` rejects `v04`'s `cond` body at `.Err(x)` with the same error.

## Root cause

Inferred from the lowering and from `yo verify` accepting the file, not traced in the evaluator: the run-time contract wrapper in `src/evaluator/builtins/contracts.yo` (the comment at line 1109 on `06c6306f3`) binds the body as `{ <ret> := (<body>); assert(E1); ...; <ret> }`, and `<ret> := (<body>)` passes the body no expected type. A bare variant that is the whole body is inferred at the function's result; one inside a block or an arm is reached only through the untyped binding. Verify-mode builds carry no run-time asserts and do not build the wrapper.

## Fix

E-0b rewrites the wrapper to assert the `ensures` on every `return(...)` (`issues/2026-11-28-a-run-time-ensures-is-skipped-by-an-early-return-or-an-unwind.md`). The rewritten wrapper evaluates the body against the declared result type.

## Test

None in this filing: the bug is open with no fix. The test lands with E-0b: this reproducer and the `cond` form as cases that `yo check` accepts and run.
