# `derive(Hash)` on a type with an `Rc` field is E0616

**Severity:** S2: a valid program is rejected. `derive(Hash)` fails on every struct or enum that holds an `Rc` (or a `Box`) field whose payload is `Hash`, so such a type cannot be a `HashMap` key or a `hash_one` argument without a hand-written impl.

**Status:** fixed 2026-10-12 on `feat/vbd-v1-step2-box` (V1 step 2, the unique `Box`). Found while adding `derive(Clone, Eq, Hash)` tests for a struct holding a `Box`, and reproduced through `Rc` with the tree compiler before the fix.

## Symptom

```text
error[E0616]: derive on "H" failed: "hash" is a method of Rc(i32) and of its payload i32, so (self.r).hash(...) could mean either (plans/VALUES_BY_DEFAULT.md decision 32).
Write Rc.hash((self.r), ...) for the Rc's own hash, or (self.r).*.hash(...) for the payload's.
  --> auto-generated://
{
    self.r.hash(hasher);
    self.k.hash(hasher);
  }
```

## Reproducer

```yo
{ hash_one } :: import("std/hash");
H :: struct(r : Rc(i32), k : i32);
derive(H, Hash);
main :: (fn() -> unit)({
  x := H(r : rc(i32(1)), k : i32(2));
  hash_one(&mut x);
});
export(main);
```

## Root cause

`__derive_hash` (`std/prelude.yo`) wrote every field's hash as
`self.f.hash(hasher)`. On a `Deref` wrapper field whose payload is `Hash` too,
that is decision 32's wrapper/payload clash. `__derive_clone` already
names the wrapper's impl for this case (`(type_of(self.f) <: Clone).clone(...)`),
but `__derive_hash` never got the same treatment.

## Fix

`__derive_hash` now spells a `Deref` field (in a struct and in an enum variant) as
`(type_of(self.f) <: Hash).hash(&mut self.f, hasher)`.

There was a companion inconsistency in `__derive_clone`, which lent
`&mut self.f` to the wrapper's `Clone`. That only worked because `Rc`'s
`Clone` impl took the trait's `&mut Self`. `Box`'s `Clone` takes `&Self`, as
Rust's does. With `&mut Self`, a hand-written `Clone` on `&Self` could not
clone its `Box` fields (E0908 on a `match` binding). So `Rc`'s `Clone` now
takes `&Self` as well, and both derive templates lend `&self.f`.

## Tests

- `tests/deref_auto.test.yo`: "auto-deref: derive(Hash) hashes an Rc field as its payload". It covers a struct and an enum, and checks that the hash equals that of the same struct holding the plain payload.
- `tests/rc.test.yo`: "unique Box: derive(Clone) and derive(Eq) go through a Box field". It runs `derive(Clone, Eq, Hash)` on a struct with a `Box` field, and `derive(Clone)` on an enum with one.
