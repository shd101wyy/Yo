# A call result in an origin-erased specialization borrows the receiver

**Severity:** S2 — valid std code is rejected: `rr_cursor(&xs).map(f).filter(p).count()` over an iterator whose `Item` is a reference fails with E0911 inside `std/prelude.yo` (`IterMap.next`), so every `tests/ref_of_ref.test.yo` test fails to compile on every OS (develop red since #1913).

- Filed: 2026-11-12 (fixdev lane; develop battery 43142204182 on `4f93d3507`). Design consult: Fable, 2026-11-12 (a written elision keeps O2's default; only an origin the receiver's pointee carries frees the receiver).
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

Origins never specialize: `drive`'s instance is keyed by `I := RrCursor(<elided>)`. Inside it the call
`self._inner.next()` is dispatched through the bound `I <: Iterator(Item := A)`, so R-CALL
(`projection_call_root_args`) reads its result off the call's specialized type, `Option(A)` at `A := &(i32, p)`: the
impl's origin parameter `p`, which no parameter slot of the specialized signature spells. That is the "impl origin
parameter" case: the receiver is a root BY VALUE (`ProjectionRootArg.by_value`, "the result points where the argument's
references point, never into the argument itself"). But R-CALL then computed that root's contribution with `origin_of`
of the argument, and `origin_of(self._inner)` is R-FIELD over the reference parameter `self`: `[self]`, the receiver's
own place. So `item` froze `self`, exactly what the by-value root promises it does not.

## Fix

A by-value root contributes what the argument HOLDS (`_origin_held_into`, `src/evaluator/utils.yo`): `origin_held_by`
read through a place's field and deref steps. A place rooted at a parameter or at a by-value holder holds that root's
registered entries (none for a parameter, whose references are the caller's); any other argument (a reference binding's
place, a temporary) keeps `origin_of`. Only the by-value roots change, so an elided result (O2's union of the reference
parameters) still freezes the receiver — the new G-B pair
`tests/origins/unsound/generic-erased-lending-result-receiver-written.yo` (a written-elided lending
`get(self : &mut Self) -> Option(&i32)` called in a generic body, then a write to the receiver: E0911, with its `-pos`
twin) pins that.

Regression tests: `tests/ref_of_ref.test.yo` ("an adapter closure over a reference Item takes a &&T", and the new
"a generic holder writes itself while an item of its inner iterator is live").
