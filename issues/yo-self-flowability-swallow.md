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

**Layer 2 — REMAINING (two sub-layers).** Confirmed via the committed ref-path
(no slice check needed): a `-> ref(i32)` function whose body is a ref-returning
METHOD call rooted in a `ref` param — `(fn(ref(list) : ArrayList(i32)) -> ref(i32))(list.project(usize(0)))`
(`ArrayList.project` is `fn(ref(self), pos) -> ref(T)`) — is accepted by TS but
WRONGLY REJECTED by yo-self. So this is a pre-existing R3 bug, not slice-specific;
ref*flowability never exercised a ref-returning \_method* call (only direct calls +
field access), so it went unnoticed.

- **2a. R3 method-callee type — FIXED (commit 308c854d).** R3 bailed at
  flowability.yo with `callee_ty_opt = None`: the `.`/2 method-callee sub-expr
  has no Func-typed ExprInfo. TS reads `call.func.$.type`. ⚠️ Writing the method
  Func type INTO the callee node's ExprInfo regressed check ./std 151 → 15 (136
  files) — that node's ExprInfo means property/field-access info. Fixed with a
  NON-destructive side-table (expr*info.yo `record*/lookup_method_callee_type`,
`ExprId → method Func type`), recorded at method RESOLUTION in function.yo
(before the call is processed, since it may throw at def-time) and read by R3
as a fallback. Validated zero-regression (std 151, yo-self 228, tests 172);
a ref-returning method call rooted in a `ref` param now type-checks flowable.

- **2b. Reflection comptime gap — WAS AN ARTIFACT.** The
  `Type.get_enum_variants`/`get_struct_fields` "info not found" `comptime_assert`
  error appeared only WITH the destructive 2a attempt (the 151→15 breakage). It
  does NOT occur with the clean side-table — `list.project(...)` resolves and
  evaluates fine. No independent reflection gap here.

- **2c. Remaining positive-case gaps (the actual slice_flowability blocker) — a
  LONG TAIL of distinct issues, one per positive.** With 2a fixed + the slice
  return-check re-applied, slice_flowability advances PAST `borrow_list_slice`
  (now accepted) but then false-rejects the next POSITIVE, and each remaining
  positive appears to hit its OWN distinct gap. First confirmed (instrumented):
  `comptime_str :: (fn() -> str)({ s :: "world"; s })`. Its body does NOT throw
  (no def-time swallow — verified), and the returned expr IS the bare atom `s`
  (no coercion wrapper — verified `FLOW-ENTER tok=s is_atom=true`). R1 rejects it
  at `R1-EARLY vars-empty name=s`: `get_variables_from_env(info.env, "s")` returns
  EMPTY — the comptime-bound `s` (`s :: "world"`) is NOT present in the env
  recorded on the returned `s` atom's `ExprInfo`. So this is an env-snapshot gap
  for a `::` comptime-const binding in a def-time-evaluated begin body (the
  recorded `info.env` predates / omits the `s` binding), NOT a swallow and NOT a
  flowability-logic gap (R1''' for comptime-bound names is present and correct).
  The other positives (`forward_slice`, `greet`, `slice_len`, the `SliceWrapper`
  struct-field cases) likely each have a different root cause and need individual
  investigation. slice_flowability is therefore a multi-fix effort, not one fix.

The slice return-check itself is implemented and std-clean; it stays reverted
until the 2c positive-case gaps are closed (else it false-rejects valid
`str`/slice-returning positives like `comptime_str`).

## 2026-06-10 — env-aliasing fix LANDED + in-body flow checks LANDED (pushed)

- **Recorded-`ExprInfo.env` aliasing FIXED (commit f6fa7132).** The `comptime_str`
  `vars-empty` root cause above was a general bug: `new_expr_info` stored the live
  env by reference, and begin's in-place `pop_frame()` dropped begin-local
  bindings from every recorded env. Fix: `new_expr_info` records `snapshot_env`
  (shallow frames-list clone, shares `Frame` refs) + begin uses
  `Environment.pop_frame_nonmutating()`. Validated std 151 / yo-self 228 /
  tests 172. Closed `comptime_str`. See `issues/yo-self-recorded-env-aliasing.md`.
- **In-body slice/ref flow checks LANDED (commit 6a681f82, faithful, MATCH TS).**
  (1) slice/raw-ptr RETURN check (function_type.yo, else-branch of the ref check);
  (2) explicit-`return(arg)` check (begin.yo — the function-body `is_flowable_expr`
  vacuously accepts `return(...)`, so the arg is re-checked, begin.ts:1243);
  (3) assignment-escape check (assignment.yo — `x = <raw-ptr-value>` with
  `max_local_frame_level = target.frame_level`; flags `flag_flow_violation` so the
  def-time swallow re-raises). Closed slice_flowability's `make_dangling`,
  `make_wrapper`, `bad_explicit_ref_return`, `assign_escape_str`.
- **⚠️ yo-self full-list 228→227 is FAITHFUL, not a regression.**
  `yo-self/codegen/exprs/asm.yo`'s `explicit_register_constraint_`
  (`(fn(reg : str) -> Option(str))(cond(... Option(str).Some("a") ...))`) is now
  rejected — and **`./yo-cli check` (the TS reference) REJECTS IT TOO**. It is a
  flowability FALSE-POSITIVE in BOTH TS and yo-self: `is_flowable_expr` R3 cannot
  resolve a QUALIFIED variant constructor `Enum.Variant(args)` (`Option(str).Some`
  is a `.`/2 selector with no Func-typed ExprInfo; only the `.Variant` / `.`-1
  shorthand is recognised as a ctor). The faithful fix is to recognise qualified
  variant ctors in **TS** `isFlowableExpr` first (then port) — making yo-self
  accept it alone would DIVERGE from TS. Phase-3's evaluator-only metric excludes
  codegen, so it is unaffected.
- **Remaining slice_flowability blocker: `assign_escape_slice`.** Its body
  (`inner := ArrayList(i32).new(); inner.push(7); inner_slice := match(inner.as_slice(), …); cur = inner_slice`)
  appears to hit an UPSTREAM def-time-eval gap before reaching `cur = inner_slice`
  (the assignment check / R1' frame-level branch never fires — no `R1FL` trace),
  so the inner-local slice escape isn't caught. Blocked upstream (body eval), not
  a frame-level bug. Next concrete step.
