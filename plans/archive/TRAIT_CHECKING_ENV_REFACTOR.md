# Trait-Checking Env Refactor (Follow-up)

## Status: Complete — full refactor shipped in commit `f61e90c9`

## Context

`typeImplementsTrait()` in `src/evaluator/trait-checking.ts` and its
underlying helper `areTypesCompatible()` perform unification while
checking whether a target type satisfies a trait constraint, but they
discard the resulting environment and return only a boolean.

This caused a real bug: where-clause validation could not learn
associated-type bindings (e.g. `A` from `Iterator(Item := A)` matched
against an impl with `Item := i32`). See
`tests/where_clause_fn_inference.test.yo` and
`tests/blanket_impl_inner_forall.test.yo` for regression coverage.

## Interim fix (already shipped)

Added `typeImplementsTraitWithBindings({ targetType, traitType, env })`
returning `{ implemented: boolean; env: Environment }`. After
`areTypesCompatible` confirms a match, it runs `synthesizeTypes` to
capture the bindings produced by:

- the Fn-trait built-in satisfaction rule (binds parameter & return
  SomeTypes against a concrete function type), and
- the impl-trait field match (binds associated-type SomeTypes such as
  `Item := A` ↔ `Item := i32`).

Wired into `validateConcreteTypeConstraints` only. All other call sites
of `typeImplementsTrait` still use the boolean form. This keeps blast
radius minimal while fixing the immediate correctness gap.

## Why a deeper refactor may eventually be needed

`typeImplementsTrait` and `areTypesCompatible` are called in 200+
places across the evaluator. The interim fix patches one entry point
(where-clause validation) but the same root cause — unification env
discarded — likely lurks elsewhere. Suspected candidates:

| Area                                                | Symptom that would surface the bug                                                                                         |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Trait method dispatch (`getReceiverMethodsByName*`) | Method dispatch picks wrong overload or fails to specialize associated types when receiver is a generic with where-bounds. |
| `dyn` coercion / vtable construction                | Associated-type witnesses dropped when boxing a generic into a `dyn`.                                                      |
| Generic impl matching for blanket impls             | Blanket `impl(forall(I), where(I <: Trait))` may fail to refine `I`'s associated types in callee bodies.                   |
| GADT match refinement via `where` constraints       | GADT branches that depend on associated-type equalities may fail to refine.                                                |
| Effect handler matching                             | Module-effect type matching (`given(x) := M(...)`) discards bindings from associated types in the module signature.        |

Each of these can be migrated _individually_ to
`typeImplementsTraitWithBindings` as bugs are discovered, by changing
one boolean call site at a time.

## Long-term refactor plan (when evidence justifies it)

When 3+ additional bugs of the same shape are discovered, escalate to
the full refactor:

1. **Make `typeImplementsTrait` return `{ implemented, env }` always.**
   Inline `typeImplementsTraitWithBindings` as the canonical
   implementation.
2. **Add a thin `typeImplementsTraitBool` wrapper** for sites that
   genuinely only need yes/no (probably ~60% of call sites).
3. **Migrate call sites in waves**, grouped by file, with regression
   tests. Order suggested:
   1. trait method dispatch (`calls/`, `dispatch.ts`)
   2. dyn coercion (`dyn.ts`, `values/dyn-impl.ts`)
   3. generic impl matching (`values/impl.ts`)
   4. GADT refinement (`exprs/match.ts`)
   5. effect handler matching (`effects/`)
   6. all remaining boolean-only sites stay on the `Bool` wrapper
4. **Consider also lifting `areTypesCompatible`** to return the env
   directly, eliminating the redundant `synthesizeTypes` second pass
   in the new helper. `areTypesCompatible` already builds the
   substitutions internally; surfacing them is the deepest correct
   fix.

## Decision criteria for escalation

Escalate to the full refactor when **any** of the following holds:

- 3 or more new bugs traced to "boolean trait-check discarded env" are
  reported.
- Bootstrapping the Yo compiler in Yo itself (per
  `plans/archive/BOOTSTRAPPING_PREREQUISITES.md`) requires associated-type
  inference in a code path not covered by where-clause validation.
- A perf measurement shows the dual-pass (`areTypesCompatible` +
  `synthesizeTypes`) is hot enough to warrant unification.

## Tracking

- Commit of interim fix: `c85db1dc`
- Regression tests:
  - `tests/where_clause_fn_inference.test.yo`
  - `tests/blanket_impl_inner_forall.test.yo`
- Related issue: `issues/blanket-impl-inner-forall-sometype-leakage.md`
- Bootstrap dependency: `plans/archive/BOOTSTRAPPING_PREREQUISITES.md` §1.2
  (Iterator combinators) — partially unblocked.

## Follow-up: env-aware `extractFnTraitFromType`

Discovered while exercising iterator combinators with inline lambdas:
`extractFnTraitFromType` only inspected `SomeType.requiredTraits`, missing
Fn-trait constraints stored in env's `whereClauseConstraints` map (which is
where `where(F <: Fn(...))` constraints actually live for forall-introduced
SomeTypes).

Fix: `extractFnTraitFromType` now takes an optional `env` parameter. When
provided, it also walks `getWhereClauseConstraintsForSomeType(env, type)`
in addition to `requiredTraits`. Callers in
`src/evaluator/values/anonymous-function.ts` and
`src/evaluator/calls/function.ts` were updated to pass env. The lambda-arg
call site in anonymous-function uses `context.expectedType?.env` (the
**callee** env), since that's where the where-clause was registered.

Also fixed: typed lambda parameter syntax `(x : *(i32)) => ...` was failing
with "Variable x not found" because regular-param handling assumed each
param was a bare atom. The fix unpacks the `:` FnCallExpr's LHS atom for
the variable name; the user-provided type annotation is ignored because
the function signature's parameter type is authoritative.

### Known limitation (deferred)

Calling iterator combinator chains with inline closures (e.g.,
`iter.filter((x : *(i32)) => x.* > i32(2)).next()`) still fails to find
the matching blanket Iterator impl for `IterFilter(I, F)`. The lambda's
where-clause Fn check now passes correctly, but the subsequent generic
impl lookup against `IterFilter(I, F-bound-to-closure)` does not match.
Top-level `fn(...)` callbacks (FunctionType, not SomeType wrapper) work
fine. This requires deeper investigation in the synthesizer's handling of
SomeType wrappers around closure capture structs and is tracked as future
work.
