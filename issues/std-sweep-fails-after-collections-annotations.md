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

## Attribution CONFIRMED (2026-09-17 late)

Clean three-way discriminator, all on the v0.2.36 seed + `YO_STD=$PWD/std`:

| tree | `yo check ./std` |
| --- | --- |
| `eb6d9a94f` (pure pre-#713 develop) | **176/176 GREEN (rc=0)** |
| `eb6d9a94f` + #713's annotations (the rebase713 branch) | 175/176 FAIL |
| task-3 branch (+#753 content) | 175/176 FAIL (same silent shape) |

⇒ #713's annotations regress the sweep. (Separately observed, NOT this
bug: a *demand-import* probe — `import("std/assert"); import("std/thread");`
from a tmp module — also fails on the v0.2.35 seed; the demand-load path
has its own latent issue with `thread.yo`'s def-time trial. The sweep bug
uses direct-target loads and is 0.2.36-specific.)

Bisection notes: the failing file varies per run (bench/term/thread) —
state-accumulation-dependent; `array_list+hash_map+bench+thread` and even
`assert+thread` demand-probes PASS, so the trigger needs the real sweep's
breadth. Next step: bisect with DIRECT-target prefixes — a tmp dir of
symlinks to the first N std files, `yo check tmp/prefix` — the check
tool's own enumeration, growing N (and reordering) until the failure
appears; then swap the last-added file to isolate the victim/polluter pair.

## Fix (PR #760, 2026-09-18)

The coverage failure was the per-file contract drain's strict
missing-solver policy: `_run_contract_verification` returned false in
solver-less environments for ANY file whose drain hit
`resolve_solver_sync`'s Installable arm — and since #713 the annotated
collections files ALWAYS hit it. (The earlier "varying victim"
readings — bench/term/thread — were an output-interleaving artifact:
the drain warning (stderr) glued onto whatever stdout line was
flushed; the counter, not the progress log, names the failure.)

Fix: `_run_contract_verification(strict_missing_solver)` — compile
passes TRUE (ships binaries; verify-mode codegen without proofs is
unsound), check passes FALSE (measures evaluator coverage; the loud
install hint prints; the `yo verify` CI job with the pinned Z3 owns
the proofs). The prefix bisection harness itself validated the N=19
boundary: with a solver the sweep is 176/176; without it, exactly the
annotated files' drains failed. Local seed-side `yo check` stays
strict until the fix rides a release (generation split); CI's tier-1
gate 3 runs the self-hosted binary and goes green on merge.

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
