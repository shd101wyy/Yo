# A generic io.async body shares one capture struct across futures of one generic producer

**Severity:** S2 — a generic function whose `io.async` body captures its `Impl(Future(T, Io))` parameter fails to compile once it is called with two futures of one generic producer at different `T` (two `JoinHandle(T).join` futures, two `Channel(T).recv` futures): clang rejects the C, or the evaluator reports a unify error; this blocks `std/async`'s `timeout` and `select` over futures (VBD §3.13 A4's std half).

**Found:** 2026-10-16, building A4's future-taking `timeout`/`select` (`feat/vbd-v3-a4-future-operands`; the parked std half is on `wip/vbd-a4-std-half`). Seed v0.2.63 and develop at `1a4cf8df6` both fail.

## Reproducer

```yo
{ assert } :: import("std/assert");
{ println } :: import("std/fmt");
import("std/async");
wrap :: (fn(generic(T : Type), fut : Impl(Future(T, Io)), io : Io) -> Impl(Future(T, Io)))(
  io.async({ fut }(io : Io) => {
    (r : T) = io.await(fut, io);
    r
  })
);
main :: (fn(io : Io) -> unit)({
  a := io.await(wrap(io.spawn(io.async((io : Io) => i32(3)), io).join(io), io), io);
  assert(a == .Some(i32(3)), "a");
  b := io.await(wrap(io.spawn(io.async((io : Io) => true), io).join(io), io), io);
  assert(b == .Some(true), "b");
  println("ok");
});
export(main);
```

`yo compile repro.yo`:

```text
error: incompatible pointer types initializing '…89204496961865559763_state_t *' with an expression of type '…89204496961865559761_state_t *'
  … = __yo_new_…63543((__yo_t_…){.__yo_v_fut = __yo_v_fut});
error: expected expression
  __yo_t_14955945487835497066 __yo_v_r = ;
```

The two calls get two state machines but ONE capture struct, whose `fut` field has the second join future's C type. With `std/async`'s parked `timeout` (whose body also builds a `T`-typed result), the same shape is an evaluator error instead: `Cannot unify incompatible types: "i32" and "bool"`.

Two futures from different `io.async` literals (or different functions) do not collide, nor does one producer used at one `T`, nor a generic function that awaits the operand without an `io.async` body.

## What the capture key sees

`create_capture_type_and_value` (`src/evaluator/utils/closure.yo`) reuses a capture struct by a key of the closure's position and each field's printed type, plus, for a `SomeT` field, its printed resolution. Printed with a debug knob (2026-10-16), both instantiations produce the same key:

```text
cap@repro.yo:4:28|fut:Impl(Future(T, Io))@res:Impl(Future(Option(T), Io))
```

The field is the generic parameter's own `SomeT`, resolved to a copy of the join future's `SomeT`, whose output is `Option(T)` with `JoinHandle`'s binder unresolved; the binder `T` read from the closure's environment resolves to itself; the resolution chain's `type_key` is the same for both. Nothing at closure creation tells the two instantiations apart: the result type of a generic producer's `Impl(Future(...))` is not instantiated per call, so futures of one producer share one type identity, and only codegen (each call's `ExprInfo`) tells their state machines apart. Adding the resolution's `type_key` or the environment's binding of the future's type variables to the key did not separate them (both tried on the branch).

## Direction

Instantiate a generic function's `Impl(Future(...))` result per call (substitute the call's binders into the returned wrapper), or key the closure of a generic body by the specialization that evaluates it. Either makes the capture key differ; the first also fixes `issues/fixed/2026-10-16-awaiting-a-future-parameter-typed-by-a-generic-binder-emits-a-void-pointer-result.md`'s family.

## Probe log 2026-10-18 (post-#1458, on develop `0f44e0e77`): the concrete `T` exists at NO stamp site

Six fix routes were implemented and measured on instrumented builds (a gated `YO_DEBUG_FWPROD` channel beside #1458's `YO_DEBUG_FWCARRIER`; logs `~/Workspace/Yo-wt/vbd-logs/fwcarr-v66/`). All are falsified, and they correct this doc's "Direction" section: neither "instantiate the result per call" nor "key the closure by the specialization" can work, because **nothing at any stamp time knows the concrete `T`** on the method-dispatch route.

Measured facts (the repro, `wrap(h.join(io))` at `T = i32` then `bool`):

- `try_to_call`'s Step-9 stamp, the mint's `spec_ret_ty`, and the registered spec signature ALL evaluate the declared `Impl(Future(Option(T), Io))` to itself: `T` stays unresolved at every stamp. A plain generic FUNCTION producer (`mk :: (fn(generic(T : Type), v : T, io : Io) -> Impl(Future(T, Io)))`) resolves the same shape concretely at Step 9 — the failure is the method-dispatch route, and it holds for an impl binder (`join`), a fn-level binder on an impl method (`mkenum(generic(U : Type), ...)` on `Option(T)`), and `Channel(T).recv` (evaluator unify error instead of C).
- The receiver's recorded argument type AND the env's `Self` binding are BOTH pattern-era `JoinHandle(T)` — the `T` occurrence carries no resolution. `ctx.self_type` is `<none>` at the stamp. The concrete never reaches the call: `io.spawn`'s own result is stamped pattern-era, and the concrete `i32`/`bool` materializes only later, by UNIFICATION at the use site (`a == .Some(i32(3))`), i.e. AFTER the capture struct was created.
- The mint env binds `T := i32` / `T := bool` BY NAME in the join spec's own minting eras (an injected `_inject_forall_captures` binding — the (name, binder-id)-pinned `get_value_of_some_type_from_env` cannot read it, but `_forall_binding_now` can). Instantiating the spec's own `spec_ret_ty` from it changes only the spec-internal signature: the CALL's stamp re-derives from the declared return in its own env, where no binding exists. The consumer still sees one shared wrapper. (Also measured: some eras bind `T := unit` — a soft-fail any such fix must reject.)
- The parked branch's capture-key extension (key += `type_key(resolve_cell_chain(resolution))`, `wip/vbd-a4-std-half` `ca284a630`) was re-tested ON TOP of #1458: still `incompatible pointer types`. At capture-creation time the resolution chain end does not yet differ.
- **One wrap call with one join future compiles and runs clean** (`ok-single`). The failure needs the SECOND registration: the `fw_rebind` rebuild's id is `${fw_id}_fwbind_${type_key(&fw_src)}` and `type_key` of a wrapper SomeT is its ID — the SHARED declared wrapper — so both wrap mints' `fut` types are ONE SomeT with ONE mutable resolution cell, written per join registration (last-write-wins). The C error is that one cell read at TWO emission times: the async argument wrapper struct bakes the FIRST machine (`…721_state_t`), the capture struct field bakes the LAST (`…723_state_t`), inside ONE wrap specialization whose own `fut` parameter lowers as the generic cell.

Remaining directions (not falsified, not attempted): make the capture field of a future-wrapper type lower as the generic future cell (like the spec's own parameter) instead of chasing the wrapper's per-registration resolution; or give the `fw_rebind` rebuild a per-mint id and per-mint resolution cell so the two mints never share one cell. Both are codegen/evaluator design decisions that need the async corpus re-run; the reproducer matrix for either is in this directory's probe files (`tmp/repro_s2.yo`, single-call control `tmp/repro_single.yo`, `Channel` variant, impl-binder variant, plain-fn control).
