# `::` accepts a `c_include`d extern global and emits an undeclared C name

**Status:** PARTIALLY FIXED 2026-09-08 — the `::` half is fixed, the ASSOCIATED-CONST half is not
**Found:** 2026-09-08, alongside `issues/c-include-global-does-not-emit-its-header.md`.

## Symptom

```rust
{ HUGE_VAL } :: import("std/libc/math");
{ println } :: import("std/fmt");
_INF :: HUGE_VAL;
main :: (fn() -> unit)({
  println(_INF.to_string());
});
export(main);
```

`yo check` passes; the emitted C references a name that was never declared:

```
/tmp/fp4.c:1606:51: error: use of undeclared identifier '_INF'
```

The same shape with an ordinary runtime value is correctly REJECTED, with a
good message:

```rust
gen :: (fn() -> i32)(runtime(i32(7)));
X :: gen();
```
```
Got runtime value. Please consider using ":=" instead of "::":
gen()
```

An associated const takes the same path and fails the same way, one layer
deeper in codegen:

```rust
impl(f64, INFINITY : HUGE_VAL);
...  f64.INFINITY ...
```
```
double __yo_ref_spill_0 = /* Error: no C type name for f64 */.INFINITY;
```

(a swallowed codegen error, emitted into the C as a comment rather than
raised as a Yo diagnostic — it fails as a C syntax error at a source position
that names neither the `impl` nor the use site). A user struct behaves
identically (`__yo_t10.LIMIT`), so this is not `f64`-specific.

## Root cause

A `c_include` field's value is `UnknownValue`, not "runtime". Per AGENTS.md,
an `ExprInfo.value` of `.None` means a RUNTIME value, while
`EvalValue.UnknownVal` means "the type is known, the value is not" — a
COMPTIME-shaped answer. The `::` guard tests for the `.None` case, sees
`.Some(UnknownVal)` and concludes the binding is comptime, so the
runtime-value diagnostic never fires and codegen is asked to emit a comptime
constant it does not have.

## Fix

An identifier that resolves to a registered extern-C global
(`is_extern_c_global` + the declared-type match `get_variable_name_for_codegen`
already uses to avoid catching a shadowing local) is a RUNTIME value: annotate
its `ExprInfo.value` as `.None`. That restores the existing "use `:=`"
diagnostic for `::` and for associated consts, and leaves `v := HUGE_VAL`
working as a runtime read.

Note this fix ALONE leaves `v := HUGE_VAL` emitting an undeclared name until
`issues/c-include-global-does-not-emit-its-header.md` is fixed too; the two
are independent halves of using a c_include constant at all.

## What the fix covers, and what it does not

A `c_include` field that is NOT a function is now built with
`create_runtime_unknown_val_with_name` (`src/evaluator/exprs/c_include.yo`), so
`::` sees a runtime-only unknown and raises the right error:

```
error: Expected compile-time value for "_INF".
Got runtime value. Please consider using ":=" instead of "::":
HUGE_VAL
```

Extern FUNCTIONS keep the plain unknown, because codegen identifies a
`c_include` callee by exactly that value shape
(`_register_extern_fn_callee`'s "callee value present but not a function
value" arm).

**The associated-const path is UNCHANGED and still emits invalid C:**

```rust
impl(f64, INFINITY : HUGE_VAL);
```
```
double __yo_ref_spill_0 = /* Error: no C type name for f64 */.INFINITY;
```

So the impl field loop does not run its member initializers through the same
comptime guard `::` uses — it accepts a runtime-only unknown and leaves codegen
to emit a field access on a TYPE. That guard is what remains to be written, and
it should produce the same "use `:=`" diagnostic, worded for an `impl` member.

Note the emitted text is a SWALLOWED codegen error pasted into the C as a
comment, so the failure surfaces as a C syntax error at a position that names
neither the `impl` nor the use site — worth fixing on its own account.

## Test

`tests/c_include_global_header.test.yo` for the runtime read. The `::`
rejection wants a `comptime_expect_error` case; the associated-const rejection
wants one too, once the guard exists.
