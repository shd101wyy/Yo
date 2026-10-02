# A `law(...)` over an IMPORTED callee reports `cannot verify: untyped expression`

**Severity:** S2 — the documented `spec/`-directory convention (laws in their
own file, implementation imported) fails loudly for every cross-file law; only
same-file laws verify, so the flagship laws workflow cannot be used as
documented.

**Status: FIXED 2026-10-03** (see Fix below). Originally: **OPEN.** Found 2026-10-01 while writing the yo-verification skill
(the agent-loop audit's failed-verify pass): the canonical example in
`docs/en-US/FORMAL_VERIFICATION.md` §Laws (which imports `./math.yo`) does not
verify, while the same law beside the callee in one file proves clean.
**Measured on:** `yo 0.2.47`, worktree at `8042cc5b9`, `--std-path ./std`.

## Symptom

Two files — the contracted callee and a law about it (the exact shape of the
doc's §Laws example and of the BEND D3 `spec/` convention):

```rust
// math.yo
pragma(Pragma.Verify);
abs_value :: (
  fn(
    x : i64,
    requires((x > i64(-1000)) && (x < i64(1000))),
    ensures((r >= i64(0)) && (r < i64(1000)))
  ) -> (r : i64)
)(cond((x >= i64(0)) => x, true => -x));
export(abs_value);
```

```rust
// laws.yo
pragma(Pragma.Verify);
{ abs_value } :: import("./math.yo");
abs_doubles_nonneg :: law(
  fn(
    x : i64,
    requires((x > i64(-1000)) && (x < i64(1000))),
    ensures((abs_value(x) + abs_value(x)) >= i64(0))
  ) -> unit
);
```

```
$ yo verify laws.yo --strict
  subset   law@laws.yo:5:22 [verify] — cannot verify: untyped expression
           (x > i64(-(1000))) && (x < i64(1000))
verify: 0 ok, ..., 1 subset-error
```

The same law text INLINE in `math.yo` (the `tests/spec/fixtures/valid/law_abs_nonneg.yo`
shape) reports `ok ... 3 obligation(s) proved`. Verifying the DIRECTORY
containing both files does not help — the callee proves, the law still
subset-errors — so the defect is not target-set membership.

## Root cause (narrowed, not fixed)

The law's synthetic verify task loses type information for the clause
predicates when the callee arrives through a demand-loaded import: the walk
reports the law's own `requires` as an "untyped expression" before any
obligation is formed. The same-file registration path (B1's
`evaluate_law` + the fn-type side tables) carries the types fine. Where the
import path diverges from the same-file path is the open question — likely
the fn-type-expr contract tables (`get_func_requires_exprs` keyed by the
fn-type expression id) not surviving the cross-module read in
`src/evaluator/builtins/contracts.yo` / `src/verifier/vc.yo`.

## Repro

`issues/repros/law-over-an-imported-callee-cannot-verify/` — `math.yo` +
`laws.yo` as above; `yo verify laws.yo --strict` fails, `yo verify
math.yo --strict` (with the law inlined) passes.

## Impact on the agent loop

This blocks the whole `spec/` + `yo verify ./spec --strict` gate the
roadmap's Agent-loop item is built on (`plans/backlog/BEND_LAWS_AND_AGENT_LOOP_LESSONS.md`
A1–A3, D3): laws cannot live in a file the implementation does not touch
until it is fixed. The shipped agent docs (pack v3, yo-verification skill)
carry the workaround — keep laws beside the contracted code — and this
issue is the tracked fix.

## Fix

Measured before the fix (`yo verify --strict`, a compiler built from develop
`300cdb9a3`):

| file | before |
| --- | --- |
| a law that only IMPORTS `math.yo`, no call | ok |
| the same law with no import | ok |
| a law with no `requires`, whose `ensures` calls the imported `abs_value` | subset-error, untyped expression |
| `laws.yo` above | subset-error, untyped expression |
| a FUNCTION whose own `ensures` calls the imported `abs_value` (`r == abs_value(x) + 1`) | subset-error, untyped expression |
| a function whose BODY calls the imported `abs_value` | ok |

So the untyped expression was the CALLEE's clause `(x > i64(-(1000))) && …`
(`abs_value`'s own `requires`), not the law's, and laws were one case of a
wider gap: any contracted call inside a contract clause.

Cause: at a contracted call the verifier reads a contract instance stashed
under the call node (`callsite_contracts_for`, written by
`prepare_callsite_contracts` at task registration) and otherwise falls back to
the callee's raw clauses, which are typed only in the callee's module table.
The stash walked the task's BODY only. A law's calls live in its clauses (its
body is a unit literal), and a function's calls in its `requires`/`ensures` were
never walked either, so a callee from another file met the raw-clause
fallback against the wrong table. Same-file callees worked only because the
two tables are one.

Fix: the stash also walks each evaluated clause — in `evaluate_law`
(`src/evaluator/builtins/contracts.yo`) and at a function's task
registration (`src/evaluator/calls/function_type.yo`, non-deferred bodies;
a generic body's clauses are soft-evaluated and stashed per instance).

Tests: `tests/internal/verifier_law.test.yo` "a law over an IMPORTED callee
proves like a same-file one" (3 obligations, like `law_abs_nonneg.yo`) and
"an ensures that calls an IMPORTED contracted fn proves", over the fixtures
`tests/spec/fixtures/valid/law_imported_callee*.yo` and
`ensures_imported_callee.yo`. The docs' and the yo-verification skill's
"keep laws beside the code" caveat is removed. (The function fixture claims
`(r >= 1) && (abs_value(x) < 1000)`: each call is modular, so equality with the
body's call is not provable. Its first run surfaced
`issues/fixed/a-callee-fact-in-the-right-operand-of-and-is-dropped.md`.)
