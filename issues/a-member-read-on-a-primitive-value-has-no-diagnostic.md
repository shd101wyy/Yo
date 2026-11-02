# A member read on a primitive value (`x.*`, `x.foo` on an `i32`) has no real diagnostic

**Severity:** S3 — a wrong `.*` or a field typo on a scalar gets an uncoded internal message that names neither the type nor what it lacks.
**Found:** 2026-10-05, while testing decision 32 (`plans/VALUES_BY_DEFAULT.md`): `a2 := a.clone()` on an `Arc(i32)` forwards to the payload, so `a2` is an `i32`, and the natural next line `a2.*` hit this.
**Measured:** yo 0.2.52 seed.

## Repro

```rust
{ println } :: import("std/fmt");
main :: (fn() -> unit)({
  x := i32(3);
  y := x.*;
  z := x.foo;
  println(x.*);
});
export(main);
```

| Shape | `yo check` |
| --- | --- |
| `y := x.*` | `error: Failed to evaluate, got (x.(*))` (no code) |
| `z := x.foo` | `error: Failed to evaluate, got (x.foo)` (no code) |
| `println(x.*)` | `error: evaluate_function_call: arg not evaluated` (no code, internal function name) |

The struct case was fixed as E0406 (`issues/fixed/unknown-struct-field-has-no-diagnostic.md`):
`p.z` on a struct says `No field "z" on P. Its fields: ...`. A receiver that is not a struct
(an integer, `bool`, a float) still falls through `evaluate_property_access` with no ExprInfo,
and the caller reports the missing info instead of the missing member.

## Fix direction

In `src/evaluator/exprs/property_access.yo`, where the `.*` arm falls through ("Not a pointer")
and where the field lookup misses on a non-struct receiver whose type is known, raise E0406:
`` `x` has type `i32`, which has no field "foo" `` and, for `.*`,
`` `x` has type `i32`: `.*` reads through a pointer or a `Box`/`Arc`, and `i32` is neither ``.
The struct case is pinned by the `unknown-field-is-an-error` cli-case; this one gets a sibling
case (or a `comptime_expect_error(x.*, "has type `i32`")` test) with the rendered message.

## Also an enum receiver (2026-11-02, yo 0.2.73 seed)

`Option(P)` falls through the same way: `o.n` on an `o : Option(P)` (a forgotten `.unwrap()`) reports `error: Last expression in "begin" is not evaluated correctly: (o.n)` under `yo check`. When the read is a call argument, the message is `evaluate_function_call: arg not evaluated`, which is how V2c's `ca_plain.get_cloned(usize(0)).ty` (`src/evaluator/calls/function.yo`, `_copying_accessor_info`) passed review and surfaced only as a build failure. Neither message names `Option(P)` or says that it has no field `n`.
