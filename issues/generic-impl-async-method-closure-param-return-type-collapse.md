# Generic impl method with a closure param: io.async return type collapses

**Found**: 2026-08-27, implementing `std/async/mutex`'s `with_lock`
(STD_API_AUDIT §7 P0 item 6). **Blocks**: the `with_lock` sugar on the async
`Mutex(T)` — the method is REMOVED from v1 and must be restored when this is
fixed. **Repros**: `issues/repros/generic-impl-async-method-closure-param-collapse.yo`
(both failing shapes), `issues/repros/generic-impl-async-method-self-only-ok.yo`
(the control that passes).

## Symptom

On a generic impl (`impl(generic(T : Type), Holder(T), ...)`), a method that
takes a CLOSURE parameter (`body : Impl(Fn(inout(v) : T) -> R)` or `-> T`) and
returns an `io.async` future mis-types its result. Two manifestations:

1. **Fixed output type** — `(fn(self : Self, body : Impl(Fn(inout(v) : T) -> T),
   io : Io) -> Impl(Future(T)))(io.async((io : Io) => { r := body(self._value);
   return(r); }))`, `T = i64`: awaiting the returned future yields type `unit`:

   ```
   Error: Cannot unify incompatible types:
   Expected: "bool"
   Given: "unit"          # r == i64(10) — r is unit
   ```

2. **Generic output type** — same method with `generic(R : Type)` and `-> R` /
   `-> Impl(Future(R))`: the METHOD CALL's type becomes the closure's own fn
   type (the future wrapper vanishes entirely):

   ```
   Error: Type mismatch for parameter "fut":
   - Expected: Impl : (Future[Future](T) E : E)
   - Got     : fn(v : i64) -> i64
   ```

## What isolates it

- Same method WITHOUT the closure param (captures only `self`) is CORRECT
  (`generic-impl-async-method-self-only-ok.yo` variant `value_async`).
- Same closure param with a PLAIN `R` return (no `io.async`, method body just
  `body(self._value)`) is CORRECT (variant `apply`).
- So the trigger is specifically: generic impl + closure param captured by the
  `io.async` block. The sibling family fixed on 2026-08-26 ("generic-fn async
  closures dropped params from their capture") covered generic FUNCTIONS; this
  is the generic-IMPL-METHOD face, and it breaks the future's TYPE rather than
  the capture's VALUE.

## Suspected area

Evaluator async-closure typing under generic-impl materialization — the same
SomeT-cell territory as C21 (`issues/fixed/async-trait-default-shares-one-impl-
future-concrete-type.md`): the `Impl(Future(...))` SomeT of the method's return
appears to lose its `FutureTraitT` resolution when the closure param
participates in the capture analysis.
