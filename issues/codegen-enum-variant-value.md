# Codegen: simple-enum variant VALUE emits malformed `base.GREEN`

## Status: OPEN (yo-self codegen, found 2026-06-14)

## Symptom

A fieldless enum-variant used as a **value** (e.g. `Color.Green` passed as a
call argument) generates malformed C.

Minimal repro (`src/tests/fixme.yo`):

```rust
pragma(Pragma.AllowUnsafe);
open(import("std/libc/stdio"));
Color :: enum(Red, Green, Blue);
code :: (fn(c : Color) -> i32)(
  match(c, .Red => i32(82), .Green => i32(71), .Blue => i32(66))
);
main :: (fn() -> unit)({
  unsafe(_a := putchar(int(code(Color.Green))));
});
export(main);
```

- **TS** (`./yo-cli compile`): prints `G` (rc=0). Emits
  `code((__yo_enum_..._id_3)(__YO_ENUM_..._ID_3_GREEN))` — cast + bare constant.
- **yo-self** (`/tmp/yo-self-bin compile`): C compile FAILS with
  `use of undeclared identifier '__YO_ENUM_YO_ID_3688_'` /
  `member reference base type 'int' is not a structure`. Emits
  `code((__yo_enum_yo_id_3688)(__YO_ENUM_YO_ID_3688_.GREEN))` — the inner value
  is the malformed `__YO_ENUM_YO_ID_3688_.GREEN` (a `base.MEMBER` field-access
  shape) instead of the bare constant `__YO_ENUM_YO_ID_3688_GREEN`.

The `match` itself is fine — `code`'s switch uses `__YO_ENUM_..._GREEN`
correctly. Only the variant-as-value expression is wrong.

## Diagnosis so far (instrumented, probes reverted)

- `(Color.Green)` reaches `generate_func_call` (generation.yo) with a
  **known** (non-UnknownVal) comptime value — so the comptime-value fast path
  (`generation.yo:294`, `match(ei.value, .Some(v) => if(!unknown && !unit &&
  !control_flow, return generate_comptime_value(v, ei.ty)))`) should fire and
  call `generate_comptime_value(<value>, Color)`.
- `generate_comptime_value`'s `.EnumVal` arm, for a simple enum, returns
  `get_enum_variant_c_name(ty, variant, ctx)` = the correct bare constant
  `__YO_ENUM_..._GREEN`. `get_enum_variant_c_name` itself is correct
  (verified — it uppercases `c_name + "_" + variant`).
- So the malformed `base.GREEN` output is NOT produced by any
  `generate_comptime_value` arm I read. **Next step: determine the actual
  value KIND of `Color.Green`** (is it `EnumVal`? `TypeVal`? something that
  hits `generate_field_access`'s fallthrough `out + "." + sanitize(field)`
  branch at property_access.yo:334-339?). The `base.MEMBER` shape strongly
  matches that fallthrough — so likely `Color.Green` is NOT reaching the
  comptime-value path (despite valkind=known) and instead hits
  `generate_field_access`, whose enum-variant routing (`_typevalue_enum_access`
  vs `_enum_field_access` vs fallthrough) mis-selects for a simple-enum
  TypeVal receiver.
- A probe to print the value kind via `is_type_value`/`is_struct_val` hit a
  yo-self type-inference quirk (`is_type_value` param "opt" unify error) —
  use direct `match(v, .EnumVal(..) => .., .TypeVal(..) => .., ..)` with
  `EvalValue` imported instead.

## Likely fix area

`yo-self/codegen/exprs/property_access.yo` `generate_field_access`
cond (line 317): for a TypeVal-enum receiver whose variant is fieldless AND
the enum `can_optimize_as_simple_enum`, emit the bare constant
`get_enum_variant_c_name(...)` (NOT the `_typevalue_enum_access` compound
literal, which is for tagged enums, and NOT the generic `base.field`
fallthrough). Cross-check against TS `generateFieldAccess`'s enum-variant
handling for simple vs tagged enums.

## Validation

Differential: both compilers compile+run `fixme.yo` to print `G`. Add a
corpus fixture `tests/codegen-bootstrap/enum_match.yo` once green. Keep the
existing 6 fixtures green.
