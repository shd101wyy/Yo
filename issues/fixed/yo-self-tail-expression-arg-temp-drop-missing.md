# yo-self: no scope-end drop for an owned RC argument temp in a bare tail-expression fn body

**Found 2026-08-05** while porting
`issues/fixed/ref-enum-unit-variant-inline-construction-leak.md`. It is **independent of
that fix** — it reproduces on the payload-carrying constructor form, which that fix never
touched.

## Minimal reproducer

```rust
{ assert } :: import("std/assert");
Val  :: ref(enum(UnitVal, IntVal(v : i32)));
Held :: struct(v : Val);
keep :: (fn(x : Val) -> Held)(Held(v : x));
// BARE TAIL EXPRESSION body — this is the trigger.
mk_payload :: (fn() -> Held)(keep(Val.IntVal(v : i32(7))));
main :: (fn() -> unit)({
  p := mk_payload();
  assert(rc(p.v) == 1, `payload: rc(p.v) should be 1, got ${rc(p.v).to_string()}`);
});
export(main);
```

| compiler              | result                                          |
| --------------------- | ----------------------------------------------- |
| TS (`./yo-cli`)       | exit 0                                          |
| self-hosted (stage-1) | `payload: rc(p.v) should be 1, got 2` — SIGABRT |

Wrapping the body in an explicit block makes both compilers agree:

```rust
mk_payload :: (fn() -> Held)({
  h := keep(Val.IntVal(v : i32(7)));
  h
});
```

## Emitted C

TS drops the argument temp on both the normal and the effect-escape path:

```c
static inline Holder fn_…_mk_unit() {
  MyVal* _temp_40542 = __yo_new___yo_enum_…_UnitVal();
  __yo_effect_escaped = 0;
  Holder _temp_40543 = fn_…_make((MyVal*)(_temp_40542));
  if (__yo_effect_escaped) {
    // Drop local variables before early return
    fn_…_id_21___drop((MyVal*)(_temp_40542));
    // Drop consumed variables (unwind propagation)
    fn_…_id_44___drop((Holder)(_temp_40543));
    return (Holder){0};
  }
  fn_…_id_21___drop((MyVal*)(_temp_40542));   // <-- MISSING in yo-self
  return _temp_40543;
}
```

yo-self emits the declaration but neither drop:

```c
static inline __yo_t0 yo_id_4975() {
  __yo_t1* _temp_5152 = __yo_new___yo_t1_UnitVal();
  __yo_effect_escaped = 0;
  __yo_t0 _temp_5153 = yo_id_4973((__yo_t1*)(_temp_5152));
  if (__yo_effect_escaped) {
    return (__yo_t0){0};            // no drops at all
  }
  return _temp_5153;                // no drop of _temp_5152
}
```

So the temp variable itself exists and is declared (`declared_c_var_names` is populated
via `get_variable_type_string`, `yo-self/codegen/utils/index.yo:1138-1149`) — what is
missing is the **scope-end drop emission** for a function body that is a single
value-returning expression rather than a begin block.

## Why it matters beyond this repro

Every owned RC temp materialised inside a bare tail-expression body leaks under the
self-hosted compiler. `yo-self/` is written overwhelmingly in that style, so this is a
candidate contributor to the self-compiled compiler's memory footprint (see
`plans/backlog/YO_SELF_ENV_SHARING.md` for the ranked footprint levers) — worth measuring before
assuming it is small.

## Where to look

- TS side: `generateFunctionBody` in `src/codegen/functions/generation.ts` and
  `generatePendingDeferredDrops` / `generateConsumedVarDropsForEscape` in
  `src/codegen/exprs/return.ts`.
- yo-self mirror: `yo-self/codegen/functions/generation.yo` and
  `yo-self/codegen/exprs/return.yo`.
- Drop selector (shared shape): `getVariablesNeedingDrop` (`src/env.ts:2272-2306`) vs
  `yo-self/env.yo:2575-2640`.

The likely divergence is which env/frame the body-level drop pass reads when the body is
not a begin block: the temp is registered at the nearest begin-block frame by
`attach_temp_variable_to_expr` (`yo-self/evaluator/utils.yo:122`), and a bare tail
expression may not have one for the pass to flush.

## Guard already in place

`tests/rc.test.yo`'s "Inline ref-enum unit-variant argument is released by the caller"
deliberately uses block bodies with a comment pointing here, so it gates the
payload-free-variant leak on both compilers instead of tripping over this gap. When this
issue is fixed, that test can be simplified back to bare tail expressions and it will
still gate both bugs.

## RESOLUTION (fixed 2026-08-06)

### Root cause — the exact divergence

TS routes **every** function-body evaluation through `evaluateBeginExpression`
(`src/evaluator/calls/function-type.ts:499`), and `evaluateBeginExpression`
**rewrites a non-begin body node in place into `begin(expr)`**
(`src/evaluator/exprs/begin.ts:1122-1151`, via
`replaceFuncCallExprWithFuncCallExpr`). Because the mutation is in place, the
`FunctionValue.body` codegen walks IS a begin node, so:

1. the begin machinery runs at eval time — begin frame pushed, the argument
   temp registered in it (`attachTempVariableToExpr`), and the scope-end pass
   attaches `___drop(temp)` to the begin node's `deferredDropExpressions`;
2. codegen always takes the begin path in `generateFunctionBody`
   (`src/codegen/functions/generation.ts:1522`), which seeds
   `context.pendingDeferredDrops` (the escape-path drops emitted inside
   `emitEffectUnwindCheck`) and flushes the scope-end drop AFTER the tail
   expression (`generation.ts:1809-1815`). Marker instrumentation confirmed the
   repro's normal-path drop is emitted by exactly that line.

