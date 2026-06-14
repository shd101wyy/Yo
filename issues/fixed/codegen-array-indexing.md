# Codegen: array literal type-decl + indexing (Index trait, Phase 3)

## Status: FIXED 2026-06-14

Both gaps fixed: (1) collect_type now registers concrete-length array types up-front (get_type_string side-effect) so generate_array_struct_declarations emits the typedef before bodies reference it; (2) generate_other_function_call gained the isArrayType branch -> `<arr>.data[<i>]` (direct, NOT the generic Index trait, mirroring TS other-fn-call.ts:2731). Array literal + indexing + loop prints "HI!" under both compilers. Fixture array_index.yo.

## Symptom

Array literals + indexing don't compile in yo-self. Repro (`src/tests/fixme.yo`):

```rust
pragma(Pragma.AllowUnsafe);
open(import("std/libc/stdio"));
main :: (fn() -> unit)({
  a := [i32(72), i32(73), i32(33)];
  (i : usize) = usize(0);
  while(i < usize(3), {
    unsafe(_r := putchar(int(a(i))));
    i = (i + usize(1));
  });
});
export(main);
```

- **TS**: prints `HI!`.
- **yo-self**: C compile fails — two gaps:

## Two gaps

1. **Array-value struct type declaration not emitted.** The array literal emits
   `(Array_int32_t_3){ .data = { 72, 73, 33 } }` (via generate_comptime_value's
   ArrayVal arm, which calls get_type_string → register_array_struct_type), but
   the `typedef struct { int32_t data[3]; } Array_int32_t_3;` is never declared
   → `use of undeclared identifier 'Array_int32_t_3'`. The array-value type isn't
   reaching the type-declaration emission (collect_required_types / the
   array_struct_types pass in generate_type_declarations). Check whether
   collection registers array-VALUE types and whether the array_struct_types map
   is drained into the C output.

2. **Array indexing `a(i)` not transpiled** — `// Failed to transpile a(i)`.
   This is **Index-trait dispatch**, which generation.yo documents as a deferred
   Phase-3 branch ("Index-trait dispatch — Phase 3, generateIndexTraitCall not
   ported"). A value-call `x(i)` whose callee is an Array (or has an Index impl)
   must route to the Index trait method. Port `generateIndexTraitCall`
   (src/codegen/exprs/...) + the evaluator's `indexMethodValue` recording.

## Assessment

Arrays are effectively a Phase-2/Phase-3 boundary: construction needs the
array-type declaration (gap 1, likely a contained collection fix); indexing
needs the Index-trait emitter (gap 2, a documented Phase-3 deferral). The
non-generic, non-Index Phase-2 surface is otherwise well-covered (13
differential-PASS corpus fixtures as of 2026-06-14).

## Validation

Differential: both compilers print `HI!`. Add corpus fixture
`tests/codegen-bootstrap/array_index.yo` once green.
