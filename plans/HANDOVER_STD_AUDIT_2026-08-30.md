# HANDOVER — std API audit campaign (2026-08-30)

The goal being handed over: **«Finish everything in plans/STD_API_AUDIT.md.
Make sure the std APIs are well designed and stable for the future. Document
and fix any surfaced issue and bug. No workaround is allowed. Admin merges are
authorized to save CI cycles.»**

Read `plans/STD_API_AUDIT.md` §2 (compiler rows) and §9 (phasing) alongside
this. Every claim below is recorded in an issue file or PR body.

---

## 1. Where the campaign stands

**v0.2.20 is RELEASED** (2026-08-30, 13 assets) and `SEED_VERSION` is bumped
to v0.2.20 on develop. The local seed bundle is at
`/private/tmp/yo-seed-0220/bin/yo` (and v0.2.19 at `/private/tmp/yo-seed-0219/bin/yo`).

**Merged this session** (all admin-squash, all with green local batteries):
#350 (C58/C59 runtime), #351 (HTTP server + C27), #353 (C57 + the Windows
parked-pipe-read runtime fix — Windows suite went 3305/3305), #354 (C56),
#355 (C55), #356 (doc `#` sections), #357 (std/term), #358 (binary bodies),
#359 (C17), #360 (C22 stub gate), #361 (C61 — ctl result-type escape rule),
#362 (C60 — nested io.async bundle binding + C45 dedup), #363 (O7 residual —
sync containers require Acyclic; also de-vacuoused the imm_vec Acyclic pin).

**§2 has ONE genuinely open compiler row: C29** (per-argument type-var
rebinding — a unification-architecture arc; two containments already tried
and reverted, see issues/generic-type-var-rebinds-per-argument.md).

---

## 2. OPEN PRs and worktrees — exact state, what to do

Worktrees in play (`git worktree list` from the main checkout; NEVER branch in
`/Users/yiyiwang/Workspace/Yo` itself — it is shared with a peer session):

### 2a. `s6/version-install-unbreak` — **COMPLETE: merged as #366 (admin-squash)**

PR #366 (branch deleted after merge) carried: the five version_cache un-hollowing
fixes (b42b7a5f3), the strict-clean build path (b783c4077 — comptime module
loading now uses synchronous libc reads via `_read_file_sync`; the build-graph
helpers are proper io.async futures using the Command.output spawned-task
recipe), and the ASan root-cause issue updates. Verified: the strict golden
PASSES; gates_fast 0/1/3/4/5/6 green; CLI corpus 45 PASS vs seed's 44 with
zero new diffs; codegen-bootstrap corpus 156/156; FIXPOINT_HOLDS CLANG_RC=0;
CI bootstrap-fixpoint + stage-3 + all four internal shards pass.

