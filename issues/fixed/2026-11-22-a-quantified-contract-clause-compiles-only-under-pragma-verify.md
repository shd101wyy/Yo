# A quantified contract clause compiles only under `Pragma.Verify`

**Severity:** S2 — a module that writes `requires(exists(...))` fails to compile with E0401 unless it carries `pragma(Pragma.Verify);`, and under `Pragma.VerifyOrAssert` a function with a quantified `ensures` and a block body is reported `subset` and proves nothing.

Filed 2026-11-22 while checking
`plans/backlog/LOGIC_PROGRAMMING_ADOPTION_CANDIDATES.md` against
[`plans/backlog/DEFAULT_ON_VERIFICATION.md`](../../plans/backlog/DEFAULT_ON_VERIFICATION.md),
which makes `verify+` the default mode. Reproduced with `yo` 0.2.79 running
the tree's `std` at `1e55e6c90`, Z3 5.1.0.

- Status: FIXED by the `wip/v0281-dov-s0` branch (DEFAULT_ON_VERIFICATION
  step S0), together with
  `issues/fixed/2026-11-15-under-verify-plus-a-function-with-a-requires-no-ensures-and-a-block-body-is-not-verified.md`.
  The both-modes sweep found the wider class described under "Root cause".

## Reproducer

```yo
quant_req :: (fn(n : i64, requires(exists(x : i64, (x + x) == n))) -> i64)(n);

quant_block :: (
  fn(n : i64, requires(n == i64(47)), ensures(exists(x : i64, (x + i64(1)) == r))) -> (r : i64)
)({
  n + i64(1)
});
```

Each function in a file of its own, under each mode:

| Mode | `quant_req` | `quant_block` |
| --- | --- | --- |
| `pragma(Pragma.Verify);` | `ok` | `ok`, 1 obligation proved |
| `pragma(Pragma.VerifyOrAssert);` | E0401, the file does not evaluate | `subset` |
| no pragma (`runtime`) | E0401, `yo compile` fails | not run alone; a quantified `ensures` on a unit function with a block body compiled and ran |

The error in the two failing cells of the first column:

```text
error[E0401]: Variable "exists" not found.
help: run `yo explain E0401` for more information
```

The `subset` report under `Pragma.VerifyOrAssert`:

```text
  subset   fn@q.yo:11 [verify+] — cannot verify: the body's definition-time evaluation did not complete (its error was swallowed at load — run yo check on the file for the underlying cause)
           begin(n + i64(1))
```

`yo check` on that file prints the same line and no underlying cause. The
same `ensures` on an expression body (`)(n + i64(1));`) is `ok` under
`Pragma.VerifyOrAssert`, so the block body is part of the trigger.

## Cause

The manual says quantifiers are legal inside contract clauses
(`docs/en-US/FORMAL_VERIFICATION.md`, the subset section), and the rule for
the modes that keep runtime checks exists: a clause that quantifies is
proof-only and is not spliced (`requires_is_runtime_checkable` and
`ensures_is_runtime_checkable`, `src/evaluator/builtins/contracts.yo:2881-2890`).
The failing paths reach the clause outside ghost context anyway: `exists` is a
builtin only while `ctx.is_ghost_context` is set (`evaluated_for_verify`,
`contracts.yo:1678-1688`), and elsewhere the name resolves as an ordinary
variable, hence E0401.

Not traced: which splice site skips the proof-only test for `requires`, and
why the block-body `ensures` wrapper fails where the expression-body one does
not. The second may share its root with
`issues/fixed/2026-11-15-under-verify-plus-a-function-with-a-requires-no-ensures-and-a-block-body-is-not-verified.md`.

## Root cause

Two causes, one per column of the table.

`quant_block` is the root cause of
`issues/fixed/2026-11-15-under-verify-plus-a-function-with-a-requires-no-ensures-and-a-block-body-is-not-verified.md`.
The quantified `ensures` is proof-only, so no `ensures` is spliced, and
`verify+` then flattened the block body into a requires-only `begin`. The
body node the verifier walks never got `ExprInfo`.

