# `yo build run` hangs forever — an async body whose LAST segment carries an await never completed its Future on the fall-through tail

**Status: FIXED 2026-09-01 (PR #373) — the REAL root cause was found and it
is NOT registry divergence.** The io.async state-machine emitter skipped the
tail completion whenever the body mentioned a `return` anywhere
(`expr_contains_return` over the last segment) and whenever the last segment
itself carried an await point — but the poll-yield recipe's body shape
(`while(!(t.is_finished())) { await yield() }; match(x, .None =>
return(...), ...); <fall-through tail>`) hits BOTH: its last segment contains
the loop's await AND a nested return, so the fall-through tail ran, stored
`sm->result`, and fell off the end of the resume function WITHOUT setting
`state = -1` or firing the continuation. The future suspended forever; every
awaiter (main's blocking await) polled eternally. `_git_version` and every
other poll-yield helper in the build path had exactly this shape.

**The bootstrap veil that hid it**: a codegen fix only takes effect one
generation later. `yo build` bakes the SEED's emission into the gen-1
binary, so the fixed tree still hangs at gen-1 and works at gen-2 — which is
also why the released bundles and the CI smoke legs (which run gen-1
candidates) kept hanging after the source was fixed. The verification binary
must be gen-2 (`S1 compile` → clang → that binary).

The fix (src/codegen/async/state_machine.yo, two gates in
`_emit_last_segment_completion` and its caller):
1. skip the tail completion only when the last segment's LAST expression is
   itself a `return(...)` call — not when a return is nested in some arm;
2. a last segment that carries an await point ALSO gets the completion
   (after the suspension block — reachable only via the fall-through).

Verified at gen-2: the in-repo `yo init` + `yo build run` smoke completes
("Hello, world!"); `check ./src` 262/262; async_await 188/188, combinators
7/7, mutex 4/4, dyn 9/9, process/command 10/10, io/async_traits 8/8, http
21/21; `FIXPOINT_HOLDS` with a compile-built gen-2 S1.

Landed together with two hardening fixes found on the way: `yield` now parks
on a 1 ms timer (it previously completed synchronously, so poll-yield loops
spun without ever polling I/O), and `_async_override_return_type` no longer
downgrades a bare-SomeT registry result to the raw `__yo_io_future_t`
spelling. The EARLIER registry-divergence theories in this file were wrong
in mechanism (the mistyped `await_future_9 : __yo_io_future_t*` rendition
was real but its layout coincides; the "reading completed states off cold
futures" was this very missing-completion bug observed from outside) — they
are retained below as the investigation record.

---

## Investigation record (superseded by the fix above)

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
   (issues/fixed/dyn-async-future-trait-body-emitted-twice.md) — its shared-set
   fix reorders the intern table and must be reworked order-stably.
* Optionally: make `yield` park on the loop (enqueue itself) so a sync-await
  of it drives `poll_step` once; that would have turned this whole hang into
  a slow-but-progressing loop.
