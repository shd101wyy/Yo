# Scope: comptime arithmetic operator folding in yo-self (Bug B)

## Goal

Make compile-time arithmetic/bitwise operators (`+ - * / % & | ^ << >>`) on
comptime-known numeric operands produce a correctly-typed (and ultimately
concrete) value in the self-hosted evaluator, instead of the current
`UnknownVal(unit)` from the unbound-`+` soft fallback. This is the gating
prerequisite for `tests/comptime_ref.test.yo` and for Bug C
(see `issues/fixed/phase3-comptime-arithmetic-not-folded.md`).

## How TS does it (the reference chain)

For `usize(5) + usize(1)`:

1. **`function.ts:452`** — `stringIsOperator("+") && expr.isInfix` branch:
   evaluate the first operand (expectedType cleared) → `receiverType = usize`,
   resolve `+` methods via `getReceiverMethodsByNameFromEnv(... isInfixOperatorCall: true)`.
   This returns BOTH candidates that match `+` on `usize`: the runtime `Add` impl
   and the comptime `ComptimeAdd` impl.
2. **`function.ts:1630-1657`** (the priority logic the maintainer flagged):
   *"Comptime function call has higher priority than normal function call …
   so we eagerly evaluate the call that can be done at compile-time."*
   Among the matching candidates, those whose `type.return.isCompileTimeOnly`
   is true are the comptime ones. When there's no runtime-only UnknownValue arg
   and exactly one comptime candidate, it is chosen (lines 1655-1657). A further
   tiebreak (1664-1681) prefers comptime *parameter* types (e.g.
   `fn(comptime_int, comptime_int) -> bool` over `fn(i32,i32) -> bool`).
   → picks `ComptimeAdd`'s `+`.
3. The chosen method returns `comptime(Self.Output)` and is compile-time-only, so
   the call routes to **`evaluateComptimeFunctionCall`**, which **executes the
   method body** `(lhs, rhs) -> __yo_comptime_usize_add(lhs, rhs)`.
4. **`_expr.ts:900`** — the body's `__yo_comptime_usize_add(...)` call is detected
   by the `__yo_comptime_*` prefix → `evaluateYoComptimeNumericFunctions`.
5. **`comptime-numeric-fns.ts:554`** — extracts the two numeric values, computes
   `5 + 1 = 6`, wraps in a `usize` NumberValue.

So arithmetic is **std-trait-driven** (`ComptimeAdd`/`ComptimeSub`/… in
`std/prelude.yo`) and the leaf computation is a **builtin intrinsic**
(`__yo_comptime_<type>_<op>`). Nothing special-cases `+` in the evaluator core;
it's ordinary comptime overload resolution + CTFE body execution.

## What ALREADY exists in yo-self (verified)

- ✅ The leaf builtin folder: `yo-self/evaluator/builtins/comptime_numeric_fns.yo`
  `evaluate_yo_comptime_numeric_functions` folds `__yo_comptime_*_add/sub/mul/…`
  on `IntLit` operands (parse_raw_int → `a+b` → `make_int_val`, lines ~500-540).
- ✅ Dispatch to it: `_expr.yo:726-727` routes `is_comptime_numeric_fn_call(expr)`
  → the folder. So a *direct* `__yo_comptime_usize_add(...)` call is handled.
- ✅ The std traits: `std/prelude.yo` defines `ComptimeAdd` (line 346) etc. and
  impls for `comptime_int`/`usize`/… whose `+` body is the builtin call.
- ✅ CTFE body execution exists: `evaluate_comptime_fn_call`
  (`yo-self/evaluator/calls/comptime_fn.yo`) executes function bodies and folds.
- ✅ Infix dispatch scaffolding: `function.yo:315-386` already resolves
  *comparison* operators via `get_receiver_methods_by_name_from_env` +
  `try_to_call_function_with_arguments`.

## The gaps (what's missing)

### Gap 1 — arithmetic operators are not routed to method resolution
`function.yo:335-344` restricts infix dispatch to `== != < <= > >=`. Arithmetic
ops fall through to the callee-eval path, where `+` is looked up as a bare
identifier, isn't found, and returns the soft fallback `UnknownVal(t_unit())`
(`identifer_and_operator.yo:148-159`). **This is the acute failure** that makes
`n + usize(1)` have type `unit`.

### Gap 2 — associated-type return (`Self.Output`) not resolved
Comparisons work because they return a concrete `bool`. Arithmetic returns
`comptime(Self.Output)` (an associated-type projection; see `ComptimeAdd` =
`(+) : (fn(... ) -> comptime(Self.Output))`). With Gap 1 fixed (operator routed
to method dispatch), the return type comes back as the bare SomeT `Output`
instead of `usize` → `n = n + usize(1)` fails `Incompatible types: Given Output`.

PRECISE MECHANISM (measured via probe, 2026-06):
- `usize`'s type id is **`__yo_t_usize`** — NOT empty. (The `impl.yo:1184`
  "primitive types produce an empty id" comment is misleading for the numeric
  builtins; they DO get ids and DO register trait methods.)
