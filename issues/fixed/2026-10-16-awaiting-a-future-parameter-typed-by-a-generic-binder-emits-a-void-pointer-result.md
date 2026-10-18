# Awaiting a future parameter typed by a generic binder emits a `void*` result

**Severity:** S1 — a generic function over `fut : Impl(Future(R, E))` that awaits `fut` and uses the result miscompiles: as a tail `io.async({ fut }(io : Io) => io.await(fut, io))` it compiles and resolves to a wrong value (re-graded from S2 on 2026-10-17 after that probe); other shapes fail in clang (`void*` result, `T v = ;`). Annotating every binding with a type built from `R` avoids it outside `io.async`, and spawning the operand (`(h : JoinHandle(R)) = io.spawn(fut, io)`) avoids it inside. **Fixed 2026-10-18** (see "Fix" below).

**Found:** 2026-10-16, writing `std/async`'s `timeout` and `select` over future operands (VBD V3 A4, `feat/vbd-v3-a4-future-operands`). Reproduces with seed v0.2.63 and with develop's compiler at `3151f8e96`; fails-before re-verified on seed v0.2.65 and develop `e7e348c3b` (all five variants below, plus the plain-parameter control). Related: `issues/2026-10-16-a-generic-io-async-body-shares-one-capture-struct-across-futures-of-one-generic-producer.md` (the same missing per-call instantiation of a future's type, on the producer's RESULT side; still open — this fix clears the parameter side only).

## Reproducer

```yo
{ assert } :: import("std/assert");
five :: (fn(io : Io) -> Impl(Future(i32, Io)))(io.async((io : Io) => i32(5)));
wrap :: (fn(generic(R : Type), fut : Impl(Future(R, Io)), io : Io) -> R)({
  r := io.await(fut, io);
  r
});
main :: (fn(io : Io) -> unit)({
  assert(wrap(five(io), io) == i32(5), "awaited");
});
export(main);
```

`yo compile repro.yo` (seed v0.2.65):

```text
error: initialization of 'void *' from 'int32_t' makes pointer from integer without a cast
error: returning 'void *' from a function with result type 'int32_t'
```

The specialization's C reads the awaited result as `void*`:

```c
void* _tmp = __sync_future->result;
void* __yo_v_r = _tmp;
return __yo_v_r;
```

Variants that fail the same way (all re-verified fails-before on seed v0.2.65):

- building a type from the binder in the body, `(out : Option(R)) = Option(R).Some(r)` (a second C type for `Option(R)`);
- the same body inside an `io.async` closure the function returns, a combinator over a by-value future operand (§3.13 A4): `io.async({ op }(io : Io) => { (v : T) = io.await(op, io); v })` emits `int32_t __yo_v_v = ;`, and the tail form `io.async({ op }(io : Io) => io.await(op, io))` compiles but resolves to a wrong value (the assert traps, rc 134). The single-pass lowering reads the await's result type as an unresolved `SomeT` and treats it as unit (`_inline_result_is_unit`, `src/codegen/async/state_machine.yo`), so no result is stored. Binding `T` through a second plain parameter (`k : T`) does not help;
- an effect binder: `timeout :: (fn(generic(T : Type, E : Type.Struct), fut : Impl(Future(T, E)), …) -> Impl(Future(…, E)))(io.async({ fut }(e : E) => …))` called with an `IoExn` operand gives the `io.async` state machine an `Io`-typed bundle field, so `io.await(timeout(…), IoExn(…))` copies the 40-byte bundle out of an `Io`-sized one (an ASan stack-buffer-overflow in `__yo_future_set_bundle`); the minimal form (`wrap` over `generic(T, E)` awaiting inside `io.async({ fut, io }(e : E) => io.await(fut, e))`, an `IoExn` operand) traps on the assert.

## Workaround (what the parked `std/async` combinators do, `wip/vbd-a4-std-half`)

Name the type at each binding, with the binder taken from a concrete parameter rather than from the future: `(h : JoinHandle(T)) = io.spawn(fut, e)`, and build every `T`-derived value in a helper whose binder comes from a plain parameter (`_timeout_result(r : Option(T), …)`, `_scoped_join(s : &mut _Scoped(U), …)`).

## Root cause (verified, correcting the first suspicion)

The suspicion was that "`R` is bound only through the `Impl(Future(R, Io))` parameter's SomeT". Probes (`YO_DEBUG_PARAMCHECK`, `YO_DEBUG_FWCARRIER`) sharpened it twice:

1. Inside the specialized body, the await's own unification read
   `[param-check] label=fut declared=Impl(Future(T, E)) final=Impl(Future(R, Io)) arg=Impl(Future(R, Io))`
   — the `fut` VARIABLE's type kept the DECLARED wrapper, whose Future carrier is the unresolved `R` OCCURRENCE, so `io.await`'s builtin bound its result `T := R(unresolved)`. A plain second parameter `x : R` does NOT help (verified: the control with `x : R` fails identically) — the carrier occurrence is a type VALUE, not a name lookup, so no env binding ever reaches it.
2. The mint's per-spec future-wrapper rebuild (`fw_rebind`, `create_specialized_function_inline`, `src/evaluator/calls/helper.yo`) — the one place meant to give the param binding a per-call wrapper — NEVER FIRED for an `io.async`-produced argument: its gate required the RESOLVED arg type (`runtime_param_tys`, after `_spec_resolve_arg_ty` collapses the resolution chain) to be a wrapper SomeT, but an `io.async` future's wrapper resolves to its state-machine struct, so the gate saw a concrete type, skipped the rebuild, and left the param bound to the shared declared wrapper (whose Future carrier names the binder).

## Fix (2026-10-18, `fix/future-param-binder-result`)

The class fix, in three layers:

- **The rebuild always fires for a Future parameter** (`src/evaluator/calls/helper.yo`): when the resolved arg type is a concrete struct, the rebuild takes its identity and Future carrier from the RAW argument wrapper (`arg_values`, pre-collapse) and its resolution from the collapsed concrete. The rebuild's Future carrier is the ARGUMENT's carrier — the call's concrete types — so every consumer in the body (the await unification, the await analysis, the capture-struct key's field print) sees per-call types. The declared carriers survive only when no argument wrapper exists, and then `_resolve_wrapper_carriers_from_env` (new, `src/evaluator/types/function.yo`, beside `_substitute_wrapper_carriers`) resolves the remaining binder occurrences against the mint env's forall bindings by name, keeping the wrapper's own id and resolution.
- **The await analysis resolves the output carrier** (`detect_await_expr_`, `src/evaluator/async/await_analysis.yo`): when the extracted FutureTraitT output is an unresolved SomeT, hop the future type's own resolution chain and re-extract there — value-first, one hop, so an unresolvable carrier keeps its occurrence.
- **The sync await lowering does the same hop as its last fallback** (`generate_await`, `src/codegen/exprs/await.yo`), after the existing await-expr-type/resolution cascade.

All five variants plus the plain-parameter control compile and produce the
correct values on a tree-built binary. The S2 capture-struct collision (a
generic PRODUCER's returned wrapper shared across its own `T`s, e.g. two
`join` futures) still fails — that is the S2 issue's own scope, left open.
The parked std half's `Io`-typed operands can migrate to generic `E` once S2
lands too.

Regression tests: the `_a4_id` family and the `R`-resolving tests in
`tests/async/combinators.test.yo` (tail, block, `Option(T)`-building, sync and
effect-binder forms) — fails-before on seed v0.2.65 (`yo test
tests/async/combinators.test.yo --std-path ./std --bail`: the batch's C fails
with the `void*` conversions), passes on a tree-built binary.
