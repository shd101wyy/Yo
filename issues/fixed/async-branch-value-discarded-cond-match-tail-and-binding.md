# Async: a cond/match BRANCH VALUE was silently discarded — tail position and `:=` bindings

**Status: FIXED in BOTH compilers** (2026-08-10). The worst kind: silent
wrong data, rc=0. Found during P2.4 while porting `version.test.ts` —
`read_yo_version` (yo-self/version.yo) returned `.None` for a perfectly
valid `.yo-version` file under BOTH compilers, because its body is

```rust
match(path_opt, .None => Option(String).None, .Some(path) => {
  content := e.io.await(read_string(path, e.io), e);
  ... .Some(version)
})
```

— a `match` whose arm awaits and then computes the arm VALUE, with the
match as the async block's tail expression.

## Symptoms (all rc=0, all silent)

For an `io.async` block, with `mk()` resolving to `Some(7)`:

| shape                                                        | pre-fix result |
| ------------------------------------------------------------ | -------------- |
| tail `match(got, .Some(v) => { await; Some(v+1) }, ...)`     | `.None`        |
| `r := match(...same...); r`                                  | `.None`        |
| tail `cond(c => { await; 41 }, true => 3)`                   | `0` / `0`      |
| `bound := cond(...same...); bound + 1` (await branch)        | `1` (= 0+1)    |
| `bound := cond(...same...); bound + 1` (fall-through branch) | `1` (= 0+1)    |

The zero-initialised SM slot decodes as `.None`/`0`.

## Root causes (three, stacked)

1. **No destination registered.** The resume generator assigns an
   await-branch's LAST remaining expression to the branch registration's
   `targetAssignmentCode` — but the enum/nullable/primitive `match` paths
   never attached ANY target, and the tail-position case (`cond` or `match`
   as the async body's implicit return) had no `:=` caller to pass one.
   Fix: derive it at registration — the bound variable's SM field, or
   `sm->result` when the expr IS `context.asyncBodyReturnExpr` (non-unit).
   Only an assignment CODE is registered, never a `targetVariableId` —
   registering the id would also trigger (2).
2. **The post-switch await-result copy overwrote branch values.** The
   "assign cond result to target variable now" copy
   (`sm->var_x = sm->await_result_N`) is emitted AFTER the branch switch;
   with a branch-level destination registered it must be suppressed
   (gated on `!targetAssignmentCode`).
3. **The temp-reference skip discarded the value.** Branch values are
   materialized into codegen temps and the generator returns the temp's
   NAME; the remaining-code emitter skipped bare temp references BEFORE
   checking for a target, so even a registered destination was never
   assigned. Same skip existed in the non-await inline path of `cond`
   (4 sites TS / 1 shared helper in yo-self), which is why the
   fall-through branch of a bound cond was ALSO zero.

Fixed identically in `src/codegen/async/state-code-gen.ts` +
`state-machine.ts` and `yo-self/codegen/async/state_code_gen.yo` +
`state_machine.yo` (helpers `_registration_target_assignment`,
`_set_cond_branch_target`, `_emit_branch_value_inline` target param).

## Why the suite never caught it

The 155-test async suite exercised awaits in scrutinees, conditions,
while steps, arm STATEMENTS, and `return(...)` tails — but no case ever
CONSUMED a branch VALUE computed after an await. All value-bearing arms
either ended at the await or used explicit `return`.

## Tests

`tests/async_await.test.yo` +4: tail match, bound match, tail cond,
bound cond (each asserting the await branch AND the fall-through). Plus
`tests/internal/version.test.yo` "read_yo_version: reads and parses"
(the original finder, 21/21 green).
