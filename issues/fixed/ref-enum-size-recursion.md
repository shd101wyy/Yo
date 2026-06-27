# Type traversals recurse forever on a recursive `ref(enum)` (size, alignment, RC-cycle analysis)

Two latent bugs of the SAME class — a type traversal that walks an enum's
variant field types inline without recognising a `ref(enum)` as a terminating
pointer / without a cycle guard. They were masked while recursive `ref(enum)`
fields were spelled `Box(Self)` (whose deref is a pointer and terminates); they
surfaced when the bootstrap `TypeValue` dropped `Box` from its `Self` fields
(Phase-4 cleanup — a `ref(enum)` value is already a heap RC handle, so `Box` is
redundant).

## Bug 1 — `getSizeOfType` / `getAlignmentOfType`

## Symptom

Compiling a program with a **recursive reference-semantics enum** whose variant
field is typed `Self` (no `Box`), when some function **reconstructs** that enum
(`fn(t) -> Self`), overflows the evaluator at def-time validation:

```
Error: Failed to call the function:
  rebuild :: (fn(t : Ty) -> Ty)(
                          ^
Error: Maximum call stack size exceeded.
```

## Minimal reproducer

```rust
Ty :: ref(enum(
  Prim(name : String),
  Listy(items : ArrayList(Self)),
  Boxed(inner : Self),
  Pair(a : Self, b : Self)
));

// A function that RECONSTRUCTS the ref-enum (returns Self) triggers it.
rebuild :: (fn(t : Ty) -> Ty)(
  match(t,
   .Prim(name) => Ty.Prim(name : name.clone()),
   .Boxed(inner) => Ty.Boxed(inner : recur(inner)),
   .Pair(a, b) => Ty.Pair(a : recur(a), b : recur(b)),
   .Listy(items) => { /* rebuild each item */ Ty.Listy(items : ...) }
  )
);
```

A merely-*reducing* recursion (`fn(t) -> i32`, e.g. counting) does **not** trip
it — only a function whose result type is the recursive ref-enum.

## Root cause

`getSizeOfType` (and `getAlignmentOfType`) in `src/types/utils.ts` short-circuit
**reference-semantics structs** to pointer size:

```ts
} else if (isStructType(type)) {
  if (type.isReferenceSemantics) return getTargetPointerSizeBits(); // ✓
  ...
} else if (isEnumType(type)) {
  return getEnumTypeSize(type);   // ✗ no isReferenceSemantics check
}
```

The **enum** branch had no such check. A `ref(enum)` value is a heap RC handle —
a pointer — exactly like a ref-struct, so its size is the pointer size. Without
the short-circuit, `getEnumTypeSize` walks the variant field types inline; a
variant field typed `Self` (with no `Box`) makes it recurse into the same enum
forever.

Value enums never hit this because they break self-recursion with `Box(Self)`,
and `getSizeOfType(Box(...))` returns pointer size (`isPtrType`) and terminates.
That is *also* why the recursion only appeared once `Box(Self)` was removed from
the (now `ref(enum)`) `TypeValue` during the bootstrap Phase-4 cleanup — the
`Box` had been masking the missing enum short-circuit.

## Fix

Add the `isReferenceSemantics` pointer-size/alignment short-circuit to the enum
branch of both `getSizeOfType` and `getAlignmentOfType`, mirroring the struct
branch (`src/types/utils.ts`). Mirrored to the self-hosted compiler in
`yo-self/types/utils.yo` (`get_size_of_type` / `get_alignment_of_type`).

## Bug 2 — `typeCanFormCyclicRcReference` (RC-cycle / GC analysis)

`canTypeFormRcCycle` (the RC-cycle analysis that decides which types need GC
tracking) guards its struct walk with a `visitedTypes` set keyed by `type.id`.
But the enum branch of its helper `typeCanFormCyclicRcReference`
(`src/types/utils.ts`) walked variant field types with **no** such guard:

```ts
if (isEnumType(type)) {
  for (const variant of type.variants)
    for (const field of variant.fields ?? [])
      if (typeCanFormCyclicRcReference(field.type, ...)) return true;   // ✗ no guard
}
```

So a recursive `ref(enum)` reached as an RC field — e.g. a value type holding a
`ref(enum(… Pair(a : Self, b : Self) …))` — recurses into its own `Self`
variant fields forever. (A `ref(enum)` with an `ArrayList(Self)` field does
**not** trip it: `ArrayList` is a ref-struct, so that path goes through the
already-guarded struct walk.)

### Fix

Guard the enum branch with `visitedTypes` (add `type.id`, skip if already
present), mirroring the struct path. Re-visiting an enum already on the path
cannot find a *new* route back to the original ref-struct, so returning `false`
is sound. (`src/types/utils.ts`.) Not mirrored to yo-self: its
`can_type_form_rc_cycle` is a conservative `-> false` stub with no recursive
walker, so it never hits this path.

## Regression test

`tests/ref_enum.test.yo`:
- `Nest` ref-enum (reached via a direct `Self` field AND an `ArrayList(Self)`
  field) + `nest_rebuild` (a `fn(t) -> Self` reconstruction) — Bug 1.
- a value type holding a recursive `ref(enum)` field — Bug 2 (exercises the
  RC-cycle analysis).

The reduce-only `tree_sum` that existed before exercised neither path, which is
why the bugs went unnoticed.
