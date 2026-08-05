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
`plans/YO_SELF_ENV_SHARING.md` for the ranked footprint levers) — worth measuring before
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
