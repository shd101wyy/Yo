# An impl whose result origin is wider than its trait's is accepted, and `Dyn` callers trust the trait

**Severity:** S1. A trait spells `pick(self : &Self, other : &Rc(X)) -> Option(&(Rc(X), self))`; an impl elides its
result (so it may return `other`) and is accepted; a caller dispatching through `Dyn(Pk)` or a `where(T <: Pk)`
bound roots the result at the receiver only, drops `other`'s root and reads freed memory. The `Dyn` form is a
regression since v0.2.76 (the seed rejects the caller with E0911); the generic form is accepted by v0.2.76 too.

Found 2026-11-11 by the ownership / borrowing / origin audit
(`plans/backlog/OWNERSHIP_BORROWING_ORIGINS_AUDIT.md` §3 A8). Confirmed on develop `64f33c710`.

## Reproducers

`issues/repros/2026-11-11-an-impl-whose-result-origin-is-wider-than-its-traits-is-accepted-and-dyn-callers-trust-the-trait.yo`
(negative, expects E0923 at the impl):

```yo
Pk :: trait(pick : (fn(self : &Self, other : &Rc(X)) -> Option(&(Rc(X), self))));
P :: struct(n : i32);
impl(P, Pk(pick : (fn(self : &Self, other : &Rc(X)) -> Option(&Rc(X)))(.Some(other))));
main :: (fn() -> unit)({
  (d : Dyn(Pk)) = dyn(P(n : i32(1)));
  mut(o) := Option(&Rc(X)).None;
  {
    b := Rc.new(X(s : String.from("0123456789abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz")));
    o = d.pick(&b);
  };
  match(o, .Some(r) => println(`OUT: ${r.*.*.s.len().to_string()}`), .None => println("none"));
  ()
});
```

```text
$ yo check repro.yo        # develop: accepted.  v0.2.76: E0911 "Cannot store a reference to `b` in `o` here"
$ yo compile repro.yo --optimize 1 --sanitize address --allocator system -o t && ./t
==…==ERROR: AddressSanitizer: heap-use-after-free
```

`…-pos.yo` (positive control): the impl spells the trait's origin and returns `&self.h`; the result survives `b`.

## The family (develop `64f33c710`)

| Shape | v0.2.76 | develop | Correct |
| --- | --- | --- | --- |
| the impl above, called through `Dyn(Pk)` | E0911 at the caller | accepted, UAF | E0923 at the impl |
| the impl above, called from `(fn(generic(T : Type), where(T <: Pk), t : &T, …))` | accepted, UAF | accepted, UAF | E0923 at the impl |
| the impl above, called directly on `P` (the caller reads the impl's own signature) | E0911 | E0911 | E0923 at the impl |
| an impl that SPELLS a wider result than the trait | E0923 | E0923 | E0923 |
| a trait default body wider than the trait's spelled result | E0923 | E0923 | E0923 |
| the parameter direction: the trait has `v : &Rc(X)` (a fresh origin), the impl narrows it to `v : &(Rc(X), p)` shared with `self` and stores `v` into `self` (VERDICTS-57's probe (c)) | accepted | accepted | E0923 at the impl |
| … called directly, `s.put(&b)` with `b` block-local | accepted, UAF | accepted, UAF (the direct call is also the method-lend hole of lane `o6-method-lend`) | E0923 at the impl |
| … called through `Dyn(Store)` or from a `where(T <: Store)` generic body | accepted | check accepts; the emitted C does not compile (two emission defects found by this audit, §3 B2 and B3), so the escape through the trait is latent behind them | E0923 at the impl |

## Root cause

`REFERENCES_AND_ORIGINS.md` O7: "a trait's clause binding every impl — the trait method's signature carries the
origin parameters; an impl may instantiate narrower (subset), never wider", and §5 route 5: "a `Dyn`/function-value
call is checked from the signature it dispatches on (traits carry origin parameters; every impl was checked against
them)". The second half is not built: an impl method is checked against ITS OWN signature (its spelled or elided
origins), and nothing compares that signature's origins with the trait's. An impl that spells a wider origin is
caught only because its own return rule fires (`src/evaluator/builtins/ptr_fns.yo`); an impl that ELIDES gets O2's
default — the union of every reference parameter — which is wider than a trait that names `self` alone, and is
accepted.

What changed since v0.2.76 is the caller: a `Dyn` call used to root its result at every reference argument (the
elided default), which over-froze and happened to cover the wider impl; it now substitutes the trait's spelled
origin, which is what the design says, and exposes the missing check.

## Expected

At the impl: E0923 naming the trait's result origin and the impl's wider one. The rule, per position: for a result
(covariant) the impl's origin must be a subset of the trait's; for a parameter (invariant, O3-3's function-type
rule) the impl's must equal the trait's after renaming — an impl may not REQUIRE a relation between two parameters'
origins that the trait leaves independent. An impl that elides is checked as if it had written the trait's
origins (the trait's signature is the contract every `Dyn` and generic caller sees).

## Test

With the fix: the pair moves to `tests/origins/unsound/`; rows in `tests/origins/impl_origin_result.test.yo`
(elided impl against a spelled trait, both directions) and a corpus row beside `impl-wider-than-trait`.
