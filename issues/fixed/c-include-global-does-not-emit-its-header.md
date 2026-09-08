# A `c_include`d extern GLOBAL does not emit its header

**Status:** FIXED 2026-09-08
**Found:** 2026-09-08, while giving `f64` the constants `plans/STD_API_STABILIZATION.md` §4 asks for.

## Symptom

```rust
{ HUGE_VAL, M_PI } :: import("std/libc/math");
{ println } :: import("std/fmt");
main :: (fn() -> unit)({
  println(M_PI.to_string());
});
export(main);
```

`yo check` passes. `yo compile` emits C referring to a name it never declared:

```
/tmp/fp5.c:1641:14: error: use of undeclared identifier 'HUGE_VAL'
```

`grep -c 'math.h' fp5.c` → **0**. The header is simply not `#include`d.

The mirror case works:

```rust
{ sqrt : _c_sqrt } :: import("std/libc/math");
...unsafe(_c_sqrt(x))...          // math.h IS included; program runs
```

So `<math.h>` arrives if and only if some FUNCTION from it is called.

## Root cause

Header collection has exactly two sources
(`collect_c_includes`, `src/codegen/c/collection.yo`): `context.types` and
`context.extern_functions`. The extern-function registry is populated by
`_register_extern_fn_callee` (`src/codegen/functions/collection.yo:262`),
whose first act is

```rust
match(cei_ty, .Func({ meta : __fm4 }) => ..., _ => ())
```

— it only ever fires for a `.Func` type. A c_include'd GLOBAL is not a `Func`,
so nothing registers its header.

The evaluator half is the same shape: `evaluate_c_include`'s field loop calls
`record_c_include_for_extern(label, header)` INSIDE the `.Func` arm of the
`field_ty_with_extern` match (`src/evaluator/exprs/c_include.yo:223`), while
`register_extern_c_global` is called for every field
(`src/evaluator/exprs/c_include.yo:300`). So a global is registered as a
global, but its header is never recorded anywhere.

## Why nobody hit it before

`g_extern_c_globals`' own doc comment states the assumption that makes it
invisible — *"the C header is `#include`d, so the real `stdout` is in scope"*
(`src/expr_info.yo:832-838`). That happens to hold for the globals the tree
actually uses: any program touching `stdout`/`stderr`/`stdin` also calls
`fprintf`/`fputs`/`fflush` from the same `<stdio.h>`, and the FUNCTION pulls
the header in. `<math.h>`'s constants have no such companion — `HUGE_VAL`,
`M_PI` and friends are the first c_include globals in the tree whose header is
not already dragged in by a call.

## Fix

Two halves, mirroring how functions already work:

1. **Evaluator** — record the header for EVERY c_include field, not only the
   `.Func` ones: hoist `record_c_include_for_extern` out of the `.Func` arm.
2. **Codegen** — register the header when a referenced identifier resolves to
   an extern-C global, so the include is emitted for globals that are actually
   USED (the same precision the extern-function path has; registering every
   global of every imported c_include module would over-include).

   This must happen in the COLLECTION pass, not at emission. The first cut put
   it in `atom.yo`'s `_var_read_code` — the one chokepoint where an extern-C
   global's real C name is chosen — and it changed nothing, because
   `emit_c_includes` has already run by the time any body is generated. It now
   lives in `find_function_calls_in_expr`'s `.Atom` arm
   (`src/codegen/functions/collection.yo`), beside
   `_register_extern_fn_callee`, which is where the function path does the same
   job.

## Test

`tests/c_include_global_header.test.yo` — read a `<math.h>` constant with no
call to any math function in the program, and check the value.

## Still broken, separately: an rvalue-macro constant cannot be addressed

With the header emitted, `v := HUGE_VAL` and comparisons work. Using such a
constant as an `inout(self)` RECEIVER still does not:

```
error: cannot take the address of an rvalue of type 'double'
   __yo_t5 _tmp = yo_id_6843((&(M_PI)));
```

A `c_include` field is declared as though it names an extern OBJECT, but many
of these are MACROS expanding to an rvalue (`M_PI` → `3.14159...`), so `&` is
invalid — while `stdout` is a real object and `errno` is a macro expanding to
an LVALUE. See
issues/c-include-rvalue-macro-constant-cannot-be-addressed.md.
