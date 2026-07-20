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

## MECHANISM: nested-receiver `.len()` dispatch reads a None-pass ExprInfo for `v.fields`

`v.fields.len()` is a method call whose RECEIVER `v.fields` is a NESTED access.
`_try_find_receiver_method` (function.yo:189) reads the receiver's ExprInfo
(line 231) — or re-evaluates it via `_try_eval_receiver_node` (182) on a miss.
The `[PA]` probe showed `v.fields` is evaluated in ≥2 passes (concrete `CLIST/0`
AND a `v`-unbound `None` pass); the ExprInfo the `.len()` dispatch ends up reading
carries the None-pass value, so `.len()`'s receiver has no value → the method
CTFE yields UnknownVal → the `cond` can't fold → the mapper returns UnknownVal
→ the quote-splice gets non-Expr elements → "Failed to transpile". A scalar field
`v._variant_index` in the SAME cond folds because `==` is an operator (no
nested-receiver method dispatch / ExprInfo re-read), and `get_struct_fields(T).len()`
works because its receiver is a direct call (single eval, concrete ExprInfo).
FIX DIRECTION (dedicated session): ensure the nested-receiver `.len()` dispatch
uses the CONCRETE receiver evaluation (don't let a `v`-unbound re-eval overwrite
the concrete `v.fields` ExprInfo, or make `_try_eval_receiver_node` evaluate in the
env where `v` is bound). This is comptime method-dispatch + ExprInfo-table timing —
pervasive, so full-battery-gated.

## Why it's deep (a dedicated arc, not a context-tail fix)

The chain is `map_variants → mapper comptime-fn CTFE → cond → VariantInfo
reflection (variant.fields)`. Each layer must produce a concrete comptime value;
one unknown poisons the whole quote. Same class as P3 — needs a focused
reflection/CTFE session, full-battery gated (touches comptime-fn evaluation +
reflection builtins). Standalone repro + `[SPLICE]` probe recipe recorded above.

## SESSION 2026-07-20 (late) — TWO bugs isolated + FOUR fixes disproven (8 s1 builds). SUPERSEDES the ExprInfo-timing theory above.

The prior "nested-receiver `.len()` reads a `v`-unbound-pass ExprInfo" theory is
WRONG. A `[LEN]` probe in `_try_find_receiver_method` (printing the receiver's
cached value + a re-eval) proved that in the (post-fix) fresh mapper calls
`variant.fields` resolves **CONC** (`cached=CONC reeval=CONC recv=(variant.fields)`,
3×). Property access is fine. There are **two independent bugs**:

**BUG 1 — over-caching (evaluator/calls/comptime_fn.yo:624).** `should_cache` =
`is_type_hierarchy_type(return_type) || func_result_is_comptime || all_args_are_types`.
TS (comptime-fn.ts:91) is ONLY `isTypeHierarchyType(returnType)` — it explicitly
does NOT cache non-Type returns. The mapper returns `comptime(Expr)`, so
`func_result_is_comptime` memoizes it; called per-variant with a `VariantInfo`
VALUE arg (`all_args_are_types` = false), all 3 calls collide on ONE poisoned
entry. A `[MV]` probe (in `evaluate_type_map_variants` after the mapper call)
CONFIRMED: with the buggy cache the mapper body's `.len()` evaluates ONCE; after
removing `func_result_is_comptime` the mapper runs 3× fresh (`[MV] vi=0/1/2`).
Fix = drop `func_result_is_comptime` (keep `all_args_are_types` — type
constructors are called with type args, so identity is preserved). NECESSARY but
not sufficient; flips nothing alone (derive is the only map_variants test file).

**BUG 2 — comptime `.len()` self-param bound to UnknownVal
(evaluator/calls/function.yo, the `.None`-branch method CTFE, block ~3934).**
`variant.fields.len()` reaches the `.None` branch (callee has no comptime value)
→ `_try_find_receiver_method` finds `ComptimeList.len()` (declared
`comptime(self):Self -> comptime(usize)`, prelude.yo:5790) → block 3934
CTFE-executes it via `evaluate_comptime_fn_call`, which evaluates the body in the
pre-built `m_env`. The self param is bound from `call_result_m.arg_values.args[0]`,
but `try_to_call_function_with_arguments` (line ~3892) binds COMPTIME params to
UNKNOWNS during its type-check pass → self = UnknownVal → `__yo_comptime_list_length(unknown)`
→ Unknown → `== usize(0)` unknown → `cond` can't fold → mapper UnknownVal.

FREE minimal-repro tests (reusing one s1 build, editing only the mapper body in
`src/tests/fixme.yo`) pinned BUG 2 exactly:

- bare `quote(_ => true)` mapper → **EXPR**
- `cond(true => quote, true => quote)` (constant cond) → **EXPR**
- `cond(variant._variant_index == 0 => …)` (SCALAR field) → **EXPR**
- `cond(variant.fields.len() == 0 => …)` (ComptimeList field + comptime `.len()`) → **NONEXPR**
  So: cond is fine, quote is fine, scalar reflection is fine; ONLY the comptime
  `.len()` on the `ComptimeList`-typed field fails to fold. (Scalar fields fold via
  property access; `.len()` is a comptime METHOD whose self goes through the CTFE.)

**FOUR fixes tried and DISPROVEN (all full s1 rebuilds, all still NONEXPR):**

1. Re-eval a value-less receiver in the CURRENT env inside `_try_find_receiver_method`
   (`.Some(ri)` value-less → re-eval). No effect — the receiver already resolves later.
2. Re-eval the receiver in the ORIGINAL call `env` (added `orig_env` param). No effect
   — no available env has `variant` at that dispatch point.
3. BUG-1 cache fix alone. Mapper now runs 3× fresh, but each still returns NONEXPR.
4. BUG-1 + bind self in `m_env` (block 3934) from the receiver's ExprInfo, then from a
   RE-EVAL of the receiver in `callee_env`. Still NONEXPR — `try_to_call` (run just
   before block 3934) has clobbered the receiver ExprInfo to Unknown AND `callee_env`
   no longer resolves `variant` (the `[LEN]` reeval=CONC held BEFORE try_to_call, not
   after).

**REAL FIX (next dedicated session):** capture the CONCRETE receiver value at
resolution time — inside `_try_find_receiver_method`, where `variant.fields` is
proven CONC — and thread it (e.g. on `ReceiverMethodResult`) to the block-3934
self-param binding, instead of relying on `arg_values`/a post-`try_to_call` re-eval.
Combine with BUG 1. Full battery (corpus 135/2/0, std 153/153, STRICT_FIXPOINT
byte-identical) + revert-on-regression. Blast radius: the `.None`-branch comptime
method CTFE (all value-instance comptime methods with a value receiver) — MUST be
gate-validated, not committed on a repro flip alone.
