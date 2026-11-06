# An impl over a reference type registers nothing: `impl(&Bag, Name)` is accepted and a `&Bag` receiver silently dispatches to `impl(Bag, Name)`

**Severity:** S2 — a program with both `impl(Bag, Tr)` and `impl(&Bag, Tr)` compiles and calls the wrong impl through a `&Bag` receiver, with no diagnostic; with only `impl(&Bag, Tr)` every call is "no method".

Found while probing decision 43's N1f-2 (`impl(&T, Trait)`, `plans/backlog/REFERENCES_AND_ORIGINS.md`)
on develop 6ca498191.

## Symptom

```yo
{ assert } :: import("std/assert");
Bag :: struct(n : i32);
derive(Bag, Copy, Clone);
Name :: trait(name : (fn(self : Self) -> i32));
impl(Bag, Name(name : (fn(self : Self) -> i32)(i32(1))));
impl(&Bag, Name(name : (fn(self : Self) -> i32)(i32(2))));
via_ref :: (fn(r : &Bag) -> i32)(r.name());
main :: (fn() -> unit)({
  b := Bag(n : i32(0));
  assert(b.name() == i32(1), "impl(Bag, Name) on an owned Bag");
  assert(via_ref(&b) == i32(2), "impl(&Bag, Name) on a &Bag");
});
export(main);
```

`yo compile` accepts it; the binary fails the second assertion (`impl(&Bag, Name) on a &Bag`, rc 134):
`r.name()` ran `impl(Bag, Name)`. Reproducer: `issues/repros/2026-11-05-impl-over-a-reference-type-registers-nothing.yo`.

## Root cause

The impl's receiver `&Bag` evaluates to a `Reference` type, but the registry key of a receiver,
`type_id_or_empty` (`src/evaluator/values/type_trait_methods.yo`), had no `Reference` arm: it
returned `""`, and registration skips a receiver with an empty id. The second impl was dropped
without a word. The coherence identity key (`_decl_identity_key_of`, `src/evaluator/values/impl.yo`)
keyed a `Reference` as its pointee, so `impl(&Bag, Tr)` would also have collided with
`impl(Bag, Tr)` as a duplicate, and `type_key` (`src/types/type_key.yo`) printed `&T` through the
generic fallback, origin included.

Method lookup had no notion of a reference receiver either: `r.name()` looks up `Bag`'s methods,
finds `impl(Bag, Name)`, and calls it with a copy of `*r`.

## Fix

Decision 43 N1f-2 (VERDICTS-25 Q2, R-PROBE), branch `vbd/d43-n1f2-impl-ref`:

- `type_id_or_empty`, `_decl_identity_key_of` and `type_key` key a reference as its mode and its
  pointee, the origin erased: `impl(Bag, Tr)`, `impl(&Bag, Tr)` and `impl(&mut Bag, Tr)` are three
  receivers; `impl(&(Bag, p), Tr)` twice is E0612, and so is a bare-variable blanket beside
  `impl(&Bag, Tr)`.
- Receiver-method lookup probes receiver slot types: the exact type, then `&`/`&mut` of it, then one
  deref; the first step with an applicable method wins. A `&Bag` receiver (a `&Bag` parameter or
  local borrow, or the explicit `(&b).name()`) reaches `impl(&Bag, Name)` at step 0; an owned `b`
  reaches `impl(Bag, Name)` at step 0.

Test: `tests/impl_ref.test.yo`, "a &Bag receiver dispatches to impl(&Bag, …), an owned Bag to
impl(Bag, …)". On develop f531eabec the reproducer fails its second assertion (rc 134); on the branch
it exits 0.
