# Phase 3: comptime arithmetic operators are never folded (`+`/`-`/`*`/…)

## Status

ROOT CAUSE FOUND. Two bugs uncovered while tracing the
`tests/comptime_ref.test.yo` failure:

- **Bug A — FIXED**: `comptime(ref(n))` / `inout(n)` parameters were bound as
  NON-reassignable, so `n = …` inside the body threw `Cannot reassign "n"`.
- **Bug B — OPEN (the real blocker)**: yo-self never folds arithmetic/bitwise
  operators at compile time. `usize(5) + usize(1)` resolves the operator name
  `+` through the *unbound-identifier soft fallback* → `UnknownVal(unit)`, even
  at module level. Comparison operators (`==`/`<`/…) are dispatched to trait
  methods; arithmetic operators are deliberately NOT, and there is no concrete
  comptime-folding path, so every comptime arithmetic expression is `unit`.
- **Bug C — OPEN (latent, masks Bug B everywhere)**: `comptime_assert` passes
  vacuously when its argument is a non-concrete (`UnknownVal`) bool. So
  `comptime_assert((usize(5) + usize(1)) == usize(999), …)` *passes* in yo-self
  (TS correctly FAILS it). This is why the gap went unnoticed — almost no test
  actually verifies a comptime arithmetic result, and the ones that "pass" do so
  vacuously.

## How it was found (body-node-level trace)

Repro: `bump :: (fn(comptime(ref(n)) : usize) -> comptime(usize))({ n = (n + usize(1)); n });`

1. `evaluate_comptime_fn_call` reaches the body-eval (`CFBODY-PRE`) on both
   calls but `evaluate_begin_expression` never returns (`CFBODY-POST` never
   logged) — it throws inside the first statement.
2. The first statement is the assignment `n = (n + usize(1))`. `evaluate_assignment`
   looked up `n` and found `is_reassignable = false` → threw `Cannot reassign "n"`.
   **(Bug A.)** The throw is caught + printed + swallowed by the non-raw
   `evaluate_expression` wrapper, which is why the file didn't hard-fail there.
3. After fixing Bug A (`is_reassignable` from `param_is_ref`), the assignment ran
   but the RHS `n + usize(1)` evaluated to **type `unit`** → assignment's
   type-compat check threw `Incompatible types: Expected usize, Given unit`.
4. Tracing the `+`: the operator name `+` is looked up as an identifier, NOT
   found in env, and returns the soft fallback `UnknownVal(t_unit())`
   (`identifer_and_operator.yo:148-159`). This happens for BOTH `bump` and a
   read-only `readn(n) = n + usize(1)`, and even for module-level
   `x :: (usize(5) + usize(1))`. **(Bug B.)**
5. `readn(5) == 999` and `x == 999` both *pass* in yo-self (should fail) →
   **(Bug C)** confirms `comptime_assert` doesn't require a concrete bool.

## Bug A fix (landed)

`yo-self/evaluator/calls/function.yo`, FuncVal-call param binding: the 6th
positional arg to `add_variable_to_env` (`is_reassignable`) was hardcoded
`false`. Now extracted from the callee `Func` type's `param_is_ref` array
(parallel to `param_types`) and passed through — mirroring TS
`helper.ts:581` (`isReassignable: parameter.isRef`). Validated per-file:
std 151→151, yo-self/tests no regressions (arithmetic still doesn't fold, so no
observable behavior change beyond the error message; the fix removes a genuine
1-to-1 divergence from TS).

## Bug B — what's needed (the actual feature)

A concrete comptime-folding path for arithmetic/bitwise operators, so that when
both operands are compile-time-known numeric values, `+`/`-`/`*`/`/`/`%`/bitwise
compute the result and produce a typed comptime value (mirroring TS's operator
dispatch: `function.ts:452` routes infix operators to the receiver's trait
method — `Add`/`Sub`/… — and the comptime body folds). yo-self currently routes
ONLY comparison operators (`function.yo:316-386`) and leaves arithmetic to the
soft fallback. This is pervasive (every comptime arithmetic expression is
affected) and high-risk to change: implementing real folding will surface latent
type errors that the `unit` fallback currently masks everywhere (Bug C lets them
pass). Treat as a dedicated feature effort with full per-file 0-regression
validation, NOT a quick fix.

## Bug C — what's needed

`comptime_assert` (and other comptime bool-forcing sites) must reject a
non-concrete (`UnknownVal`) argument instead of passing vacuously. Fixing C
BEFORE B would expose the true count of arithmetic-dependent test failures
(currently hidden), so C is a prerequisite measurement tool for B.

### Bug C root cause + why the obvious fix is BLOCKED (attempted, reverted)

`comptime_assert.yo` is ALREADY 1-to-1 with TS:
- The *executing* path (`is_executing == true`) is STRICT — `is_bool_val(arg)`
  rejects `UnknownVal` (matches TS `comptime-assert.ts:78` `isBooleanValue`).
- The *non-executing* path is LENIENT — accepts `UnknownVal` (matches TS lines
  42-46). This leniency is intentional and correct.

The vacuous pass is NOT a comptime_assert bug. It's that yo-self evaluates ALL
module-level exprs with `ctx.is_executing == false`, so module-level
`comptime_assert` takes the lenient path. TS evaluates module-level exprs with
`isExecuting: true` (`index.ts:194`, `Evaluator.evaluateProgram` — for the main
module AND every module loaded via `loadModule`), so TS takes the strict path
and correctly fails a false module-level assertion.

ATTEMPTED FIX (reverted): set `ctx.is_executing = true` at the
`evaluate_anonymous_module_begin_exprs` call sites in `main.yo` (prelude,
demand-loaded imports, top-level check). Result: CATASTROPHIC — `is_executing`
is too broad a flag. It makes EVERY module-level expr "execute", but yo-self's
module-level evaluator is built to CHECK, not EXECUTE:
- Full version (incl. prelude): even a trivial file fails — the prelude's own
  module-level code hits Bug B (`Previous: Expr, Current: unit`) and breaks the
  cached prelude env, so all files fail.
- Top-level-only version (prelude left lenient): a trivial
  `main :: (fn()->i32)(0); export main;` STILL fails with
  `paren-less function and operator calls are not supported` — `export main`
  (and other module-level forms) are not execution-ready under `is_executing`.

CONCLUSION: Bug C's faithful fix requires the module-level evaluator to be
EXECUTION-READY (a Phase-5+/codegen-semantics concern, not evaluator-only
Phase 3) AND Bug B fixed first. Do NOT re-attempt the `is_executing` flip in
isolation — it is not a targeted fix. The narrow, safe path is: fix B
(comptime arithmetic folding) first; C becomes observable/measurable only once
module-level execution is viable.

## Affected test

`tests/comptime_ref.test.yo` (and any test that genuinely depends on a comptime
arithmetic result — currently vacuously green via Bug C).
