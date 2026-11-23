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

Boundary datum (CORRECTED 2026-11-22): the candidate-set shape is NOT the discriminator. A single blanket providing the only method with that name reproduces the E0601 verbatim (one `impl(generic(T), where(T <: Wh), &T, Wh(wh : fn(self : &Self)))`, no other `wh` in the program, `rr.wh()` on `rr : &&C`); the earlier "passes with one blanket" observation was a different spelling (`r.show()` on `r : &C` — a SINGLE-level reference, where the slot `&C` is rank 0 and the reference fills it directly). What discriminates is the DEPTH of the receiver's own type: the bug fires exactly when the winning slot equals a receiver whose own reference type has two or more levels.

## Root cause

A reference binding's receiver read is one level erased (the read rule, decision 43 step 2 N1e-2b: `rr : &&String` reads as its place `&String`), and R-PROBE then took `probe_base = t_slot_pointee(&receiver_type)` — a SECOND erasure, down to `String`, as if the receiver were a plain `&String`. The blanket's slot `&&String` therefore looked like the autoref step ("lend the binding's own storage", P3), and `_lend_reference_receiver_at_double_slot` minted `&rr` (a `&&&String`) at the `&&String` slot — one indirection too many. The argument check (the conservative check in `_evaluate_funcval_runtime_call`) then correctly rejected the `&&&String` against the slot's pointee `&String`, and the def-time trial of the enclosing body swallowed the same error, so the notes poisoned the real evaluation too.

## Fix (2026-11-22, VERDICTS-75 §3 row (b) riders r2/r3)

`_receiver_own_reference_type` (`src/evaluator/calls/function.yo`) recovers the receiver's own reference type, `probe_base` becomes its pointee (`&String` for `rr : &&String`), `_r_probe_rank` ranks a reference base RELATIVE to the receiver's own type (the exact-type slot `&&String` is step 0 and outranks every autoref candidate), and `_lend_reference_receiver_at_double_slot` mints nothing when the winning slot IS the receiver's own type — "a receiver that is itself a reference value needs no borrow — the reference is the slot's value" (VERDICTS-75 row (b)). The call then lends the place `*rr`, whose address is the reference itself. Tests: `tests/impl-ref.test.yo` "(r3)": `hash_one(&ra) == hash_one(&a)` and `rr.to_string()` on `rr : &&String` rendering the referent.

Same family as `issues/2026-11-11-a-bound-method-on-a-by-value-reference-parameter-is-rejected.md` (that one is by-value binders `v : T`, still open).
