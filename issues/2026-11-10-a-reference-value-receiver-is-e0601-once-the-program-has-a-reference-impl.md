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
