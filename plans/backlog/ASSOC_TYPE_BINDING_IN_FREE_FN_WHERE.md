# `where(T <: Trait(Assoc := A))` binds nothing when `A` is a generic

**Status:** BACKLOG — measured 2026-09-11 while implementing
`plans/reference/ASYNC_ITERATION_STREAM.md`. Not specific to `Stream`:
`Iterator` behaves identically, so this is a property of associated-type
bounds in general and has been latent for as long as they have existed.

## The gap

Inside an `impl(...)` a bound may name the associated type and bind it to one
of the impl's own generics — the prelude does it in a dozen places:

```rust
impl(
  generic(I : Type, A : Type),
  where(I <: DoubleEndedIterator(Item := A)),
  IterRev(I),
  Iterator(Item : A, next : … )
);
```

The same spelling on a **free function** rejects every argument:

```rust
// error[E0602]: Type ArrayListIter(i32) does not implement required trait Iterator.
count :: (fn(generic(I : Type, A : Type), it : I, where(I <: Iterator(Item := A))) -> usize)( … );
count(list.into_iter());
```

Measured, with `Stream` and with `Iterator`, same result:

| free-function bound | a SOURCE argument | a COMBINATOR argument |
| --- | --- | --- |
| `where(S <: Stream)` (bare) | ✓ | ✓ |
| `where(S <: Stream(Item := i32))` (concrete) | ✓ | ✓ |
| `where(S <: Stream(Item := A))`, `generic(A : Type)` | ✗ E0602 | ✗ E0602 |

A related failure, same root: a blanket-impl METHOD cannot be called on a
generic parameter even when the bound is concrete —

```rust
// error: No matching call found with arguments: (s.collect)(io)
drain :: (fn(generic(S : Type), s : S, io : Io, where(S <: Stream(Item := i32))) -> ArrayList(i32))(
  … s.collect(io) …
);
```

The trait's OWN methods (`s.next(io)`) work on such a parameter; only the
blanket-impl combinators fail, because their own
`where(Self <: Stream(Item := A))` has no concrete impl to read `Item` off.

## Why it matters

It decides how a consumer generic over a sequence must be WRITTEN, and the
compiler does not say so:

- A free function that must accept both sources and chains uses a bare bound,
  or spells the item type concretely.
- A consumer that must be generic over the item type has to be a
  blanket-impl method (`impl(generic(S : Type), where(S <: Stream), S, …)`),
  which is how `collect` / `for_each` / `map` in `std/async/stream.yo` and
  every `Iterator` combinator in `std/prelude.yo` are written. That is not a
  coincidence — it is the only shape that works.
- A test helper hits it immediately: `tests/async/combinators.test.yo`'s
  `_bounded` takes the collect FUTURE rather than the stream for exactly this
  reason, and its comment says so.

Nothing in std is blocked by it today, which is why this is backlog and not a
bug report against the stream work.

## Options

1. **Resolve the associated type at bound-check time (RECOMMENDED).** When a
   bound is `T <: Trait(Assoc := A)` and `A` is an unbound generic of the same
   signature, look up `T`'s impl of `Trait`, read the `Assoc` field, and BIND
   `A` to it — the same lookup that already succeeds inside an impl. The
   impl-level path is the reference implementation; the free-function path
   evidently tests the constraint before (or instead of) binding.
2. **Make the second failure follow from the first.** Once `A` binds from a
   concrete impl, a blanket method called on a generic parameter can resolve
   its own `Item := A` the same way, which removes the `s.collect(io)`
   restriction too. Worth checking whether one fix covers both before
   treating them separately.
3. **Diagnose instead of fixing.** E0602 currently reads "Type X does not
   implement required trait Y" about a type that plainly does. Even without
   the inference, saying "the associated-type binding `Item := A` cannot be
   inferred here; use a bare bound or name the type" would save the hour this
   cost.

Recommendation: (3) immediately — it is a message change — and (1)+(2) as one
piece of work in `src/evaluator/` where where-clause constraints are applied
before argument binding (`yo-design.instructions.md`, "Implementation
details" under trait method disambiguation).

## Cross-references

- `plans/reference/ASYNC_ITERATION_STREAM.md` — the closing record naming
  this as one of the two shape constraints found while landing it.
- `tests/async/combinators.test.yo` — `_bounded` / `_count_items` /
  `_sum_i32` are the three working spellings, with the reasons in comments.
