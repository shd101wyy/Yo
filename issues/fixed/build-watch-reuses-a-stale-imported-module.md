# `yo build --watch` reused a stale imported module (and, once fixed, emitted an untranspiled call)

> Found 2026-09-25 while checking that the evaluator memory campaign
> (`plans/EVALUATOR_MEMORY_REDUCTION.md`) had not broken incremental
> compilation. **FIXED same day** on `fix/build-watch-stale-imports`. Two
> stacked bugs. The first had been present since the warm in-process watch
> build landed (#728): v0.2.38 and v0.2.41 both reproduce it. The second came
> from the campaign's per-function purge (#883), and the first bug hid it.

## Symptom

A project whose `main.yo` imports `val.yo`, built with `yo build --watch`:

| edit | expected | v0.2.38 – v0.2.42 |
| --- | --- | --- |
| `val.yo`: `i32(41)` → `i32(42)` | binary prints 42 | binary still prints 41 |
| `val.yo`: result becomes `true` (type error) | round fails | round "succeeds", binary unchanged |
| edit `main.yo` itself | picked up | picked up |

The round reported `1 file(s) changed — rebuilding`, recompiled in process,
and produced the old code. Only the entry file was re-read.

## Root cause 1: the watch loop never invalidated anything

`build --watch` rounds compile in process against the warm module cache
(`issues/warm-compile-selfcheck.md`, §7 step 2). The cache does not re-read a
file on load. `check --watch` evicts each changed file and its reverse import
closure with `mm_invalidate_document` before re-checking, but the build loop
in `src/main.yo` went straight from `wait_for_change` to the next round, so
every import was served from round 1. The fix for §7 step 2 was verified with
an edit to `src/main.yo`, the entry, which is never cached.

**Fix:** `invalidate_changed_files(changed, std_path)` (`src/check_watch.yo`)
canonicalizes each changed path the way `watch_round` does and invalidates it.
The build loop calls it before every round.

## Root cause 2: the per-function purge outran the specialization cache

With invalidation in place, the type error was now rejected, but a valid edit
failed the round:

```
build: FAILED — internal compiler error: Failed to transpile part of main's body — the emitted C for "__yo_user_main" contains an untranspiled expression
```

Bisected by rebuilding with the campaign's owner purges disabled in
`mm_invalidate_document`:
- all purges disabled: correct;
- only the ExprId side-table purge (#886) disabled: still broken;
- only the per-function purges (#883) disabled: correct.

`take_owned_func_ids` returns the function ids registered while the dropped
module was loading, including the specializations of cached (std) generics
that its evaluation requested. The purge dropped their `g_func_type_registry`
and per-function side-table entries. The specialization cache
(`g_specialized_fn_caches`) kept the entries. Type ids are stable, so the
module's re-evaluation hit those entries and got back FuncVals whose function
types were gone, and codegen could not lower the call.

`check`, `check --watch` and `yo lsp` never run codegen after an invalidation,
so none of them could see this. Root cause 1 meant `build --watch` never
invalidated either.

**Fix:** each `SpecializedFunctionCache` records `registration_owner()` (the
same owner `record_owned_func_id` uses), and
`purge_specialization_caches_owned_by` runs in the same step as the
per-function purge. The re-evaluation then specializes afresh.

This owner purge was first tried as a memory lever and recorded as refuted
(no memory effect). It is required for correctness: an owner purge has to
cover every cache that can hand back the ids it drops.

## Tests

- `tests/internal/check_watch.test.yo`, "build --watch: invalidate_changed_files
  makes an edited import re-read on the next load": the importer's `doubled`
  reads 2. After editing the import, it still reads 2 without invalidation
  (the premise), and 4 after `invalidate_changed_files`.
- `tests/internal/module_invalidation.test.yo`: the B2 plateau test also holds
  the specialization-cache count flat across re-analysis rounds.
- End-to-end, a two-module project under `yo build --watch` with a stage-1 of
  this branch:
  - edit → `answer=42`;
  - type error → round rejected with E0604 while the watcher stays up;
  - revert → `answer=43`.

  On develop it printed 41 throughout and accepted the type error.

`scripts/bootstrap/watch_verify.sh` also read each round's verdict with
`tail -1`. Since a round's diagnostics can follow its summary line (the unused
`is_concrete_type` warning), that line was a `help:` line: the comment-only
and hub checks failed spuriously, and the leaf-break check passed vacuously.
It now reads the last `watch: revalidated` line.
