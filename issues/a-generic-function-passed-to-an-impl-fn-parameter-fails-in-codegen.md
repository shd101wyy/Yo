# A generic function passed to an `Impl(Fn(...))` parameter fails in codegen

**Severity:** S2 — a program that passes `check` stops at `compile` with an internal compiler error (E1301); no wrong code reaches a binary.

**Status:** OPEN. **Found:** 2026-10-13, probing the shapes of
`issues/fixed/dyn-of-a-named-function-value-emits-invalid-c.md` (on the
`feat/vbd-d44-dyn-fn-explicit` tree, `7bc17e931`; independent of that fix).

## Repro

```yo
{ println } :: import("std/fmt");
identity :: (fn(generic(T : Type), x : T) -> T)(x);
apply :: (fn(f : Impl(Fn(x : i32) -> i32), v : i32) -> i32)(f(v));
main :: (fn() -> unit)({
  a := apply(identity, i32(4));
  println(`${a}`);
});
export(main);
```

```
$ yo check repro.yo        # evaluator OK
$ yo compile repro.yo -o a.out
error[E1301]: internal compiler error: Failed to transpile part of main's body — the emitted C for "__yo_user_main" contains an untranspiled expression, so the program would run without it
```

`YO_DEBUG_SWALLOW=1` shows `[ftt-stub] kind=unit fn=__yo_user_main`: the
body was emitted as an abort stub.

## What is and is not accepted

A generic function is not a first-class value anywhere else: binding it to a
`(fn(x : i32) -> i32)` local, to an `Impl(Fn(x : i32) -> i32)` local, or boxing
it with `dyn(identity)` into a `Dyn(Fn(x : i32) -> i32)` is E0601 at `check`
(`Given: fn(generic(T) x : T) -> T`). The `Impl(Fn(...))` PARAMETER route is
the one that passes `check`, so the program reaches codegen with no
specialization of `identity` for the argument to name.

## Direction

Either reject the argument at `check` like the other three routes (the smaller
rule; `issues/a-generic-function-bound-with-colon-equals-is-called-through-an-undeclared-symbol.md`
argues the same for `:=`), or instantiate a generic function against the
`Fn(...)` signature it is checked against, at every typed site at once
(binding, parameter, `dyn(...)`), not at this one alone.
