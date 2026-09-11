# `c_include` cannot express a by-value C struct

**Status:** FIXED 2026-09-11 — `c_include` type ADOPTION
(`src/evaluator/exprs/c_include.yo`), the adoption registry
(`src/types/guards.yo`) and its use at type registration
(`src/codegen/types/collection.yo`).
**Reported in:** PR #565, which described the four pieces but landed none of
them; the branch carried an unrelated export-naming change instead.

## Symptom

A C library's by-value struct — the shape raylib, SDL, and most C libraries are
built around — had no spelling at all. The 0.1.x form declared the mirror
struct inside the `c_include` body:

```rust
c_include "<raylib.h>",
  (Color : Type) = struct(r : u8, g : u8, b : u8, a : u8),
  DrawText : fn(...) -> unit,
```

and every current spelling of that intent was rejected:

| spelling | result |
| --- | --- |
| `(Name : Type) = struct(...)` inside `c_include` | `evaluate_module_field: assigned value form is not yet supported (Phase 3)` |
| `Name := struct(...)` inside `c_include` | same |
| `Name :: struct(...)` inside `c_include` | `Cannot use "::" for module field` |
| bare `Name : Type` inside `c_include` | compiles, but the type is an opaque handle — **unconstructible** |
| `Name :: struct(...)` at module level, `Name : Type` in `c_include` | the `c_include` field OVERWROTE the real type with the opaque handle |

The last row is the one that looks like it should work, and its failure is the
bug:

```
error: evaluate_function_call: TypeVal SomeT callee without FnTrait (Phase 4)
  --> byval.yo:14:8
   |
14 |   a := Vector2(x : f32(1.5), y : f32(2.5));
   |        ^^^^^^^
```

Declaring the struct at module level and NOT naming it in the `c_include` gets
past the evaluator and then fails in C: the argument lowers to the mangled
`__yo_tN`, which is a different type from the header's:

```
passing '__yo_t0' to parameter of incompatible type 'Vector2'
```

This regressed the raylib_yo / tetris_yo example projects (35 structs, ~106
by-value signatures in raylib_yo alone), and there is no workaround that
preserves the C ABI.

## Root cause

`c_include`'s `Name : Type` field always created an extern-C OPAQUE type — a
`SomeT` placeholder — and bound the name to it, exactly as `extern("Yo", X :
Type)` does. That is right for a handle (`pid_t`, `FILE`), and wrong for a
struct the Yo program has to CONSTRUCT: the placeholder has no constructor and
no fields.

Codegen had the other half of the gap. A collected type's C name is interned to
`__yo_t<N>` unconditionally (`_intern_type_c_name`), with the note "Gap 3:
extern-C names not modelled generally" — TS carries `type.isExtern` /
`type.externName` on the type itself and returns the plain name from
`getTypeString`, which yo-self's `TypeValue` has no field for.

## Fix — adopt, don't shadow

`c_include("<header>", Name : Type, …)` where `Name` ALREADY names a module type
does not declare a new type. It says **this Yo type IS that C type**. So:

1. **Evaluator** (`c_include.yo`): if the label resolves to a type value with a
   declaration id (a `struct(...)` or `enum(...)` written in Yo), keep that type
   as the field's value instead of replacing it with a placeholder, and record
   the adoption.
2. **Registry** (`types/guards.yo`): `register_adopted_extern_c_type` /
   `get_adopted_extern_c_type`, keyed by the type's declaration id — the one
   identity the evaluator and codegen can both read off a `TypeValue` without
   agreeing on codegen's structural `type_key`. This is the stand-in for TS's
   `isExtern` / `externName` fields, in the same shape as the neighbouring
   `g_extern_type_names`.
3. **Codegen** (`types/collection.yo`): an adopted type registers under the
   header's name with its header as the entry's `c_include`.

Nothing else needed changing, because the rest of the pipeline was already
built for a type that comes from a header and merely never saw one:

- `collect_c_includes` emits the `#include` for any type entry with a
  `c_include`;
- every declaration pass (`generate_type_declarations` and the three others)
  already skips forward declarations and bodies for such an entry;
- `get_type_string` reads the registered C name, so struct lowering, compound
  literals (`(YoTestPoint){ .x = …, .y = … }`), parameters and return types all
  follow with no further change.

A `union(...)` carries no declaration id and is not adopted; neither is a
`SomeT`, which would be adopting a placeholder as itself.

## Regression test

`tests/c_include_struct_by_value.test.yo`, with its header beside it
(`tests/c_include_struct_by_value.h` — the test batch's generated `.c` is
emitted in that directory, so a quoted include resolves with no `-I`). It
covers the five things that were broken or at risk: the adopted type is still
constructible; a Yo-built value crosses INTO C by value and the C function
reads both fields; a value returned FROM C by value is readable in Yo; a value
round-trips; and the adopted type is otherwise an ordinary Yo value (assignment,
Yo function parameter and return, untouched original).