yo-self deliberately does NOT clone+mutate into a begin node — a
single-expression body shares the SAME node id with its begin `out_info`
(`yo-self/evaluator/exprs/begin.yo` "shared-id" carry-across design, and the
closure/specialization paths already call `evaluate_begin_expression` directly
on non-begin bodies: `yo-self/evaluator/calls/closure_type.yo:255`,
`yo-self/evaluator/calls/helper.yo:2920`). The one deviation was the
**definition-time fn-body eval**: `_trial_eval_fn_body`
(`yo-self/evaluator/calls/function_type.yo`) called
`evaluate_expression_raw(wrap_body_in_begin(body))`, and `wrap_body_in_begin`
(`yo-self/expr.yo:895`) is narrowed to bare-ATOM / bare-field-access bodies. So
a bare tail-expression CALL body skipped the begin machinery entirely: no begin
frame scope-end pass, no `deferred_drop_expressions` recorded on the body node
— codegen had nothing to emit, on either the normal or the escape path.

### Fix

`yo-self/evaluator/calls/function_type.yo` — `_trial_eval_fn_body` now calls
`evaluate_begin_expression(body, env, ctx, [], true, inner_exn)` directly, the
faithful port of `function-type.ts:499` (and the same shape the closure path
already used). The begin `out_info` (scope-end `deferred_drop_expressions`
included) lands on the shared node id; codegen's existing post-call drop flush
(`yo-self/codegen/exprs/other_fn_call.yo`, mirror of `other-fn-call.ts:1511`)
then emits the drop right after the call:

```c
__yo_t1* _temp = __yo_new___yo_t1_IntVal(7);
__yo_effect_escaped = 0;
__yo_t0 _res = keep(_temp);
__yo_decr_rc((void*)(_temp));       // <-- now emitted
if (__yo_effect_escaped) { return (__yo_t0){0}; }
return _res;
```

Placement differs from TS (drop before the escape check instead of duplicated
on both sides of it), but is drop-once-correct on both paths, and correctly
never touches the unassigned call-result temp on the escape path.

Routing every fn body through the begin machinery exposed three shared-id
gaps that TS never has (TS clones the inner node into `begin(...)`, so the
inner node's `$` never collides — begin.ts:1131-1151). All three were fixed as
part of this change:

1. `yo-self/evaluator/exprs/begin.yo` — carry `is_primitive_match` across the
   single-expression shared-id clobber. Without it, a bare
   `(fn(n : i32) -> i32)(match(n, ...))` body lost the flag and codegen's
   `generate_match_expression` fell into the enum branch — `// Error: "match"
expression requires an enum type` spliced after `return`
   (tests/basic.test.yo).
2. `yo-self/evaluator/exprs/begin.yo` — carry the tail's `variable_name`,
   gated on `carry_runtime_args` AND the (previously unused)
   `is_evaluating_function_body_begin_block` flag. The carried deferred
   `___dup` references that temp; losing the name suppressed the balancing +1
   via the undeclared-temp gate and re-opened the borrowed-field-tail UAF
   (tests/codegen-bootstrap/borrowed_field_return.yo printed "2 2" instead of
   "2 3"). The fn-body-only gate exists because for match/cond ARM begins the
   trailing `attach_temp_variable_to_expr` would re-register the carried name
   as owning in the enclosing frame of the same C function — an over-release.
3. `yo-self/codegen/exprs/comptime_value.yo` — the StructVal literal and
   ref-semantics constructor branches now pair fields by FULL declaration
   index and skip comptime-only fields (faithful port of
   `comptime-value.ts:276-315`, which filters through
   `getRuntimeStructFields`). Previously a struct with a comptime-only field
   (`tag :: "..."`) emitted a `.tag = ...` designator that does not exist in
   the (correctly erased) C struct layout
   (tests/module_struct_unification.test.yo "Phase 1").

No TS changes were needed (TS was correct).

`tests/rc.test.yo` "Inline ref-enum unit-variant argument is released by the
caller" was simplified back to bare tail-expression bodies, so it now gates
this bug AND the payload-free-variant leak on both compilers.

### Gate results (all on this fix, 2026-08-06)

- `bun run build` — clean.
- stage-1 rebuild (`node ./out/cjs/yo-cli.cjs compile yo-self/main.yo --release`) — rc=0.
- Repro flip: stage-1-compiled repro exits 0 (was rc(p.v)==2 / SIGABRT 134);
  TS-compiled repro still exits 0. Stage-1 emitted C verified to contain the drop.
- `./yo-cli test ./tests/rc.test.yo --parallel 1` — 20 passed, 0 "error in" (TS arm);
  also 20 passed under stage-1.
- `S1=/tmp/yo-stage1 P=hand2 bash scripts/bootstrap/gates_fast.sh` — battery all
  rc=0 hollow=0, corpus PASS 155 DIFF 0 SELF-FAIL 0, STD 153/153, failures=0.

### Related (not covered here)

`_trial_eval_anon_body` (`yo-self/evaluator/values/anonymous_function.yo:386`)
still uses the narrowed `wrap_body_in_begin` route for ANONYMOUS-function
def-time trial eval. Closure bodies take the `closure_type.yo:255` direct
`evaluate_begin_expression` path at creation time, so the reported leak class
does not reproduce there; if a sibling gap is ever observed on anon-fn def-time
eval, port the same change there.
