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

Instantiate a generic function's `Impl(Future(...))` result per call (substitute the call's binders into the returned wrapper), or key the closure of a generic body by the specialization that evaluates it. Either makes the capture key differ; the first also fixes `issues/2026-10-16-awaiting-a-future-parameter-typed-by-a-generic-binder-emits-a-void-pointer-result.md`'s family.
