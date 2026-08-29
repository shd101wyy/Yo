# A `->` fn literal passed to `Impl(Fn(..) -> R)` does not bind `R`; a `=>` closure does

**Status: FIXED** (2026-08-29, `src/evaluator/values/anonymous_function.yo`).
The bare-SomeT return binding (`nrs_ret_bare`) was gated on "is a `=>`
closure" to keep ctl effect handlers' per-call-site `ResumeType` unbound; it
now excludes only ctl-typed literals (`ctl_force`), so a plain `->` fn literal
binds `R` like a closure. The re-registration in that branch also rebuilds the
func meta with the literal's SOURCE param labels (like L3/L4) — with the
expected type's labels the emitted C declared `a` while the body used `x`.
Regression test: `tests/closure.test.yo` "a -> fn literal binds the result type
variable of Option.map and of an Impl(Fn) method". Found 2026-08-29 while isolating C27. **Severity:** MEDIUM —
a confusing type error on idiomatic code; the `=>` spelling works, so no std
API is blocked.

## Symptom

```rust
o := Option(i64).Some(i64(2));
s := o.map((x) -> `v=${x}`).unwrap();   // Error: No matching call found: (s.to_string)()
t := o.map((x) => `v=${x}`).unwrap();   // fine — t : String
```

`issues/repros/arrow-fn-literal-result-type-not-inferred.yo`. The same holds
for a user method `(generic(R : Type), self : Self, body : Impl(Fn(inout(v) : T) -> R)) -> R`
and for the where-clause spelling `where(F <: (Fn(..) -> R))`: with a `->`
literal the call's result stays an unresolved `R` (it unifies with anything —
`(probe : bool) = s` type-checks), so the first method call on it fails.

## Why it matters

`->` literals are what a capture-free function argument is normally written
as (and the compiler itself REQUIRES `->` for effect handlers), so the
inference asymmetry is a trap: the value flows fine at runtime (the literal
is called through the same closure protocol), only the call-site TYPE of `R`
is missing. Tests in this repo now use `=>` wherever a result type variable
must be inferred (`tests/impl_method_closure_param_future_return.test.yo`,
`tests/async/mutex.test.yo`).

## Root cause (confirmed)

Closure-argument synthesis against an `Impl(Fn(...) -> R)` wrapper binds the
Fn trait's return from the CLOSURE's inferred body type; the regular-fn
literal path types the literal as a bare `Func` whose result is checked
against, but never propagated into, the wrapper's carrier `R`
(`src/evaluator/values/anonymous_function.yo`, the `rp_ty`/expected-type
substitution around line 1100 and the where-check binding arc near 1960).
