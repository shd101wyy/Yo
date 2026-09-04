> **CLOSED (2026-08-06).** The bootstrap campaign this document belongs to is
> complete: the self-hosted compiler passes the full suite, the stage-2/stage-3
> fixpoint holds, and every CI job gates PRs (run 31069479984, commit
> `ac85f6cfc`). Kept as a historical record — do not resume work from this
> file. Umbrella status: `plans/archive/BOOTSTRAPPING.md`. What comes next:
> `plans/archive/SELF_HOSTING_COMPLETION.md`.

# Remaining unported evaluator files (TS → yo-self)

**Update:** all 3 files now have yo-self counterparts. `unsafe.yo` is fully
active. `flowability.yo` and the `contracts.yo` markers are ported and
regression-free; each has a documented _activation_ follow-up (wiring +
remaining sub-piece) below.

| File                                      | Status                                                                         |
| ----------------------------------------- | ------------------------------------------------------------------------------ |
| `builtins/unsafe.ts` → `unsafe.yo`        | **Done + active** (`21052924`)                                                 |
| `types/flowability.ts` → `flowability.yo` | **Ported** (`3675b39d`); pending activation (setters + caller wiring)          |
| `builtins/contracts.ts` → `contracts.yo`  | **Markers ported** (`f22993f7`); `wrap_function_body_with_contracts` remaining |

Prerequisites landed: Func.param_is_ref/result_is_ref (`fab9f423`),
Variable.is_ref/is_parameter (`b0ca9387`), type_representation_contains_raw_ptr
/ type_may_provide_slice_source (`1d41ff4c`), has_any_control_flow (pre-existing).

## Activation follow-ups

- **flowability**: (1) SET `Variable.is_ref` at `ref(name) : T` param bindings
  and `ref(name) := …` locals, and `Variable.is_parameter` at all param
  bindings; (2) wire `is_flowable_expr` into its callers (function_type.yo
  return-flow, begin.yo return, the `ref(name) :=` binding site). The setters
  MUST precede enforcement wiring — otherwise legitimate `ref(T)`-returning
  functions are wrongly rejected during codegen. Both are codegen-only (not
  reached by `check`).
- **contracts**: port `wrap_function_body_with_contracts` (the ~250-line
  signature→assert lowering) and wire it into function_type.yo /
  anonymous_function.yo body construction.

---

## Original assessment (historical)

Of the 3 TS evaluator files without a yo-self counterpart, 1 was tractable and
2 were blocked on prerequisite sub-ports (now landed — see above).

## ✅ `evaluator/builtins/unsafe.ts` → `unsafe.yo` (DONE, `21052924`)

Tractable — all dependencies existed. Added `unsafe_context` to `EvalContext`,
created `evaluate_unsafe` (privilege gate + transparent ExprInfo propagation),
wired `BF_UNSAFE` dispatch in `_expr.yo`. Regression-free; verified the
privilege gate works.

## ⛔ `evaluator/types/flowability.ts` → `flowability.yo` (BLOCKED)

`isFlowableExpr` — the `ref(T)`-flow soundness check (R1–R4 from
`plans/archive/ITERATOR_REDESIGN.md`). Used at `ref(name) := expr` binding sites and
`-> ref(T)` function returns (callers: `function_type.yo`,
`anonymous_function.yo`, `begin.yo`). Prerequisites NOT yet in yo-self:

1. **Type predicates** (port from `src/types/utils.ts` into
   `yo-self/types/utils.yo`): `type_representation_contains_raw_ptr`,
   `type_may_provide_slice_source`.
2. **`has_any_control_flow`** (port from `src/expr.ts`) — reads the
   control-flow flags on an evaluated expr.
3. **`Variable.is_ref` and `Variable.is_parameter`** — yo-self's `Variable`
   (`env.yo`) lacks both. Adding them requires SETTING them at every binding
   site (`ref(name) : T` params and `ref(name) := …` locals set `is_ref`;
   parameter bindings set `is_parameter`).
4. **`FunctionParameter.isRef` / `FunctionType.return.isRef`** — yo-self
   **flattened** `FunctionParameter` into parallel arrays (`param_types`,
   `result : Box(Self)`), dropping per-parameter `isRef` and the return's
   `isRef`. R3 (callee return must be `ref(T)`, every `ref` arg must be
   flowable) cannot be checked without restoring this ref-tracking on the
   `Func` type. This is the largest prerequisite — same flavor as the
   `constructor_func_id` / `type_arguments` restorations.

A conservative `false` stub is NOT acceptable: it would reject every legitimate
`ref(T)`-returning function at codegen time. The file is only exercised by
codegen / full fn-body eval (not by `check`), so there is no `check`-level
pressure — it should be ported only after prerequisites 1–4 land.

## ⛔ `evaluator/builtins/contracts.ts` → `contracts.yo` (BLOCKED)

`requires` / `ensures` / `invariant` / `ghost` / `ghostFn` / `old` +
`wrapFunctionBodyWithContracts` (design-by-contract). Prerequisites NOT yet in
yo-self:

1. **Contract builtin keywords** — `expr.yo` has no `BF_REQUIRES` / `BF_ENSURES`
   / `BF_INVARIANT` / `BF_GHOST` / `BF_OLD` constants, and the lexer/parser do
   not yet recognize the contract syntax (`requires(...)`, `ensures(...)`,
   `invariant(...)` as the first body statement, `ghost(...)`, `old(expr)`).
2. **`wrapFunctionBodyWithContracts` integration** — callers
   (`function_type.yo`, `anonymous_function.yo`) currently build the function
   body WITHOUT the contract wrapper; wiring it in is a body-construction change
   that must preserve current behavior when no contracts are present.

Like flowability, contracts are exercised by codegen / fn-body eval, not
`check`, so there is no `check`-level pressure.

## Recommended order

flowability prerequisite #4 (restore `FunctionParameter`/`Func` ref-tracking) is
the highest-leverage prerequisite — it is also needed elsewhere and is the same
kind of faithful data-type restoration as `type_arguments`. Land #1–#3, then
flowability, then the contracts keyword/parser support, then contracts.
