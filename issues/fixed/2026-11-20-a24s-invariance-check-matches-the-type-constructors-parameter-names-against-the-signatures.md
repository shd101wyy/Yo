# A24's invariance check matches the type constructor's parameter names against the signature's

**Severity:** S1 — use-after-free in safe code: A24's fix (#1939) rejects `put(Slot(x)(dst : &mut slot), &y)` only
while the function's origin parameter and the type constructor's carry the same name. Rename either one
(`generic(r : Origin), s : Slot(r)`, or `Slot :: (fn(comptime(z) : Origin) ...)`) and the call is accepted: `put`
stores `&y` into the outer `slot`, and the read after `y`'s block is an ASan heap-use-after-free.

- Filed: 2026-11-20 by the v0.2.80 s1-origins lane, while fixing
  `issues/fixed/2026-11-19-an-invariant-origin-is-widened-through-a-returned-holder-or-a-generic-wrapper.md` (the
  return check's first cut had the same blind spot).
- Reproduces on `v0280/clusters` `33c855dfa` (and the test 7 binary `76f6aaf03`): both renamed forms are accepted and
  ASan-dirty, while A24's own row `tests/origins/unsound/a24-by-value-holder-mut-pointee.yo` stays E0923.
- **Status: FIXED** on `v0280/s1-origins`.

## Reproducer

`tests/origins/unsound/a24-by-value-holder-renamed-fn-origin.yo` (the function's origin parameter renamed):

```yo
{ String } :: import("std/string");
{ println } :: import("std/fmt");
X :: struct(s : String);
Slot :: (fn(comptime(p) : Origin) -> comptime(Type))(struct(dst : &mut Option(&(Rc(X), p))));
put :: (fn(generic(r : Origin), s : Slot(r), v : &(Rc(X), r)) -> unit)({
  s.dst.* = .Some(v);
});
main :: (fn() -> unit)({
  x := Rc.new(X(s : String.from("x")));
  mut(slot) := Option(&(Rc(X), x)).Some(&x);
  {
    y := Rc.new(X(s : String.from("0123456789abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz")));
    put(Slot(x)(dst : &mut slot), &y);
  };
  match(slot, .Some(r) => println(`OUT: ${r.*.*.s.len().to_string()}`), .None => println("none"));
  ()
});
export(main);
```

`tests/origins/unsound/a24-by-value-holder-renamed-ctor-origin.yo` is the same program with `Slot`'s parameter
renamed to `z` and the function's left as `p`.

## Root cause

An instance's field types keep the type constructor's OWN parameter names: `Slot(x)`'s field reads `dst : &mut
Option(&(Rc(X), p))` with `Slot`'s `p`, not `x`; only the instance's `type_arguments` carry `x`. A24's step-1 form in
`lend_through` (`src/evaluator/calls/function.yo`) collected the origin names below a `&mut` from the slot's FIELDS
(`_mut_pointee_origin_names`) and then looked for the SIGNATURE's names (paired from the type arguments) among them.
A24's row spells `p` on both sides, so the lists met; any other spelling made the invariant set name something the
signature never mentions, nothing was fixed, and `&y` widened `r` as a covariant position would.

## Fix

A type constructor's argument takes its variance from its fields by the constructor's own parameter names (O3 step
3: "a type constructor's origin parameter takes its variance from its fields"). `_ctor_arg_is_invariant`
(`src/evaluator/utils.yo`) reads the type function from the instance (a struct's `constructor_func_id`, an enum's
`lookup_enum_cfid`, through `lookup_type_ctor_value`), takes its parameter at that position, and searches the fields
for it below a `&mut` pointee, recursively through a nested constructor's invariant arguments.
`invariant_origin_names(ty)` lists the origins a type spells at its invariant positions (constructor arguments
included); step 1's nested form uses it, and `_mut_pointee_origin_names` is gone. The return check's invariance pairs
(`_invariant_origin_pairs`) use the same per-argument variance.

Rows (`tests/origins/unsound/`, beside A24's): `a24-by-value-holder-renamed-fn-origin` and
`a24-by-value-holder-renamed-ctor-origin`, E0923, both accepted and ASan-dirty before; positive twins
`a24-by-value-holder-renamed-fn-origin-pos` and `a24-by-value-holder-renamed-ctor-origin-pos`, clean under ASan.
