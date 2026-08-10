# A bare `if` whose branch awaits and early-returns is miscompiled (BOTH compilers)

**Status: FIXED** (found 2026-08-10 while reducing the stage-2 empty-RHS
errors; fixed the same day). Started as "TS skips the branch, yo-self is
right" — the full reduction showed BOTH compilers miscompile the shape, in
different ways, and the yo-self "correct" case was only one sub-shape.

Reproducer: [`../repros/ts-bare-if-await-early-return-skipped.yo`](../repros/ts-bare-if-await-early-return-skipped.yo)
Regression tests: `tests/async_await.test.yo` — "Test a bare if whose branch
awaits then early-returns" and "…between two top-level awaits".

```rust
io.async((aio : Io) => {
  first := aio.await(f(aio), aio);          // ← preceding await (one sub-shape)
  if(n == usize(0), {
    existing := aio.await(f(aio), aio);     // await-BINDING in a bare-if body
    if(existing.len() > usize(0), { aio.await(yield(aio), aio); });
    return(String.from("empty-path"));      // early return
  });
  return(String.from("deps-path"))
})
```

`yo fetch`'s prune-stale-lock branch (`yo-self/fetch.yo` `run_fetch`) and
`clone_repo`'s checkout-retry branch are exactly this family — it is what
broke the PR #92 bootstrap-fixpoint job (8 stage-2 clang errors, all
`sm->var_N = ;`).

## The failure modes

- **TS** (valid C, silent wrong behavior): the branch's code after its first
  await goes through `generateRemainingExprFuture` (state-machine.ts), which
  handled nested cond/match/while/begin but **not `if`** — a macro whose
  branch structure only exists in `$.macroExpansion`. It emitted
  `// Warning: unhandled await pattern` and nothing else, so the nested
  await's future was never stored; the chained early-return code was then
  emitted INSIDE the `if (sm->await_future_N != NULL)` guard of that
  never-submitted future. Result: the whole branch was skipped at runtime
  (prints the fall-through value, rc 0).
- **self-hosted** (invalid C): the suspension-point walker
  (`yo-self/evaluator/shared/suspension_analysis.yo`) had **no `if` case** —
  TS walks `expr.$.macroExpansion` for an `if` (suspension-analysis.ts) so
  its points get the merged cond indices; yo-self walked the raw args, and
  because yo-self's `if`→`cond` expansion CLONES subtrees with fresh
  ExprIds, the awaits never became await points at all. Codegen (which does
  follow the expansion) then emitted `sm->var_N = ;` where the await results
  were read — the stage-2 clang errors. A second yo-self gap:
  `contains_suspension_expr` (codegen/shared/suspension_codegen.yo) compared
  `ast_expr_id` and never looked through the expansion table, so even found
  points could not be routed.

## The fix set (both compilers, kept 1:1)

1. **Walk `if` through its macro expansion** in the suspension analysis
   (yo-self `suspension_analysis.yo`; TS already had it).
2. **See through expansions in containment**: yo-self
   `contains_suspension_expr` now recurses into
   `lookup_macro_expansion(id)` — the durable side-table, since yo-self
   expansions have fresh ids where TS shares node identity.
3. **`generateAwaitExpression` retries via the expansion** for an `if` whose
   await is in a branch value (yo-self `state_code_gen.yo`; TS already had
   it).
4. **`generateRemainingExprFuture` handles `if`** via the expansion
   (state-machine.ts + state_machine.yo).
5. **cond_branch dispatch codes start at 1** (`allocCondBranchCodes` /
   `_alloc_cond_branch_codes`): the sm is calloc-zeroed, so 0 now
   unambiguously means "no await-carrying branch ran".
6. **Outer-cond chained layers are emitted OUTSIDE the NULL guard**, gated on
   `sm->cond_branch_X == <code>` (their own still-reliable dispatch field);
   layers whose field was CLAIMED by the nested cond
   (`condBranchFieldIndex === prevAwait.index`, the drops-only
   `nestedClaimedDispatch` kind) keep their unconditional inside-guard
   placement. TS: extracted `processChainedBranch` in state-machine.ts;
   yo-self: `_emit_outer_chained_branch_layers` in state_machine.yo.

## Verification

- Probe (both paths): TS `empty: 0 / some: 1` (was `1/1`); self-hosted
  emission has no FTT comments, no `= ;`, no unhandled-await warnings.
- `tests/async_await.test.yo` 153+2/155, `tests/algebraic_effects.test.yo`
  74/74 under TS after the fix.
- The stage-2 fixpoint reduction this unblocks is tracked in
  `issues/fixed/stage2-match-if-else-value-phantom-temp.md` (sibling bug,
  same campaign).
