# A ref-struct field named `header` collides with the RC header member in the emitted C

**Status: FIXED 2026-08-23 by RESERVING the name** (fix direction 2's spirit,
not the mangle of direction 1): `src/evaluator/types/struct.yo` rejects a
reference-struct field named `header` at declaration time, so `yo check` now
reports it with the field's own source location instead of the backend emitting
C that will not compile.

Why reserving rather than mangling: the mangle has to rename a C member
consistently across struct declaration, constructor parameters and body,
struct-literal emission, field access, `_ptr_field_access`, match
destructuring, `open()`, the traversal functions, dup/drop/dispose, and four
`box->${field}` sites in `src/codegen/functions/dyn.yo` — and a single missed
site reproduces this very bug or, worse, silently reads the wrong member. One
reserved name is the surgical fix. The mangle stays available as a future
upgrade if the name is ever wanted.

The reservation is deliberately narrow, and each edge has a test arm in
`tests/ref_struct.test.yo`: VALUE structs inject nothing and keep the name;
COMPTIME fields are erased from the C layout (`get_runtime_struct_fields`) so
`ref(struct(header :: 1))` stays legal; and the header's own members
(`ref_count`, `gc_flags`, `type_id`) are nested INSIDE it, so they never
collide and remain usable as field names. The rejection itself is gated by
`tests/cli-cases/check-ref-struct-header-field`, whose `stdout_keep_match`
asserts THE diagnostic rather than merely a failure (red-first verified: the
pre-fix binary produces no such message, so the case scores NO-GOLDEN).

## Symptom

Declaring a `ref(struct(...))` with a field named `header` emits invalid C:
the generated struct already carries the built-in RC header member
(`__yo_ref_header_small_t header;` / `__yo_ref_header_t header;`), so the
user field produces `error: duplicate member 'header'`, and every access of
the user field (`p.header`) emits `self->header`, which now resolves to the
RC header — cascading into incompatible-type errors at constructor
(`obj->header = header;`), traversal (`obj->header.data...`), and use sites.

```
error: duplicate member 'header'
error: assigning to '__yo_ref_header_small_t' from incompatible type '__yo_t0'
error: no member named 'data' in 'struct __yo_ref_header_small_t'
```

## Minimal reproducer (verified failing on develop HEAD 342092b7c)

```rust
{ String } :: import("std/string");
P :: ref(struct(header : String));
main :: (fn() -> unit)({
  p := P(header : String.from("x"));
  _y := p.header.len();
});
export(main);
```

`yo compile repro.yo --release -o repro` → 6 C errors, all the classes above.
`yo check` passes — the evaluator has no reserved-field notion; the collision
is purely a codegen namespace clash.

## Root cause

The C layout emitter gives every reference struct a first member literally
named `header` (the RC header), and field labels are sanitized via
`sanitize_for_c_identifier` with no reserved-name check, so a user field
`header` maps to the same C identifier. Field-access emission likewise
renders `->header` with no disambiguation.

## Fix directions (not yet attempted)

1. **Mangle the user field**, not the runtime member: a reserved-C-member
   check in the field-label → C-name mapping (`header` → e.g. `header_u42_`),
   applied consistently at struct declaration, constructor parameters,
   literal initialization, and field access — the same choke points that
   already share `get_runtime_struct_fields`/`sanitize_for_c_identifier`.
2. Or rename the runtime member to a reserved identifier (`__yo_hdr`) —
   touches every runtime literal and constructor/traversal emitter, much
   larger blast radius.

Option 1 is the surgical one. Until fixed, avoid `header` as a ref-struct
field name (the chunk assembler renamed its field to `header_text` —
src/codegen/chunk_assembly.yo).

## Test to add with the fix

A `tests/` case declaring a ref struct with fields named `header` (and for
completeness `ref_count`, which lives INSIDE the header struct and does not
collide today) that constructs, reads, and drops the value.
