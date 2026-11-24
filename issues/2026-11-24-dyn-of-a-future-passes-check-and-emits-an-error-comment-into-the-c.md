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
