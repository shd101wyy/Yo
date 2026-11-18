# `str`'s `Clone` derefs its fat reference receiver and emits invalid C

**Severity:** S1 — invalid C in generated code: programs the evaluator accepts do not compile (`tests/copy_trait.test.yo` and `tests/dyn.test.yo` batches on develop, battery run 44029352099).

## Observed

`tests/copy_trait.test.yo` failed its whole batch at the C compile (taking `tests/prelude.test.yo`'s with it):

```text
.yo_selftest_batch_5684_1_0.bin.c:8181:11: error: indirection requires pointer operand ('__yo_str' invalid)
```

The offending C is the prelude impl's own body:

```c
static inline __yo_str fn_yo_id_18245486744179477499000000(__yo_str __yo_v_self) {
  return (*__yo_v_self);
}
```

`std/prelude.yo`'s `impl(str, Clone(clone : (self -> self.*)))` — `self : &str` is passed as the fat
`__yo_str` pair BY VALUE (decision 49 S2), and the `self.*` read emits `(*__yo_v_self)`: an indirection of
a struct. `tests/dyn.test.yo` hit the same shape through a specialized generic — `d.*` on `d : &Dyn(T)`
emitted `return (*__yo_v_d);` over a `__yo_t_<hash>` fat pair (67/67 of its batch).

## Root cause

The `.*` spelling is #1961's deref text sweep of the pre-#1347 `clone : (self -> self)`: correct when `str`
was a sized pointer, wrong once the `str` flip (#1980) made `&str` the fat reference. The evaluator accepts
the body — the only one it does: `(self -> self)` is E0926 (a bare reference read), a spelled
`(fn(self : &Self) -> Self)(...)` member is E0602 (its result is aliased to `&str` while the trait requires
the unsized `str`), and `(self -> __yo_str_from_raw_parts(...))` is E0604 (the builtin's result is aliased
`&str`, the lambda's result slot unsized `str`) — so the spelling cannot be fixed in the prelude; the
LOWERing is the defect. Two sites lower a deref of a by-value fat reference to `(*pair)`:

- `_var_read_code` (`src/codegen/exprs/atom.yo`): a binding whose slot is a borrow, read as the unsized
  place (`read_ty` unsized — the evaluator's rewrite of `self.*`), was wrapped `(*name)` unconditionally.
  A FAT borrow slot (`&str`, `&[T]`, `&Dyn`, a tail struct) holds the pair itself in C — the pair is the
  read, and `unsized_place_fat_code` already accepts the bare pair as an unsized place's fat pointer.
- `_generate_field_access_raw` (`src/codegen/exprs/property_access.yo`): the `p.*` branch over a
  `.Reference`-typed object emitted `(*p)` for fat and thin alike; a fat reference's C value is the pair.

The same relaxation as `issues/fixed/2026-11-16-a-lend-of-an-unsized-place-emits-a-deref-of-the-fat-pair.md`
(fold `(*X)` to `X` at the value slot), taken at the producer: the unsized-place `(*F)` convention is kept
for THIN borrow slots only, whose C storage is a pointer. The tail-struct field branch of
`_generate_field_access_raw` now takes its fat pointer through `unsized_place_fat_code`, so a field read
through either spelling of an unsized place lowers the same.

The evaluator-reachability half of this bug — `s.clone()` on a `&str` resolving to this impl at all — is
fixed separately on the reds branch (`s.clone()` is the structural copy, Rust's `<&str as Clone>::clone`;
`issues/fixed/2026-11-17-str-clone-returns-the-unsized-str-and-emits-invalid-c.md`). That fix does not
reach every path: `(str.clone)(s)` — the impl member spelled directly — still selects the impl and emits
the body above (probe: `assert((str.clone)(s) == "abc", ...)`; the emitted C carries
`return (*__yo_v_self);`). The impl itself stays until S3b-`str` deletes it (the v0.2.78 seed still needs
it), so its body must compile.

## Fix

- `src/codegen/exprs/atom.yo`, `_var_read_code` (the load-bearing change): the `(*name)` wrap never
  applies to a FAT borrow slot — a slot `&U` with `U` unsized — whichever disjunct asked for it (`is_ref`,
  a by-`ref` receiver binding, or `read_unsized && t_slot_is_borrow`, the unsized-place read): the wrap is
  gated on the slot being thin (`type_is_sized(&t_slot_pointee(slot))`), so a fat slot reads as the pair it
  is stored as. The thin twins are unchanged: `&mut T` parameters (`T*` in C) still read `(*name)`, and the
  scalar clones' by-value receivers still read bare (their C is byte-identical).
- `src/codegen/exprs/property_access.yo`, `_generate_field_access_raw`: `p.*` over a `.Reference` with an
  unsized pointee emits `(p)` (identity); the thin case keeps `(*p)`.
- `src/codegen/exprs/property_access.yo`, the tail-struct field branch: `fat` comes from
  `unsized_place_fat_code(&object_code)`, accepting the bare-pair spelling of an unsized place.

## Verification

Stage-1 binaries built from this branch — first on the pre-#1993 develop base (the emitter fix alone, no
reachability fixes), then rebased onto the #1993 tree (both fixes together):

- `(str.clone)(s) == "abc"` compiles and runs on BOTH; the emitted body reads `return __yo_v_self;` (was
  `return (*__yo_v_self);`). The inline-argument form `f(s.clone())` likewise; the thin twin
  `(i32.clone)(n)` is byte-identical to develop's emission (`return __yo_v_self;` over `int32_t`).
- `yo test ./tests/copy_trait.test.yo --parallel 1`: 34/34 on both trees (was 0/34 — the batch failed at
  the C compile; on the emitter-only tree `s.clone()` still selects the impl, whose body is now valid C).
- `yo test ./tests/dyn.test.yo --parallel 1`: 67/67 on both trees (was 0/67 — `return (*__yo_v_d);` over a
  `__yo_t_<hash>` fat pair): the f3 lane's twin is the same producer.
- `yo check ./std --std-path ./std` clean (171/171); `yo check ./src --std-path ./std` clean;
  `yo fmt --check` on both changed files.
- Spot files over the fat-read consumers: `unsized_places` (6/6), `unsized_pointers` (7/7), `str` (13/13),
  `sized` (18/18), `ref_payload_binding` (12/12).
