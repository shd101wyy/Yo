# A default parameter value that is not compile-time known emits invalid C

**Severity:** S2 — a default the language forbids (a runtime call) passes the evaluator and fails later in the C compiler with an internal-looking error, instead of a diagnostic at the definition.

**Status:** FIXED (#1165). Found 2026-10-03 alongside
`issues/fixed/a-default-parameter-value-resolves-names-in-the-callers-module.md`.

## Reproducer

```rust
{ println } :: import("std/fmt");
seven :: (fn() -> i32)(i32(7));
g :: (fn((x : i32) ?= seven()) -> i32)(x);
main :: (fn() -> unit)({
  println(`g() = ${g()}`);
});
export(main);
```

`yo compile main.yo -o a.out`:

```
a.out.c:2254:150: error: expected expression
  int32_t _file____tmp__temp_… = (((int32_t (*)())/* Error: no C function name for func value yo_id_… */)());
yo: error: compile: C compiler failed (exit 1) on a.out.c
```

## Root cause

DESIGN §Default parameter values says "Default parameters must use
compile-time known values", but nothing checks it. The definition records
an unknown value for `seven()`, and then codegen re-emits the default
expression at the call site (the mechanism in the companion issue), where the
function value has no C name.

## Fix direction

At definition time, reject a default whose evaluated value is not known at
compile time, with a registered diagnostic that names the parameter and
suggests `Option(T) ?= .None` plus a branch in the body. With that check and
the companion fix (emit the recorded value), call sites never re-evaluate a
default.

## Test

A `comptime_expect_error` (or a cli-case) for the rejected definition, plus
the repro's shape with a compile-time default that still runs.
