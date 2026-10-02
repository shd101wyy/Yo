# A trait method returning `Option(Self.Item)` under a where clause emits an undeclared call

**Severity:** S2: a valid program that `check` accepts fails in the C compiler.

**Status: OPEN.** Found 2026-10-03 while documenting trait where-clause projection (agent-knowledge consolidation K1). **Measured on:** yo 0.2.49, `--std-path ./std`.

## Symptom

```rust
{ println } :: import("std/fmt");
Source :: trait(Item : Type, first : (fn(self : Self) -> Self.Item));
Peek :: trait(peek : (fn(self : Self) -> Option(Self.Item)), where(Self <: Source));
Box1 :: struct(n : i32);
impl(Box1, Source(Item : i32, first : (self -> self.n)));
impl(Box1, Peek(peek : (self -> .Some(self.n))));
main :: (fn() -> unit)({
  p := Box1(n : i32(7)).peek();
  println(p.unwrap_or(i32(0)));
});
export(main);
```

- `yo check`: evaluator OK.
- `yo compile`: `error: call to undeclared function 'fn_yo_id_…'`, then an `int`-to-struct initialization error at the same site.

Returning a bare `Self.Item` from `peek` instead of `Option(Self.Item)` compiles and runs.

## Expected

The program prints `7`.