`quant_req`: `wrap_function_body_with_contracts`
(`src/evaluator/builtins/contracts.yo`) filtered the `requires` by
`requires_is_runtime_checkable` only in `verify` mode. `verify+` and runtime
mode spliced every `requires` as an entry assert, and the splice evaluated the
quantifier outside ghost context. The both-modes sweep
(`scripts/verify-both-modes.py`) found two more cases of the same rule being
broken, in 12 fixtures of `tests/spec/fixtures/valid/` that prove under
`Pragma.Verify` and failed under `Pragma.VerifyOrAssert`:

- **A requires that cannot run is spliced** (`forall`, `distinct`, a
  `ghost_fn` call): `dml-sorted-insert`, `list-distinct`, `ghost-fn-inline`,
  `lemma-member-frame`. The load fails with "ghost-only builtin" or "a
  ghost_fn is callable only from ghost context".
- **The runtime-checkability test knew too few ghost-only builtins.**
  `_contract_clause_runs` listed `old`, `forall`, `exists`, `ghost` and
  `distinct`, but not `==>` or the std/spec ghost collections (`seq_*`,
  `seq_of`, `produced`, `ms_*`, `set_*`, `str_bytes`). An `ensures` over them
  was spliced in `verify+` and runtime mode: `dml-append-seq`, `for-produced`,
  `spec-seq`, `spec-set`, `spec-multiset`, `spec-str-bytes`. The load fails
  with "ghost-only builtin".
- **Contracts are spliced into a `ghost_fn` body**, which never runs. `verify`
  mode skipped a `ghost_fn`, but `verify+` spliced a `requires failed` guard
  (a `__yo_panic` call) into it. The walk of the ghost function, and of every
  caller that unfolds it, then reported `subset` ("call to an uncontracted,
  untyped callee"): `dml-member`, `ghost-fn-recursive`,
  `ghost-fn-contracted-ghost-call`.

## Fix

Every mode treats a proof-only clause the same way: it is evaluated in ghost
context for type-checking and for the verifier, and never spliced.

- `wrap_function_body_with_contracts` splices only the runtime-checkable
  `requires` and `ensures`, in every mode, and splices nothing into a
  `ghost_fn`. A proof-only `requires` is then unchecked for a caller the
  verifier never walks, as `verify` mode already had it and as for a `refine`.
- `_contract_clause_runs` treats every ghost-only builtin as proof-only
  (`_is_ghost_only_builtin`: the quantifiers, `==>`, and the std/spec ghost
  collections).
- `requires_enforced_flags` mirrors the splice. The verifier counts a
  `requires` as enforced only when it is asserted at entry: a checkable one
  outside a `ghost_fn`, in either verifying mode.
- The `subset` message for an untyped body root no longer points at `yo
  check` (fixed with the 2026-11-15 issue).

## Test

- One `Pragma.VerifyOrAssert` fixture per cause, each failing before the fix:
  `tests/spec/fixtures/valid/verifyplus-proof-only-requires.yo` (E0401 at
  load), `verifyplus-ghost-builtin-ensures.yo` ("ghost-only builtin" at load)
  and `verifyplus-ghost-fn-body.yo` (3 `subset-error`).
- Runtime mode: the last test of `tests/spec/contracts-phase0.test.yo` calls
  functions with a quantified `requires`, a `ghost_fn` `requires` and an
  `ensures` over `seq_*`. Before the fix the file fails to load with E0401.
- `quant_block`: `tests/spec/fixtures/valid/verifyplus-requires-block.yo`.
- The both-modes sweep runs every valid fixture under both pragmas and
  requires the same proved set. Its known-divergence list
  (`tests/spec/verify-both-modes-known.tsv`) is empty.
