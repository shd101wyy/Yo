# In-process watch drivers hit "forcing `X` after module finished its walk and released its evaluation context"

**Status: FIXED 2026-09-21.** Regression from #805 (`plans/EVALUATOR_MEMORY_REDUCTION.md`
Phase 1, F1): a finished module walk now releases its `EvalContext` unless
`set_retain_walk_contexts(true)` was called first. `src/main.yo` sets it for
`check --watch` / `--watch-once`, `src/lsp/server.yo` for the LSP. The internal
test `tests/internal/check_watch.test.yo` drives `watch_round` IN PROCESS
without going through `main`, so its per-def rounds re-forced definitions of
walks that had already dropped their context:

```
internal error: forcing `answer` after module `file:///tmp/yo_check_watch_fixture_p3/lib.yo`
finished its walk and released its evaluation context (only `check --watch` and `yo lsp` retain it)
```

Develop battery run 35520237279 (tip ba77dead3): internal-tests shard 1 red on
the Phase 3a and Phase 3b tests. (Shards 0 and 2 were red on a DIFFERENT bug
the same PR exposed: `issues/fixed/module-level-method-call-on-a-user-fn-result-is-a-stub.md`.)

## Fix

1. The test declares itself a watch session (`set_retain_walk_contexts(true)`)
   before its first load, exactly as `main` does for `--watch`. The internal
   error stays: it is the correct diagnosis for a driver that forgot.
2. `mm_revalidate_plan` treats a walk whose context was released as not
   per-def-able (`allowed = walk.ctx.is_some()`), so any other in-process
   caller falls back to the file-level reload instead of tripping the
   internal error mid-round. The file-level path is always correct.
