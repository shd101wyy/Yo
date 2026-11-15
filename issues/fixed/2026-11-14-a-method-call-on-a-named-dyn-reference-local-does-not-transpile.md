# A method call on a named `&Dyn` local does not transpile (the dyn(&v) rows' dispatch)

**Severity:** S1 (blocks the d49 flip's flipped `dyn_pointer_kinds` rows: "a dyn(&v) bound to a local" runs `d.speak()` on `(d : &Dyn(Speak)) = dyn(&c)`; VERDICTS-43 S2 step 3 names this dispatch as part of the R-TEMP deletion)

**Date:** 2026-11-14

## Verbatim error

```text
error[E1301]: internal compiler error: Failed to transpile part of main's body — the emitted C for "__yo_user_main" contains an untranspiled expression
[fttmark] loc=tmp/p/p6.yo:61:10 expr=(d.speak)()
```

## Reproducer (`tmp/p/p6.yo:58-62`; minimized)

```yo
Speak :: trait(speak : (fn(self : &Self) -> i32));
Cat :: struct(n : i32);
impl(Cat, Speak(speak : ((self : &Self) -> self.n)));
main :: (fn() -> unit)({
  c := Cat(n : i32(6));
  (d : &Dyn(Speak)) = dyn(&c);
  d.speak(); // no ExprInfo on the call: marker
});
export(main);
```

## Root cause (found 2026-11-14 16:50; the evaluator was NOT at fault)

Codegen keys dyn dispatch on the receiver's RECORDED type: a `&Dyn`
PARAMETER records the pointee (`DynT`), while a named `(d : &Dyn(T)) =
dyn(&c)` LOCAL records the reference binding (`Reference(DynT)`). The
guards — `other_fn_call.yo`'s `dot_recv_is_dyn` (feeding `dm_has_slot` /
`dm_is_dyn_clone`) and `property_access.yo`'s two `is_dyn_type(&object_type)`
checks (the method-access guard at ~374 and the value-shape arm at ~518) —
all spelled `is_dyn_type(...)`, so a reference-binding receiver missed every
one and the call emitted `// Failed to transpile (d.speak)()`. The call node
HAS ExprInfo; only the dispatch branch failed to recognize the receiver.

## Fix (commit c31c88098)

New `dyn_dispatch_receiver_type` helper (`src/types/utils.yo`, beside
`dyn_type_has_vtable_slot`): the Dyn behind a dispatchable receiver shape —
the Dyn place itself or ONE `Reference` level over it. Deliberately does not
unwrap `Box(Dyn)`/the interim cell: a box receiver's own methods (`clone`)
are the box's, not the payload's (the registration-shaped WIDE unwrap lives
in the codegen collector, `collection.yo`'s `dyn_arm_ty`). Used at all three
guards.

Note the ARGUMENT form works: passing the local to a `&Dyn` parameter
dispatches fine — so the fix is in the dot-dispatch evaluation for a
reference-binding receiver of an unsized pointee, likely where the receiver's
`.*`-through is built (the `d` binding is a `&Dyn` local borrow of `c`; the
dispatch must read through it to the fat pair).

## Test

`tests/dyn_pointer_kinds.test.yo`'s "a dyn(&v) bound to a local" row (part of
the flipped rows 1-5) and `tmp/p/p6.yo`.
