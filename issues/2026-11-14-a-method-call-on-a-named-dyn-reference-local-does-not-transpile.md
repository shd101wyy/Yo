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

## Root cause (to this precision)

After the R-TEMP deletion a `(d : &Dyn(T)) = dyn(&c)` binding is accepted
(binding + dispatch through the local was VERDICTS-43's named-local
acceptance), but a METHOD CALL whose receiver is the `&Dyn`-typed REFERENCE
BINDING leaves the call node without ExprInfo — the evaluator's method-call
path for a `Reference(DynT)` receiver does not record the dispatch the way a
`&Dyn` PARAMETER receiver does (`_speak_via(d)` with `d : &Dyn(Speak)`
works: probe p6's `_speak_via` rows pass; only the local-receiver
`d.speak()` marks). The call therefore emits `// Failed to transpile
(d.speak)()`.

Note the ARGUMENT form works: passing the local to a `&Dyn` parameter
dispatches fine — so the fix is in the dot-dispatch evaluation for a
reference-binding receiver of an unsized pointee, likely where the receiver's
`.*`-through is built (the `d` binding is a `&Dyn` local borrow of `c`; the
dispatch must read through it to the fat pair).

## Test

`tests/dyn_pointer_kinds.test.yo`'s "a dyn(&v) bound to a local" row (part of
the flipped rows 1-5) and `tmp/p/p6.yo`.
