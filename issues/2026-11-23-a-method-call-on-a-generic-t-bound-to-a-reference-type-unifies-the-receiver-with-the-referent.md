# A method call on a generic `T` bound to a reference type unifies the receiver with the referent

**Severity:** S2 — a valid program is rejected with E0601: a generic body calls a trait method on `t : T` where `T := &C` and the impl is `impl(&C, Trait)`, and the checker unifies `C` with `&C`.

Filed 2026-11-23 by the test 7 lane while respelling the audit corpus's drifted negatives
(`scripts/test7/respell-manifest.tsv`, plan `plans/handover/VBD_V0279_RETIREMENTS_AND_CLAIM.md` §3.6). Probe: `probes/generics/i02-impl-ref-generic.yo`
in `scripts/test7/audit-corpus.tar.gz`. Reproduced with a stage 1 of develop `f06ff5889`.

## Reproducer

```yo
{ String } :: import("std/string");
{ println } :: import("std/fmt");
X :: struct(s : String);
C :: struct(v : Rc(X));
View :: trait(view : (fn(self : Self) -> Option(&Rc(X))));
impl(&C, View(view : (fn(self : Self) -> Option(&Rc(X)))(.Some(&self.v))));
see :: (fn(generic(T : Type), t : T, where(T <: View)) -> Option(&Rc(X)))(t.view());
main :: (fn() -> unit)({
  c := C(v : Rc.new(X(s : String.from("abc"))));
  rc := &c;
  o := see(rc);
  match(o, .Some(r) => println(`OUT: ${r.*.*.s.len().to_string()}`), .None => println("none"));
});
export(main);
```

```text
error[E0601]: Cannot unify incompatible types: "C" and "&C"
 7 | see :: (fn(generic(T : Type), t : T, where(T <: View)) -> Option(&Rc(X)))(t.view());
```

The qualified call `View.view(t)` is accepted. Respelled probe: `scripts/test7/respelled/probes/generics/i02-impl-ref-generic.yo`.

## Root cause

Not traced to a line. Method-call receiver resolution on `t : T` auto-dereferences a reference receiver before
looking up the impl (`&C` → `C`), so the `impl(&C, View)` candidate's `self : Self` (`&C`) is unified against `C`.

## Fix

At `T := &C`, try the receiver at its own type before the dereferenced one when the impl is over the reference type.

Status 2026-11-23 (branch `fix/receiver-riders`, VERDICTS-75 rider r2): R-PROBE now ranks a slot equal to the receiver's own reference type first. The E0601 is gone and `t.view()` type-checks. The program still does not compile: the C for this generic path is wrong for both spellings. See `issues/2026-11-23-a-generic-body-at-t-ref-c-calling-an-impl-over-ref-c-method-emits-mismatched-c-pointer-types.md`. This document closes when that one does.
