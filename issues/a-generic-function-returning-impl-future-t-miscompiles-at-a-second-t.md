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
miscompiles. It is a different defect, and as of 2026-09-12 it is measured
rather than hypothesised.

### The sharp A/B

One variable, four programs, all against develop's compiler
(`issues/repros/generic-future-return-two-t-closure-param.yo` and three
variants of it):

| the call | result |
| --- | --- |
| `b.run(() => …, io)` — METHOD-CALL syntax on an impl method | **compiles, runs, `a=7 b=8`** |
| `Box3.run(b, () => …, io)` — the same method, explicit receiver | fails |
| an impl entry with no `self` | fails |
| a free function, with or without a leading parameter | fails |

So it is the METHOD-CALL path that is special — not `self`, not
free-vs-impl, which is what the earlier note in this document guessed. The
method arm of `evaluate_function_call`
(`src/evaluator/calls/function.yo`, the `_with_resolved_concrete` bridge) reads
the SPECIALIZATION's body ExprInfo and pins the result with it; no other call
arm does, so every other shape falls through to the shared channel below.

### What the emitted C shows

Both async-block generations exist (`closure_…000000`, `closure_…000001`) and
so do both `_sync_fut_t` structs. What disagrees is the closure's own C return
type: the PROTOTYPE loop and the BODY loop render the same fid differently, and
across the two generations the renderings are crossed.

### What the evaluator shows

Three probes, on a compiler built for the purpose (`YO_DEBUG_CAPTURE` already
existed; `[fidty]` traces `register_func_type`, `[proto]` traces
`generate_function_prototype`, `[aclos]` traces the closure body/return
unification):

```
[fidty] closure_…16430952469372288712000000 := fn(io : Io) -> T
[fidty] closure_…16430952469372288712000001 := fn(io : Io) -> i32

[aclos] fid=…000000 ioasync=true ret=T   body=R   bodyconc=false
[aclos] fid=…000001 ioasync=true ret=i32 body=i32 bodyconc=true

[proto] …000000 ret_str=<Pair struct> result=T   some=true    <- DECLARATION pass
[proto] …000001 ret_str=int32_t       result=i32 some=false   <- DECLARATION pass
[proto] …000000 ret_str=int32_t       result=T   some=true    <- BODY pass
[proto] …000001 ret_str=int32_t       result=i32 some=false   <- BODY pass
```

Read it in order:

* **Generation 0** (the `i32` call) registers its result as the BARE SomeT `T`
  — io.async's own forall. Its body `f()` types as `R`, the enclosing generic's
  forall, also unresolved. A bare SomeT is rendered by
  `resolve_some_type_to_concrete`, which reads the per-object cell first and
  then the GLOBAL id→concrete table. That table is one entry per DECLARATION,
  shared by every call, so generation 0's return renders as whatever was
  written last: the `Pair` struct when the prototypes are emitted, `int32_t` by
  the time the bodies are — the prototype/definition split, from one type that
  changed under two readers.
* **Generation 1** (the `Pair` call) is worse: its result is already the
  CONCRETE `i32` — the FIRST call's binding, baked in before the closure was
  even typed. Swapping the two calls swaps the answer exactly
  (`Pair` first ⇒ generation 1 registers `-> Pair`), which is the signature of
  a stale global, not of a mis-ordered emission.

### The first suspect, and why it is NOT the writer

`src/evaluator/calls/helper.yo`'s closure-param binder does
`register_some_resolved_concrete(fn_res_id, cl_res3)` against the id of the
DECLARED bound's result — `R` itself, one object for the whole program — which
looks like exactly the shared write this needs. It is not: the trace shows that
registration happening with the RIGHT value at each call (`2027 := i32`, then
`2027 := Pair`). Correct, per call, and not the leak. The next section names the
writer that is.