- Under `__yo_t_usize`, the trait-method registry has **23** entries named
  `Output` (every trait with an `Output` assoc type that `usize` impls: Add,
  Sub, Mul, Div, Index, …). So a naive `get_type_trait_methods_by_name(usize_id,
  "Output")` is AMBIGUOUS — it can't tell which `Output` belongs to `ComptimeAdd`.
- The resolved `+` `MethodEntry` carries `source_trait_id` (the `ComptimeAdd`
  trait id). The fix must resolve `Self.Output` to the `Output` registry entry
  **whose `source_trait_id` matches the operator method's `source_trait_id`** —
  i.e. disambiguate by trait, not just by name.
- `evaluate_function_return_type_again` (`types/function.yo:3483`) only calls
  `get_value_of_some_type_from_env`, which resolves SomeTs against env variables
  — it does NOT consult the trait-method registry. So the binding either has to
  be (a) injected into `callee_env` (bind `Output` → the matched impl's Output
  type) before return-type eval, mirroring how TS binds impl associated types
  during method resolution, or (b) resolved post-hoc in the operator dispatch
  using the method's `source_trait_id`.
The faithful approach is (a): when a trait method is resolved for a receiver,
bind that impl's associated types into the method's callee env (this is what TS
does and it generalizes beyond operators). yo-self has assoc-type machinery
(`property_access.yo:_try_resolve_associated_type`, keyed by type id) but it is
only invoked on the EnumT property-access branch and is name-only (no
`source_trait_id` disambiguation).

### Gap 3 — comptime-over-runtime overload priority is UNPORTED
`grep` of `yo-self/evaluator/calls/helper.yo` finds NO equivalent of
`function.ts:1630-1681`. With both `Add` (runtime) and `ComptimeAdd` (comptime)
matching `+`, yo-self has no rule to prefer the comptime impl when operands are
comptime. Needs a faithful port: filter candidates by
`type.return.is_compile_time_only`, pick the unique comptime one when no
runtime-unknown arg is present; tiebreak by comptime parameter types.

### Gap 4 — operator dispatch must EXECUTE the comptime body (to fold values)
The current comparison path calls `try_to_call_function_with_arguments`, which
returns `create_unknown_val(return_type)` and **never executes the body**
(`helper.yo` `return_value` is always `None`). So even comparisons yield a
bool-*typed* UnknownVal, not a concrete bool. To actually FOLD arithmetic to
`6`, the chosen comptime operator method must route through
`evaluate_comptime_fn_call` (which executes the body → the `__yo_comptime_*`
builtin → concrete value), the same way an ordinary comptime call does.

## Two implementation tiers

### Tier 1 — type correctness only (smaller, lower risk)
Route arithmetic/bitwise operators to method resolution (Gap 1) and resolve the
`Self.Output` return type (Gap 2), mirroring the comparison path — producing a
correctly-typed `UnknownVal(usize)` for `n + 1`. This alone:
- removes the `Incompatible types: … Given unit` failures from comptime
  arithmetic;
- lets `n = n + usize(1)` type-check (usize vs usize), so
  `tests/comptime_ref.test.yo` passes the same way `readn` already does (the
  value stays unknown, consistent with current comparison behavior + Bug C).
- Does NOT require Gaps 3/4.
Risk: medium — must not regress the comparison path; `Self.Output` resolution is
the crux. Validate per-file (yo-self 227 / std 151 / tests 163, 0 regressions).

### Tier 2 — true value folding (larger)
Add Gap 3 (comptime-over-runtime priority) and Gap 4 (execute the comptime
method body via `evaluate_comptime_fn_call`) so `usize(5)+usize(1)` actually
folds to `6`. Enables real comptime arithmetic (array lengths, comptime
branching) and — together with the module-level execution work — makes
`comptime_assert` over arithmetic verify for real (Bug C). Verify the leaf
folder receives `IntLit` operands (confirm `usize(5)` reduces to `IntLit("5")`,
not `UnknownVal(usize)`; if the latter, the cast path needs comptime folding too).
Risk: higher — overload-resolution change is broad; CTFE-executing operator
bodies could surface latent issues the `unit`/UnknownVal fallback masks.

## Recommended order

1. **Tier 1 first.** It removes the acute `unit`-type failures and is
   self-contained. Measure per-file; it should be net-positive or neutral.
2. **Tier 2 next**, on top of Tier 1: port the overload priority (Gap 3), then
   route comptime operator methods through `evaluate_comptime_fn_call` (Gap 4).
3. Only then revisit **Bug C** (`is_executing` at module level), which
   additionally requires an execution-ready module-level evaluator (Phase 5+).

## Files in play

- `yo-self/evaluator/calls/function.yo` — infix dispatch (Gaps 1, 2, 4 wiring)
- `yo-self/evaluator/calls/helper.yo` — overload resolution (Gap 3)
- `yo-self/evaluator/calls/comptime_fn.yo` — CTFE body execution (Gap 4 target)
- `yo-self/evaluator/builtins/comptime_numeric_fns.yo` — leaf folder (exists)
- `yo-self/types/...` — `Self.Output` associated-type resolution (Gap 2)
- TS references: `src/evaluator/calls/function.ts:452,1630-1681`,
  `src/evaluator/builtins/comptime-numeric-fns.ts`, `std/prelude.yo:346+`
