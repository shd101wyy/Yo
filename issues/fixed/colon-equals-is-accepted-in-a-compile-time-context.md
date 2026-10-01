# `:=` is accepted in a compile-time context and silently treated as `::`

**Severity:** S2 — an invalid program is accepted: a runtime declaration (`:=`, `(x : T) = v`) inside a compile-time function body compiles, and the docs taught `:=` as the idiom.

**Status: FIXED 2026-10-01.** Every runtime declaration form in a
compile-time context is error E1104, with a `yo fix` repair where one edit
fixes it.

## Rule

`:=` declares a **runtime** variable and `::` a **compile-time** one
(`docs/en-US/DESIGN.md`, "Variables"). A compile-time context has no runtime,
so a runtime declaration cannot appear there. Every variable is mutable, so a
compile-time local is still reassigned with `=` in a loop.

| Form | In a compile-time context |
| --- | --- |
| `x := v` | **E1104**; repair: `:=` → `::` |
| `(x : T) = v` | **E1104**; repair: `x` → `comptime(x)` |
| `x : T` (declaration without a value) | **E1104**; repair: `x` → `comptime(x)` |
| `inout(y) := x` | **E1104**, no repair: an `inout` binding aliases runtime storage, and a compile-time body has none (it was already rejected, as "`inout(name) :: ...` is not allowed", because the `:=` had been turned into `::`) |
| `x :: v`, `(comptime(x) : T) = v`, `comptime(x) := v`, `comptime(x) : T`, `given(x) := v` | allowed |
| `x = v` (reassigning an existing variable) | allowed |

## Reproducer

```rust
factorial :: (fn(comptime(n) : i32) -> comptime(i32))({
  result := i32(1);
  i := i32(1);
  while(comptime(i <= n), {
    result = (result * i);
    i = (i + i32(1));
  });
  return(result);
});

value :: factorial(10);
comptime_assert(value == i32(3628800));
```

`yo check` (0.2.47): `evaluator OK`. So was the same body with
`(result : i32) = i32(1);`. Written with `result :: i32(1); i :: i32(1);` it
checks and evaluates to `3628800`.

## Cause

CTFE evaluates a body with `ctx.force_compile_time_bindings = true`, and both
binding evaluators turned every runtime declaration into a compile-time one
under that flag (`src/evaluator/exprs/initialization_assignment.yo` for `:=`,
`src/evaluator/exprs/binding.yo` for `(x : T)`). A gate for "runtime variable
declaration in a compile-time only function body" existed in both files, but
it ran only when the flag was OFF, so it never fired during a call; it fired
(uncoded) only in a definition-time evaluation. `docs/en-US/CTFE.md`
documented the `:=` conversion as the design until #1087.

## What counts as a compile-time context

The body of a function whose DECLARED type returns a compile-time value: the
`result_is_comptime_only` return flag (`-> comptime(T)`) or a compile-time-only
result type (`Type`, `Expr`, `comptime_int`, …), i.e.
`is_function_type_and_returns_comptime_value`. "Declared" is read from the
type registered for the function value (`get_func_type(fid)`), falling back to
the context's `func_type` only for an unregistered value (the throwaway values
of definition-time trials); the innermost function body decides
(`in_compile_time_fn_body`, `src/evaluator/utils.yo`). Per site that sets
`force_compile_time_bindings`:

| Site | Context | Runtime declarations |
| --- | --- | --- |
| `calls/comptime_fn.yo`: calling a function declared `-> comptime(...)` | compile-time | **E1104** |
| `calls/function_type.yo`: the definition-time trial of such a body | compile-time | **E1104**, raised even when the body otherwise waits for its calls |
| `ctfe/ctfe_analysis.yo`: CTFE capability analysis of a RUNTIME function (a synthesized comptime type over the runtime function value) | runtime code evaluated early | allowed |
| `calls/comptime_fn.yo`: calling a `comptime_fn(f)` clone (built by `_build_comptime_clone`, now recorded by `mark_fn_ctfe_clone`) | runtime code evaluated early | allowed |
| `builtins/derive.yo`, `builtins/type_fns.yo`: generated code strings | not the body of a declared compile-time function | allowed (unchanged) |
| `builtins/comptime_expect_error.yo` | judged by the enclosing body | unchanged |
| `types/field.yo`, `calls/function_type.yo:1503`: flag reset / nested CTFE analysis | unchanged | unchanged |

A function literal nested in a compile-time body (a method of the struct a
`-> comptime(Type)` function returns, a closure) opens its own function-body
context and is judged by its own return type, so a runtime method keeps its
runtime locals. A `:=` inside `quote(...)` is generated code, not a binding
of the macro body, and stays legal.

## Fix

- `E_COMPTIME_RUNTIME_BINDING` = **E1104** (`src/diagnostics.yo`), with a
  bilingual `yo explain` entry whose bad/good pair shows both spellings
  (`src/diagnostics_registry.yo`).
- `in_compile_time_fn_body` (`src/evaluator/utils.yo`) decides the context;
  `mark_fn_ctfe_clone` / `is_fn_ctfe_clone` (`src/function_value.yo`), set in
  `_build_comptime_clone`, exclude `comptime_fn` clones.
- `evaluate_initialization_assignment` and `evaluate_binding` raise E1104
  BEFORE consulting `force_compile_time_bindings`; the old uncoded gates are
  gone.
- `calls/function_type.yo`: the deferred-body definition-time trial re-raises
  a swallowed E1104 at its own span, so a never-called compile-time function
  is reported too.
- `comptime(x) := v` now binds like `x :: v`. It used to fall through to
  destructuring and fail
  (`issues/fixed/comptime-name-colon-equals-is-parsed-as-destructuring.md`),
  which would have left the compile-time spelling of `:=` unusable once `:=`
  is rejected.

## Migration

Running the fixed compiler over `std/`, `src/` and `tests/` found **no**
runtime declaration in a compile-time context, for either spelling. The ~47
functions a text scan flagged for `:=` were all runtime code written after a
short compile-time function, nested runtime bodies, or `quote(...)` templates.
The only uses were the four CTFE examples in `docs/en-US/CTFE.md` /
`docs/zh-CN/CTFE.md` (fixed in #1087) and the deliberate
`comptime_expect_error(b := 12)` in `tests/fn.test.yo`, which now asserts the
E1104 message. A scan of `docs/` and `.github/` for typed and bare runtime
declarations inside compile-time function bodies found none.

## Verification

- `tests/comptime.test.yo`, "runtime declarations in a compile-time function
  body are E1104": `:=`, `(i : i32) = i32(0)`, `i : i32` and `inout(y) := x`,
  each inside `comptime_expect_error` and never called, so the
  definition-time path is what fires. Fails on the 0.2.47 seed (the expected
  error never happens).
- Same file, "compile-time locals in a compile-time function body stay
  mutable": `::`, `(comptime(i) : i32) = i32(0)`, `comptime(i) := ...` and
  `comptime(i) : i32`, each reassigned and its value asserted; a runtime
  method with `:=` and `(copy : T) = …` inside a `-> comptime(Type)` body; a
  runtime function with `:=` through `comptime_fn`; and a module-level
  `comptime(_ct_module_seven) := 7`.
- `tests/fn.test.yo`: the existing `b := 12` case asserts the E1104 message.
