# A `comptime(T) : Type` parameter's associated constant fails at definition time

**Severity:** S2: a valid program is rejected.

**Status: OPEN.** Found 2026-10-03 while documenting associated constants (agent-knowledge consolidation K1). **Measured on:** yo 0.2.49, `--std-path ./std`.

## Symptom

```rust
a :: (fn(comptime(T) : Type) -> u32)(T.BITS);
main :: (fn() -> unit)({
  _ := a(u8);
});
export(main);
```

`yo check` fails with `error: Last expression in "begin" is not evaluated correctly:` on `(T.BITS)`. Adding `where(T <: Integer)` doesn't help. The same constant through a `generic(T)` parameter called with a value argument works, and so does a trait-declared constant through `comptime(T)`.

## Expected

`a(u8)` is `8`. The body is evaluated when `a` is called with a concrete type, not judged at definition time against an unbound `T`.
