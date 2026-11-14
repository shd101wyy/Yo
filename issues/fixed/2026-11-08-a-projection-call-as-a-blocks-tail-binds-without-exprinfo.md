# A projection call as a block's tail, bound with `:=`, makes its later `.*` an internal error

**Severity:** S2. A valid program is rejected with an internal error instead of either a reference binding or a diagnostic.

Filed 2026-11-08 by the G2 lane with the v0.2.76 seed, while testing an impl origin's result outliving its holder.

## Reproducer

`issues/repros/2026-11-08-a-projection-call-as-a-blocks-tail-binds-without-exprinfo.yo`:

```yo
{ assert } :: import("std/assert");
first :: (fn(p : &i32) -> &i32)(&p.*);
main :: (fn() -> unit)({
  x := i32(1);
  z := {
    w := i32(2);
    first(&x)
  };
  assert(z.* == i32(1), "a projection result as a block's tail");
});
export(main);
```

```text
error: check_if_function_parameter_matches_argument: arg has no ExprInfo
  --> …:9:11
```

`z := first(&x)` binds a reference (`_bind_projection_result`). Behind a block tail the call is not seen as a projection: `z` is bound some other way, and the operand `z.*` has no `ExprInfo`.

## Where to look

`evaluate_initialization_assignment` routes only a direct projection call to `_bind_projection_result` (`projection_call_mode_of(&rhs, ctx)`). A `begin` whose tail is one is not routed there, and neither are a `cond`/`match` whose arms are. Either route those through the same binding, with the tail's roots and the block's locals checked against them, or reject them with a diagnostic.

## Test

The fix adds the reproducer to `tests/origins/reference_read_rule.test.yo`, plus the case where the block's own local is the root (which must be rejected), and moves this doc to `issues/fixed/`.

## Triage 2026-11-09 (bugs lane)

On a develop build (`b5e6881c3`): `z := { w := i32(2); first(&x) }` binds the
VALUE (an `i32` copy of the place), exactly as `z := { w := i32(2); x }` does,
and `assert(z == i32(1), ...)` and `v := z` both compile and run. The internal
error comes from the reproducer's `z.*`, a `.*` on a plain value
(`issues/fixed/2026-11-09-a-deref-of-a-plain-value-is-an-internal-error-not-a-diagnostic.md`;
`x.*` with `x := i32(1)` fails the same way), not from the block tail. So the
open question is the design one: does a block whose tail is a projection call
yield the reference (option A below, with the block locals' roots checked) or
the value (today)? Recommendation: the value. A block is an expression that
yields a value; `z := first(&x)` binds a reference only because decision 24
spells a projection call bound directly, and a reference that crosses a block's
end brings the block-local root checks of E0912 with it. Bind the reference
by calling the projection outside a block, or read the value; the diagnostic
for the stray `.*` is the other issue. Left open for the coordinator.

## Fix (2026-11-11, plane-c P2)

The triage's recommendation was overruled by VERDICTS-41 Q1 (option A, **R-TAIL**): an unannotated `:=` whose initializer is a `begin`, `cond` or `match` binds the reference when every result-chain leaf is a reference: a lend `&place`, a projection call of a named function, or a reference binding read. `ref_chain_leaves_of` (`src/evaluator/utils.yo`) classifies the leaves before evaluation and registers them, so `reference_read_wanted` types them `&U`. A `&place` leaf is evaluated by `evaluate_chain_lend` (`src/evaluator/builtins/ptr_fns.yo`). `_bind_projection_result` then binds the chain with the union of the leaves' roots: a temporary root is E0911 (R-TEMP) and a root declared inside the block is E0911 at the block's end (Q1 item 3). In codegen, `chain_leaf_pointer_code` gives each leaf's pointer for the `begin` tail, the `cond` arms and the `match` arms. The reproducer's `z.*` reads `1`. A block-local root (`{ w := i32(2); first(&w) }`) is rejected with "Cannot end this block while its result borrows `w`".

Tests: `tests/origins/reference_read_rule.test.yo` ("A block, cond or match whose every leaf is a reference binds the reference", the mixed chain, the block-local root for a projection and for a lend, both roots of a two-arm `cond` frozen). Corpus rows: `block-tail-projection`, `block-tail-projection-local`, `cond-arm-projection-join`, `cond-arm-projection-read`. One gap remains open: a method-call leaf (`issues/2026-11-10-a-method-call-leaf-of-a-block-tail-is-not-classified-before-evaluation.md`).
