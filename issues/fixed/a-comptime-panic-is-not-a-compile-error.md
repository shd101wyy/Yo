# A panic reached during compile-time evaluation is not a compile error

**Status: FIXED 2026-09-23** (branch `safe-mode-5-comptime-panic`,
`plans/SAFE_MODE.md` §14 R2).

## Symptom

A comptime function whose execution reaches `__yo_panic` does not fail the
compile with the panic's message. Measured on v0.2.39:

```rust
{ println } :: import("std/fmt");
LIMIT :: Option(i32).None.comptime_unwrap();
main :: (fn() -> unit)({
  println(`limit=${LIMIT}`);
});
export(main);
```

- `yo check main.yo` → `evaluator OK`, rc **0**.
- `yo compile main.yo` → fails in **clang**, far from the cause:

  ```
  error: use of undeclared identifier 'LIMIT'
  ```

- If nothing reads `LIMIT`, compilation succeeds (the failing constant is
  silently accepted).
- A free comptime function shows the same defect in a different form:

  ```rust
  f :: (fn(comptime(x) : i32) -> comptime(i32))(
    cond((x == i32(0)) => __yo_panic("boom at comptime"), true => x)
  );
  Z :: f(i32(0));
  ```

  fails with `Function body is not evaluated correctly. Expected to
  return(a compile-time known value.)`. The message `boom at comptime` is
  lost.

## Root cause

`evaluate_panic` (`src/evaluator/builtins/panic.yo`) treated every panic as
a runtime divergence. It annotated the call with the enclosing function's
return type and left `ExprInfo.value` as `.None` (a runtime value). Under
CTFE the body therefore produced no compile-time value. Each caller then
failed in its own way. The free-function path (`calls/comptime_fn.yo`)
threw the generic "not evaluated correctly" error. The method path
(`comptime(self)` methods such as `comptime_unwrap`) produced no value and
no error, so the lazily bound constant stayed unbound until codegen named
it.

## Fix

`evaluate_panic` throws `compile-time panic: <message>` at the panic site
when the panic is reached by a **live** compile-time execution. Liveness is
recorded on the function-body context (`FuncOrAsyncBlockCtx.ctfe_live`,
`ctfe_arm_depth`) by `calls/comptime_fn.yo` when it executes a body. A body
is live when:

- every argument of the call is known, and
- the call does not sit inside an untaken arm of an enclosing comptime body.
  `EvalContext.ctfe_untaken_arm_depth` counts the `cond`/`match` arms of
  comptime-result bodies that the execution does not take. A body is live
  only if that count still equals the depth at which the nearest live body
  entered (0 when no comptime body encloses the call).

The panic fires when its body is live and the count equals the body's entry
depth, which means no untaken arm of that body encloses it.

The first attempt required `ctx.is_executing && !is_validating_function_definition`,
and it was insufficient. Measured: it fired for module-level constants, but
`z := Option(i32).None.comptime_unwrap();` (or `z :: …`) inside `main`, and
the same call inside a runtime `cond` arm, still passed `check` and failed
only in clang. That comptime execution happens in a validating context. (A
`comptime_assert` in the same positions does fire, measured; its path was
not investigated.) The arms of a runtime body are not counted on purpose:
codegen needs the value of a comptime call there whether or not the arm
runs.

Controls that must stay green, each measured:

- a comptime fn whose untaken `.None` arm contains a failing nested
  comptime call, called with `.Some`;
- a comptime fn with a failing arm that is never called with the failing
  input;
- `comptime_unwrap` on `.Some`.

This is the "comptime carve-out" of `plans/SAFE_MODE.md` §3 0c, re-measured:
`unwrap` is not comptime-evaluable at all, and the comptime spelling
(`comptime_unwrap` / `comptime_unwrap_err`) is already legal in safe files.
What D7 was missing was the "checked at compile time" half, and this
supplies it.

## Regression test

- The cli-case `tests/cli-cases/comptime-panic-is-a-compile-error` runs `yo
  check` on the fixture above. It expects rc 1 and
  `compile-time panic: Called comptime_unwrap on a None value`. Before the
  fix the same `check` returned rc 0.
- `tests/comptime_option_result.test.yo` covers `comptime_unwrap` on
  `.None` / `.Err` (`comptime_expect_error`) inside a test body. That is the
  runtime-body shape, and the batch fails to compile under v0.2.39. It also
  covers the free-fn taken and untaken panic arms.
