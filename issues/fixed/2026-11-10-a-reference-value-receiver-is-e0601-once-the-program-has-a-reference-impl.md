# A reference-value receiver `rr.*.m()` is E0601 once the program has any reference impl

**Severity:** S2. A valid program is rejected (the origins corpus row `ref-of-ref-method`, `rr.*.len()` with
`rr : &&String`), and it starts failing in every program that imports a std module carrying an
`impl(&C, …)` (G2 puts `IntoIterator` for `&ArrayList` and friends there).

Found 2026-11-10 while gating G2 piece 2 (`vbd/g2-into-iter`). Present on develop (a develop-built binary fails it as
soon as a user program declares one `impl(&Bar, Tr)`); latent because std had no reference impl.

## Reproducer

```yo
Foo :: struct(a : i32);
impl(Foo, len : (fn(self : &Self) -> i32)(self.a));
Bar :: struct(a : i32);
Tr :: trait(m : (fn(self : Self) -> i32));
impl(&Bar, Tr(m : (fn(self : Self) -> i32)(i32(1))));
main :: (fn() -> unit)({
  s := Foo(a : i32(1));
  r := &s;
  rr := &r;
  _ := rr.*.len();
  ()
});
export(main);
```

```
error[E0601]: Cannot unify incompatible types: "Foo" and "&Foo"
```

Without the `impl(&Bar, …)` it checks.

## Root cause

`_find_receiver_method_of` runs R-PROBE only once `reference_impls_seen()`. The probe gathers the hits of the pointee
`Foo` for a receiver typed `&Foo`; without it the lookup on `&Foo` is empty and the deref retry rewrites the call to
`rr.*.*.len()`. With the probe the hit is taken for the value `rr.*` itself, so the callee's `Self` is bound to the
receiver's type `&Foo`, not `Foo`.

## Fix

For a receiver that is a reference value (not an identifier, not an explicit `(&x)`), the probe keeps only the
candidates whose impl receiver is itself a reference; a method of `C` is reached by the deref step as before.
Test: `tests/impl_ref.test.yo` (ix).

## Fixed by #1876 (triaged 2026-11-11)

#1876 (R-FOR / G2 `impl(&C, IntoIterator)`, merged `a4c34e1a1`) reworked R-PROBE's receiver walk for reference impls; the
commit list shows no later change to this path apart from the R-PROBE gates #1882 and #1884, which only narrow when the lookups run. Two checks show the bug is gone:

- The reproducer above checks clean. `yo check` rc 0 with a binary built from develop `26a422d55`, which includes #1876
  and the R-PROBE gates #1882 and #1884.
- The origins corpus row `ref-of-ref-method` (`tests/origins/corpus.tsv`, run by `tests/origins/model_corpus.test.yo`
  and `scripts/origins-corpus.sh today`) is `accept` in the today column, and every develop battery since #1876 has
  passed it.
- `tests/impl_ref.test.yo` case (ix) runs the same shape as a language test.

The doc stayed in `issues/` by oversight. It moved to `fixed/` when the v0.2.77 release notes were drafted.