**THE NEW CRITICAL PATH: develop CI is red from the ASan regression, which is
now ROOT-CAUSED as C54's specialization split on the EFFECT type** — the same
"second specialization clobbers the first via the global last-writer registry"
mechanism as issues/future-wrapper-return-shared-across-specializations.md,
clobbering `E` instead of `R`: the await site's future type says effect=Io
(32-byte temp) while the child SM's set_effect was emitted under IoExn (40-byte
copy). A codegen-side mitigation was built, tested on CI, and is NOT viable
(neither side can see the other's type) — recorded in
issues/asan-stack-overread-set-effect-batch-selftest.md so it is not retried.
Repro assets: the `debug/asan-batch` branch (temporary workflow + the offending
pre-emitted tests/debug-batch-linux.c; crash at batch index 85) — delete when
C54 lands. **v0.2.21 remains gated on the E-class ASan red** (the spec-cache dispatch
investigation — breadcrumb + repro assets in
issues/asan-stack-overread-set-effect-batch-selftest.md: the body capture's
type read Fn(i64)->R during the R=String spec's eval, so
create_specialized_function_inline's cache key is serving cross-substituted
signatures; check it FIRST). The R-class fix (#367) does not cover it.

### 2b. PR #365 `s6/fs-watch-windows` — **COMPLETE: merged (admin-squash) 2026-08-30 evening**

Develop was merged into the branch first (its CI legs carry only the
C54-inherited ASan red, same as develop). Local battery after the merge:
gates_fast real gates green (the 3 reported FAILs are the bash-3.2 harness
bug), FIXPOINT_HOLDS with CLANG_RC=0 and stage2 hollow=0, CLI corpus
45 PASS / the same pre-existing 9 diffs — zero new.

**fs.watch on Windows is fixed and verified**: `__yo_io_poll`'s empty-IOCP
early returns skipped `__yo_poll_and_fs_event_tick`; a yield-driven wait
(`Watcher.next`) never reaches `__yo_io_wait`, so RDCW completions were never
serviced. The early returns now tick (mirrors io_wait's failure path). Round-3
debug run on windows-latest: **4/4 tests/fs/watch.test.yo pass, rc=0**;
`SkipWindows` pragma removed; issue moved to issues/fixed/; audit §7 updated.
All probes stripped; the temp workflow deleted; everything committed+pushed.

TO DO: the local battery for this branch was started and then **corrupted by
a stray pkill** (its PREP build died; the gates ran with a missing S1) —
disregard `/tmp/fsw-battery.log`. Rerun:

```bash
cd /private/tmp/yo-fsw
YO_STD=/private/tmp/yo-fsw/std /private/tmp/yo-seed-0220/bin/yo build \
  && cp yo-out/aarch64-apple-darwin/bin/yo /tmp/yo-fsw-s1
S1=/tmp/yo-fsw-s1 P=local bash scripts/bootstrap/gates_fast.sh
S1=/tmp/yo-fsw-s1 P=local bash scripts/bootstrap/fixpoint_only.sh
```

On green (plus the PR's own suite legs), admin-merge #365.

### 2c. PR #364 `s6/version-cache-std-http` (`/private/tmp/yo-d6`) — PARKED

The D6 PR-3 curl→std/http swap. Seed-gated on v0.2.20 (now satisfied — the
tree builds), and **live-verified**: `version list --remote` over std/http
TLS, real 5 MB bundle download through the CDN redirect, binary body written
and extracted. Its install fixes were split out to §2a (cherry-pick
`0fef9ad67` was clean), so this PR should be REBASED onto develop after §2a
merges (dropping the duplicated fix commit) leaving only the swap.

Parked because it exhibits the SAME strict regression as §2a (same backtrace)
— un-hollowing is the trigger there too, so §2a's strict fix should clear it.
Two additional items to fold in before merge:

- **Battery-script gap**: `scripts/bootstrap/fixpoint_only.sh:20` (and the
  equivalent stage2-compile in gates_fast.sh) compiles stage2.c with a bare
  `clang` line; with std/http in the compiler closure, stage2.c includes
  OpenSSL headers → `fatal error: 'openssl/bio.h' file not found`. Add
  pkg-config flags (`pkg-config --cflags --libs openssl` fallback
  `$(brew --prefix openssl)`) to those clang invocations. NOTE: the d6
  battery run printed FIXPOINT_HOLDS with CLANG_RC=1 — treat that verdict as
  suspect until the clang step actually links (the memory rule: check rc +
  stage-file mtimes before trusting a verdict).
- The strict CLI golden must pass on the branch.

### 2d. `s7/seed-gated-sweep` (`/private/tmp/yo-sweep`) — no PR yet, ~80% done

Contains three seed-gated items (all unblocked by v0.2.20):

1. `HashMapError.KeyNotFound` / `HashSetError.ElementNotFound` DELETED
   (`check ./std` under the 0220 seed passes with the now-identical enum
   shapes — the #343 gate held).
2. Prelude `if` macro DELETED (the 0220 seed ships the parse-time desugar);
   `.github/instructions/yo-syntax.instructions.md` updated.
3. `Command.current_dir` **generation B**: `std/sys/externs.yo` +
   `std/sys/process.yo` gained `__yo_async_spawn_start_cwd`/`spawn_cwd`
   (the runtime symbol shipped in v0.2.20 — generation A, #338);
   `std/process/command.yo` gained `_cwd : Option(String)`, the
   `current_dir` builder, and `_spawn_with_fds` now calls `spawn_cwd`
   (`.None` = inherit); a generation-B end-to-end test was added to
   `tests/process/command.test.yo`.

`check ./std` + `check ./src` + `yo build` were green under the 0220 seed
BEFORE item 3's std changes; the audit rows (§9 dead variants, §4 prelude,
§7 item 5 current_dir, the stale line-13 bufio note) are already updated.

TO DO: rebuild (`YO_STD=... /private/tmp/yo-seed-0220/bin/yo build`), run
tests: `tests/process/command.test.yo`, `tests/hash_map*.test.yo` /
`tests/hash_set*.test.yo` (whatever covers the two collections),
`tests/quote_macro_eval.test.yo` + `tests/macro_expansion.test.yo` +
`tests/macro_helpers.test.yo` + `tests/macro_def_pragma.test.yo` (if-macro
deletion fallout — a dynamically built `if` AST is now an error), then
`check ./std ./src`, fmt, battery, PR, merge. Note `git status` may show my
uncommitted work — everything described above is intentional; commit it all.

---

## 3. New compiler issues filed today (all need eventual fixes; none block std)

| Issue | Summary | Suggested attack |
|---|---|---|
| issues/wrong-arity-call-silently-accepted-version-install-broken.md | Wrong-arity calls are swallowed at def-eval and ship as UB; broke `yo version install` in two releases | Validate argument count against the resolved callee OUTSIDE the trial swallow (same enforcement family as C61); `try_to_call_function_with_arguments` already produces the error inside the swallow — find which layer eats it for async-helper shapes |
| (same issue, "gate gap" section) | A hollow ASYNC STATE MACHINE passes the C22 stub gate (completes/aborts instantly instead of poisoning the build) | Give the C22 attribute treatment an async-SM equivalent: an SM whose body ExprInfos were never stamped must poison its resume fn |
| issues/builtin-name-shadows-user-definition.md (upgraded) | Builtin-first dispatch silently shadows user locals — now with a production casualty (`short`) | The audit decision is pending: reserve builtin names (option 1) or prefer user bindings (option 2); at minimum land the shadowing diagnostic (option 3) before the next release |
| issues/module-level-control-bound-binding-not-rejected.md | Module-level `(g : Exception) = ...` accepted though escape boundary 2 should reject it; the rule only fires in comptime_expect_error propagate mode | Trace `rhs_info_opt` for annotated module bindings; add check-visible repros |
| issues/command-stdin-windows-pipe-write-blocks-the-event-loop.md | Windows pipe WRITES still block the loop (reads fixed in #353) | Overlapped NAMED pipes for child stdin |
| issues/future-wrapper-return-shared-across-specializations.md (C54, body half) | Second specialization's `R` clobbers the first's async body via the global last-writer registry | Stamp the call result concretely inside the spec body (resolve `R` through the spec env at stamping time) or stop keying the fallback by the shared forall id; repro: issues/repros/future-wrapper-return-two-r-specializations.yo; unblocks async `Mutex.with_lock` |
| issues/generic-type-var-rebinds-per-argument.md (C29) | The last open §2 row; per-call unification state needed | Read the issue — two failed approaches are recorded so they are not retried |

---

### 2e. PR #334 (`fix/second-cond-await-target`) — RESOLVED 2026-08-30 (evening): CLOSED as superseded; test salvaged as #368

Asked about during the evening session. The 2026-08-28 PR fixed a cond arm's
second-await storage (the plain-HTTP crash) but was CONFLICTING with develop.
Measured: the motivating crash no longer reproduces on develop (live
`fetch("http://github.com")` clean), the PR's own test passes on develop
unchanged, and merging its remaining delta REGRESSES tests/http 21→5 (its
store-side machinery predates and double-handles develop's newer
`_dispatch_branches` chained-arm dispatch; first as a `duplicate case value`,
then as runtime failures after reconciling). Closed with the evidence
comment; `tests/async/cond_multi_await.test.yo` salvaged as PR #368 so the
behavior stays pinned. NOTE the branch was the peer session's main-checkout
branch — if that session is still iterating on it locally, it should rebase
onto develop or drop the superseded changes.

## 4. Remaining audit tail beyond the PRs (rough priority order)

> **1 Sep 2026 FINAL session state.** **#371 MERGED (2026-08-31 21:52)**:
> the #370 revert + the **E-class fix** — the io.async closure's bundle-param
> slot now renders the CALL's own recorded Future-trait effect
> (`_io_async_call_effect_type`, src/codegen/exprs/async.yo; concrete-only)
> instead of the shared forall E's global last-winner. That fix is the ONLY
> change that ever made CI's tier-1 async_await + hollow sweep PASS — C54 is
> CLOSED (docs PR #372 moved both issues to issues/fixed/). The earlier
> belief that this render "breaks the smoke" was WRONG: **the smoke hang is
> pre-existing and environment-triggered** — PRISTINE #369 (CI-green Aug 30
> 19:48) hangs the smoke both natively-built locally and on today's CI
> runners; something in the runner environment shifted after Aug 30.
>
> **The standing blocker for v0.2.21 is that smoke hang** — root-caused to
> the same registry-divergence family but at DIFFERENT read-sites; the full
> investigation state (verified against a `--debug-async-await` build of
> #369) is in issues/build-smoke-hangs-registry-perturbation.md: the
> synchronous `yield()` defect (fixed in the /private/tmp/yo-369 worktree —
> park on a 1 ms timer — cures the spin, NOT the hang), the mistyped
> `await_future_9 : __yo_io_future_t*` rendition in std/process output()
> (continuation written at the wrong offsets; zombie children + re-cycling
> SMs), the `_async_override_return_type` bare-SomeT gate (fixed in the same
> worktree — ALSO not curative alone), and the unmerged order-stability
> constraints. **The systematic fix** (per-ExprInfo reads at every
> await-future typing site; evaluator-side concrete registration; intern
> table order unobservable) is the next arc. Two worktree fixes await
> order-stable rework: the yield park + the override gate (both in
> /private/tmp/yo-369), and the dyn double-emission dedup. The E-class fix
> attempted first (registry seeding) and the dyn fix are documented as
> refuted in their issues so they are not retried.
>
> **TLS unblocked**: the OpenSSL interop moved from std's `c_include` into a
> per-target runtime backend behind `g_uses_tls` (branch
> `fix/tls-runtime-backend`, rebased on the #371 merge, T1-gates green, live
> HTTPS verified) — D6 PR-3's Windows blocker is gone; it can PR once the
> smoke blocker clears (its own CI would hang the same way).

1. **Merge queue — RESOLVED 2026-08-30 (evening session)**: §2a #366 MERGED;
   §2b #365 MERGED; **C54 body half #367 MERGED** (valueless-callee call
   results resolve through the call's env — Mutex.with_lock RESTORED with
   regression tests; the E-class variant is a different site, see below);
   §2d #370 MERGED **then REVERTED by #371 (2026-08-31 — see addendum
   above)**; #334 CLOSED as superseded (its crash fixed by develop's
   dispatch; its delta regressed http 21→5) with the test salvaged as #368;
   #369 (issue breadcrumb) MERGED. **§2c PR #364 rebased + verified
   (remote list over std/http TLS, FIXPOINT_HOLDS with the
   OpenSSL-pkgconfig'd battery/CI lines — all on the branch) and UNBLOCKED
   2026-08-31 by the TLS runtime backend** (Windows gets ABI stubs +
   `tls_available()` until Schannel).
2. **C54 body half** (unblocks `Mutex.with_lock`, the last C54 item).
3. **Arity-outside-swallow enforcement + async-SM gate** (§3 rows 1–2) — these
   two would have caught every defect found today; highest bug-class value.
4. **C29** — the big unification arc.
5. **Windows cluster**: stdin pipe writes (overlapped named pipes);
   issues/s3-fs-wrappers-windows-semantics-audit.md (Child/spawn + fs
   wrappers have no Windows story; fs_convenience S3 sections skip on
   Windows). The debug-workflow pattern (temp workflow on the branch,
   cross-emit from a Linux stage-1, clang-compile and run one test file on
   windows-latest, upload the log) is proven — see git history of
   `debug-win-c57.yml` / `debug-win-fsw.yml` (both deleted after use).
6. **Polish rows** (§7/§4 of the audit): regex extras; `std/cli` typed values
   + std/term adoption; O5's Formatter routing for derive output; D5's
   remaining `Dyn(Reader)` spelling (C17 is FIXED, so this is now unblocked)
   and the deliberately-deferred async `lines()`.
7. **Builtin-shadowing decision** (§3 row 3) — user-visible language decision;
   propose option 2 (prefer user bindings) or 1 (reserve), write the plan.
8. **Freeze prep** (§9 S5): after the tail lands, re-run the dead-surface and
   test-coverage sweeps and declare the stability freeze.

---

## 5. Operational knowledge you will need (hard-won today)

- **macOS host quirks (afternoon session)**: the system has NO `timeout`/`gtimeout`
  (gates_fast.sh and the diff harnesses call a bare `timeout` — every gate
  reported rc=127 until a shim was provided: a tiny bash wrapper in
  /tmp/yo-bin/timeout prepended to PATH). `/bin/bash` is 3.2 and chokes on the
  harnesses' `declare -A` ("PASS: unbound variable", scripts/cli-diff-test.sh:325,
  scripts/diff-test.sh:201) — run BOTH harness scripts with
  /opt/homebrew/bin/bash. The local clang's ASan runtime is BROKEN and the test
  runner SILENTLY skips the sanitizer ("AddressSanitizer is not functional with
  this compiler setup") — never trust a local "green" on ASan-gated paths.
- **Builds**: `YO_STD=<worktree>/std /private/tmp/yo-seed-0220/bin/yo build`
  (~10 min). Copy the product to `/tmp/yo-<name>-s1` BEFORE running gates
  (S1 must live outside the repo).
- **Batteries**: `S1=/tmp/... P=local bash scripts/bootstrap/gates_fast.sh`
  then `fixpoint_only.sh`. **NEVER run two batteries concurrently** — they
  share `/tmp/local_*` scratch and manufacture FIXPOINT_BROKEN (memory:
  yo-gates-fixpoint-share-tmp-scratch). Also avoid a battery + a heavy build
  concurrently (16 GB machine swaps; the user has complained).
- **One battery verdict trap**: FIXPOINT_HOLDS with a nonzero CLANG_RC or
  suspicious stage-file mtimes is not a verdict — check rcs first.
- **The C22 gate**: value-returning hollow closures fail the C compile with
  an `error` attribute; hollow ASYNC SMs do NOT (yet) — a silently-broken
  async body presents as an instantly-completing/aborting future and a
  SILENT early return in the caller (rc=0!). When something async "does
  nothing", run `YO_DEBUG_SWALLOW=1 yo check <file>` and read the
  `[anon-swallow]` lines — that is how all five §2a defects were found.
- **A compiled program's runtime C comes from the COMPILING binary's
  templates, not the tree** — editing `src/codegen/async/runtime_*.yo` only
  affects what the NEW compiler emits (stage-2+ / user programs). To change
  the compiler binary's own runtime behavior you need the seed to carry it.
- **CLI goldens**: after anything touching CLI output, run
  `scripts/cli-diff-test.sh`; the `async-blocking-await-inside-task` case
  arms `YO_ASYNC_STRICT=1` and is the strict-cleanliness gate.
- **Windows debug loop**: temp workflow per branch (see §4 item 5), ~50 min
  round trip; always `upload-artifact` the log with `if: always()`.
- The main checkout `/Users/yiyiwang/Workspace/Yo` is SHARED with a peer
  session — never check out branches there; use `/private/tmp` worktrees
  with `git -c protocol.file.allow=always submodule update --init`.
- Admin merges are authorized; an unmergeable PR gets NO CI — merge develop
  into the branch instead of close/reopen.

## 6. Background state at handover

All background monitors and builds from my session are stopped (or dead).
Batteries needing (re)runs: yo-fsw (§2b), yo-vfix (§2a, after the strict
fix), yo-sweep (§2d), yo-d6 (§2c, after rebase + script fix). The
`/tmp/yo-*-s1` binaries and `/tmp/*-battery.log` files from today are
disposable. `~/.cache/yo/versions` currently holds a test-installed 0.2.19.
