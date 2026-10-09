# A `cond`/`match` tail of an `Impl(Fn)`-returning function adopts the abstract `Impl` type

**Status:** FIXED (2026-10-10). **Found:** 2026-10-10, on the VBD stack binary and on seed v0.2.54
(also v0.2.56).
**Severity:** S1 — a valid program miscompiled (clang rejected the C), and the check
that keeps a borrowing closure from escaping its frame (decision 38 A, E0909) was
skipped, so fixing the C alone would have shipped a silent use-after-free.

## Symptom

A function whose declared result is `Impl(Fn(...) -> R)` and whose body's TAIL is
directly a `cond(...)` or `match(...)` whose arms yield the same concrete closure:

```rust
{ println } :: import("std/fmt");
mk :: (fn(x : i32, b : bool) -> Impl(Fn() -> i32))({
  (f : Impl(Fn() -> i32)) = ({ x }() => x);
  match(b, true => f, false => f)      // or cond(b => f, true => f)
});
main :: (fn() -> unit)({
  g := mk(i32(42), true);
  println(`g() = ${g()} (want 42)`);
});
export(main);
```

1. **Codegen.** `yo compile` failed in clang:
   `error: assigning to 'void *' from incompatible type '__yo_t_..._struct'`. The
   join's result temp was typed `void*` (the unresolved `Impl`) instead of the
   closure's capture struct. Binding it first (`g := match(...); g`) worked.
2. **Soundness.** With a borrowing capture `({ imm(x) }() => x)` the same shape
   PASSED `yo check`, while `g := cond(...); g` and `return(f)` were rejected with
   E0909 "... second-class and cannot be returned". The emitted C stored
   `&(__yo_v_x)` — the dead frame's parameter — in the returned closure.

Every shape reproduced: `cond` and `match` tails, guarded `match` arms, a `cond`
nested in a `match` arm, `return(cond(...))`, a closure-literal function
(`mk := (fn(...) -> Impl(Fn() -> i32))(...)`) and a generic function
(`fn(generic(T : Type), x : T, ...) -> Impl(Fn() -> T)`).

## Root cause

A function body is evaluated with its declared result as the expected type
(`src/evaluator/context.yo`, `create_function_body_evaluation_context`), so the tail
join sees `Impl(Fn() -> i32)`: a `SomeT` whose required traits include a
`FnTraitT`. The joins adopt a "concrete" expected type as their result type in
place of the arms' unified type:

- `src/evaluator/exprs/cond.yo` (three sites: the comptime-chosen arm with and
  without control flow, and the runtime join) gated on
  `!type_contains_some_type_deep(et.ty)`;
- `src/evaluator/exprs/match.yo` `_arm_result_type` gated on
  `!type_contains_some_type(et.ty)`.

`type_contains_some_type` deliberately counts an `Impl(Fn)` / `Impl(Future)`
SomeT as CONCRETE (`src/types/utils.yo`: it lowers to the value's capture struct
/ state machine, and the codegen gates must not skip such types). That carve-out
is right for codegen gates and wrong for a branch join: the join's result became
the unresolved existential, so

- codegen typed the result temp `void*` (the unresolved Impl), and
- the body's `ExprInfo.ty` no longer named the closure's capture struct, so
  `type_is_second_class` (keyed by the capture struct id in
  `g_capture_borrows`) found no borrow and the function-result check in
  `src/evaluator/calls/function_type.yo` (`reject_second_class_escape(ub_ty,
  "returned", ...)`) passed. The same held for `return(...)`'s argument.

A block tail (`g := cond(...); g`) was immune because the binding carries the
arm's concrete type.

## Fix

`type_mentions_impl_fn_or_future` (`src/types/utils.yo`): does a type mention an
`Impl(Fn...)` / `Impl(Future...)` SomeT anywhere (resolved or not)? The four
join sites adopt the expected type only when it is concrete AND mentions no such
existential, so an `Impl` expected type never replaces the arms' concrete type.
The join's type is then the closure's capture struct, which gives codegen the
right C type and gives the second-class / `Impl` trait checks the real value
type. Not closure-specific: the rule is "an existential expected type never
replaces a concrete arm type".

## Tests

- `tests/closure.test.yo`: "a cond or match tail returns its arms' closure as an
  Impl(Fn) result" (cond, match, guarded match, nested, `return(cond)`, generic at
  two types, a fn literal) and "a closure returned through a cond tail keeps and
  releases its capture once" (Dispose counter).
- `tests/closure_capture_list.test.yo`: "second-class: a cond or match tail
  cannot return a borrowing closure" (cond, match, `return(cond)`).
- `tests/cli-cases/check-cond-tail-borrowing-closure-is-not-returned`: the
  module-level repro through `yo check` (a definition-time rejection a
  `comptime_expect_error` might not observe).
