# yo-self: flowability tests — swallow + cond ptr-relaxed + ref-capture-escape

## Status

- `ref_flowability.test.yo` — **FIXED** (3 coordinated changes below).
- `ref_local_binding.test.yo` — still failing: needs ref-capture-escape (below).
- `ref_closure_capture.test.yo` — still failing: needs ref-capture-escape.
- `slice_flowability.test.yo` — still failing: needs slice-escape-at-return.

`is_flowable_expr` (yo-self/types/flowability.yo) is a complete, faithful port of
`isFlowableExpr` — the failures were never in that function.

## What `ref_flowability` needed (all three, together)

The four `comptime_expect_error` cases plus two positives in this file exercised
three independent gaps. None alone closed the file:

### 1. Binding-site flow violation swallowed (Step B)

`ref(name) := <non-flowable>` inside a function body throws via the `exn`
threaded into the body eval — which, during def-time trial eval, is
`_trial_eval_fn_body`'s swallowing `inner_exn` (function_type.yo). So
`bad_binding :: (fn() -> unit)({ ref(r) := returns_value(); })` was not rejected.

The swallow handler is a capture-free `->` effect handler — it **cannot** close
over a propagating `exn` to re-raise (the language forbids `->` functions
capturing outer runtime variables). Fix: the binding-site (init*assignment.yo)
flags a global box (`flag_flow_violation(msg)` in flowability.yo) before throwing;
the throw is swallowed as usual; then the def-time CALLER
(function_type.yo, right after `_trial_eval_fn_body`) re-raises it via the real
`exn` — UNCONDITIONALLY (not under `result_is_ref`, since the function may
return any type). The message is carried in a parallel box so the re-raised
diagnostic matches. An `ArrayList` box mutated only inside top-level
`flag*/clear\_` fns is used (not a reassignable global) so yo-self can check its
own source (which forbids reassigning a module-level global inside a closure).

### 2. Return-position rejection skipped on swallowed body (Step A)

The `-> ref(T)` return flow check ran on `flow_out.get(0)` (the trial-evaluated
final body expr) and `.None => ()` SKIPPED when `flow_out` was empty. A
`cond`/`match` body whose bad arm fails to unify with `*(T)` throws during eval
→ swallowed → empty `flow_out` → not rejected (`bad_cond_mixed_arms`). Fix: fall
back to flow-check the raw body `fb` when `flow_out` is empty. `is_flowable_expr`
is structural, so a genuinely non-flowable body is still rejected.

This fallback is sound ONLY together with fix #3 — otherwise a _valid_ cond body
(`pick`) whose eval throws for an unrelated reason leaves an empty `flow_out`,
and the raw-body flow check (no ExprInfo) mis-rejects it.

### 3. cond arm type vs `*(T)` ref-return expected type (cond ptr-relaxed match)

`pick :: (fn(ref(p) : Point, use_x : bool) -> ref(i32))(cond(use_x => p.x, true => p.y))`
is valid in TS but yo-self threw `Incompatible type with expected type` while
trial-evaluating the body: the arm `p.x` yields `i32`, but the body's expected
type is lowered to `*(i32)` for `-> ref` returns. TS cond.ts has an
`isPtrRelaxedMatch` (cond.ts:352-361): when expected is `*(T)` and the arm yields
non-pointer `T` compatible with the pointee, accept it (codegen address-takes on
the way out; the flowability rule owns soundness). yo-self's cond.yo arm-type
check (the `Incompatible type with expected type` throw) lacked it. Ported it
(single-expr `p.x` worked only because it skips the cond arm-check path).

## Remaining: ref-capture-escape + slice-escape (the other 3 tests)

`make_reader :: (fn(ref(x) : i32) -> Impl(Fn() -> i32))(() => x)` and
`make_capturing_closure` must be rejected because a returned closure capturing a
`ref`-bound name outlives the call frame. TS enforces this in
`anonymous-function.ts:1078-1087`: iterate `context.capturedVariables` (the
PRECISE free-variable set, populated during body eval) and throw if any captured
variable `isRef`.

**Architectural blocker:** yo-self DEFERS closure body eval and snapshots ALL
visible outer variables coarsely into `cap_names` (anonymous_function.yo:431-468),
not the precise free-var set. Checking `isRef` on `cap_names` would false-reject
any closure merely created in a scope that has a ref binding. A faithful port
needs the closure's actual free variables — either (a) evaluate closure bodies at
def time, or (b) a static free-variable AST scan of the closure body intersected
with outer ref-bound names. Both are substantial. Once the precise set exists,
the rejection must ALSO flag the global box (generalize `flag_flow_violation`
into a `flag_safety_violation`) so it propagates through the def-time swallow,
exactly like fix #1.

