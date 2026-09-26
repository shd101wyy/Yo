# `compile` reports a derived error instead of the safe-code raw-pointer rejection

**Status: FIXED** (found and fixed 2026-09-26, while measuring `sizeof(Option(*T))`
for `plans/EVALUATOR_MEMORY_REDUCTION.md` Phase 3).

## Symptom

A raw pointer type named inside a function body of a safe file (no
`pragma(Pragma.AllowUnsafe);`) is rejected by `yo check` with the right
diagnostic. `yo compile` rejects the same file, but reports an unrelated
error instead of the real one:

| Body of `main` (safe file) | `yo check` | `yo compile` |
| --- | --- | --- |
| `a := sizeof(*(i32)); println(a);` | `Raw pointer types ('*(i32)') are not available in safe code.` | `error[E0401]: Variable "println" not found.` (with `{ println } :: import("std/fmt")` present) |
| `a := sizeof(*(i32));` | same | `internal compiler error: Failed to transpile part of main's body` |
| `(p : Option(*(i32))) = .None; println(1);` | same | `Expected "comptime" for compile-time known value binding: Comptime` |

At module level (`P :: *(i32);`), both commands report the rejection
correctly. With `pragma(Pragma.AllowUnsafe);`, all three bodies compile and
run (`sizeof(*(i32))` is 8), so safe code does NOT get raw pointers. This is a
diagnostics bug, not a safety hole. It is reproduced on v0.2.43 and on the
tree at b9fbb6118.

## Reproducer

```rust
{ println } :: import("std/fmt");
main :: (fn() -> unit)({
  println(0);
  (p : Option(*(i32))) = .None;
  println(1);
});
export(main);
```

```
$ yo check repro.yo      # error: Raw pointer types ('*(i32)') are not available in safe code.
$ yo compile repro.yo    # error: Expected "comptime" for compile-time known value binding: Comptime
```

## What is established

Found with a probe build (traces at the top of `_evaluate_expression` and in
`evaluate_raw_pointer_call`, `src/evaluator/calls/pointer.yo`):

- Both commands take the same evaluation path: the binding, then
  `Option(*(i32))`, then `Option`, then `*(i32)`, then `i32`.
- Both enter `evaluate_raw_pointer_call` with `unsafe_context = false`, outside
  a definition-time trial, with the same CTFE flags (`is_analyzing_ctfe_capability`,
  `force_compile_time_bindings` and `is_executing` all false), and both reach the
  `exn.throw` of the safe-code gate.
- In `check`, the throw reaches the swallowing `evaluate_expression` wrapper
  (`[swallow]` under `YO_DEBUG_SWALLOW=1`). The binding's rhs then has no
  `ExprInfo`, and `format_eval_failure` reports the recorded cause.
- In `compile`, no `[swallow]` is recorded. `Option(*(i32))` still yields a type,
  a placeholder bound by the prelude `Comptime` trait, and the binding rejects
  that type. In the `sizeof` shape, the next statement's environment is the
  prelude's (`[var-miss] name=println env_module=…/std/prelude.yo`), because
  `evaluate_size_of` adopts the env of the argument's `ExprInfo`.

## Root cause

A second probe build traced every exception handler in the evaluator that
caught the rejection. In both commands the throw goes to the call trap in
`evaluate_function_call`, which rethrows it, and then to the swallowing
`_evaluate_expression_wrapper`, which returns `make_err_expr()`. The caller
(the binding's rhs, the `sizeof` argument) tests for failure by that node
having no ExprInfo, and reports the recorded cause through
`format_eval_failure` when it has none.

`make_err_expr()` is an `Atom` with id **0**, and `g_next_global_expr_id`
also started at 0, so the first node ever parsed (the prelude's) shared the
sentinel's id:
- `check` keeps a table per module, so the user module's table has nothing at
  id 0, the test works, and the cause is reported.
- `compile` shares one table across the prelude and every module, so id 0
  holds the prelude node's info. The failed rhs "evaluated" to it (a type bound
  by `Comptime`), and `sizeof` adopted its env, the prelude's.

A probe on the fixed tree also found a write to id 0: compiling
`tests/closure.test.yo` stores a `fn(...) -> Box(V)` type through a fallback
`make_err_expr()` node. With a shared table, such a write makes the next
failure test in any module pass.

## Fix

- `src/expr.yo`: `g_next_global_expr_id` starts at 1, so no node shares the
  sentinel's id.
- `src/expr_info.yo`: `expr_info_table_set` ignores id 0, so no write can give
  the sentinel an ExprInfo.

## Verification

Two CLI cases compile the reproducers and pin the safe-code diagnostic:
`tests/cli-cases/ptr-type-in-body-safe-code` (the binding shape) and
`tests/cli-cases/sizeof-ptr-type-in-body-safe-code` (the `sizeof` + `println`
shape). With a pre-fix compiler, both score "stdout_keep_match matched nothing".
The ICE shape (`a := sizeof(*(i32));` alone) reports the rejection too.
