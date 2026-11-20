# `consume` passes its expected `unit` type to its argument

**Severity:** S2 — a valid `consume(e)` whose own expected type is `unit` (an argument to a `unit` parameter, the tail of a `-> unit` body, a `(x : unit) =` binding) is rejected with E0601 when `e` is not unit.

- Filed: 2026-11-20 (found while probing `issues/fixed/2026-11-20-a-side-effecting-builtin-is-deleted-when-its-unit-value-is-bound-or-folded.md`).
- Status: FIXED on branch `v0280/extern-dce`.
- Test: `tests/unit-value-side-effects.test.yo` ("consume under a unit expected type accepts a non-unit argument").

## Reproducer

```yo
pragma(Pragma.AllowUnsafe);
extern("C", putchar : (fn(c : i32) -> i32));
take_unit :: (fn(u : unit) -> i32)(i32(1));
ret_unit :: (fn() -> unit)({
  consume(unsafe(putchar(i32(67))))
});
main :: (fn() -> unit)({
  _a := take_unit(consume(unsafe(putchar(i32(65)))));
  ret_unit();
});
export(main);
```

v0.2.78 and a tree binary built from `df9927b92`:

```text
error[E0601]: Cannot unify incompatible types: "i32" and "unit"
   --> tmp/v5.yo:13:18
   |
13 |   consume(unsafe(putchar(i32(67))))
   |                  ^^^^^^^
```

## Root cause

`evaluate_consume` (`src/evaluator/builtins/consume.yo`) evaluates its
argument with the caller's `ctx.expected_type` still set. That expected type
belongs to the consume's own result, which is always `unit`; the argument may
be any type. It shows when the argument's own evaluator checks its result
against the expected type: an `extern("C", …)` call does, so
`take_unit(consume(unsafe(putchar(…))))` fails, while a Yo function call does
not, so `take_unit(consume(bump(p)))` is accepted.

## Fix

The argument is evaluated with no expected type (`replace` →
`evaluate_expression_guarded` → restore → rethrow, the `the`/`Array.fill`
pattern).
