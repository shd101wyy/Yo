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

### Second attempt, also reverted (both facts measured)

Adding a `Self.<Assoc>` fast path to `_get_or_create_some_ty_for_trait` — look
the associated type up by LABEL in the trait's own scoped frame, where the field
loop binds it as a `TypeVal(SomeT)` (the `already_bound` block in
`evaluate_trait`) — did NOT make the constraint visible: with the trait-field
validation on, `check ./std` still reported the same `ComptimeNegate` rejection
(15/153). So the failure is upstream of the resolver's dot branch. Three
candidates remain, in the order worth testing:

1. `env_mut` is REPLACED wholesale in this file (`env_mut.frames =
te_info.env.frames` etc. in the constraint path), so the frame that received
   the `Output` binding may no longer be reachable when the retry runs.
2. `_lhs_should_defer_for_pending` defers the constraint on the FIRST pass and
   the retry re-enters through `_drop_where_constraint_failures`, whose local
   handler swallows whatever still fails — so a resolver fix has to be verified
   INSIDE that path, not just in `_parse_trait_where_clauses`.
3. The where-clause LHS `Self.Output` may not arrive as a 2-arg `BF_DOT` call.

Recommended next move: build one probe binary that prints, at the retry site,
`ast_expr_to_string(lhs_expr)` plus whether `get_variables_from_env(env_mut,
"Output")` finds anything. That single probe distinguishes all three.

## 2026-07-30 round — steps 2 is LANDED; the arm's residue is a DIFFERENT family

The probe recommended above was built and answered everything in one run:

- `__DBG_P retry=(Self.Output) <: Comptime lhs=[... dot2=true] output_var=somet:84`
  — the retry DOES see an env-bound `Output` SomeT (candidate 1 refuted) and
  the LHS IS a 2-arg dot call (candidate 3 refuted).
- ZERO `__DBG_P2 swallowed=` lines — the retry parse SUCCEEDS (candidate 2's
  "still fails inside `_drop_where_constraint_failures`" also refuted).
- `__DBG_P4 field=neg somes: Self#83(req=1) Output#85(req=0)` with
  `output_var=somet:84` — **the real root: SomeT identity split.** The env
  bound `Output#84` (which received the retried constraint) while the field's
  return type carried a separately-minted `Output#85` whose required list
  stayed empty.

**Fix 1 (identity, creation side):** `property_access.yo`'s SomeT
associated-type branch minted a FRESH placeholder SomeT per `Self.Output`
access, where TS returns the field's single `unassignedSomeType`
(property-access.ts:445-456). It now resolves through the trait-definition
scoped frame's binding of the label (the yo-self stand-in for that per-field
storage) before minting. After the fix the field types and the env share ONE
`Output` SomeT and the retried constraint is visible to field-type walkers.

**Fix 2 (the validation itself):** the trait-field comptime-RETURN validation
(TS trait.ts:1074-1102) is re-applied in `evaluate_trait_type`, AFTER the
pending-constraint retry, gated on a DEEP contains-SomeT check
(`get_all_some_types(...).len() > 0` — yo-self's `type_contains_some_type` is
SHALLOW and walks right past `*(Output)`). `check ./std` stays **153/153**
(prelude's `ComptimeNegate` now passes — the false positive that killed both
earlier attempts is gone). Module-level twins behave exactly like TS:

- BAD (`-> comptime(*(Self.Output))`, no `Self.Output <: Comptime`): REJECTED.
- GOOD (constraint present): accepted.
- The full arm-26 sequence inside a fn that IS CALLED at module level: cee
  observes the error, GOOD accepted — parity with TS.

**Why arm 26 is STILL hollow (measured, new family):** inside `main`'s
DEF-TIME TRIAL, the statement `MyBad :: (fn(comptime(Idx) : Type, ...) ->
comptime(Trait))(trait(...))` **never reaches anonymous-function creation at
all** — a `__DBG_V9` probe at `anonymous_function.yo`'s defer decision fired
760 times during the repro compile, every one from `std/prelude.yo`, none from
the repro module. So the trait body is never evaluated in the trial, the cee's
argument "evaluates successfully", and the cee throws its own "Expected
compile error..." into main's wall (`__DBG_F` confirmed exactly that one
swallow). The remaining work is therefore NOT in trait validation: it is the
trial-mode evaluation of `::` comptime-fn bindings (likely shared with
`issues/yo-self-comptime-const-batch-undeclared.md`'s batch-arm context).