### slice_flowability — return-position check IS portable, blocked by call-routing

The slice/raw-ptr return check (function-type.ts:541-572, the `else if` branch of
the `-> ref` check) ports cleanly into function_type.yo's flow-check block:
`type_representation_contains_raw_ptr(return) && !result_is_comptime_only &&
!is_implicitly_unsafe_capable_file(...)` → `is_flowable_expr(returnExpr,
{allow_parameter_source: true, allow_comptime_source: true})`. Implemented and
**swept clean on std (151/151)** — it correctly rejects `make_dangling`.

BUT it cannot land faithfully yet: it false-rejects the POSITIVE
`borrow_list_slice :: (fn(ref(list) : ArrayList(i32)) -> Option(Slice(i32)))(list.as_slice())`.
Root cause is NOT the check — it's a call-routing gap. During def-time body
eval, `list.as_slice()` (a runtime method, unknown receiver) is OVER-ROUTED to
`evaluate_comptime_fn_call` (comptime_fn.yo), whose arg-collect step throws
"Failed to call the function for compile-time. Some arguments are not
compile-time evaluated correctly." (an arg's value is `.None`). TS hits the same
throw at the same collect step (comptime-fn.ts:78) — the difference is TS does
NOT route an unknown-receiver runtime method call there; it produces an unknown
typed result via the type-checking path. The throw is swallowed → empty
`flow_out` → the return check falls back to the raw body (no ExprInfo) →
`is_flowable_expr` can't resolve the callee Func type → false reject. So the
slice check turns a previously-swallowed routing error into a false rejection.

**Refined root cause:** the throw is not from routing `list.as_slice()` itself
(its args aren't types and its return isn't a `Type`, so the function.yo:1921
gate does NOT send it to comptime). It comes from yo-self INLINE-EXECUTING
`as_slice`'s BODY at def-time with the unknown receiver — instead of yielding an
unknown result for a runtime-return call (cf. the helper.ts:1731 "don't execute
runtime-return fn bodies" rule, partially ported per
[[yo-self-phase3-knot-real-root]]). Inside that executed body, a type-constructor
call (`Slice(T)` / `Option(Slice(T)).Some`) is reached with the element forall
`T` unbound → its forall arg value is `.None` → the comptime-fn collect step
(comptime_fn.yo:467-505, which DOES include forall args) throws "Failed to call
for compile-time." TS never executes the body here, so it never reaches that
constructor with an unbound `T`.

**Layer 1 — FIXED (commit a4977828).** The throw came from the operator-dispatch
path (function.yo) routing a comptime-returning operator method (`!=`, `<` inside
`as_slice`'s bounds/null checks) through `evaluate_comptime_fn_call` even when an
operand was a runtime unknown. Added an `op_operands_concrete` guard: only fold at
comptime when every operand is present and not `UnknownVal`; otherwise yield
`UnknownVal(resolved_ret)` directly (the behavior the surrounding comment already
promised). Now `list.as_slice()` evaluates at def-time without a swallowed throw.
Validated zero-regression (std 151/151, yo-self 228/228, tests 172/182).

**Layer 2 — REMAINING.** With layer 1, the slice return-check is reached and
`flow_out` is populated (no swallow), but `is_flowable_expr` still returns false
for the evaluated `list.as_slice()`. The failing point is R3 in flowability.yo:
`callee_ty_opt := _info(ctx, call_func)` resolves to `.None` for the method-callee
sub-expr `list.as_slice` (its ExprInfo carries no Func type), so R3 returns false
at flowability.yo:307 before it can confirm the receiver `list` (a `ref` param) is
flowable. Fix: ensure method-call evaluation records the resolved Func type in the
callee sub-expr's ExprInfo (TS sets `call.func.$.value`/`.$.type` — flowability.yo's
header comment assumes yo-self does too; for this method path it does not), or have
R3 resolve the method's Func type from the receiver type + method name when the
callee ExprInfo is absent. The slice return-check itself is implemented and
std-clean — once layer 2 lands it closes slice_flowability. The slice check is
reverted until then (it would false-reject the positive `borrow_list_slice`).
