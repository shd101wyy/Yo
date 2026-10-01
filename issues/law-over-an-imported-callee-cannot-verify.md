# A `law(...)` over an IMPORTED callee reports `cannot verify: untyped expression`

**Severity:** S2 — the documented `spec/`-directory convention (laws in their
own file, implementation imported) fails loudly for every cross-file law; only
same-file laws verify, so the flagship laws workflow cannot be used as
documented.

**Status: OPEN.** Found 2026-10-01 while writing the yo-verification skill
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
