# A quantified contract clause compiles only under `Pragma.Verify`

**Severity:** S2 — a module that writes `requires(exists(...))` fails to compile with E0401 unless it carries `pragma(Pragma.Verify);`, and under `Pragma.VerifyOrAssert` a function with a quantified `ensures` and a block body is reported `subset` and proves nothing.

Filed 2026-11-22 while checking
`plans/backlog/LOGIC_PROGRAMMING_ADOPTION_CANDIDATES.md` against
[`plans/backlog/DEFAULT_ON_VERIFICATION.md`](../plans/backlog/DEFAULT_ON_VERIFICATION.md),
which makes `verify+` the default mode. Reproduced with `yo` 0.2.79 running
the tree's `std` at `1e55e6c90`, Z3 5.1.0.

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
`issues/2026-11-15-under-verify-plus-a-function-with-a-requires-no-ensures-and-a-block-body-is-not-verified.md`.

## Fix

Every mode treats a proof-only clause the same way: it is evaluated in ghost
context for type-checking and for the verifier, and never spliced. The
`subset` message names the underlying error instead of pointing at a command
that does not print it.

## Test

The reproducer under each of the three modes as fixtures of
`tests/spec/fixtures/valid/`. DEFAULT_ON_VERIFICATION step S0's both-modes
sweep covers the first two once it exists:
`tests/spec/fixtures/valid/dml-sorted-insert.yo` has a quantified `requires`
and is verified only under `Pragma.Verify` today.
