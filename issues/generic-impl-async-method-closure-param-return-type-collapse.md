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

## SHARPER DIAGNOSIS 2026-08-28 (measured after C18/C19 fixes)

`YO_DEBUG_SWALLOW=1 yo check` over the repro shows the collapse IS a def-eval
swallow, the same wall as C18/C19 — but un-swallowing it does NOT fix it, so
it stays OPEN and is NOT a candidate for the C18/C19 flow-violation-reraise
treatment:

```
[anon-swallow] Error: Expected expression value for "__yo_expr_to_string" argument
[swallow] Error: Type mismatch for type member "value":    (×2)
[swallow] Error: Cannot unify incompatible types:
```

- The io.async closure body (`r := body(self._value); return(r)`) is NOT
  evaluated at `yo check` time (the async-closure def-eval blind spot), so
  `print_info(r)` never fires — the type of `r` cannot be observed via check.
- Inside the closure, `body`'s Fn-trait RETURN type is not resolved in the
  generic-impl materialization context, so `body(self._value)` types as unit
  and the future's output SomeT unifies to unit → `io.await(f, io)` yields
  unit → the caller's `r == i64(10)` is the `Cannot unify: bool vs unit` the
  user actually sees.
- This is **generic-impl-materialization territory**, the same family as C21
  (fixed) and C24 (fixed): the enclosing method's `T` binding and the `body`
  closure-param type are not correctly threaded into the async closure's
  capture/type context. C24 fixed the CAPTURE (runtime values dropped from
  the frame); C27 is the TYPE face (the closure-param's Fn-trait return type
  collapses), which C24's fix does not reach.

### Why NOT a C18/C19-style flag fix

C18/C19 are cases where a HARD, CORRECT rejection was merely swallowed —
re-raising it via the flow-violation channel surfaces the right diagnostic.
C27 is different: the closure body's inference produces a WRONG type (unit),
not a rejectable error. Re-raising the swallowed "Cannot unify" would turn
C27 into a loud error, but `with_lock` would still not WORK — the fix must
make the closure-param return type RESOLVE correctly inside the generic-impl
io.async body, which is genuine type-inference work in the materialization
path.

### Blast-radius note (why hasty fixes are rejected)

Two attempts on 2026-08-27 both broke std and were reverted:
1. **Uniquing the reserved "Impl" SomeT name** (`Impl$<id>`) — broke the Io
   struct's `async` field type-member checks and `Pragma` resolution.
2. **Skipping env-binding for "Impl"-named SomeTs in `_bind_some_type`** —
   dropped std from 167→130 checking files.

So the fix must thread the closure-param return type WITHOUT disturbing the
shared "Impl" sugar name's resolution. This needs dedicated inference work in
the generic-impl body-materialization path (impl.yo `_freshen_return_only_
somes` neighborhood — the same code C21 touched), and must run the full
battery to prove no std regression. `Mutex.with_lock` stays removed (a
deferral, not a paper-over) until it lands.
