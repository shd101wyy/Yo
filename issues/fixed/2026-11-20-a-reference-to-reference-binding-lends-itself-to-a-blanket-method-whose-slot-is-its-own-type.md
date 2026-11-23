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

## Root cause

A reference binding's receiver read is one level ERASED (the read rule, decision 43 step 2 N1e-2b: `rr : &&C` reads as its place `&C`), and R-PROBE then took `probe_base = t_slot_pointee(&receiver_type)` — erasing a SECOND level, down to `C`. `_r_probe_rank` ranks by the slot's ABSOLUTE shape, so at `ref_mode = shared` a slot `&C` is always step 0 and the blanket's slot `&&C` — `rr`'s OWN type, an exact match — is step 1, "the autoref". Resolution picked the blanket through the autoref reading, and `_lend_reference_receiver_at_double_slot` minted the P3 self-lend `&rr` (a `&&&C`) at the `&&C` slot: one indirection too many.

## Fix (2026-11-22, VERDICTS-75 §3 row (b) rider r2)

`_receiver_own_reference_type` (`src/evaluator/calls/function.yo`) recovers the receiver's own reference type (the binding's slot type, the explicit `(&x)`'s lend, a reference field's type), and `probe_base` is the POINTEE OF THAT — `&C` for `rr : &&C`, `String` for `rs : &String` (unchanged). `_r_probe_rank` ranks a base that is itself a reference RELATIVE to the receiver's own type `&base`: the exact-type slot is step 0 at every depth and outranks every autoref candidate, so the autoref step (`&&U`) can never shadow an exact-type blanket; the step itself stays (VERDICTS-75 §6 question 2: rank-fix, not delete). `_lend_reference_receiver_at_double_slot` returns before minting anything when the winning slot IS the receiver's own type — the reference is the slot's value. Test: `tests/impl-ref.test.yo` "(r2)": the reproducer, asserting `107`.
