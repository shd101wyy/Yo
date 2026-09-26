# `compile` reports a derived error instead of the safe-code raw-pointer rejection

**Status: OPEN** (found 2026-09-26, while measuring `sizeof(Option(*T))` for
`plans/EVALUATOR_MEMORY_REDUCTION.md` Phase 3).

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

So some handler between the `Option(...)` comptime call and its argument's
evaluation catches the throw in `compile` without recording it, and falls back
to a placeholder. The evaluator has no compile-mode flag. One known structural
difference is that `run_compile` shares one `ExprInfoTable` across the prelude
and every module (`g_shared_expr_info_table`), while `check` does not. The
catching handler is not yet identified.

## Next step

Identify the handler that catches the argument's throw in `compile` (the
comptime-fn call path for `Option`, `src/evaluator/calls/`), and make it
propagate the error or record it the way the swallowing wrapper does. Then
add a CLI case that compiles the reproducer and pins the safe-code
diagnostic, since `comptime_expect_error` observes the swallowed throw either
way.
