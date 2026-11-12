# A call result in an origin-erased specialization borrows the receiver

**Severity:** S2 — valid std code is rejected: `rr_cursor(&xs).map(f).filter(p).count()` over an iterator whose `Item` is a reference fails with E0911 inside `std/prelude.yo` (`IterMap.next`), so every `tests/ref_of_ref.test.yo` test fails to compile on every OS (develop red since #1913).

- Filed: 2026-11-12 (fixdev lane; develop battery 43142204182 on `4f93d3507`). Design consult: Fable, 2026-11-12 (the definition-signature rule below).
- Regression since #1913 (a fn-value call `(self._f)(&item)` now lends `&mut self._f`); the hole itself is older: v0.2.76 rejects the minimal shape below.

## Reproducer

```yo ignore
GWrap :: (fn(comptime(I) : Type) -> comptime(Type))(struct(_inner : I, n : i32));
impl(
  generic(I : Type, A : Type),
  where(I <: Iterator(Item := A)),
  GWrap(I),
  step : (fn(self : &mut Self) -> Option(A))(
    match(
      self._inner.next(),
      .Some(item) => {
        self.n = (self.n + i32(1));
        .Some(item)
      },
      .None => .None
    )
  )
);
drive :: (fn(generic(I : Type, A : Type), it : I, where(I <: Iterator(Item := A))) -> i32)({
  mut(g) := GWrap(I)(_inner : it, n : i32(0));
  _ := g.step();
  g.n
});
```

With `RrCursor` from `tests/ref_of_ref.test.yo` (`impl(generic(p : Origin), RrCursor(p), Iterator(Item : &(i32, p), next :
(fn(self : &mut Self) -> Option(&(i32, p)))(…)))`), `drive(rr_cursor(&xs))` was E0911 at `self.n = …`: "`item` borrows `self`".
`YO_DEBUG_ORIGIN=1` printed `((self._inner).next)() -> [self(imm)]`. Calling `step` directly on a `GWrap(RrCursor(xs))` was
accepted (`-> []`).

## Root cause

Origins never specialize: `drive`'s instance is keyed by `I := RrCursor(<elided>)`, so the impl's `next` called inside it has
the specialized type `fn(self : &mut RrCursor(<elided>)) -> Option(&(i32, <elided>))`. R-CALL
(`projection_call_root_args`, `_origin_carrying_roots_shallow`) found no result origin name in that type and took O2's
elided-result default, the union of the reference parameters: the receiver's place. But that `<elided>` is not an elision
written in a signature; it is the impl's `p`, which the receiver's POINTEE carries and against which the impl body was
checked (the return rule). With `p` spelled, the existing mode-2 rule applies: the result points where the receiver's
references point, never into the receiver (`issues/fixed/2026-11-08-a-call-whose-composite-result-spells-its-origin-freezes-the-receiver.md`).

## Fix

`_call_definition_origin_type` (`src/evaluator/utils.yo`): when a recorded method call's specialized callee type spells no
result origin and the method's DEFINITION type (the recorded method FuncVal's, as `lend_through`'s `_method_slots` reads it)
does, R-CALL and the shallow walk read the definition's names and slots. Erasure is recognized only by "the definition
spells, the specialization does not", never guessed: a definition that spells nothing (a written-elided lending
`get(self : &mut Self) -> Option(&i32)`) keeps O2's default and keeps freezing the receiver — the new G-B pair
`tests/origins/unsound/generic-erased-lending-result-receiver-written.yo` (E0911, with its `-pos` twin) pins that.

Regression tests: `tests/ref_of_ref.test.yo` ("an adapter closure over a reference Item takes a &&T", and the new
"a generic holder writes itself while an item of its inner iterator is live").
