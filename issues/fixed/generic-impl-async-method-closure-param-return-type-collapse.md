# Impl method with a closure param: `Impl(...)` return type collapses to the closure's type

**Status: FIXED 2026-08-29** — root cause was NOT generic-impl materialization
and not capture analysis. Every `Impl(...)` annotation wrapper is a SomeT minted
with the RESERVED name `"Impl"` (`builtins/impl_constraint.yo`). In
`try_to_call_function_with_arguments` (`calls/helper.yo`) **Step 9's per-call
return substitution matches return-position SomeTs to declared-param SomeTs
BY NAME** and substitutes the matching ARGUMENT's type — meant for
`IterFilter(Self, F)`-style records whose forall slots hold def-era SomeTs.
With an `Impl(Fn(...))` closure param and an `Impl(Future(...))` (or any
`Impl(...)`) return, both wrappers are named `Impl`, so the return was
substituted with the closure argument's fn type — hence "Type mismatch for
parameter fut: Got `fn(v : i64) -> i64`" and, for a fixed `T`, the future
typed as the closure's own type. `YO_DEBUG_PARAMCHECK=1` shows it directly
(`label=handler … arg=fn(x : i32) -> i32` then `label=fut … arg=fn(x : i32) ->
i32`); the `[s9-*]` trace is silent because it prints only inside def-time
trials. Free functions and static methods don't reach this route (2026-08-29
isolation over 10 variants: free fn, static method, non-closure
`Impl(ToString)` param and a where-clause `F` all OK; every `self` +
`Impl(Fn)` + `Impl(...)`-return variant collapsed, including one whose body
never touches the closure). Re-found while writing `std/http`'s
`HttpServer.serve_once` — a NON-generic impl.

**Fix**: Step 9 excludes the reserved name `Impl` (and nameless wrappers) from
both by-name sources — the param-name match and the "resolve remaining
occurrences from the callee env by name" fallback. Wrapper returns resolve
through their own cells and the Step 9b return-type-expression re-eval, as
they already did for methods without closure params (v7). The SomeT name,
the env bindings and every `== "Impl"` reservation check are untouched — the
two 2026-08-27 attempts below (renaming the SomeT; skipping its env binding)
and a 2026-08-29 attempt (keying env bindings by `Impl#<id>`) all regressed
std or `async_await` because io.async/io.await deliberately share wrapper
bindings by name.

**Regression tests**: `tests/impl_method_closure_param_future_return.test.yo`
(non-generic + the original generic `Holder` repro, effectful future,
later-position closure, `Impl(ToString)` return, two closure shapes);
`Mutex.with_lock` is NOT yet restored: with C27 gone, calling a generic
`-> Impl(Future(R))` method with two different `R`s still miscompiles (C54,
`issues/future-wrapper-return-shared-across-specializations.md`).

**Original report (2026-08-27) follows.** **Found**: 2026-08-27, implementing `std/async/mutex`'s `with_lock`
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
