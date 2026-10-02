# `yo verify` function ids carry 0-based rows, so `--explain file:line` misses

**Severity:** S3: misleading diagnostics. A function's report id names the line before the one it sits on, and `--explain <file>:<line>` with the real line matches nothing.

**Status: OPEN.** Found 2026-10-03 while writing FORMAL_VERIFICATION §Loop invariants (agent-knowledge consolidation K1). **Measured on:** yo 0.2.49, `--std-path ./std`.

## Symptom

```rust
pragma(Pragma.Verify);

add_one :: (fn(x : i32) -> (r : i32))(x + i32(1));
```

`add_one` is on line 3, but `yo verify` reports it as `fn@tmp/fv_7.yo:2`. `yo verify tmp/fv_7.yo --explain fv_7.yo:3` fails with `verify: --explain 'fv_7.yo:3' matched no verified function (of 1)`, and `--explain fv_7.yo:2` matches. Guard-site ids such as `divisor-nonzero@13:63` are 1-based, so the two kinds of id disagree in the same report.

## Cause

`fn@` and `law@` ids format `tok.row` (and `tok.column`) directly, and those are 0-based: `src/evaluator/calls/function_type.yo` near lines 1583 and 1771, and `src/evaluator/builtins/contracts.yo` near line 3208.

## Expected

Every id is 1-based, so `--explain` accepts the line an editor shows. The sample output in `docs/en-US/FORMAL_VERIFICATION.md` §Loop invariants, `fn@sum_to.yo:7/ensures#0`, shows today's 0-based row; update it, and its zh-CN mirror, with the fix.
