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

## DEFINITIVE ISOLATION (2026-07-20, via `[MV]` probe + fast emit-probes) — root = `v.fields.len()`

A `[MV]` probe in `evaluate_type_map_variants` (after the mapper call, type_fns.yo
~1781) printing the mapper result kind + type, run against a series of minimal
`map_variants(EnumT, mapper)` repros (all reusing ONE s1 build), isolated the
root step-by-step:

1. Real MyEq enum mapper → `result=NOTEXPR ty=Expr` (resolved return TYPE Expr,
   VALUE unknown → the mapper body did not CTFE).
2. Bare-quote mapper `(v) -> quote(_ => false)` → **EXPR** (map_variants fine).
3. Constant-cond mapper `cond(true => quote, true => quote)` → **EXPR** (cond fine).
4. `cond(v.fields.len()==0 => quote, true => quote)` → **NOTEXPR** (the CONDITION).
5. `quote(#(v.name.to_expr()))` → **EXPR**; `cond(v._variant_index==0 …)` → **EXPR**
   (SCALAR field accesses on the comptime VariantInfo param fold fine).
6. `cond(v.fields.len()==0 …)` on a WITH-FIELDS enum → still **NOTEXPR** (not the
   empty-list case).

**ROOT: comptime access of the COMPOUND field `v.fields`
(`ComptimeList(TypeFieldInfo)`) — or `.len()` on it — yields UnknownVal, while
scalar fields (`name : comptime_str`, `_variant_index : usize`) fold concretely.**
`_ti_bind_comptime_list` (type_fns.yo:746) binds a concrete `ComptimeListVal`, and
the comptime StructVal field-value retrieval (property_access.yo:1352,
`sflds_l.get(fi_lbl)`) SHOULD return it — so the ONE remaining probe for next
session: instrument property_access to see whether `v.fields` reaches the
concrete-return path (1352) or an UnknownVal path (1038/1107/1364), OR whether
`.len()` on the field-accessed `ComptimeList` fails to CTFE (it WORKS on a direct
`Type.get_struct_fields(T).len()`, so compare field-accessed vs direct list).

7. Binding `f :: v.fields; cond(f.len()==0 …)` (temp before `.len()`) → still
   **NOTEXPR**. So it is the FIELD ACCESS `v.fields` that yields UnknownVal, NOT
   the `.len()` chaining — even though the VariantInfo StructVal holds the concrete
   `ComptimeListVal` at that index and property_access.yo:1352 returns
   `sflds_l.get(fi_lbl)`. So `v.fields` must take a DIFFERENT property-access path
   (one returning `create_unknown_val`, e.g. 1038/1107/1364) or `fi_lbl`/`sflds_l`
   mis-map for the compound field. NEXT (needs a rebuild): instrument
   property_access at the comptime-StructVal `.field` retrieval to print, for
   `v.fields`, the path taken + `fi_lbl` + `sflds_l.len()` + the retrieved value's
   kind — vs the working `v.name` (index 0) / `v._variant_index` (index 3).

8. `[PA]` probe in property_access (comptime StructVal `.field` retrieval), on the
   minimal `map_variants(Direction, cond(v.fields.len()==0 …))` repro, printed TWO
   results for the SINGLE `v.fields` access: `fi_lbl=1 sflds[fi]=CLIST/0` (obj_val
   is a concrete 4-field VariantInfo StructVal; `.fields` = concrete empty
   `ComptimeListVal`) AND `objval=NONE` (obj_val_main is None — `v` has NO value).
   So the mapper is evaluated in ≥2 PASSES: one with `v` concrete (→ CLIST/0, would
   give `.len()==0` → true), one with `v` UNBOUND (→ field access unknown → cond
   unknown → mapper UnknownVal). **map_variants captures the v=None pass** (matches
   `[MV]=NOTEXPR`).

**FINAL ROOT (isolated): the mapper's param `v` has NO comptime value in the eval
pass whose result map_variants keeps** — so `v.fields` (and any field access) is
unknown, the `cond` can't fold, and the quote is never produced. This is a
comptime-fn eval-pass / param-value-binding issue: the synthetic `mapper(vi_name)`
call (type_fns.yo:1748, with `force_compile_time_bindings=true`) must evaluate the
mapper body with `v` BOUND to the concrete `vi_val` — currently the captured pass
sees `v` unbound. NEXT: at type_fns.yo:1748-1780, verify the mapper call routes
through `evaluate_comptime_fn_call` (CTFE, which binds params to arg VALUES) rather
than a regular call that leaves the comptime param value-less; compare to
join_fields (works) — the difference is likely the mapper FuncVal or the arg
(VariantInfo StructVal) binding, NOT the call code (which is identical).

## THE DISCRIMINANT: field TYPE (ComptimeList vs scalar), same cond structure

`cond(v._variant_index == usize(0) => …)` (usize scalar field) → **EXPR**.
`cond(v.fields.len() == usize(0) => …)` (ComptimeList field) → **NOTEXPR**.
IDENTICAL cond structure — the ONLY difference is the accessed field's TYPE. So
the bug is specifically **comptime property-access of a ComptimeList (compound)
field**: for it, the receiver `v` is seen value-less (obj_val_main=None, per the
`[PA]` probe) in the captured eval pass, so the field yields UnknownVal; a scalar
field (`_variant_index : usize`, `name : comptime_str`) reads the concrete value.
The fix is in property_access.yo's comptime-StructVal `.field` handling for a
compound/ComptimeList-typed field (it must not re-evaluate the receiver in a
value-less context) — a targeted property-access change, but property-access is
pervasive so it needs the full battery. NEXT: at the comptime-StructVal field
retrieval, find why obj_val_main is None specifically when `ft_lbl` is a
`ComptimeList` (vs concrete for scalar `ft_lbl`) — likely a receiver re-eval /
materialization triggered only for compound field types.

## Why it's deep (a dedicated arc, not a context-tail fix)

The chain is `map_variants → mapper comptime-fn CTFE → cond → VariantInfo
reflection (variant.fields)`. Each layer must produce a concrete comptime value;
one unknown poisons the whole quote. Same class as P3 — needs a focused
reflection/CTFE session, full-battery gated (touches comptime-fn evaluation +
reflection builtins). Standalone repro + `[SPLICE]` probe recipe recorded above.
