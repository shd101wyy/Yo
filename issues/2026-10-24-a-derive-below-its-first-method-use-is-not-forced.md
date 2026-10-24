# A `derive` below a method call that uses it is not forced: E0610

**Severity:** S2. A valid program is rejected: `b.clone()` above `derive(Bag, Clone)` fails with E0610 "No method `clone` on Bag", where the same call above an `impl(Bag, Clone(...))` checks clean. The workaround is to move the `derive` above its first use.

> Found 2026-10-24 while building P8 (`plans/handover/VBD_LOOKAHEAD_2026-10-23.md`
> §4.4). The explicit-copy migration was taught to ask a copied type for
> `Clone` once the run is evaluated. It would then have written
> `d.clone()` at `src/diagnostics.yo:88`, about 280 lines above
> `derive(Diagnostic, Clone)`, and that call does not resolve there.

## Symptom

`issues/repros/2026-10-24-a-derive-below-its-first-method-use-is-not-forced.yo`:

```yo
{ ArrayList } :: import("std/collections/array_list");
Bag :: struct(items : ArrayList(i32), label : i32);
count :: (fn(b : &Bag) -> usize)({
  c := b.clone();
  c.items.len()
});
derive(Bag, Clone);
main :: (fn() -> unit)(());
export(main);
```

`yo check` (the v0.2.69 seed and the tree at `f271ed005`):

```text
error[E0610]: No method "clone" on Bag: the type has no field or method with that name.
  --> issues/repros/2026-10-24-a-derive-below-its-first-method-use-is-not-forced.yo:7:9
```

With `impl(Bag, Clone(clone : (fn(self : &Self) -> Self)(Bag(items : self.items.clone(), label : self.label))))`
in place of the `derive`, the program checks clean.

## Root cause (suspected, not traced)

Lazy top-level bindings (`plans/reference/LAZY_TOPLEVEL_BINDINGS.md`) force a
pending `::` definition or `impl(...)` registration when a lookup misses,
including a method lookup on a named type. `count`'s body is evaluated at its
definition, before the module reaches `derive(Bag, Clone)`. A `derive` is a
statement evaluated in order (`src/evaluator/builtins/derive.yo`), not a
registration the miss forces, so the lookup fails.
`docs/en-US/DEFINITION_ORDER.md` names `::` definitions and `impl`
registration only. It says nothing about `derive`.

## Direction

Register a top-level `derive(T, Traits...)` with the lazy-binding forcing
pass, as an `impl(...)` registration is, so a method or trait lookup on `T`
that misses forces it. Or, if `derive` is meant to stay ordered, document it
in `DEFINITION_ORDER.md` (both languages) and make E0610 suggest moving the
`derive` up. Until then, `yo fix --migrate explicit-copy` lists a copy whose
type gets `Clone` only further down the module, instead of writing a
`.clone()` that may not resolve
(`issues/fixed/2026-10-24-explicit-copy-migration-drops-a-copy-made-before-its-types-clone-impl-registers.md`).
