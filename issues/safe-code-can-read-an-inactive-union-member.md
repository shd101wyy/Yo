# Safe code can read an inactive union member (undefined behavior)

**Status: OPEN, needs a language decision** (found 2026-09-28 by the first
full-suite UBSan run, `plans/SAFE_MODE.md` D6/§14 R6).

## Symptom

A file without `pragma(Pragma.AllowUnsafe)` may read any member of a
`union(...)`, including one other than the member last written. When the read
member's type has invalid bit patterns, the result is C undefined behavior,
which safe mode's Promise A excludes. Measured with a tree-built compiler on
2026-09-28:

```rust
{ println } :: import("std/fmt");
U :: union(x : i32, y : bool);
main :: (fn() -> unit)({
  v := U(x : 12);
  b := v.y;
  println(b);
});
export(main);
```

- `yo check` → `evaluator OK`, rc 0. No safe-mode gate fires.
- `yo compile --sanitize undefined` → the binary aborts with
  `runtime error: load of value 12, which is not a valid value for type 'bool'`
  (rc 134).

`tests/basic.test.yo` "Test 'union'" does the same through destructuring
(`{ y : z } := v1; // unsafe access`). That file is `AllowUnsafe`, so the test
itself is legitimate. It is the full-suite UBSan run's only report in this
class.

## Root cause

C permits type punning through a union: the bytes are reinterpreted. An
`i32` 12 read as `bool`, however, is not a valid `bool` value, and loading it
is UB (clang's `-fsanitize=bool`). The same holds for any member type with
invalid representations: fieldless enums lowered to integers, and pointers or
references read from integer bits. Nothing in `src/evaluator/memory_safety.yo`
treats a union member read as unsafe. The pragma-gated list (raw pointers,
`&`, `extern`, `asm`, `unsafe(...)`) does not include untagged unions.

## Options

1. **Gate union member reads behind `AllowUnsafe`** (recommended). An untagged
   union is raw memory reinterpretation, the same category as `*T` and
   `unsafe.cast`, which are already pragma-gated. std defines no unions, so the
   gate costs nothing in-tree. Construction (`U(x : 12)`) stays legal; reading
   a member, including through destructuring, becomes a compile error naming
   the pragma. Safe code that needs a sum type already has `enum`, whose
   `match` is checked.
2. **Allow reads only of members whose every bit pattern is valid** (integers,
   floats, byte arrays). This is more permissive but still reinterprets
   memory, and the "valid for every bit pattern" predicate must be kept
   correct as types grow.
3. **Accept and document** an exception to Promise A. Not recommended: this
   is exactly the silent-wrong-value class the campaign exists to remove.

Whichever lands, it needs a fails-before/passes-after cli-case (the repro
above: rc 0 today, a compile error after) and a `docs/*/MEMORY_SAFETY.md`
entry in both languages.
