# Reading an unknown struct field has no real diagnostic, and inside arithmetic it passes `check`

**Found:** 2026-09-23, type-system audit (`plans/TYPE_SYSTEM_SOUNDNESS.md`, Phase 4).
**Status:** FIXED 2026-09-25 (`plans/TYPE_SYSTEM_SOUNDNESS.md` Phase 4.3). Diagnostics and soundness: the most common typo got an internal message or none.
**Measured:** yo 0.2.39 seed; re-verified with the same result on a develop build `d455b6a67`.

## Repro

```rust
{ println } :: import("std/fmt");
P :: struct(x : i32, y : i32);
main :: (fn() -> unit)({
  p := P(x : i32(1), y : i32(2));
  z := (p.xx + i32(1));
  println(z);
});
export(main);
```

| Shape | `yo check` |
| --- | --- |
| `z := (p.xx + i32(1))` | rc=0; `yo compile` then fails with `internal compiler error: Failed to transpile part of main's body` |
| `z := p.z` | `error: Failed to evaluate, got (p.z)` (no code) |
| `println(p.z)` | `error: evaluate_function_call: arg not evaluated` (no code, internal fn name) |

None of the messages names the field, the type, or the fields that do exist.

## Fix direction

Raise a coded error in property access when the receiver type is known and has no such field or
method: `No field "xx" on P (fields: x, y)`, with a did-you-mean from the E0401 suggester. The
arithmetic case must not be swallowed: find which trial eats it and make it re-raise.

## Resolution (2026-09-25, Phase 4.3)

A field read that names no field of its struct is error E0406 (`E_FIELD_NOT_FOUND`, a new
registry entry). The message lists the fields and suggests the nearest one:

```
error[E0406]: No field "xx" on P. Its fields: x, y.
Did you mean "x"?
```

It fires everywhere, including inside arithmetic (which used to pass `check`). A dot expression
that is the CALLEE of a call (`p.m(x)`) is still a method lookup: `evaluate_function_call` marks
its callee (`mark_dot_callee`, `src/evaluator/context.yo`), and only an unmarked access that
misses reports E0406 (`src/evaluator/exprs/property_access.yo`).

Regression test: `tests/cli-cases/unknown-field-is-an-error`.
