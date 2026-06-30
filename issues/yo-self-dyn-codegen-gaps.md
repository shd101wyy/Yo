# yo-self dyn() codegen gaps (binary)

**Status: OPEN — two distinct, well-characterized gaps in the self-compiled
binary's `dyn()` codegen. The TS compiler handles both correctly.** Surfaced by
differential testing the binary against TS on small `dyn`/trait programs
(2026-06-30). The evaluator-side dyn coercion + method dispatch were fixed
earlier (commits 2f91537c / 02315945); these are the remaining CODEGEN gaps.

## Gap 1 — value-type `dyn()` auto-box (SomeT not resolved to concrete)

Repro `/tmp/cgbugs/16_dyn.yo`:

```rust
Shape :: trait(area : (fn(self : *(Self)) -> i32));
Sq :: struct(s : i32);                                  // VALUE struct
impl(Sq, Shape(area : (fn(self : *(Self)) -> i32)(self.s * self.s)));
use_shape :: (fn(sh : Dyn(Shape)) -> i32)(sh.area());
main :: (fn() -> unit)({ unsafe(printf("area=%d\n", use_shape(dyn(Sq(5))))); });
```

TS prints `area=25`. Binary emits:

```c
__yo_dyn_trait_yo_id_3726 t = /* Error: dyn() requires an object type (use box() for value types) */;
```

Root cause (confirmed by instrumenting generate_dyn_call): the dyn payload's
codegen type is `void*` — i.e. the inner `Sq(5)`, evaluated with the
SomeT-Shape expected type (evaluate_dyn_value lines 202-232), keeps the **SomeT**
(type-variable) type rather than resolving to the concrete `Sq`. TS auto-boxes
the inner (evaluateDynValue dyn.ts:250-310, `expr.args[0] = box(...)`), and TS's
inner resolves to the concrete `Sq` so `box(Sq) -> Box(Sq)` (a ref struct) passes
the codegen object-type guard.

In yo-self:

- TS's `evaluateDynValue` has NO executing/validating split; it always boxes.
  yo-self added an early-return validating path (evaluate_dyn_value ~233-262)
  that skips the auto-box — and yo-self evaluates fn bodies in validating mode,
  which is the ExprInfo codegen reads.
- Even after adding the auto-box to the validating path + recording the boxed
  expr in `runtime_arg_exprs_in_order` (the field generate_dyn_call prefers),
  the inner stays SomeT-typed (`void*`), so `box()` of a SomeT silently produces
  no usable box function (0 box fns emitted) and the guard still fires.

So the real fix is upstream: **resolve the inner value's SomeT to its concrete
type** (here `Sq`) after synthesize binds it, so the auto-box wraps a concrete
type. (Same SomeT-stays-unresolved class as the closure operator-body issue in
`yo-self-closure-codegen-gate.md`.) A reverted experiment confirmed the
auto-box plumbing is correct; only the SomeT→concrete resolution is missing.

## Gap 2 — dyn method dispatch through the fat pointer

Repro `/tmp/cgbugs/16b_dyn_ref.yo` (same as above but `Sq :: ref(struct(s:i32))`
so no boxing is needed). The `dyn(Sq(5))` construction now succeeds, but
`use_shape`'s body fails:

```c
static inline int32_t yo_id_3731(__yo_dyn_trait_yo_id_3726 sh) {
  return // Failed to transpile (sh.area)();
}
```

TS dispatches `sh.area()` through the vtable (`sh.vtable->area(sh.data)`).

REFINED ROOT CAUSE (2026-06-30): this is NOT a missing codegen emitter and NOT a
swallowed eval throw:

- The dyn-method-dispatch EMITTER already exists in yo-self
  (`other_fn_call.yo` ~860-919: lowers `(recv).vtable->method((recv).data, …)`,
  gated on `recv_is_dyn && dot_recv_is_dyn && method_atom_ok`).
- The "Failed to transpile" actually fires earlier, at `generation.yo:405-412`:
  `get_expr_info(expr)` returns **None** for the `sh.area()` call expr, so codegen
  bails before reaching the dyn-dispatch branch.
- It is not a swallowed throw: instrumenting `_trial_eval_fn_body`'s swallow
  handler (`function_type.yo:217`) to `eprintln` every swallowed error produced
  **zero** TTERR lines for this compile — the body eval does not throw.

So the call expr simply has no findable ExprInfo at codegen time. This is the
same hard class as the earlier P1 work ("ExprInfo lookup failing due to
expression-id mismatch" / "get_expr_info=None during binary compile"): the
method-call expr's ExprInfo is either never produced during `use_shape`'s
def-time body eval, or recorded under a different ast_expr_id than the node
codegen walks. Needs a two-sided id trace (the id eval records for the dyn
method call vs the id codegen looks up). Evaluator-side, deeper than an emitter
fix.

## Working (for contrast)

Differential testing confirmed these categories compile + run identically to TS
in the binary: struct, enum + match, generic fn, generic struct + methods,
nested generics, Option/Result + match, recursion (recur), inherent impl
methods, HashMap get/set, struct-variant match destructuring, algebraic effects
(ctl/handler), to_string, String concat. The dyn/trait-object path is the
outlier.
