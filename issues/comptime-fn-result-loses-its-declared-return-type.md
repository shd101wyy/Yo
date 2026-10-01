# A `comptime_fn(f)` call's result is typed `comptime_int`, not `f`'s declared return type

**Severity:** S2 — an invalid program is accepted: the `i32` result of a `comptime_fn` call coerces into a `u8` where an `i32` constant is rejected.

**Status: OPEN** (found 2026-10-01).

## Reproducer

```rust
factorial :: (fn(x : i32) -> i32)(
  cond(
    (x <= i32(1)) => i32(1),
    true => (x * recur(x - i32(1)))
  )
);
comptime_factorial :: comptime_fn(factorial);
result :: comptime_factorial(i32(5));

main :: (fn() -> unit)({
  (y : u8) = result;
});
export(main);
```

`yo check` (0.2.47): `evaluator OK`. Expected: `error[E0601]: Incompatible
types`, which is what the same assignment from `k :: i32(120);` reports.

`yo lsp` hover on `result` agrees with the evaluator:

```
comptime(result)
: comptime_int
= 120
```

The original README code image (an IDE screenshot from an older compiler)
showed `: i32` for the same hover, so this looks like a regression.

## Where to look

`evaluate_comptime_fn` (`src/evaluator/builtins/comptime_fn.yo:44`) and the
call path for the function value it returns: the folded value keeps the
literal's `comptime_int` type instead of being converted to the callee's
declared return type.

## Fix plan

Type the folded result with the callee's declared return type (a
`comptime(i32)` value of 120), so the reproducer reports E0601 and the hover
shows `: i32`. Add a `comptime_expect_error` test for the `u8` assignment and
a positive test that the `i32` result flows into an `i32` slot.
