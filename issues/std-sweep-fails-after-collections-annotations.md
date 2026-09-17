# The full `yo check ./std` sweep fails 175/176 after the std/collections annotations (#713)

**Status: OPEN — a merged regression on develop (2026-09-17, via #713 →
`53417021b`). The tier-1 gate's `check ./std` is red on every PR until this
is fixed.**

## Symptom

`yo check ./std` (the SEED binary evaluating the whole std tree in one
process) exits 1 with:

```
check: 175/176 file(s) passed
yo: error: check: 1 file(s) failed evaluator coverage
```

The failing file VARIES between runs/trees — observed: `std/testing/bench.yo`,
`std/term.yo`, `std/thread.yo` — the common shape is a module whose
evaluation silently dies mid-def-time-trial in the accumulated-sweep state
(the `check:` progress line shows `invoking evaluate_anonymous_module_begin_exprs`
for it and NO `— evaluator OK` verdict follows). Every failing file PASSES
`yo check` in isolation. `YO_DEBUG_SWALLOW=1` shows the last trial
(e.g. `[trial] std/thread.yo:390:2` — the generic `where(T <: (Send,
Acyclic))` fn `_take_blocking_result`) with NO matching `[swallow]`: the
throw escaped the trial's handler entirely.

## Attribution (discriminated 2026-09-17)

- **#745's tier-1 was green** (34/34 incl. `check ./std` 176/176) on the
  pre-#713 tree.
- The pre-task-3 tree (develop + #713's annotations, WITHOUT the task-3
  std/spec rework) **fails identically** — 175/176, same silent shape.
- The task-3 branch (with the std/spec rework) fails the same way — the
  rework is exonerated; and since the sweep runs the SEED's compiled-in
  evaluator, no un-landed src fix can affect it.

⇒ introduced by **#713's std/collections annotations**
(`pragma(Pragma.Verify)` + bounds contracts + `assumed()` on
`array_list.yo`/`hash_map.yo`) interacting with the single-process sweep's
accumulated state. `yo verify ./std/collections` is green (rc=0), the
runtime collections tests are green, both files check clean in isolation —
only the FULL-sweep order/accumulation breaks.

## Leading hypothesis (unconfirmed)

The annotated modules' load-time machinery — contract registration, the
ghost-fn def registry, spliced-guard caches, or the verify-mode pragma
state — persists across module loads in one process and poisons a later
module's def-time fn trial. The escaped (unswallowed) throw at
`thread.yo:390:2` suggests the failing trial's error class is NOT caught by
`_trial_eval_fn_body`'s handler — or the failure is before/at the trial's
signature evaluation.

## Suggested attack

1. Bisect the polluting module set: load the prelude + `std/collections/*`
   + progressively more of std, then `std/thread.yo`, in one `yo check`
   probe until the 2-module-order probe (array_list → bench/thread) that
   already PASSES breaks. The minimal polluting set names the mechanism.
2. `YO_DEBUG_SWALLOW=1` on the failing prefix; the escaped throw at
   `thread.yo:390:2` left no `[swallow]` — instrument
   `_trial_eval_fn_body`'s handler entry/exit to see whether the handler
   ran at all (throw before the trial's begin vs an uncaught error class).
3. Suspects in order: (a) the verify-mode pragma persisting past the
   annotated file's evaluation (the docs promise "mode effects apply only
   to the files being verified"); (b) the `assumed()` signature ghosts'
   def-registry entries colliding with later modules' ghost fns; (c) the
   splice caches re-keyed by fn-id colliding across module loads.

## Constraint

Do NOT "fix" by de-annotating std/collections — the annotations are the
task-5 exit criterion and their runtime + verify behavior is correct. The
defect is the sweep-state interaction; fix the leak (or the trial's
handler coverage) in the evaluator/module loader.
