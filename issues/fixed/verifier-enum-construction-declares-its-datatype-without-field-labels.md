# Verifier: an enum construction declared its datatype without the field labels, so a later `match` named undeclared accessors

**Severity:** S3 — `yo verify` reported a solver error (z3 "unknown constant …_Green_v") for a body that builds a payload variant and then matches on it by field.

- **Status:** FIXED on `fix/verifier-cond-arm-construction` (2026-10-01).
- **Component:** `src/verifier/vc.yo` — `_build_enum_ctor`.

## Reproducer (measured on the same branch, after the final-arm fix)

`payload_read` in `tests/spec/fixtures/valid/variant_payload_construction.yo`:

```
SOLVER-ERROR  z3 rejected the script: (error "line 8 column 339: unknown constant
__yo_denum_decl_valid__variant_payload_construction_Color_r0c9_Green_v (…Color_r0c9) ")
```

Before #1050 this would have been reported as REFUTED.

## Root cause

`_build_enum_ctor` registered the datatype through `_note_enum_datatype`
with a SYNTHETIC `EnumT`: right id, names and fields, but an empty
`variant_field_labels`. The first registration of a datatype name wins, so
the declared accessors were not the labelled ones (`…_Green_v`) that the
match lowering (`_variant_accessors`) projects through.

## Fix

Register the construction's own enum type (`info.ty`, labels included).
Pinned by `payload_read` (ok) and `payload_read_wrong` (refuted) in the
`variant_payload_construction` fixtures.
