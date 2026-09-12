# A generic function returning `Impl(Future(T))` miscompiles at a second `T`

**Status:** the VALUE-PARAM shape is FIXED 2026-09-12; the CLOSURE-PARAM shape
is still open (see "What is still open").
**Found:** 2026-09-12, writing `spawn_blocking` for waker step 5
(`plans/WAKER_BASED_SCHEDULING.md`).
**Pre-existing:** reproduces identically on the published **v0.2.31**.

## Symptom

Three different C errors depending on the shape, all the same root: ONE
specialization's view of `T` is used where another's belongs.

| shape | error |
| --- | --- |
| `fn(generic(T), v : T, io : Io) -> Impl(Future(T, Io))`, async body `v` | the AWAIT temp is `void*` (T never resolved) while the sync future's `result` is `int32_t` / the struct |
| same with a closure param `f : Impl(Fn() -> T)` | `conflicting types for closure_yo_id_…` — ONE async-block closure emitted, returning `void*`, with a `Pair`-typed body |
| an `io.await` inside the async body | `sm->result` typed `int32_t` in the specialization whose `T` is a struct |

Either instantiation ALONE compiles and runs. The pair does not.

## Reproducers

* `issues/repros/generic-future-return-two-t-plain-param.yo`
* `issues/repros/generic-future-return-two-t-closure-param.yo`
* `issues/repros/generic-future-return-two-t-with-await.yo`

## Root cause of the value-param shape, and its fix

The evaluator DOES compute the right per-call return type. `YO_DEBUG_RRE=1`
prints it:

```
[rre] callee=wrap old=true hkt=Impl : (Future[Future](i32) Io : Io)  resolved_ret=Impl : (Future[Future](R) Io : Io)
[rre] callee=wrap old=true hkt=Impl : (Future[Future](Pair) Io : Io) resolved_ret=Impl : (Future[Future](R) Io : Io)
```

`hkt` is the re-evaluated return-type EXPRESSION, per call, and it is correct
both times. It was thrown away: the adoption gate in
`_evaluate_funcval_runtime_call` (`src/evaluator/calls/function.yo`) accepted a
re-evaluated type only when it was SomeT-free, or when every SomeT in it
resolved through its own cell. An `Impl(...)` existential is itself a SomeT
with an empty resolution cell, so an async return could never pass either arm —
`resolved_ret` stayed the declared, unresolved `Impl(Future(R) Io)`, every
caller shared it, and the await site rendered it `void*`.

The gate gains a third arm: adopt when the re-evaluated type no longer mentions
any of THIS CALLEE'S OWN forall binders, because substitution is then complete
for this call and what remains are existentials rather than type variables. It
is gated on `rre_old_wanted`, which is what keeps the recorded adoption hazard
out — the per-call closure-`F` family leaves a substituted return whose SomeTs
all resolve concretely, so the re-eval is never wanted there in the first place.

### The binder test must compare IDs, not names

The first cut compared binder NAMES, and produced a compiler in which *the same
program compiled or not according to what its type variable was called*:

| receiver forall | method forall | result |
| --- | --- | --- |
| `U` | `R` | compiles |
| `A` | `B` | compiles |
| `T` | `Q` | **miscompiles** |
| `U` | `E` | **miscompiles** |

`T` and `E` are the names the PRELUDE's own `Future(T, E)` declaration uses, and
those binders ride along inside the re-evaluated `Impl(Future(i32) Io)` — so a
name comparison reported "still mentions `T`" for any user generic that happened
to be called `T`, which is the most natural name there is. The fix reads the
binder IDs off the declared return type (`_rre_binder_ids`), applying the name
filter exactly once, where the names are unambiguously the callee's.

## What is still open

The CLOSURE-PARAM shape —
`fn(generic(R), f : Impl(Fn() -> R), io : Io) -> Impl(Future(R, Io))` — still
miscompiles, and it is a different defect. Measured in the emitted C, sharpened
once the return stamping above stopped being the problem:

* BOTH async-block generations exist (`closure_…000000`, `closure_…000001`),
  and so do both `_sync_fut_t` structs. Nothing is missing.
* The two forward declarations DISAGREE with each other correctly:
  `…000000` is declared returning the struct, `…000001` returning `int32_t`.
* **Both DEFINITIONS return `int32_t`.** So `…000000`'s definition contradicts
  its own forward declaration, which is the `conflicting types for
  closure_yo_id_…` the C compiler reports, and the struct specialization's
  state machine calls a body that computes the wrong type.

That is a prototype-vs-definition split for ONE fid, and the interesting part
is that `generate_function` and `generate_function_declaration`
(`src/codegen/functions/`) build both strings from the SAME helper —
`generate_function_prototype(get_func_type(fid), …, async_override, …)`. So
something those two passes read differs between them. `async_override` is the
suspect: `_async_override_return_type` consults the BODY node's ExprInfo, and
the two generations share one body AST node, so anything recorded there is
last-writer. That is a hypothesis, not a measurement — what is measured is the
three bullets above.

The lead from the working side stands: an IMPL METHOD with a closure param
compiles at two `R`s (`std/async/mutex.yo`'s `with_lock`, and a stripped
20-line copy of it). A FREE FUNCTION with the same closure param does not. That
pair is the A/B to bisect next.

`std/thread.yo`'s `spawn_blocking` has exactly that shape, which is why waker
step 5 (`plans/WAKER_BASED_SCHEDULING.md`) is not landed with it.

## What is NOT the trigger

Measured, one variable at a time — none of these makes it pass:

* free function vs impl method;
* a generic receiver (`Box3(U)`) vs a concrete one;
* `Impl(Future(T))` vs `Impl(Future(T, Io))`;
* a bare tail vs an explicit `return(r)`;
* a by-value closure param vs `inout`;
* the definition living in another module;
* result types `i32`+struct vs `i32`+`String`;
* an `io.await` inside the async body vs none (it changes WHICH error, not whether there is one).

## What DOES pass, and is the lead

`std/async/mutex.yo`'s `with_lock`:

```rust
with_lock : (fn(generic(R : Type), self : Self,
                body : Impl(Fn(inout(v) : T) -> R), io : Io) -> Impl(Future(R)))(
  io.async((io : Io) => {
    io.await(self.lock(io), io);
    r := body(self._value);
    self.unlock();
    return(r);
  })
)
```

called twice on ONE `Mutex(i64)` with an `i64` body and a `String` body compiles
and runs (`tests/async_mutex.test.yo`, and standalone). Its history is
`issues/fixed/future-wrapper-return-shared-across-specializations.md` — the
same class, fixed in 2026-08-30 for the valueless-closure-callee stamp sites by
resolving `ret_type_rt` through `_resolve_some_types_deep(_, caller_env)`
before stamping. So a correct path EXISTS; the reproducers above take a
different one. Finding what `with_lock` does that the reproducers do not is the
whole of the remaining work — the list above is what it is NOT.

## Impact

`std/thread.yo`'s `spawn_blocking` is correct and works at one instantiation
per program; a second `T` in the same program miscompiles. That is why it is
not exported yet.
