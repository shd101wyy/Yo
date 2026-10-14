# Safe code can call `index_unchecked` since it returns a reference

**Severity:** S2: an invalid program is accepted. `check` passes safe code that calls the bounds-check-free `IndexUnchecked.index_unchecked`. Today the call still fails in clang, because a direct projection call bound to a local emits a pointer where a value is expected. Once direct projection calls lower correctly (V2b, feat/vbd-v2b-projection-calls), the same program compiles to an out-of-bounds read in safe code, which is S1.

Found 2026-10-14 while running `check ./tests` for PR #1339's Tier 1. The cause is develop's #1361 (V2b Generation B), not #1339: a compiler built from develop at 23787451b gives the same result.

## Symptom

`tests/safe_code_structural_gates.test.yo:171` pins the gate, and it now fails:

```text
error: Expected compile error, but the expression was evaluated successfully:
begin(xs := (ArrayList(i32).new)(), (xs.push)(i32(1)), (xs.index_unchecked)(usize(5)))
    --> tests/safe_code_structural_gates.test.yo:171:1
```

Reproducer (safe code, no pragma):

```yo
{ ArrayList } :: import("std/collections/array_list");
{ println } :: import("std/fmt");
main :: (fn() -> unit)({
  xs := ArrayList(i32).new();
  xs.push(i32(1));
  r := xs.index_unchecked(usize(100000));
  (v : i32) = (r + i32(0));
  println(`read ${v}`);
});
export(main);
```

`yo check` accepts it. `yo compile` currently stops in clang (`incompatible pointer to integer conversion initializing 'int32_t' ... 'int32_t *'`). The safe `xs.index(usize(0))` hits the same clang error in that position, which is the direct-projection-call work, not this bug.

## Root cause

Before #1361 the trait was:

```yo ignore
IndexUnchecked :: trait(
  Output : Type,
  index_unchecked : (fn(self : &mut Self, idx : usize) -> *Self.Output)
);
```

Its result was a raw pointer, and the safe-code structural gates reject a raw pointer type in safe code. That made a direct call unsafe-only, which is what the test pins. #1361 moved the trait to the projection shape (`-> &Self.Output`, plus `IndexUncheckedMut`). A reference is legal in safe code, so nothing gates the call any more, and nothing else marks `index_unchecked` as unsafe.

## Fix direction

`index_unchecked` / `index_unchecked_mut` exist for codegen, which calls them only at a subscript the verifier proved in bounds (plans/backlog/SAFE_MODE_5B_CONTAINER_BOUNDS_ELISION.md). Reject a call by name to either method outside an `unsafe(...)` block or a raw-pointer pragma, the way the pointer operations are gated, while leaving codegen's own promoted call alone. The existing `comptime_expect_error` at `tests/safe_code_structural_gates.test.yo:171` is the regression test. It fails now and passes once the gate is back. Add the `index_unchecked_mut` twin beside it.
