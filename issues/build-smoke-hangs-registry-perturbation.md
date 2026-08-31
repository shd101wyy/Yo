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

## Status of the fix (2026-09-01, after #371 merged)

**The E-class half is FIXED and merged (#371)** — the bundle-slot per-call
render made CI's tier-1 and hollow sweep green; its earlier retraction was
mistaken (the smokes hang on pristine #369 too, so the render was never the
smoke's cause). **The smoke hang itself remains OPEN and is now known to be
pre-existing and environment-triggered**: it reproduces on PRISTINE #369
(CI-green on Aug 30) both natively-built locally and on today's CI runners —
something in the runner environment shifted after Aug 30 19:48 UTC and
surfaced it everywhere. Concrete findings for the next session, all verified
against a `--debug-async-await` build of #369:

1. `yield()` completed synchronously and never drove `__yo_async_poll_step`
   — poll-yield loops spun. FIXED in a worktree (yield := await a 1 ms
   timer, the Mutex.lock park): the loop now kevents properly, but the hang
   REMAINS — the spin was a symptom.
2. The stall signature: std/process `output()`'s SM reaches its
   stdout-drain await and reads the freshly-created (cold) drain future as
   `state=-1` — in the compiler's C, that rendition's `await_future_9` is
   typed `__yo_io_future_t*` (the RAW extern future) while its two twin
   renditions type it `_file____priv_temp_13893_state_t*` (the real async
   block). The continuation fields sit at different offsets → the await
   writes its continuation into the wrong slot → the SM never resumes →
   zombie children + re-cycling output SMs (double `close`s on fd 4/6 per
   cycle).
3. The mistyping path: `awaited_future_c_type_override` →
   `_async_override_return_type` bails to the raw future when the REGISTRY
   result (`get_func_type(fid)`) renders as a bare SomeT. A gate fix
   (continue to the per-expr body resolution when ret is a SomeT) was tried
   and did NOT cure the hang — at least one more divergence read-site
   remains. Systematic fix: per-ExprInfo reads at every await-future typing
   site + evaluator-side registration of concrete params/results, and making
   the type intern table's insertion order unobservable.
4. Also fixed in a worktree (unmerged): the dyn double-emission
   (issues/dyn-async-future-trait-body-emitted-twice.md) — its shared-set
   fix reorders the intern table and must be reworked order-stably.
* Optionally: make `yield` park on the loop (enqueue itself) so a sync-await
  of it drives `poll_step` once; that would have turned this whole hang into
  a slow-but-progressing loop.
