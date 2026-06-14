# Codegen: tagged-enum (payload) value construction + match destructuring broken

## Status: FIXED 2026-06-14

Both bugs fixed: (1) value construction (strip leading dot in generate_comptime_value EnumVal arm so _enum_variant_index matches), (2) match destructuring (strip dot in _emit_destructure_binds + wire local_shadowed_variables + unwrap curly `_(...)` wrapper). Positional + curly forms both compile+run to "J". Corpus fixture tagged_enum.yo (curly form). Commits 4ab81e5a7 + 93f310812.

## Symptom

Tagged enums *with payloads* (e.g. `enum(Nothing, Just(v : i32))`) mis-compile
in two ways. Simple (fieldless) enums work fine (see
`tests/codegen-bootstrap/enum_match.yo`); this is specific to variants carrying
data.

Minimal repro (`src/tests/fixme.yo`):

```rust
pragma(Pragma.AllowUnsafe);
open(import("std/libc/stdio"));
Maybe :: enum(Nothing, Just(v : i32));
unwrap :: (fn(m : Maybe) -> i32)(
  match(m, .Nothing => i32(48), .Just({v}) => v)
);
main :: (fn() -> unit)({
  unsafe(_a := putchar(int(unwrap(Maybe.Just(i32(74))))));
});
export(main);
```

- **TS**: prints `J` (74), rc=0.
- **yo-self**: C compile FAILS: `use of undeclared identifier
  '_file____tmp__temp_1650'`.

## Two distinct bugs in the generated C

1. **Value construction drops the payload.** `Maybe.Just(i32(74))` emits
   `(__yo_enum_yo_id_3688){ .tag = __YO_ENUM_YO_ID_3688_JUST }` — the
   `.data = { .Just = { .v = 74 } }` is MISSING. (Same `generate_comptime_value`
   EnumVal tagged-union arm and/or the runtime variant-constructor path — the
   payload value (74) is not flowing into the EnumVal fields, OR the fields are
   present but the emitter's `any_field` check skips them.)

2. **Match destructuring doesn't bind the field.** The `.Just({v}) => v` arm
   emits `_temp_1651 = _temp_1650;` where `_temp_1650` (the bound `v`) is never
   declared. `_emit_destructure_binds` (match.yo:597) did NOT emit
   `int32_t <v> = (m).data.Just.v;`. Affects BOTH the curly `.Just({v})` and
   positional `.Just(v)` forms (tested — identical failure).
   - Related mechanism gap: `local_shadowed_variables` (FunctionGenerationContext,
     context.yo:62) is DEFINED but NEVER populated/consulted. TS's match
     destructuring declares the var with its source name, adds it to
     `localShadowedVariables`, and the body resolves the name to the local C var
     (not the evaluator's temp `variableName`). yo-self must wire this: populate
     in `_emit_destructure_binds`, consult in `generate_atom`'s variable path
     (before `get_variable_name_for_codegen`), and remove after the arm body.
     See `src/codegen/exprs/match.ts:309-378`.

## Investigation notes

- Simple enums (no payload) are FIXED (commit 70f9a4902 — the leading-dot strip).
- The payload-construction bug (#1) needs checking whether the EnumVal carries
  the field value at all (yo-self EnumVal fields are a RESTRICTED value enum:
  `ArrayList(enum(UnitVal, BoolVal, IntLit, FloatLit, StrLit, VarRef))` — an
  i32 arg becomes `IntLit("74")`, which should render; verify it's present in
  the EnumVal and that `can_optimize_as_simple_enum`/the tagged arm's
  `any_field`/field-type-unit checks aren't wrongly skipping it). Or the value
  is RUNTIME (i32(74) not folded) → a runtime variant-constructor codegen path,
  separate from `generate_comptime_value`.

## Validation

Differential: both compilers compile+run the repro to print `J`. Add corpus
fixture `tests/codegen-bootstrap/tagged_enum.yo` once green. Keep the 9 existing
fixtures green.
