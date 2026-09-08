# The blanket `into_iter` is a bare METHOD, so `where(T <: IntoIterator)` rejects every iterator

**Status:** OPEN
**Found:** 2026-09-08, giving `HashMap.extend` its bound.

## Symptom

```rust
extend : (
  fn(
    generic(I : Type),
    self : Self,
    iterable : I,
    where(I <: IntoIterator(Item := MapEntry(K, V)))
  ) -> unit
)({ ... })
...
a.extend(b);                 // b : HashMap  — OK
a.extend(c.into_iter());     // c.into_iter() : HashMapIter — REJECTED
```

```
error[E0602]: Type <struct:struct_yo_id_5443> does not implement required trait IntoIterator.
   --> where(I <: IntoIterator(Item := MapEntry(K, V)))
```

## Root cause

`std/prelude.yo:10332` adds `into_iter` to every `Iterator` as a bare inherent
method:

```rust
impl(
  generic(I : Type),
  where(I <: Iterator),
  I,
  into_iter : (fn(self : Self) -> Self)(self)
);
```

That is enough for the `for` macro, which simply CALLS `.into_iter()` and never
asks about a trait. It is not enough for a `where` bound, which asks whether the
type implements `IntoIterator` — and no such impl is registered.

## The docs claim otherwise, twice

- `std/prelude.yo:10326` — *"Blanket `into_iter` — every `Iterator` is its own
  `IntoIterator`"*
- `std/prelude.yo:8742` — *"a blanket `into_iter` impl on `Iterator` (below)
  makes every iterator its own `IntoIterator`"*

Both are true of the `for` macro and false of the type system, which is exactly
the sort of claim that costs a debugging session. Whatever is done about the
impl, these two comments need to say "method, for the `for` macro" rather than
"its own `IntoIterator`".

## Fix

Register a real blanket trait impl:

```rust
impl(
  generic(I : Type),
  where(I <: Iterator),
  I,
  IntoIterator(
    Item : ???,        // I's own Iterator.Item — an associated-type projection
    IntoIter : Self,
    into_iter : (fn(self : Self) -> Self)(self)
  )
);
```

The open question is whether `Item` can be projected from `Self <: Iterator`
inside a blanket impl. If it cannot, that is a language gap worth its own
entry, and the interim answer is to correct the two doc comments so nobody else
plans around a bound that does not hold.

## Consequence today

Every `where(T <: IntoIterator)` bound in the std is a COLLECTION bound, not a
"sequence" bound. `HashMap.extend` documents this explicitly and tells the
caller to `collect` a chain first.
