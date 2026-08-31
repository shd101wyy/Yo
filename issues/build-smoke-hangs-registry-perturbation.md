# `yo build run` hangs forever in `_git_version`'s poll-yield loop — the shared type registry flips on ANY type-graph perturbation

**Status: OPEN — develop un-redded by REVERTING the perturbations (#370 and
the E-class seeding attempt), not by fixing the underlying registry.** Found
2026-08-31: every CI platform's `test` leg stopped at the "Build system smoke
test" step (`yo init` + `yo build run`) for the full job timeout (4–6 h) on
develop HEAD (#370's merge), with exactly one orphaned `yo-suite` process.

## How it was isolated (local, deterministic)

The hang is **in-repo only**: the same compiler runs a project created
OUTSIDE a git repo fine. Inside the repo, the build path runs `_git_version`
(`src/build_runner.yo`) — a spawned `_git_output_task` polled with
`is_finished()` + `await yield()`. Compiled with `--debug-async-await`, the
trace shows the task/output state machines re-cycling forever:

* the output SM re-enters states 6→10 every cycle (re-closing pipe fds 4/6 —
  double `close` on every iteration);
* its drain awaits read `state=-1` (COMPLETED) off futures that are COLD;
* the task re-reads its await as completed without advancing;
* `_git_version`'s loop condition never turns false.

Reading completed states off cold futures is the C54/E-class family signature
(`issues/fixed/future-wrapper-return-shared-across-specializations.md`): the emitted
C consults type stamps resolved through the process-global last-winner
registry, so a perturbed type population reads another specialization's
future struct.

## The two perturbations that flipped it (both reverted)

1. **#370 (std-only, no compiler change)** — deleting the dead
   `KeyNotFound`/`ElementNotFound` variants, the prelude `if` macro, and
   adding `Command.current_dir` shifted every `yo_id`. Verified locally with
   a pristine worktree of 2698b6a1d: the in-repo smoke hangs; #369's tree was
   CI-green. Bisected by rebuilding the compiler against synthetic stds: the
   prelude alone and the process trio alone each still hang (the shift, not
   any one diff, is the trigger).
2. **The E-class seeding attempt (PR #371's first two pushes)** —
   `register_func_type(func_id, seeded_type)` re-registers the shared
   io.async closure's type with one call's concrete bundle cell: the SAME
   last-writer clobber with a different winner. Breaks the build path under
   the v0.2.20 std too, i.e. independent of (1).

## A second, pre-existing latent defect found on the way

`yield()` (`std/async`) is `io.async((io) => { return(()); })` — its future
completes SYNCHRONOUSLY at creation. The top-level (non-SM) await emission
runs the cold future's first step inline and then only enters the
`__yo_async_poll_step` loop if the future is still pending — so **`io.await(yield(io), io)`
from a SYNC context never drives the event loop at all**: the ready queue is
never drained, malloc-churning an infinite loop
(`issues/repros/spawn-task-polled-with-yield-from-main.c` shape). The recipe
only works today when some OTHER pending await on the C stack drives
`poll_step`. Inside an SM the same recipe works (verified), and the compiler's
real build path normally has such a driver — which is exactly why this
defect goes unnoticed until the registry corruption above removes the last
real pending await.

## Status of the fix (2026-09-01)

NOT fixed — and the investigation widened the class: BOTH the dyn
double-emission fix and the E-class codegen render fix perturb the
INSERTION-ORDERED type intern table (any extra `get_type_string` during
emission reorders it — 742k C lines shifted from a 3-site guard), and the
reordering alone flips CI manifestations (tier-1 async_await, the platform
smoke legs). Emission-order stability is itself part of the root cause: the
type table's insertion order must not be observable. The E-class fix that
works must be evaluator-side (register the closure's INFERRED concrete
param-0 at def-eval, no codegen render change); the dyn fix must dedup
without changing first-collection order. Both recorded in their issues. The
LOCAL-native-build hang below remains explained-but-open.
* Optionally: make `yield` park on the loop (enqueue itself) so a sync-await
  of it drives `poll_step` once; that would have turned this whole hang into
  a slow-but-progressing loop.
