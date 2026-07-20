# yo-self: derive on an ENUM — `Type.map_variants` mapper CTFE returns UnknownVal (quote-splice gets non-Expr elements)

_2026-07-20. Deep root trace of `tests/derive.test.yo` (`error: expected
expression` at the derived-`==` body). NOT fixed — a deep reflection/CTFE gap
(same class as P3), traced to the exact site. Precise entry point below._

## Symptom

`tests/derive.test.yo` (s2) fails C compile:

```
tests/.yo_selftest_batch_1.bin.c:NNNN:1: error: expected expression
```

at a derived comparison whose body is an UNEXPANDED quote-splice:

```c
static inline bool fn_yo_id_6870(__yo_t38 self, __yo_t38 other) {
  return // Failed to transpile match(self, ...#(match_branches), ...#(match_branches), ...#(match_branches));
}
```

Repro (standalone): the user-defined derive rule `MyEq` (derive.test.yo:236-297)
applied to a fieldless enum:

```rust
DRColor :: enum(Red, Green, Blue);
derive(DRColor, MyEq(DRColor));   // rule: enum branch → quote(match(self, ...#(match_branches)))
```

## Root (probe-confirmed)

The derive rule builds `match_branches :: Type.map_variants(T, fn(variant) ->
Expr { quote(<branch>) })` and splices via `quote(match(self,
...#(match_branches)))`. The quote-splice handler (evaluator/builtins/quote.yo
:229-252) correctly sees a `ComptimeList` of length 3 (Red/Green/Blue), but a
`[SPLICE]` probe showed **every element is an `UnknownVal`, not an `ExprVal`**
(`is_ev=F is_unk=T`), so the spread falls to `new_args.push(arg)` — pushing the
LITERAL `...#(match_branches)` node 3× (unexpanded) → codegen "Failed to
transpile".

The list elements are UnknownVal because **`Type.map_variants`
(evaluator/builtins/type_fns.yo:1588, `evaluate_type_map_variants`) calls the
mapper per variant (bind VariantInfo temp → `mapper(vi)` → `evaluate_expression`
with `force_compile_time_bindings=true`, line 1748-1780) and the call returns an
UnknownVal** instead of the concrete quoted `ExprVal`. TS's `callMapperWithArg`
(src/evaluator/builtins/type-fns.ts:1610) uses the IDENTICAL mechanism and gets
an `ExprValue` — so the gap is UPSTREAM: yo-self does not CTFE the enum mapper's
comptime-fn call to its concrete quote result.

Why the STRUCT case works but ENUM doesn't: the struct mapper body is a bare
`quote(self.field.my_eq(...))`; the enum mapper body is a
`cond(variant.fields.len() == usize(0) => quote(...match...), true => quote(...))`.
PRIME SUSPECT: the `cond` condition `variant.fields.len()` (on the VariantInfo
built by `_ti_build_variant_info`, type_fns.yo:1733) doesn't fold to a concrete
comptime bool — so the whole `cond` (and thus the mapper) yields UnknownVal.
Verify next session: probe whether `variant.fields` / `.len()` on the built
VariantInfo is concrete, and whether the mapper's comptime-fn call routes through
`evaluate_comptime_fn_call` (CTFE) vs the regular call path (which fabricates
UnknownVal for a comptime-return fn).

## NARROWED: the mapper-CALL mechanism is NOT the culprit (VariantInfo reflection is)

`evaluate_type_join_fields` (type_fns.yo:1274, the STRUCT path that WORKS) calls
its mapper with the IDENTICAL mechanism map_variants uses — `call_code =
mapper(fi_name)`, `generate_expr_from_code`, `force_compile_time_bindings=true`,
`evaluate_expression` (join_fields lines 243-249 vs map_variants 1748-1780). So
the comptime-fn CTFE call itself is fine. The divergence is the ARG the enum
mapper reads: a `VariantInfo` (built by `_ti_build_variant_info`) whose
`variant.fields.len()` / `variant.name.to_expr()` must fold to concrete comptime
values inside the mapper body. For a FIELDLESS variant `_ti_build_variant_info`
gets empty field lists, so `.fields.len()==0` SHOULD be concrete — so the prime
remaining suspect is `variant.name.to_expr()` (or the `VariantInfo` field
accessors) yielding UnknownVal. Next session: probe `variant.name` /
`variant.fields` concreteness INSIDE the enum mapper (not just the built
VariantInfo) — the FieldInfo accessors (struct path) work, so diff FieldInfo vs
VariantInfo reflection.

## FURTHER NARROWING: VariantInfo.name is concrete → suspect the cond-CTFE

`format_variant_info_call` (type_fns.yo:679) constructs
`VariantInfo("North", <field_list>, <enum_ty>, usize(idx))` — the name is a
STRING LITERAL, so `variant.name` folds concretely. Eliminate `variant.name` as
the suspect. The enum mapper body is `cond(variant.fields.len()==0 => quote(...),
true => quote(...))` (a COND whose branches are quotes) — vs the struct mapper's
BARE `quote(...)`. So the remaining suspect is the comptime evaluation of a
`cond` that RETURNS a quote inside a comptime mapper: either `variant.fields.len()`
doesn't fold (check `_ti_bind_type_field_list`, type_fns.yo:815, for the
empty-field-list case) or the `cond` doesn't propagate the selected branch's
`ExprVal` at CTFE. Next-session probe: instrument map_variants right after the
mapper call (type_fns.yo:1764) to print `call_info.value`'s kind, AND separately
CTFE-evaluate `variant.fields.len()` in the mapper env to see if the cond
condition is concrete.

## Why it's deep (a dedicated arc, not a context-tail fix)

The chain is `map_variants → mapper comptime-fn CTFE → cond → VariantInfo
reflection (variant.fields)`. Each layer must produce a concrete comptime value;
one unknown poisons the whole quote. Same class as P3 — needs a focused
reflection/CTFE session, full-battery gated (touches comptime-fn evaluation +
reflection builtins). Standalone repro + `[SPLICE]` probe recipe recorded above.
