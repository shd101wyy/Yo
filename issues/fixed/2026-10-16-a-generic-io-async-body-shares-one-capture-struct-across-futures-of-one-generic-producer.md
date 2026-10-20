# A generic io.async body shares one capture struct across futures of one generic producer

**Severity:** S2 — a generic function whose `io.async` body captures its `Impl(Future(T, Io))` parameter fails to compile once it is called with two futures of one generic producer at different `T` (two `JoinHandle(T).join` futures, two `Channel(T).recv` futures): clang rejects the C, or the evaluator reports a unify error; this blocks `std/async`'s `timeout` and `select` over futures (VBD §3.13 A4's std half).

**Status:** FIXED 2026-10-20 (`fix/async-capture-per-mint`): the capture key and the future-wrapper rebuild both read the END of the resolution chain, where the two instantiations do differ; see "Resolution". The evaluator-error variant (a type built from the binder, `timeout`'s `JoinHandle(T)`) is a different bug, split off to `issues/fixed/2026-10-20-a-type-built-from-a-binder-bound-to-a-substituted-enum-reuses-another-instantiation.md` (fixed on the stacked `fix/ctfe-enum-arg-type-args`).

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

## Resolution 2026-10-20 (develop `6ccddf25d`, tree-built compiler)

### The corrected diagnosis: the chain end DOES differ at capture time

Traced with a gated channel on the reproducer (`wrap(h.join(io))` at `i32`, then `bool`), the `fut` field's resolution chain at capture creation, as `[id]` links:

```text
spec 1: [4413_fwbind_4305] -> [4305] -> [4418]
spec 2: [4413_fwbind_4305] -> [4305] -> [4425]
```

`4305` is `join`'s one declared `Impl(Future(Option(T), Io))` wrapper. `4418` and `4425` are the two `join` specializations' own `io.async` futures, and codegen registers each one's state machine under its own id. So the per-mint cell already exists one link down. Three readers ignored it:

- The capture key printed the resolution with `type_to_string`, which renders both as `Impl(Future(Option(T), Io))`.
- The parked key extension (`wip/vbd-a4-std-half` `ca284a630`) appended `type_key(resolve_cell_chain(resolution))`. But `resolve_cell_chain` returns its INPUT when the chain ends in a SomeT rather than a concrete type, so both keys collapsed back to `4305`. That, not timing, is why the probe log above found the "chain end does not yet differ".
- The `fw_rebind` rebuild's id was `${fw_id}_fwbind_${type_key(&fw_src)}`, with `fw_src` the shared wrapper `4305`, so both mints' `fut` had one id.

The spec's own `fut` parameter already lowered correctly per mint (`…571_state_t*` and `…573_state_t*`), because codegen follows the chain to its end. Only the capture struct was shared: one struct, keyed by the printed type, whose field took the first registration's C type.

### The design decision: per-mint identity, not the generic cell

Both remaining directions were compared on the same reproducer.

- **(a) Lower a future-wrapper capture field as the generic future interface pointer.** This is a codegen-only change, so it cannot reach the evaluator. On develop the struct is shared in the evaluator too: one `struct_id`, whose `register_struct_fields` entry is last-write-wins. Other C paths would need casts. The field's C type is load-bearing at the capture initializer (`{.__yo_v_fut = __yo_v_fut}`, the reported clang error), and at any body site that passes the captured future to a function whose parameter lowers to the concrete state machine (a call, not an `io.await`, which already casts through `void*`). That means a cast at every read and initialization site, for a struct that would still be one evaluator type across instantiations whose operands differ.
- **(b) Give each mint its own identity, read from the chain end.** This is CHOSEN. `resolution_chain_end` (`src/types/utils.yo`) returns the last link, SomeT or concrete; `resolve_cell_chain` is now that plus its old "input unless concrete" rule. The capture key appends `#type_key(chain end)` for a resolved SomeT field (`src/evaluator/utils/closure.yo`). The rebuild's id becomes `${fw_id}_fwbind_${src}_${end}` when the end differs from the source (`src/evaluator/calls/helper.yo`). Every reader keyed on the id or the capture struct then separates the mints: the evaluator's struct registry, the closure-identity spec keys, and codegen's struct emission.

Which call paths change: only a capture field whose SomeT type has a resolution, and only a rebuild whose arg wrapper resolves further than itself. A chain that ends where it starts keeps its old key and id byte for byte.

Measured on the reproducer:

| | develop | (b) |
| --- | --- | --- |
| `repro_s2.yo` | clang `incompatible pointer types` | `ok` |
| emitted C | 380,285 bytes, 17 `capture_` mentions | 380,526 bytes (+241), 18 |
| single-call control, plain-function producer | `ok` | `ok` |
| the compiler's own C (`compile src/main.yo --emit-c`, same source) | 142,824,369 bytes, 1,984 `capture_` mentions | 142,824,324 bytes, 1,984 |

The +241 bytes are the second capture struct, which is correct: the two instantiations' fields have different C types. The compiler itself has no such pair, so its own C is the same size to within 45 bytes, with no capture struct added.

### Split off: the evaluator variant is a different bug

The doc's second symptom, `Cannot unify incompatible types: "i32" and "bool"`, persists under (b). Its body builds a type from the binder (`(h : JoinHandle(T)) = io.spawn(fut, io)`, `timeout`'s shape). It reproduces with NO capture and NO `io.async` at all: a plain generic function returning `Option(T).Some(io.await(op, io))`, called with two join futures, fails the same way on develop. The cause is the CTFE memo, not the capture struct: an enum argument with the same declaration id memo-hits regardless of its type arguments. Its own doc is `issues/fixed/2026-10-20-a-type-built-from-a-binder-bound-to-a-substituted-enum-reuses-another-instantiation.md`.

### Re-verified after #1503 (develop `fc15a6092`)

#1503 (`issues/fixed/2026-10-17-a-closure-in-a-generic-method-first-reached-from-another-generic-impl-is-emitted-at-the-trial-type.md`) added the closure's call signature (the `type_key` of its parameters and result) to every capture key. That alone splits the two mints whenever the consumer's `io.async` RESULT mentions `T`, so on develop `fc15a6092` the reproducer above, the `Channel(T).recv` variant (`wrap(c1.recv(io))` then `wrap(c2.recv(io))`) and the first regression test below all compile and run. It does not split them when the consumer's body has ONE call signature at every `T`. With `_a4_ran(generic(T), op : Impl(Future(T, Io)), io) -> Impl(Future(bool, Io))`, whose body awaits `op` and returns `true`, develop still fails in clang (`incompatible pointer types initializing '…913_state_t *' with an expression of type '…911_state_t *'`), over two `JoinHandle(T).join` futures and over two `Channel(T).recv` futures alike. With the fix both compile and run.

The `Channel(T).recv` variant was unverifiable before because of the closure bug #1503 fixed. It is now verified, in both shapes.

Regression tests, in `tests/async/combinators.test.yo`:

- "A4: futures of one generic producer at two types each get their own capture struct" covers the block and tail forms at `i32` and `bool`. It failed on `6ccddf25d` and passes on develop since #1503.
- "A4: a consumer with one call signature at every T gets a capture struct per producer future" covers `_a4_ran` over two join futures and two `recv` futures. It fails on develop `fc15a6092` (the clang error above) and passes with the fix.
