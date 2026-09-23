# Reading an unknown struct field has no real diagnostic, and inside arithmetic it passes `check`

**Found:** 2026-09-23, type-system audit (`plans/TYPE_SYSTEM_SOUNDNESS.md`, Phase 4).
**Status:** OPEN. Diagnostics and soundness: the most common typo gets an internal message or none.
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
