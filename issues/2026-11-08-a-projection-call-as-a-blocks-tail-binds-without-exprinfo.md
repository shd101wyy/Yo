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
