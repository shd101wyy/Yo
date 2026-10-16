# Awaiting a future parameter typed by a generic binder emits a `void*` result

**Severity:** S2 — a generic function over `fut : Impl(Future(R, E))` that awaits `fut` and uses the result without naming its type fails to compile (clang rejects the C); annotating every binding with a type built from `R` works around it.

**Found:** 2026-10-16, writing `std/async`'s `timeout` and `select` over future operands (VBD V3 A4, `feat/vbd-v3-a4-future-operands`). Reproduces with seed v0.2.63 and with develop's compiler at `3151f8e96`. Related: `issues/2026-10-16-a-generic-io-async-body-shares-one-capture-struct-across-futures-of-one-generic-producer.md` (the same missing per-call instantiation of a future's type).

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

`yo compile repro.yo`:

```text
error: incompatible integer to pointer conversion initializing 'void *' with an expression of type 'int32_t'
error: incompatible pointer to integer conversion returning 'void *' from a function with result type 'int32_t'
```

The specialization's C reads the awaited result as `void*`:

```c
void* _tmp = __sync_future->result;
void* __yo_v_r = _tmp;
return __yo_v_r;
```

Variants that fail the same way:

- building a type from the binder in the body, `(out : Option(R)) = Option(R).Some(r)` (a second C type for `Option(R)`);
- the same body inside an `io.async` closure the function returns, a combinator over a by-value future operand (§3.13 A4): `io.async({ op }(io : Io) => { (v : T) = io.await(op, io); v })` emits `int32_t __yo_v_v = ;`, and the tail form `io.async({ op }(io : Io) => io.await(op, io))` compiles but resolves to a wrong value. The single-pass lowering reads the await's result type as an unresolved `SomeT` and treats it as unit (`_inline_result_is_unit`, `src/codegen/async/state_machine.yo`), so no result is stored. Binding `T` through a second plain parameter (`k : T`) does not help. The A4 tests in `tests/async/combinators.test.yo` therefore use combinators that resolve to `unit`;
- an effect binder: `timeout :: (fn(generic(T : Type, E : Type.Struct), fut : Impl(Future(T, E)), …) -> Impl(Future(…, E)))(io.async({ fut }(e : E) => …))` called with an `IoExn` operand gives the `io.async` state machine an `Io`-typed bundle field, so `io.await(timeout(…), IoExn(…))` copies the 40-byte bundle out of an `Io`-sized one (an ASan stack-buffer-overflow in `__yo_future_set_bundle`). The parked future-taking combinators (`wip/vbd-a4-std-half`) take `Io` operands for this reason.

## Workaround (what the parked `std/async` combinators do, `wip/vbd-a4-std-half`)

Name the type at each binding, with the binder taken from a concrete parameter rather than from the future: `(h : JoinHandle(T)) = io.spawn(fut, e)`, and build every `T`-derived value in a helper whose binder comes from a plain parameter (`_timeout_result(r : Option(T), …)`, `_scoped_join(s : &mut _Scoped(U), …)`).

## Suspected cause

`R` is bound only through the `Impl(Future(R, Io))` parameter's SomeT, and the await's result type in the specialized body stays the binder's unresolved type variable, which codegen lowers as `void*`. A binder bound through a plain parameter (`x : R`) resolves.
