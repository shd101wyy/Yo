# yo-self: `comptime_expect_error` inside a FUNCTION BODY goes hollow

Status: arm 27 FIXED (step 1 below). Arm 26 still OPEN — the port is written
but blocked on constraint VISIBILITY, see "What blocked arm 26". `tests/comptime.test.yo` arms 26
("Comptime SomeType constraint validation") and 27 ("comptime_assert validates
argument type even in function body"), plus the wider cee hollow family.

## Symptom

```rust
main :: (fn() -> unit)({
  comptime_expect_error(comptime_assert(i32 == i32, "should be rejected"));
});
```

emits `// Failed to transpile comptime_expect_error(...)` — and every statement
after it in the body, the "abandoned from that statement onward" signature. The
SAME expression at MODULE level is accepted by both compilers.

## Root cause (verified by reading both compilers)

The cee handler itself is a faithful port
(`yo-self/evaluator/builtins/comptime_expect_error.yo` — local unwinding exn,
the `cee_observed_error` channel for throws eaten by the non-raw wrapper,
propagate-mode around the arg eval, a 31-field ctx save/restore). It is not the
bug: **the argument genuinely does not throw in yo-self**, so cee reports
"Expected compile error, but the expression was evaluated successfully",
throws that through the CALLER's `exn` without ever stamping ExprInfo for its
own node, and the def-time trial-eval wall swallows it. `generate_func_call`
then bails at its missing-ExprInfo early return — BEFORE the
`BF_COMPTIME_EXPECT_ERROR` case that would have emitted `""`.

Why the argument does not throw, for `i32 == i32`:

1. `yo-self/evaluator/calls/function.yo` narrows the "no matching operator"
   HARD error to primitive receivers:
   `if((op_methods.len() == usize(0)) && (is_primitive_type(receiver_ty) && !(is_unit_type(receiver_ty))), { exn.throw(...) })`.
   The receiver of `i32` (used as a VALUE) is the type-hierarchy type
   `TypeUni`, and `is_primitive_type` (`yo-self/types/guards.yo:129-150`) has no
   `.TypeUni` case → no throw. (`op_methods` is genuinely empty: the prelude
   gives `Type` only `impl(Type, Comptime())` plus the module fns `Type.eq` /
   `Type.neq` — there is no `Eq(Type)` impl.) The narrowing was deliberate and
   measured against `unit` / bare-SomeT / anon-struct fall-throughs; `TypeUni`
   was never in that sample.
2. The fall-through evaluates the callee atom `==`, which hits a **yo-only soft
   fallback with no TS counterpart** (`identifer_and_operator.yo` — "Unresolved
   OPERATOR names keep the soft fallback"), yielding `UnknownVal(unit)` where
   `identifer-and-operator.ts:489-493` throws unconditionally.

At module level the same expression is fine because there is no def-time trial
wall to swallow the cee's own throw, so the "expected an error" failure is
reported (and `comptime_assert` on a non-bool is separately rejected).

## Fix plan

1. **Widen the operator no-match hard error to type-hierarchy receivers**
   (one condition, `is_type_hierarchy_type` is already imported in
   `function.yo`): matches TS's unconditional "No matching call found with
   arguments" (`function.ts:1776/1827`). Keep the existing unit / bare-SomeT /
   anon-struct carve-outs — those are the measured-safe ones. Expected to flip
   arm 27's first two cees.
2. **Port the trait-field comptime-RETURN-type validation**
   (`src/evaluator/types/trait.ts:1074-1102`) into
   `yo-self/evaluator/types/trait.yo`, before the scoped env frame is popped:
   a `comptime`-returning trait field whose return type contains a SomeType
   without a `Comptime` constraint must be rejected. That is what arm 26's cee
   is waiting for.
3. **Make a cee that sees no error LOUD instead of hollow**: route its message
   through the existing `flag_flow_violation` channel ("deliberate rejection
   swallowed by the def-time trial wall — re-raise me via the real exn"), which
   both trial-eval callers (`anonymous_function.yo`, `function_type.yo`) already
   re-raise verbatim. This turns the whole family from silent hollowness into a
   reported error, which is how the remaining cee files should be triaged.
4. Do NOT remove the `identifer_and_operator.yo` soft fallback in the same pass
   — step 1 makes it unreachable for the shapes that matter, and removing it
   wholesale changes every `unit`/bare-SomeT/anon-struct operator fall-through
   in the prelude. Separate change, separate gate.

## What blocked arm 26 (measured, so the next attempt starts here)

Step 1 landed and flips arm 27: widening the operator no-match hard error to
type-hierarchy receivers makes `i32 == i32` throw as TS does.

Step 2 — porting the trait-field comptime-return validation
(`src/evaluator/types/trait.ts:1074-1102`) into
`yo-self/evaluator/types/trait.yo`, just before the scoped env frame is popped —
was written and REVERTED, because it rejects the prelude's OWN `ComptimeNegate`:

```
Error: Return type "Output" in trait field "neg" is used with "comptime" but
type parameter "Output" does not implement the Comptime trait.
Add "Output <: Comptime" to the where clause.
```

`ComptimeNegate` is declared `trait(Output : Type, (neg) : (fn(comptime(self) :
Self) -> comptime(Self.Output)), where(Self <: Comptime, Self.Output <:
Comptime))` — the constraint IS there, so
`find_some_type_missing_comptime_constraint` cannot see it at that point.

One real porting gap was found and KEPT while investigating: the yo-self helper
only checked the SomeType's own `required_trait_types` and never TS's SECOND
step, `getWhereClauseConstraintsForSomeType` (trait-checking.ts:696-704). That is
now ported (`yo-self/evaluator/trait_checking.yo`), and it is strictly more
permissive — it can only make the helper accept MORE, never reject more — but it
is not sufficient: `check ./std` still reported the same rejection with it in
place, so the `Self.Output <: Comptime` constraint is not reachable from that
SomeType by either route at trait-definition time.

Next step for arm 26: find how `where(Self.Output <: Comptime)` is recorded
(`_add_where_clause_constraint` in `yo-self/evaluator/types/function.yo`, plus
the pending-constraint retry list in `trait.yo`) and whether the SomeType
identity differs from the key used — TS additionally collects ALIAS NAMES bound
to the same SomeType id (`src/env.ts:441-451`), which yo-self's
`get_where_clause_constraints_for_some_type` may not do. Confirm the ordering
too: TS runs the validation after the pending constraints are applied, and
yo-self's retry block is `_drop_where_constraint_failures`, which discards
rather than applies.
