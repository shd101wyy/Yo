# `:=` is accepted in a compile-time context and silently treated as `::`

**Severity:** S2 — an invalid program is accepted: a `:=` (runtime binding) inside a compile-time function body compiles, and the docs taught it as the idiom.

**Status: OPEN** (found 2026-10-01).

## Rule

`:=` declares a **runtime** variable and `::` a **compile-time** one
(`docs/en-US/DESIGN.md`, "Variables"; every variable is mutable, so a `::`
accumulator can still be reassigned). A compile-time context, such as the
body of a function whose parameters are `comptime(...)` and whose return type
is `comptime(...)`, has no runtime, so `:=` is not allowed there.

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

`yo check` (0.2.47): `evaluator OK`. Expected: an error at each `:=`, pointing
at `::`. The same body written with `result :: i32(1); i :: i32(1);` checks and
evaluates to `3628800`.

## Cause

CTFE evaluates the body with `ctx.force_compile_time_bindings = true`
(`src/evaluator/ctfe/ctfe_analysis.yo:223`), and the binding evaluator turns
every `:=` into `::` under that flag
(`src/evaluator/exprs/initialization_assignment.yo:468-469`,
`src/evaluator/exprs/binding.yo:228-229`). `docs/en-US/CTFE.md` used to
document this as the design ("Makes `:=` bindings store compile-time values
(behaves like `::`)"); that text and its four examples were corrected to `::`
when this doc was filed.

## Fix plan

1. Under `force_compile_time_bindings`, reject a `:=` written directly in the
   compile-time body with a coded diagnostic (and a `yo explain` entry, en +
   zh) suggesting `::`. A `:=` inside a nested **runtime** function literal
   (for example a method body in a struct that a `-> comptime(Type)` function
   returns) stays legal: the flag must not leak into those bodies, the way
   `src/evaluator/types/field.yo:337-343` already resets it for type field
   values.
2. Migrate the existing uses. A rough scan finds `:=` inside about 47
   comptime-returning functions (3 in `src/`, about 30 in `tests/`, the rest
   in docs). Many of those are nested runtime bodies, so the compiler with
   step 1, not grep, decides which to change.
3. Regression test: a `comptime_expect_error` case for the reproducer, plus a
   positive case for a nested runtime `:=`.
4. Seed gating: `src/` is built by the seed, so `src/` can only drop the
   pattern once the diagnostic exists, and must not rely on it before.
