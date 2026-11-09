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
