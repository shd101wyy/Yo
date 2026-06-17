# Extern-C GLOBAL (stdout/stderr) emits undeclared `__yo_c_reserved_*`

**Status:** OPEN. Surfaced 2026-06-17 once the Gap-6 println specialization was
fixed (271d96e61) — now the only thing blocking `println`/`print`/`eprintln`
end-to-end. This is "Gap 3" (yo-self models `is_extern` only on the `Func`
TypeValue variant).

## Repro

`/tmp/pln.yo` (`println("hello")`) now specializes correctly, but its C references
`__yo_c_reserved_stdout`, which is never declared:
```c
fwrite(((void*)(str_bytes_ptr)), 1ULL, str_bytes_len, __yo_c_reserved_stdout);
```
Also `/tmp/cast.yo` (a plain `fwrite(..., stdout)` in main) hits the same — so it's
independent of generics/specialization.

## Root

`stdout`/`stderr`/`stdin` are `c_include("<stdio.h>", …, stdout : *(FILE), …)`
globals — extern-C VARIABLES whose type is `*(FILE)` (a Pointer), not a Func.
- c_include (c_include.yo:202-239) stamps `is_extern = "c"` / `extern_name` ONLY
  onto **Func** field types; a non-Func field (`stdout : *(FILE)`) falls through
  `_ => result.field_type` UNMARKED.
- Codegen's extern-C detection for a variable reference (utils/index.yo:818,
  `getVariableNameForCodegen` → `sanitize_for_c_identifier(variable.name,
  is_extern_c)`) computes `is_extern_c` only from a Func type's `is_extern`. For
  `stdout` (`*(FILE)`) it's false.
- `sanitize_for_c_identifier(s, is_extern_c=false)` sees `stdout` is a C reserved
  word/macro and prefixes it → `__yo_c_reserved_stdout`. The C `<stdio.h>` IS
  `#include`d (so the real `stdout` is in scope) — ONLY the name mapping is wrong.

TS avoids this by checking `variable.type.isExtern === "c"` on ANY type
(codegen/utils/index.ts:957-960).

## Fix options

1. Add `is_extern` (+ maybe `extern_name`) to the non-Func TypeValue variants that
   can be extern-C globals — at least `Pointer` (and possibly the scalar c-types).
   Then c_include stamps it like it does for Func, and the codegen detection works
   uniformly. Schema-touching (build-guided arity updates) but mirrors TS closely.
2. Add an `is_extern_c : bool` flag to `Variable`, set true by c_include for ALL
   fields (Func and non-Func), and consult it in `getVariableNameForCodegen` instead
   of (or in addition to) the type's Func-only `is_extern`. Localizes the change to
   Variable + two sites, but diverges from TS's type-based model.

Either way: validate the real C `stdout` is referenced (not `__yo_c_reserved_stdout`),
`println("hello")` prints `hello` matching TS, corpus + std sweep hold 94/58. Once
fixed, `println`/`print`/`eprintln`/`eprint` should all work end-to-end (their bodies
all use `fwrite(..., stdout/stderr)`).
