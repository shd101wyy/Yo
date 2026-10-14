# A Drop impl beside a Dispose impl is accepted, and one destructor never runs

**Severity:** S2 — a user `Drop` impl on a type whose destructor already comes from a `Dispose` impl (std's `ArrayList(T)`) silently replaces it, so the elements and the buffer leak; one struct with both impls runs only the `Drop` body.

**Status:** Fixed (v0.2.63). Found by the v0.2.62 adversarial review; new with decision 45 Generation A (#1343).

## Symptom

```yo
{ ArrayList } :: import("std/collections/array_list");
(g : i32) = i32(0);
El :: ref(struct(n : i32));
impl(El, Drop(drop : (fn(self : &mut Self) -> unit)({ g = (g + i32(1)); })));
impl(ArrayList(El), Drop(drop : (fn(self : &mut Self) -> unit)(println("user Drop on ArrayList(El)"))));
main :: (fn() -> unit)({
  {
    xs := ArrayList(El).new();
    xs.push(El(n : i32(1)));
    xs.push(El(n : i32(2)));
  };
  println(`elements dropped=${g}`);   // printed 0, want 2
});
export(main);
```

The same impl spelled `Dispose` was rejected with E0612 ("Trait "Dispose" is
already implemented for type "ArrayList(El)" by the generic impl at
std/collections/array_list.yo:1028"). One struct with `impl(Fd, Drop(...))` and
`impl(Fd, Dispose(...))` was accepted and ran only `Drop.drop`.

## Root cause

Generation A defines `Drop` and `Dispose` as two prelude traits, and
coherence (E0612, `src/evaluator/values/impl.yo`) compares trait identity, so a
type could carry one impl of each. `_destructor_method_name`
(`src/codegen/functions/collection.yo`) returns `"drop"` as soon as it finds a
`Drop`-sourced method, and the synthesized `___dispose` calls only it.

## Fix

Coherence treats the two spellings as one destructor slot (decision 45: "the
compiler treats a trait with id "Drop" exactly as "Dispose""):

- at a concrete impl, the other spelling's concrete impl on the same type
  (`trait_impl_site_of`), and a generic impl of the other spelling that covers
  the receiver (its generic-impl bucket), are E0612;
- at a generic impl, an impl of the other spelling over the same receiver
  pattern, and a concrete impl of it that the new impl covers, are E0612.

The message names both spellings: `Trait "Drop" is already implemented for
type "ArrayList(_MoDropFd)" under its other spelling, "Dispose", by the generic
impl at …, which covers it`. `_trait_instances_agree` is bypassed for the pair:
the methods' labels differ and neither trait has parameters.

## Test

`tests/move_only.test.yo`, "Drop: a type has one destructor, under either
spelling": a `Dispose` impl on a `Drop` type, a `Drop` impl on a `Dispose` type,
a `Drop` impl on `ArrayList(_MoDropFd)`, a generic `Dispose` impl over a type
with a concrete `Drop` instance impl and over one with a generic `Drop` impl —
each E0612 — and std's `ArrayList` destructor still drops each element. Before
the fix every impl is accepted.
