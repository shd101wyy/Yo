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
when all of the following hold:

- the context is **executing** (`ctx.is_executing`),
- the context is inside a CTFE call (`ctx.ctfe_depth > 0`),
- the context is not validating a definition, and
- the enclosing function body is one whose declared return is `comptime(...)`
  (`FuncMeta.result_is_comptime_only`).

`cond` and `match` already clear `is_executing` in every arm the execution
does not take, so only a panic that is actually reached fires. A runtime
function body nested inside a comptime call has its own non-comptime
`fn_ctx`, so its panics stay runtime panics.

This is the "comptime carve-out" of `plans/SAFE_MODE.md` §3 0c, re-measured:
`unwrap` is not comptime-evaluable at all, and the comptime spelling
(`comptime_unwrap` / `comptime_unwrap_err`) is already legal in safe files.
What D7 was missing was the "checked at compile time" half, and this
supplies it.

## Regression test

The cli-case `tests/cli-cases/comptime-panic-is-a-compile-error` runs `yo
check` on the fixture above. It expects rc 1 and
`compile-time panic: Called comptime_unwrap on a None value`. Before the fix
the same `check` returned rc 0.
