# A non-finite comptime float constant emits invalid C (`inf.0`)

**Status:** FIXED 2026-09-08
**Found:** 2026-09-08, while giving `f64` the constants `plans/STD_API_STABILIZATION.md` §4 asks for (`EPSILON`, `INFINITY`, `NAN`, …).

## Symptom

```rust
{ println } :: import("std/fmt");
impl(f64, INFINITY : f64(1.0e400));
main :: (fn() -> unit)({
  println(f64.INFINITY.to_string());
});
export(main);
```

`yo check` passes. `yo compile` emits C that does not compile:

```
/tmp/fp9.c:1606:29: error: use of undeclared identifier 'inf'; did you mean 'if'?
 1606 |   double __yo_ref_spill_0 = inf.0;
      |                             ^~~
```

## Root cause

`generate_comptime_value`'s `.FloatLit(raw)` arm in
`src/codegen/exprs/comptime_value.yo`. The raw text comes from f64
`.to_string()`, which is C `%g` — and `%g` renders the non-finite doubles as
`inf`, `-inf`, `nan`, `-nan`. The arm decides whether the raw is already
float-typed in C by looking for a radix point or an exponent marker:

```rust
has_float_marker := (
  (raw.contains(".") || raw.contains("e")) || raw.contains("E")
);
base := if(has_float_marker, raw.clone(), { r := raw.clone(); r.push_str(".0"); r });
```

`inf` contains none of `.`, `e`, `E`, so it takes the integer-form branch and
becomes `inf.0`. `nan` becomes `nan.0`. Neither is C.

This is the SAME class as the bug the comment right above it already records
(an exponent-form raw becoming `1e+09.0`): the check asks "does this look like
a C float literal?" when the real question is "is this a finite number at
all?".

## Why it is reachable without writing `1.0e400`

Any comptime arithmetic that overflows the f64 range folds to infinity, and
`f64` constants are exactly what §4 asks the std to grow. It is also the only
spelling of `f64.INFINITY` available: the alternative — binding
`<math.h>`'s `HUGE_VAL` — is blocked by
`issues/c-include-global-does-not-emit-its-header.md`.

## Fix

Emit a portable C spelling for the three non-finite cases and register the
header they come from:

| value | f64 | f32 |
| --- | --- | --- |
| +infinity | `HUGE_VAL` | `HUGE_VALF` |
| -infinity | `(-HUGE_VAL)` | `(-HUGE_VALF)` |
| NaN | `((double)NAN)` | `NAN` |

`HUGE_VAL`/`HUGE_VALF`/`NAN` are C11 `<math.h>` macros (7.12/4, 7.12/5).
`(1.0/0.0)` is NOT a substitute: it is a division by zero in a context that may
require a constant expression.

**The header cannot be registered from the value generator.** The first cut
called `context.add_c_include("<math.h>")` right there and changed nothing —
`collect_c_includes`/`emit_c_includes` run in `codegen_c.yo` immediately after
the COLLECTION passes, long before any function body is generated, so the
include set has already been written out by then. `<math.h>` therefore joins
`<string.h>`/`<errno.h>`/`<fcntl.h>` in the unconditional base include set.

## Test

`tests/float_non_finite_constants.test.yo` — a comptime `INFINITY`/`NEG_INFINITY`/
`NAN` associated const on both `f64` and `f32`, each round-tripped through a
runtime comparison so the assertion cannot pass vacuously.
