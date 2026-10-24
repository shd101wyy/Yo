# A `ref` object with a compile-time-only field reaches codegen and emits invalid C

**Severity:** S3 — an invalid program gets a C compiler error instead of a
diagnostic: `ref(struct(x : Type))` is accepted by the evaluator, and its
constructor is emitted with an `// Unknown type: Type` parameter.

**Status:** OPEN — found 2026-10-24 by the adversarial review of
`feat/yo-cell-primitive-gen-a`. The cell primitive got its own check on that
branch (`__yo_cell(Type)` is rejected: "a cell's payload is a run-time value,
and Type exists only at compile time"); the `ref` object form is unchanged.
Not fixed.

## Reproducer

```yo
{ println } :: import("std/fmt");
RT :: ref(struct(x : Type));
main :: (fn() -> unit)({
  r := RT(x : i32);
  println("made");
});
export(main);
```

`yo compile p.yo -o p` with the develop binary (v0.2.68 tree, 54e94f11e):

```
p.c:895:1: error: invalid storage class specifier in function declarator
p.c:895:120: error: expected ')'
```

## Cause

`evaluate_struct_type` (`src/evaluator/types/struct.yo`) rejects a field list
only through `fields_have_incompatible_contexts`, which fires when a
compile-time-only field sits beside a run-time-only one. A reference object
is a run-time object whatever its fields are, so for `ref(...)` and
`atomic(ref(...))` a single compile-time-only field should be enough to
reject it, as `evaluate_cell_type` now does with
`type_is_comptime_only_full`.
