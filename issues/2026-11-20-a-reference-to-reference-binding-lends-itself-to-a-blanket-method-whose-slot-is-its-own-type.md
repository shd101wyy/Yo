# A `&&C` binding lends itself to a blanket method whose slot is its own type

**Severity:** S2 — `rr.wh()` on a binding `rr : &&C` is rejected with E0601 when a blanket
`impl(generic(T), where(T <: Wh), &T, Wh(wh : (fn(self : &Self) -> …)))` provides `wh`. The blanket at `T := C` has
the slot `&&C`, which is `rr`'s own type, so `rr` is the argument (VERDICTS-69 Q1 step 1), but the call lends `&rr`.

Found 2026-11-20 by Fable's VERDICTS-69 probe `h3.yo`. Confirmed by the ToString lane on develop `d8f0d89fa`, where the
earlier line `rr.*.wh()` hides it, and on `v0279/blanket-tostring`, where that line now resolves.

## Reproducer

Expected: `107`.

```yo
{ println } :: import("std/fmt");
Wh :: trait(wh : (fn(self : &Self) -> usize));
C :: struct(v : usize);
impl(C, Wh(wh : (fn(self : &Self) -> usize)(self.v)));
impl(generic(T : Type), where(T <: Wh), &T, Wh(wh : (fn(self : &Self) -> usize)(T.wh(self.*) + usize(100))));
main :: (fn() -> unit)({
  c := C(v : usize(7));
  r := &c;
  rr := &r;
  println(rr.wh());
});
export(main);
```

```
error[E0601]: `&rr` lends the reference `rr` itself (a `&&&C`), and parameter "self" takes `&&C`: nothing coerces a
reference to a reference into a reference to its referent.
```

## Root cause (not yet traced)

For a reference binding, R-PROBE ranks the candidates against the binding's pointee (`probe_base`), so the blanket at
`&&C` is taken as an autoref of `r`'s storage and the lend wraps `rr` once more. When the slot equals the receiver's
own type (step 1), the binding's value is the argument and nothing is lent.

## Test that will pin it

`tests/impl_ref.test.yo`: the reproducer, asserting `107`.
