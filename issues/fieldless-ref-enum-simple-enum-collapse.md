# An all-payload-free `ref(enum)` does not compile (simple-enum collapse vs `T*` lowering)

**Found 2026-08-05** while fixing
`issues/fixed/ref-enum-unit-variant-inline-construction-leak.md`. **Pre-existing and
independent** of that fix — the fix's "some variant has fields" gate deliberately skips
this shape so as not to add to the pile.

## Minimal reproducer

```rust
{ assert } :: import("std/assert");
Flag  :: ref(enum(On, Off));
check :: (fn(f : Flag) -> bool)(
  match(
    f,
    .On => true,
    .Off => false
  )
);
main :: (fn() -> unit)({
  assert(check(Flag.On), "on");
});
export(main);
```

`./yo-cli compile … --release` → **9 clang errors**, e.g.

```
error: member reference base type '__yo_enum_yocfc2720e_id_3' is not a structure or union
```

## Root cause

`canOptimizeAsSimpleEnum` (`src/codegen/utils/index.ts:961-969`) returns true when **every**
variant is payload-free, and does not exclude reference-semantics enums. So the type is
lowered to a plain C enum, while the rest of codegen still treats a `ref(enum(…))` as
`T*`:

- the per-variant constructors `__yo_new_<cName>_<Variant>()` still emit
  `obj->header.ref_count = 1` (8 of the 9 errors — a member reference on a non-struct);
- the `match` still emits `switch (f)` against a value the drop/dispose machinery expects
  to be a pointer (the 9th).

Either the collapse must exclude `isReferenceSemantics` enums, or the constructor /
parameter / match lowering must follow the collapse. The first is the smaller change and
matches the collapse's intent (a tag-only type needs no heap identity) — but it changes
the ABI of any such type, so check `___drop` / `___dispose` / GC registration
(`src/codegen/functions/generation.ts:3164-3250`) before choosing.

## Note for whoever fixes it

`ref(enum(On, Off))` currently has **no working behaviour to preserve** — it does not
compile at all — so there is no back-compat constraint. Add a regression test to
`tests/ref_enum.test.yo` once it does.