Worth keeping in view anyway, because the same file carries the ANTIDOTE
pattern with the rationale already written out ("This call now OWNS `flabel`:
drop any resolution a PREVIOUS call left … TS mints a fresh SomeType per call
for every forall binder") — the mechanism a real fix should copy, applied to the
channel that actually carries the stale value.

### The writer, named

Two fixes were tried against the two channels above and BOTH were measured to
be no-ops for this shape — recorded so nobody spends the builds again:

* draining the SomeT's per-lineage `resolved_concrete` cell at the point where
  a call takes ownership of its forall binder. The trace says
  `[own] flabel=T id=1708 cell=0` — by then the cell on the object the clear
  can reach is already EMPTY, so there is nothing to drain. The stale value is
  not there.
* snapshotting the io.async action closure's result into a per-generation cell
  at the call. It returns "nothing to pin": at generation 0 the result does not
  resolve at all yet.

Tagging all fifteen `register_some_resolved_concrete` call sites named the real
writer, and it is none of them — the line is emitted by the ONE untagged site,
`_resolve_some_types_deep` (`src/evaluator/types/function.yo`, the nested
wrapper loop). It resolves a nested SomeT **by NAME** out of the env chain
(`get_value_of_some_type_from_env`) and registers what it finds whenever the
resolution came from the env:

```
[own] flabel=T id=1708 cell=0     <- this call takes ownership of T
[src-] 1708                        <- registry entry dropped
[src+] 1709 := Io
[src+] 1708 := i32                 <- re-registered from the ENV, i32 = call 1's R
[fid-src] closure_...000001        <- and only THEN is generation 1 minted
```

So the stale datum is a `T := i32` VARIABLE BINDING left in the env chain by the
previous call, in a frame the per-call ownership rebind does not shadow. That is
the same poison path `calls/helper.yo` already documents for
`evaluate_function_parameter_type_again` ("the re-evaluation reads `T`/`E` BY
NAME from the shared mutable env chain, concretizing the action closure's
expected with a SIBLING call's resolution") and works around with
`use_param_type_directly`; `_resolve_some_types_deep` has the same read and no
such guard. `io.async` is declared in the PRELUDE, whose env is cached for the
whole program, which is why the binding outlives the call.

### What to try next, and the obstacle each candidate hits

Not another name-based special case — that is what the first cut of the
value-param fix got wrong (see the ID-vs-name table above). Three candidates,
each read far enough to name what stands in its way, so the next attempt starts
from a design rather than a hunt.

**The shape of the problem.** TS gets per-call identity for free: it mints a
fresh `SomeType` OBJECT per call and identity is the object. yo-self's env is
keyed by NAME, so a per-call freshened binder (`_freshen_io_builtin_callee`
mints a fresh id) is still looked up by the name `T` — and finds whatever the
previous call bound under that name. Every candidate below is a different answer
to "how does a name-keyed env carry per-call identity".

0. **Check WHICH env the read uses first — it may be the wrong one.**
   `_resolve_some_types_deep` is called at the three stamp sites with
   `call_result_*.caller_env` ("Resolve through the CALL's env, where the
   enclosing specialization binds the binder concretely"). That is the right
   env for the ENCLOSING function's binder. It is NOT obviously the right env
   for the CALLEE's own forall `T`, which `try_to_call_function_with_arguments`
   binds into `callee_env` — where Step 6's per-call marker lives. A by-name
   read of `T` against the CALLER's chain cannot see that marker and can see a
   previous call's concrete binding instead, which is exactly the observed
   shape. Cheapest to falsify: print the env identity (module path + frame
   count) at the `nres_from_env` registration and compare it with the env Step 6
   bound the marker into. If they differ, the fix may be as small as resolving
   a callee-owned binder against the callee env, and candidates 1-3 below are
   not needed.

1. **Make the READ identity-aware.** `_do_chain_resolve`
   (`src/types/env_lookup.yo`) ALREADY guards this: a concrete resolution is
   adopted only if `_was_self_bound(env, name, id)` — did this env ever bind
   this NAME to a SomeT with THIS id. A freshened binder was never self-bound,
   so that guard correctly says no. The hole is the fallback right after it:
   `_def_frame_confirms_binding` is **id-blind** — it looks up the definition
   FRAME for the name, finds a concrete type, and confirms on
   `type_to_string` equality. A freshened SomeT copies the original's
   `frame_level`, so it inherits the previous call's binding through exactly
   that fallback. *Obstacle:* the fallback exists because "the self-referential
   marker is gone once `synthesize_types` rebinds the variable to the concrete
   type" — by then the id is no longer recoverable from the env, so making it
   id-aware needs a new channel recording WHICH SomeT id a concrete binding was
   made for. The place for that channel is `VariableRare` (`src/env.yo`), the
   existing bag for infrequently-used `Variable` fields, set by
   `_bind_some_type`; `_def_frame_confirms_binding` would then need a
   `_lookup_by_frame` variant that returns the VARIABLE rather than its
   TypeValue, and must fall back to today's behaviour when the field is unset
   or it will over-reject every binding made by a site that does not set it.
   Bounded, but not a one-liner.

2. **Do not let a freshened binder claim the declaration's frame.** If
   `_freshen_io_builtin_callee`'s fresh SomeTs carried no `frame_level` (or a
   per-call one), `_def_frame_confirms_binding` would return `false` for them
   via its own `_some_frame_level` → `.None` early-out, and candidate 1's hole
   closes with no new channel. *Obstacle:* `frame_level` is load-bearing for
   `_lookup_by_frame` elsewhere; this needs the def-frame consumers audited
   before it can be called safe.

3. **Per-call NAMES, not just per-call ids.** The honest translation of TS's
   object identity into a name-keyed env. *Obstacle:* names are compared as
   data in several places — `_skip_fallback`'s `_nsn == "E"`, the reserved
   `"Impl"`, and the forall-label match `fv_mn == flabel` in
   `try_to_call_function_with_arguments`, whose labels come from the FuncVal's
   `forall_names` rather than from the type. Renaming the type's binders alone
   desynchronises that match.

The A/B for any of them is the four-program table above: the method-call form
must keep working and the other three must start. Gate with `check ./src` and
`check ./std` FIRST — both are minutes, and this is the hottest type-resolution
path in the evaluator, so an over-narrowed guard shows up there long before the
suite.

`std/thread.yo`'s `spawn_blocking` has exactly this shape, which is why waker
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
