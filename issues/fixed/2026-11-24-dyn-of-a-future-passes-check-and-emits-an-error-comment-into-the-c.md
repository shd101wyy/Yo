# `dyn(&f)` of a future into `Dyn(Future(T, E))` passes `yo check` and emits an error comment into the C

**Severity:** S2 — a program `yo check` accepts fails at the C compiler: the `Dyn(Future(...))` value is emitted as `/* Error: dyn() call missing trait values */`, and an await through it reads fields the `Dyn` pair does not have.

Filed 2026-11-24 by the io-v68 lane (VERDICTS-68) while writing the `Dyn(Future(T))` negative the verdict asks for. Reproduced with a stage 1 of `v0280/io-v68` (develop `34359627e` plus the lane's checker change) and with the v0.2.79 seed: the same 22 clang errors.

## Reproducer

```yo
{ println } :: import("std/fmt");
mk :: (fn(io : Io) -> Impl(Future(i32, Io)))(io.async((io : Io) => i32(4)));
main :: (fn(io : Io) -> unit)({
  f := mk(io);
  (d : Dyn(Future(i32, Io))) = dyn(&f);
  (v : i32) = io.await(d, io);
  println(&v);
});
export(main);
```

`yo check`: evaluator OK. `yo compile`:

```text
v68-dyn6.c:8298:86: error: expected expression
v68-dyn6.c:8301:122: error: member reference type '__yo_t_14344704024429096159' is not a pointer; did you mean to use '.'?
v68-dyn6.c:8301:124: error: no member named 'state' in '__yo_t_14344704024429096159'
```

The emitted C at the binding:

```c
__yo_t_14344704024429096159 __yo_v_d = /* Error: dyn() call missing trait values */;
```

Without the annotation on `v` the await is E0613 (`T` of `io.await` is not inferred from a `Dyn(Future(i32, Io))`).

## Root cause

`Future` is a builtin trait (`FutureTraitT`) with no `impl` registry entry and no vtable: `dyn(...)` finds no trait values to put in the pair, and codegen writes its refusal into the C as a comment (the pattern `issues/fixed/dyn-of-an-existing-dyn-value-emits-an-error-comment-into-the-c.md` closed for `dyn` of a `Dyn`). The await lowering then treats the `Dyn` pair as a state-machine pointer (`->state`, `->vt`). Nothing in the evaluator rejects a `Dyn` over the `Future` trait.

## Fix direction

Either reject `Dyn(Future(...))` at check time (a future is already a pointer to a type-erased state machine; `Impl(Future(T, E))` is the erased form), or give `Future` a vtable and lower an await through the `Dyn` pair. The first matches the language's one spelling per operation; the decision is the coordinator's. The lane's PR rejects a bundled future at a bundle-less `Dyn(Future(T))` slot (E0605), which is the VERDICTS-68 rule, and does not touch this.

The VERDICTS-68 PR's `tests/async/effect-bundle.test.yo` checks only the negative (a bundled future
into `Dyn(Future(i32))` is E0605); a positive `Dyn(Future(i32, Io))` round trip waits for this fix.

## Fix

Decided by VERDICTS-80 (Fable 5.2, adopted 2026-11-25): reject, no vtable. `Future` cannot be listed in a `Dyn`. A future is one pointer to its state machine, and awaiting or spawning it consumes it. One future is typed `Impl(Future(T, E))`. Several different running tasks are kept as `JoinHandle(T)`.

- `evaluate_dyn_type` (`src/evaluator/types/dyn.yo`) throws E0614 at a `Future(...)` argument of `Dyn(...)`, negated or not. Every position forms its `Dyn` there: a local, a parameter, a struct field, a list element. Every `Dyn` type a program writes is formed there, and a `Dyn` a `dyn(...)` derives from its payload needs an expected `Dyn` type, which was formed there. A generic alias over a `Trait` binder (`(fn(comptime(Tr) : Trait) -> comptime(Type))(Box(Dyn(Tr)))`) would also reach it at its application, but its definition is rejected today (`issues/2026-11-25-a-comptime-type-function-over-a-trait-binder-cannot-form-dyn-of-it.md`), so the verdict's seventh test row is not written. The message:

  ```text
  error[E0614]: `Dyn(Future(i32, Io))` cannot be made: `Future` has no vtable slot. A future is awaited or spawned by value (`io.await(f, e)`, `io.spawn(f, e)`), which consumes it, and a `Dyn` is unsized and lives behind the pointer that owns it. A future is already one pointer to its state machine.
  help: type one future as `Impl(Future(i32, Io))`: a parameter, a result or a struct field
  help: to keep several different tasks in one collection, spawn each and keep its handle: `ArrayList(JoinHandle(i32))` (`io.spawn(f, io)`; `join_all` and `race` in `std/async` take the list)
  ```

- The two `Dyn(Future)` paths #2072 added are deleted as unreachable: the `DynT` arm of `_future_trait_of` (`src/types/compatibility.yo`) and the future-view check in `_require_dyn_traits_implemented` (`src/evaluator/values/dyn.yo`).
- The E0902 static-dispatch texts (reassigning an `Impl` local, different concrete types across branches or returns) no longer suggest `Dyn(...)` when the `Impl` is a future: they name `JoinHandle(T)` (`impl_dispatch_hint`).
- `yo explain E0614`, `docs/*/TRAIT_OBJECTS.md`, `docs/*/ASYNC_AWAIT.md` and the pack state the rule.

Tests: `tests/dyn.test.yo` ("a Dyn that lists Future cannot be made, in every position", the E0902 hint, and two running positives: different tasks as `ArrayList(JoinHandle(i32))` joined with `join_all`, different cold futures behind one `Impl(Future(i32, Io))` struct field); `tests/async/effect-bundle.test.yo`'s `Dyn(Future(i32))` row now expects E0614; the cli-case `a-dyn-of-a-future-is-e0614` pins the rendered diagnostic and the `explain` text.
