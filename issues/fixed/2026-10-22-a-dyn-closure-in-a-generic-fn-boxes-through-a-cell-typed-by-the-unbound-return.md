# A `dyn` closure in a generic function boxes through a cell typed by the unbound return

**Severity:** S2. A `Dyn(Fn(...), Send)` built from a closure that captures a parameter of a generic (`Impl(Fn)`) function does not compile: the C compiler rejects the generated `arc` instance, whose result has a second C type, the unbound `Arc(V)`.

**Status:** FIXED 2026-10-22 (`feat/rc-alloc-parameter`). **Found:** 2026-10-22, while adding `rc`'s `alloc` parameter. The first version gave `rc` the same body as `arc` (#1519), a `match` as the body's tail. The v0.2.68 seed then could not build the compiler from the branch's std: `yo build --std-path ./std` stopped in clang, at the `rc` instance that `dyn(...)` synthesizes for the detector closure in `analyze_await_points` (`src/evaluator/async/await_analysis.yo`), which captures the `get_info : &Impl(Fn(...))` parameter. `arc` has had that shape since #1519, so user code reaches the same failure through a `Send` dyn. Develop `e30c0d8ed` with the v0.2.68 seed fails on the reproducer below.

## Reproducer

```yo
{ assert } :: import("std/assert");
Detector :: struct(detect : Dyn(Fn(x : i32) -> i32, Send));
run :: (fn(get : Impl(Fn(x : i32) -> i32, Send, Sync)) -> i32)({
  d := Detector(detect : dyn((x : i32) => (get(x) + i32(1))));
  d.detect(i32(2))
});
main :: (fn() -> unit)({
  n := i32(10);
  assert(run((x : i32) => (x + n)) == i32(13), "through the dyn");
});
export(main);
```

`yo compile` on develop `e30c0d8ed` (seed v0.2.68, the tree's std):

```text
error: incompatible pointer types assigning to '__yo_t_17754804306474760513 *' from '__yo_t_16273135591263856145 *' [-Werror,-Wincompatible-pointer-types]
error: incompatible pointer types returning '__yo_t_17754804306474760513 *' from a function with result type '__yo_t_16273135591263856145 *' [-Werror,-Wincompatible-pointer-types]
```

The same program with `Dyn(Fn(x : i32) -> i32)` and a `&Impl(Fn(...))` parameter goes through `rc` instead. It compiles on develop, whose `rc` body is the bare `Rc(V)(value)`, and failed the same way once `rc`'s body was a tail `match`.

## Root cause

`dyn(v)` on a value that is not an object auto-boxes it: `evaluate_dyn_value` (`src/evaluator/values/dyn.yo`) synthesizes `rc(v)`, or `arc(v)` for a `Send` target. For a closure, `V` is the closure's capture struct. When the closure captures a parameter of a generic function, that struct's field is typed by the parameter's `Impl(Fn)`.

In the emitted instance, both arms build the concrete cell over the capture struct, but the match's result temp is declared with the instance over the unbound `V`, whose payload lowers to `void*`. Here is the `rc` twin's instance, from the branch's first `rc`:

```c
static inline __yo_t_14122043430686301281* __yo_fs_17177003009635259072(__yo_t_11503253351495608750 __yo_v_value, ...) {
  __yo_t_6551707298659785715* _file____home_temp_104466830441179448511;   // Rc(V)
  switch ((__yo_v_alloc).tag) {
  case ..._SOME: { ... _file____home_temp_104466830441179448511 = __yo_v_cell; ... }
  case ..._NONE: { ... = __yo_new___yo_t_14122043430686301281(__yo_v_value); ... }
  }
  return _file____home_temp_104466830441179448511;
}
```

A `match` takes the expected type as its result type when that type carries no `SomeT` (`_arm_result_type`, `src/evaluator/exprs/match.yo`). The tail of a specialized body is evaluated with the specialization's return type as its expected type (`create_specialized_function_inline`, `src/evaluator/calls/helper.yo`, `spec_ret_ty`). For this instance that return type is still the declared `Arc(V)` (`Rc(V)` for `rc`). Binding the match to a local, so that it is evaluated with no expected type, gives it the arms' concrete type, and the instance compiles. That confirms the expected return type as the carrier.

Why `spec_ret_ty` keeps the declared `Arc(V)` here was not instrumented. The likely path is the return re-evaluation's adoption gate in `create_specialized_function_inline`. It adopts a re-evaluated `-> Arc(V)` only when the result is concrete, or when its `SomeT`s are this call's own closure-typed forall arguments (the carve-out from `issues/fixed/arc-of-a-send-closure-emits-two-capture-struct-typedefs.md`). A capture struct that carries an enclosing function's `Impl(Fn)` fits neither case.

## Fix

`rc` and `arc` (`std/prelude.yo`) bind the `match` and return the binding: `cell := match(alloc, …); cell`. The match is then typed by its arms, which build the cell through the same constructor memo as the instance's signature, so the result has one C type. The seed lowers this shape, so `rc`'s `alloc` parameter ships without a seed gate. A comment at each constructor names this issue.

Only `dyn`'s synthesized call reaches these constructors with a capture-struct `V`. A closure passed directly is typed by its `Impl(Fn)`, which the existing carve-out handles. So no other prelude or user function reaches the evaluator path. Making the specialization adopt the re-evaluated `Rc(<capture struct>)` return would let a tail `match` stand. That change was not made here, because the v0.2.68 seed needs the bound shape to build the compiler anyway.

Tests: `tests/arc.test.yo` "a Send dyn of a closure capturing a generic fn's Impl(Fn) parameter boxes through arc" fails on develop `e30c0d8ed` (clang rejects the batch) and passes with the fix. `tests/rc.test.yo` "a dyn of a closure capturing a generic fn's Impl(Fn) parameter boxes through rc" is the `rc` twin: it guards the new `rc` body, and it failed with the branch's first, tail-`match` `rc`.
