# Partial application through a generic binder loses the compile-time result

**Severity:** S1 — a valid program that partially applies a comptime function whose `_` slot is typed by a `generic(...)` binder fails with an internal compiler error (E1301) when the result is used at run time.

Found 2026-11-21 while verifying `.github/instructions/testing.instructions.md` ("Partial application (`_`)")
with the v0.2.78 tree binary (`cut-g4-final`).

## Reproducer

```yo
{ println } :: import("std/fmt");
Wrap :: (fn(generic(A : Type), comptime(x) : A, comptime(y) : A) -> comptime(A))(x);
g :: Wrap(i32(7), _);
r :: g(i32(9));
main :: (fn() -> unit)({
  (v : i32) = r;
  println(&v);
});
export(main);
```

`yo compile` fails:

```
error[E1301]: internal compiler error: Failed to transpile part of main's body — the emitted C for "__yo_user_main" contains an untranspiled expression, so the program would run without it
```

## Observations

- The full call `Wrap(i32(7), i32(9))` compiles and runs.
- With concrete parameters (`fn(comptime(x) : i32, comptime(y) : i32) -> comptime(i32)`), the same partial
  application folds: `comptime_assert(g(i32(9)) == i32(7))` passes.
- With the generic binder, `comptime_assert(r == i32(7))` fails with E1101 ("Expected bool value"): `r` has
  type `i32` (`(v : i32) = r` type-checks) but no compile-time value, so the binder `A` is presumably left
  unresolved when the partial application's remaining slot is filled.
- A `_` in a generic parameter's position is rejected as intended ("Partial application: expected 2
  argument(s), got 3"): generic parameters are inferred, not positional.

## Next step

Find where the partial-application value re-enters the call with the filled slot, and check that it binds
`A` from the late argument before the comptime body runs (`YO_DEBUG_BIND=A`, `YO_DEBUG_SWALLOW=1`).
