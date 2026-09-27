# A recursive type definition has no indirection check — `check` is green and the C compiler reports the cycle

**Status:** FIXED 2026-09-27 (branch `tss/option-self-field`)
**Found:** 2026-09-26, while re-verifying `issues/fixed/option-self-field-on-environment-splits-into-two-c-types.md`
(fixed on develop) — probing the neighbouring shapes.

## Symptom

A type that names itself with NO indirection passes `yo check` and dies in the
C compiler:

```rust
// direct: a struct with itself as a field
Bad :: struct(n : i64, me : Self);
```

```rust
// through a constructor that EMBEDS its argument (Option of a value type is a
// tagged union, not a pointer)
EnvV :: struct(n : i64, memo : Option(Self));
first :: (fn(l : ArrayList(EnvV)) -> Option(EnvV))(l.get(usize(0)));
```

Measured on develop `37045aa56` (a develop-built binary): `yo check` reports
"evaluator OK" for both, and `yo compile --optimize 2` fails with

```
.c:819:33: error: field 'value' has incomplete type
.c:2215:72: error: invalid initializer
```

for the `Option(Self)` shape — the emitted C declares the struct inside itself.
The direct `me : Self` shape emits the same incomplete-type error.

## What a fix needs

A cycle check at definition (and at generic instantiation, where the cycle can
first appear for `struct(f : Option(T))`): walking the field types, a path back
to the type being defined is legal only through an INDIRECTING wrapper — `Box`,
`ref`, `atomic(ref)`, a raw pointer, an enum variant (the enum's data is behind
its own struct) — and illegal through an EMBEDDING wrapper: a struct field, a
tuple element, an `Option`/`Result` of a VALUE type, a fixed `Array`. The
error should name the cycle the way the existing `cyclic definition: a (line N)
→ b (line M) → a` note names binding cycles.

Note the tree's own rule for the reference-semantics case: a self reference on
a `ref(struct)` goes through `Box(Self)` (`Variable`'s
`is_owning_the_same_rc_value_as : Option(Box(Self))`); `ref(struct(...))` with
`Option(Self)` works today only because #943 lowered `Option(<ref struct>)` to
a bare nullable pointer — the evaluator split behind
`option-self-field-on-environment-splits-into-two-c-types` is gone, but a
VALUE type has no such collapse to hide behind.

## Resolution

**Fixed 2026-09-27** (branch `tss/option-self-field`), in two parts:

1. **The struct twin of the enum check**: `evaluate_struct_type`
   (`src/evaluator/types/struct.yo`) runs `_type_reaches_root_by_value` on every
   PATCHED field of a value `struct(...)`/`newtype(...)` (`ref(struct)` and
   `atomic(ref)` are exempt — pointer-sized) and throws
   `recursive value struct: field '<f>' contains the struct itself by value …`.
   The struct shell shares the final's `struct_id`, so the walker's Struct arm
   gained the root comparison the EnumT arm always had — without it, the
   shell's EMPTY field list hid direct `me : Self` cycles entirely.
2. **The walker's children now route through the indirection cut**:
   `_type_value_cycle_step` (`src/evaluator/types/enum.yo`) recursed via
   `recur`, which is the step function itself — so the
   `_type_is_ref_indirection` gate only protected the TOP of the walk, and
   `Box(Self)` inside a payload was cut only BY ACCIDENT (the pre-patch shell
   has no fields to walk). Every child walk now goes through
   `_type_reaches_root_by_value`, so a reference-semantics payload cuts BY
   RULE at every depth — which also makes the enum check's documented
   "cycles through ArrayList/Box/ref fields are cut" true as stated instead
   of true by luck of the empty shell.

Measured (all four, a built compiler): `struct(me : Self)` and
`enum(A(me : Self))` are rejected with their messages; `struct(next :
Option(Box(Self)))` and `enum(A(b : Box(Self)))` check clean. Gates:
`tests/type_soundness.test.yo` ("a value struct cannot reach itself by
value" + "a ref struct's Option(Self) survives a generic specialization"),
`check ./std` 176/176, `check ./src` 279/279, fixpoint, fast suite, CLI
corpus, `gates_fast`.
