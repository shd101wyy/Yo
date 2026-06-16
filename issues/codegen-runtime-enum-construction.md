# Runtime enum construction `.Some(runtimeVal)` doesn't fill the field value

**Status:** OPEN. High value — blocks ALL runtime `Option`/`Result`/enum construction
(not just `ArrayList.push`). Cleanly isolated (no raw pointers).

## Repro (`/tmp/rtenum.yo`)
```rust
mk :: (fn(v : i32) -> Option(i32))({ return(.Some(v)); });
main :: (fn() -> unit)({
  o := mk(i32(65));
  match(o, .Some(x) => unsafe(putchar(int(x))), .None => unsafe(putchar(int(i32(63)))));
});
```
TS prints `A`. self-bin emits, in `mk`'s body:
```c
(__yo_enum_yo_id_3691){ .tag = ..._SOME, .data = { .Some = { .value = /* skip generating value */ } } };
```
i.e. the compound literal is emitted but the **runtime field value `v`** is
`/* skip generating value */` → C compile error.

(NOTE on repro: match arms must UNIFY — `.Some => putchar(...)` is `int`, so the
`.None` arm must also be `int`, not `()`; an `int`-vs-`unit` arm mismatch is a real
type error, not the bug under test.)

## Root cause
`.Some(v)` (v runtime) evaluates to a comptime `EnumVal` SHELL with a runtime
hole. `generate_func_call`'s comptime-value path (generation.yo:305-315) sees the
`EnumVal` (not unknown, not unit) → `is_plain_comptime` → `generate_comptime_value`
→ which can't fill the runtime field → emits `/* skip generating value */`.

This is the ENUM analogue of the value-struct/newtype runtime-ctor fix
(commit cfb84cff1), which was done for `StructVal` but NOT for `EnumVal`. Also,
yo-self's `other_fn_call.yo` has NO runtime enum-construction branch at all
(grep: no `is_enum_type`/`.tag =` construction there) — runtime enum construction
was never ported; only the comptime path (comptime_value.yo) exists, and it
can't handle runtime fields.

## Two-part faithful fix
1. **generation.yo** — extend the `is_runtime_ctor` guard (currently
   `is_struct_val(v) && ctor_has_runtime_args`) to ALSO cover
   `is_enum_val(v) && ctor_has_runtime_args`, so a runtime enum ctor falls through
   the comptime-value short-circuit to `generate_other_function_call` (mirrors the
   struct case from cfb84cff1).
2. **other_fn_call.yo** — port the TS runtime enum-construction branch from
   `src/codegen/exprs/other-fn-call.ts:2500-2680` (the `isEnumType(functionValue.value)`
   else-if). Three sub-cases:
   - **nullable-pointer** (`canOptimizeAsNullablePointer`): `.None`→`NULL`,
     `.Some(p)`→ the bare pointer value. (This also fixes the `.Some(ptr)` push gap.)
   - **simple enum** (`canOptimizeAsSimpleEnum`): emit the enum constant (variant
     C name).
   - **tagged union** (fallback): `(cName){ .tag = <VARIANT>, .data = { .<Variant> =
     { .<label> = <argCode>, ... } } }`, filtering unit fields, generating each
     runtime field value. The TS code also has closure/state-machine capture temp-var
     handling (Phase 4/5) — stub those parts as the rest of yo-self codegen does;
     the no-RC/no-async corpus needs only the plain field-value emission.

## Validation
Add `tests/codegen-bootstrap/runtime_enum_construct.yo` (the repro above → `A`).
Run corpus + std per-file sweep (must stay 94/58; this touches the pervasive
comptime-value short-circuit, so validate broadly via `--release`).
