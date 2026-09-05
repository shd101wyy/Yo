# `dyn(String.from(...))` as a fn's BARE TAIL loses the payload type and emits an unmangled C identifier

**Status:** OPEN
**Found:** 2026-09-05, building the over-rejection canary set for
`issues/fixed/dyn-does-not-check-that-the-value-implements-the-traits.md` (the
canary that models the compiler's own `exn.throw(dyn(...))` path).
**Severity:** crash-at-C-compile. `yo check` is clean; the build dies inside
clang on a C identifier that contains spaces, parentheses and `->`.

## Symptom

```rust
{ Exception } :: import("std/error");
open(import("std/string"));
open(import("std/fmt"));

// BARE TAIL body — no braces.
thrower :: (fn(exn : Exception) -> unit)(exn.throw(dyn(String.from(`plain string error`))));

main :: (fn(io : Io) -> unit)({
  handler := Exception(throw : (err -> { println(`caught: ${err}`); unwind(()); }));
  thrower(handler);
});
export(main);
```

`yo check` — clean. `yo compile … --optimize 2`:

```
out.c:451:29: error: expected ')'
  451 | } __yo_dyn_box_unknown_fn(T : Type) -> Type;
out.c:453:34: error: expected function body after function declarator
```

The payload type came out as the pretty-printed *unknown* type
`fn(T : Type) -> Type` and was pasted straight into C identifiers:

```c
typedef struct { __yo_ref_header_t header; void* value; } __yo_dyn_box_unknown_fn(T : Type) -> Type;
static const char __yo_typeid_unknown_fn(T : Type) -> Type = 0;
static const __yo_t10_vtable __yo_vtable_unknown_fn(T : Type) -> Type___yo_t10 = { … };
```

and the box constructor call is specialized on the same non-type:

```c
yo_id_3192_fn_T___Type_____Type_id_fn_T___Type_____Type_rtparam0_…((void*)(yo_id_2632))
```

## What separates it from the working shapes

Three one-line variants of the same program, all measured with the same binary
(`yo` built from `ddc3e38a4`):

| body | payload | result |
| --- | --- | --- |
| bare tail | `String.from("…")` | **invalid C** (above) |
| bare tail | `` `template` `` | compiles, runs |
| `{ … ; }` block | `String.from("…")` | compiles, runs |

So it takes BOTH the bare-tail body AND a payload that is a static method call
returning `Self`. `String.from` is `from : (fn(slice : str) -> Self)`
(`std/string/string.yo:102`); the `Self` evidently never resolves to `String` on
that path, and `dyn()` boxes the unresolved thing.

This is why the compiler itself never hits it: its ~1230 `exn.throw(dyn(…))`
sites are inside `{ … }` bodies, and the few bare-tail ones pass a template
string (`src/net/…`, `src/doc_command.yo:59`).

## Root cause (not yet isolated)

Not a `dyn()` bug per se — the payload's `ExprInfo.ty` is already the wrong type
by the time `evaluate_dyn_value` reads it. The two candidate sites are the
bare-tail return-type synthesis in `evaluator/values/anonymous_function.yo` and
the `Self`-returning static-method resolution. Note that
`_require_dyn_traits_implemented` (`evaluator/values/dyn.yo`) deliberately does
NOT reject here — `type_contains_some_type_deep` waves the unresolved payload
through as "undecidable" — so this issue is unchanged by that check.

There is a second, independent defect visible in the same output: codegen builds
C identifiers by pasting `type_to_string` output rather than a mangled type key,
so ANY type that reaches the dyn-box emitter without a key produces text that is
not a C identifier. A `type_key`-based name would have turned this into a wrong
answer rather than a parse error, but the guard is worth having either way.

## Reproducer

`issues/repros/` — the three-variant table above; the failing one is the first
row.

## Fix

1. Find why a bare-tail `String.from(...)` leaves the call's `ExprInfo.ty` as
   the comptime type-constructor function type instead of `String`.
2. Independently, make the dyn-box / typeid / vtable emitters
   (`src/codegen/functions/dyn.yo`) name themselves from `type_key`, and fail
   loudly (`codegen_fatal_expr`) rather than emitting `unknown_…` text.

## Regression test

`tests/dyn.test.yo`: the bare-tail `dyn(String.from("…"))` throw, plus the two
passing variants as canaries.
