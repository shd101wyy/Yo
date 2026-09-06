# A concrete function body is never checked against its declared result type

**Status: FIXED (2026-09-05, the lazy-top-level-bindings PR).** Surfaced twice while
probing plans/reference/LAZY_TOPLEVEL_BINDINGS.md: first as a body written `({ cond(...); })`
that emitted a C function with no `return`, then as a forced definition with a
`String` body and an `i32` result that `check` accepted.

## Symptom

All of these pass `yo check`:

```rust
a :: (fn() -> i32)(String.from("not an i32"));
b :: (fn() -> i32)(true);
f :: (fn(n : i32) -> i32)({
  (n * 2);
});
```

`a`/`b` reach codegen as `return <String>` / `return true` from an `int32_t`
function; `f` emits a function with no `return` at all:

```
error: non-void function does not return a value in all control paths [-Werror,-Wreturn-type]
```

Only a body whose evaluation UNIFIES with the expected type is rejected —
`c :: (fn(n : i32) -> String)(n + 1)` fails with "Cannot unify incompatible
types" because the operator call consults `ctx.expected_type`. A body that is a
plain value of the wrong type is never compared.

For `f`, the `unit` comes from the parser: a `{ ... }` block whose last token
before `}` is `;` gets a trailing unit appended (`src/parser.yo`, "add trailing
unit"), so `{ e; }` is `begin(e, ())` — the intended block semantics.

## Root cause

`try_to_implement_function_by_function_type` (src/evaluator/calls/function_type.yo)
runs the definition-time body trial for every concrete function, but the
return-type comparison existed only on the deferred-GENERIC path
(`checkDeferredGenericReturnType`, the `dg` trial). TS's concrete path relied on
the same unification-through-expected-type and had the same hole.

## Fix

After a successful concrete trial the body's type is compared with the declared
result (`are_types_compatible(body, result)`), skipping the shapes that
legitimately differ: a control-flow tail (`return`/`unwind` never falls
through), a SomeT on either side (resolved at specialization), a `void` result
(FFI declarations), a `Type`-kinded result (type constructors) and `inout`
results. The rejected definition is marked unemittable (a
`comptime_expect_error` wrapper discards its callers but the registration
already happened).

```
error: Function body has type `String`, but the declared result type is `i32`.
error: Function body has type `unit`, but the declared result type is `i32`. A `{ ... }` block whose last statement ends with `;` has the value `()` — remove the semicolon after the tail expression, or return the value explicitly.
```

## Verification

- `tests/lazy_toplevel_bindings.test.yo` — "unit-valued body against a non-unit result is rejected" and "body of the wrong type is rejected" (`comptime_expect_error`).
- `tests/cli-cases/check-forced-definition-error-attribution` — the mistyped body is reported when its definition is forced out of order.
- `check ./std`, `check ./src` and the byte-identity corpus are unchanged: the check never fires on a program that compiles today.
