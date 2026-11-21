# A receiver that is a reference of exactly the method's own slot type is lent once too often (E0601)

**Severity:** S2: valid programs are rejected — `println(&r)` on a reference, `hash_one(&r)`, and `where(T <: Hash)` / `where(T <: ToString)` bodies instantiated at `T := &U` fail to type-check; nothing miscompiles.

Found 2026-11-21 while gating the blanket `Hash(&T)` / `ToString(&T)` riders (branch `v0280/ref-blankets`): the riders' natural test rows could not be written. Pre-existing: the same diagnostic is produced by the v0.2.79 seed (develop's evaluator) through `std/fmt`'s `println` with no blanket anywhere in std, so it does not come from the riders — they only add more paths into it.

## Reproducers

On develop's std (verified with the v0.2.79 seed; no reference blankets exist there):

```yo ignore
{ println } :: import("std/fmt");
{ String } :: import("std/string");
// println :: (fn(generic(T : ?Sized), v : &T, where(T <: ToString)) -> unit)(...)
s := String.from("abc");
rs := &s;
println(&rs);   // v : &&String at T := &String: the body's call is rejected
// error[E0601]: `&v` lends the reference `v` itself (a `&&&String`), and
// parameter "self" takes `&&String`: nothing coerces a reference to a reference
// into a reference to its referent.
```

With the `Hash(&T)` blanket (branch `v0280/ref-blankets`), std's own hasher helper hits it verbatim:

```yo ignore
{ String } :: import("std/string");
{ hash_one } :: import("std/hash");
// hash_one :: (fn(generic(T : ?Sized), value : &T, where(T <: Hash)) -> u64)({ ...; value.hash(&mut h); ... })
a := String.from("key");
ra := &a;
hash_one(&ra);   // E0601 raised inside std/hash.yo, at value.hash(&mut h)
```

Also concrete, with no generic function at all once an impl over `&U` with a `self : &Self` method exists (the blankets are exactly that): `rr := &rs; rr.to_string();` with `rs : &String` is the same E0601.

Boundary datum: a single hand-written blanket over `&T` whose trait is declared locally does NOT trigger it — `(fn(generic(T : Type), r : &T, where(T <: Show)) -> String)(r.show())` at `T := &String` passes on both the seed and the blanket branch. The failing calls all have the method name resolvable through more than one impl family (std's `ToString` over every primitive beside the bound's own trait method; two blankets supplying the same name). The candidate-set shape, not the spelling, looks like the discriminator.

## Root cause (not yet traced)

VERDICTS-69 step 1 says a receiver whose evaluated type is `&U` probes slot `&U` first and "the reference itself is the argument". That is implemented when the winning candidate comes from an impl over the referent (`impl(U)`'s `self : &Self` methods: `rs.to_string()` on `rs : &String` works). In the failing calls the receiver — already a reference of exactly the slot the resolved method wants (`&&String`) — is instead lent once more (`&receiver`), one indirection too many. The diagnostic's own help line states the correct call ("pass `v` itself"), so the error path knows the slot; only the binding of the receiver misses it.

Same family as `issues/2026-11-11-a-bound-method-on-a-by-value-reference-parameter-is-rejected.md` (that one is by-value binders `v : T`; this one is reference binders at `T := &U`, std `?Sized` helpers, and concrete `&&U` receivers).

## Fix

Treat a receiver whose evaluated type is identical to the winning method's first-parameter slot as the argument itself (no auto-lend), whichever impl or bound the method was resolved through. Tests: the three shapes above; with the std blankets landed, `hash_one(&ra) == hash_one(&a)` and `println(&rs)` printing the referent are the user-visible rows.
