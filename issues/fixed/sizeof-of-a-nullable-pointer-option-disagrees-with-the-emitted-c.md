# `sizeof(Option(*(T)))` disagrees with the emitted C

**Status: FIXED** (found and fixed 2026-09-26, while sizing `plans/EVALUATOR_MEMORY_REDUCTION.md` Phase 3).

## Symptom

```rust
pragma(Pragma.AllowUnsafe);
{ println } :: import("std/fmt");
main :: (fn() -> unit)({
  println(sizeof(Option(*(i32))));
});
export(main);
```

This printed `16` on a 64-bit target, but the emitted C type is a bare pointer:

```c
typedef int32_t* __yo_t_9162526612179318916; //  : Option(*(i32)) (optimized as nullable pointer)
```

## Root cause

Codegen lowers a two-variant enum with one empty variant and one single-pointer
variant to the bare pointer, with NULL as the empty variant
(`can_optimize_as_nullable_pointer`, previously in `src/codegen/utils/index.yo`).
The size and alignment model (`get_size_of_type` / `get_alignment_of_type`,
`src/types/utils.yo`) has to agree with the emitted C on every type, but it
knew nothing of that rule. It sized the enum as a tag plus the payload. The
error was an over-estimate, so a `malloc(sizeof(Option(*(T))) * n)`
over-allocated rather than overflowing. Any layout computed from the model was
wrong for these types, though.

## Fix

- `can_optimize_as_nullable_pointer` moves to `src/types/guards.yo`, where both
  codegen and the size model can reach it (codegen imports it from there).
- The `.EnumT` arms of `get_size_of_type` and `get_alignment_of_type` return
  the pointer's size and alignment for such an enum.

Test: `tests/ptr.test.yo` "sizeof of a nullable-pointer Option is the
pointer's". It fails on the previous compiler and passes with the fix.
