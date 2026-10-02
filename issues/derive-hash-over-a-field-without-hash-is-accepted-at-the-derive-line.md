# `derive(T, Hash)` over a field without `Hash` is accepted at the derive line

**Severity:** S3: a late, misplaced diagnostic. The error appears at the first `.hash` call, as E0610 on the field's type, not at the `derive` that cannot work.

**Status: OPEN.** Found 2026-10-03 while documenting derives (agent-knowledge consolidation K1). **Measured on:** yo 0.2.49, `--std-path ./std`.

## Symptom

```rust
{ println } :: import("std/fmt");
{ DefaultHasher } :: import("std/hash");
Inner :: struct(n : i32);
Outer :: struct(i : Inner);
derive(Outer, Hash);
main :: (fn() -> unit)({
  h := DefaultHasher.new();
  o := Outer(i : Inner(n : i32(1)));
  o.hash(h);
  println("hashed");
});
export(main);
```

`yo check` reports `error[E0610]: No method "hash" on Inner` at `o.hash(h)`. Without that call the program checks clean, even though `derive(Outer, Hash)` can never be used.

## Expected

`check` rejects `derive(Outer, Hash)` at the derive line, naming the field whose type lacks `Hash`. #968 (v0.2.46) gave `Clone` the same gate for an `ArrayList` field whose element is not `Clone`.
