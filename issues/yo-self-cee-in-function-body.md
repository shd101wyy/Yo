# yo-self: `comptime_expect_error` inside a FUNCTION BODY goes hollow

Status: OPEN — root identified, not yet fixed. `tests/comptime.test.yo` arms 26
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
