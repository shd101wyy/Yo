# Handover — std API audit campaign, session ending 2026-09-02

Supersedes `plans/HANDOVER_STD_AUDIT_2026-09-01.md` (whose §0/§0a/§0b addenda
are the detailed log of 09-01 → 09-02 morning; keep it) and, for deep
background, `plans/HANDOVER_STD_AUDIT_2026-08-30.md`. THIS doc is the current
state and the queue.

The /goal is unchanged: finish everything in `plans/STD_API_AUDIT.md`,
well-designed stable std APIs, document + fix every surfaced bug, no
workarounds. **Admin merges are ALLOWED again (user, 2026-09-02 midday)** —
the 09-01 night ban was about coverage, not the button; the checklist that
survives it is in §4.

---

## 0. LATE ADDENDUM 2026-09-02 (afternoon session — read §3 as DONE)

**Landed since §1 was written**: #364 **MERGED** `e84def46b` (curl→std/http,
the LAST D6 item); #381 `a7dcc7bd2` (develop un-red: apostrophes inside the
single-quoted Alpine `sh -euc '...'` docker scripts terminated the quoting —
the musl leg died on `syntax error near unexpected token )` BEFORE apk, so
the openssl-libs-static package fix had never actually run; both workflows'
blocks rephrased apostrophe-free, verified by scan. Develop run 33589885601
on that head: SUCCESS — the package fix's first real exercise, musl green);
#382 `7b8976438` (**ArrayList §5 breaking change**: `drain(range) ->
ArrayList(T)` Rust-parity panics, `remove(idx) -> T` (Index contract),
`iter()` non-consuming over the RC-shared handle; 21 two-arg sites migrated
across std+src, channel pops simplified, tests rewritten, three yo_id
goldens re-recorded; validation: check 172/172+262/262, seed build, 93/93,
dyn 9/9, battery, CLI --network 55/0). Post-#382 develop run 33595076863 FAILED
only the tier-1 goldens (the route lesson above); healed by #383. Post-#383
run 33606554518 in flight at this writing.

**Machine restart mid-session wiped /private/tmp**: all worktrees and
/tmp binaries were rebuilt (worktree dirs come back via `git worktree add`
+ submodule update; the v0.2.21 seed re-downloads from the release).
`/tmp/yo-bin/timeout` shim must be recreated (script in §8), and gates
drivers need `PATH=/opt/homebrew/bin:/tmp/yo-bin:$PATH` — the child
scripts (`diff-test.sh`, `cli-diff-test.sh`) use associative arrays →
bash 5 via `env bash`, and `timeout` must resolve.

**#383 MERGED `01176a511` — P0 (LAZY_TOPLEVEL_BINDINGS §4.6) LANDED.** The
silent-hollow class now errors at check time:
`forward reference to "X" (defined at line N) — Yo evaluates definitions in
order; move the definition above this use`. Module-walk cell in context.yo
(accessor-fn pattern), `forward_ref_diagnostic` scanning later `::`/`:`/`=`,
`comptime(X)`, `impl(X,...)` heads; wired at the fn-body dg trial + the
anon-closure concrete and dgc trials (new anon swallow cell); the bounded
pending-def re-run site deliberately unwired (no exn in scope — noted in
the plan). Pinned by `tests/cli-cases/check-forward-ref-async-body/` (a
check-FAILURE cli case; a .test.yo pin cannot see module order — the batch
runner hoists `::` defs). Two hard lessons en route: (1) plain module-level
SELF-recursion fails check today (`Variable X not found` at the def trial)
— the campaign's own §6 target, do not write recursive helpers in src/std;
(2) **the macOS /tmp/yo-bin/timeout shim must be exec-based** — the
post-restart recreation used a `"$@" &` background form, and
non-interactive bash gives background jobs /dev/null STDIN: the lsp CLI
cases ran vacuously (2-line goldens) while CI's GNU timeout forwards
stdin and emits the framed transcripts — the REAL cause of the #382 and
#383 tier-1 golden failures (the compile-vs-build route theory was wrong;
both routes agree). #385 re-recorded with a fixed shim + yo-build S1.

_(Earlier note, kept for the record:)_ the repro that started P0.
The silent-hollow class is confirmed end-to-end: a forward-referenced call
INSIDE an `io.async` body (deferred-generic trial) is swallowed by the dg
site (`function_type.yo:~1543`, TS ts:112 catch parity) and the test passes
VACUOUSLY. Red repro (as `tests/tmp_fwdref.test.yo`, passes 1/1 today):

```rust
open(import("std/libc/stdio"));
open(import("std/string"));
open(import("std/fmt"));
do_it :: (fn(io : Io) -> Impl(Future(unit, Io)))(
  io.async((io : Io) => { later(); })
);
later :: (fn() -> unit)(println(String.from("later")));
test("forward ref inside async body", { io.await(do_it(io), io); });
```

Implementation shape (per plan §4.6): the swallow already lands in
`g_trial_swallow_msg` (`_flag_trial_swallow`, function_type.yo:161). At the
two SILENT sites — the dg trial (~1543) and the pending-def re-run (~799) —
before discarding, match the message against the unbound-name text
(`Variable "X" not found.`; the concrete path at ~1357 already re-raises),
look for X bound LATER in the same module's begin_exprs, and re-raise
`forward reference to "X" (defined at line N) — Yo evaluates definitions
in order; move the definition above this use` through the real exn.
Needs: module begin_exprs reachable at def-eval time (a global set by
`evaluate_anonymous_module_begin_exprs` is the likely plumbing) + the
binding-name/impl-receiver extraction. Acceptance: check ./std+./src
unchanged, the repro above errors with the new text, battery green. NOTE
the plain (non-async) forward call already errors loudly today — only the
dg/re-run swallows are the target.

**Queue after P0**: unchanged — §5 items 4-8 (D7 join, C29/arity, Windows,
polish, next patch release whose notes must now ALSO say the ArrayList
breaking change).

---

## 0a. EVENING ADDENDUM 2026-09-02 — v0.2.22 SHIPPED

**#384** (docs sync en+zh), **#385** (the stdin-fixed LSP goldens — the
real cause of the #382/#383 tier-1 reds was the recreated macOS timeout
shim eating stdin, see the corrected lesson in §0) — then develop went
fully green on `74e4410c1` and **v0.2.22 was cut** (run 33620216691, ALL
jobs green — the first release with std/http in the compiler closure:
both Alpine `cc` lines linked `openssl-libs-static` successfully, the
macOS bundle legs weak-linked, the portable-C parse gate passed, the
stage-3 byte-identity fixpoint held, `yo build run` smoked). Published
with the prepared notes; **SEED_VERSION = v0.2.22** (`4851ff9c0`).
Live-verified from the published tarball: `yo version list --remote`
speaks TLS through the compiler itself, no curl.

The v0.2.22 seed carries: the P0 forward-ref diagnostic, TLS-emitting
codegen, the gen-2 machinery, the ArrayList API. **Unblocked by the new
seed:** std/src may now USE the extern("Yo") TLS ABI freely; the
LAZY_TOPLEVEL_BINDINGS campaign (P1+) can build on the recorded
module-walk cell; the next seed-gated items in §5.

## 0b. NIGHT ADDENDUM 2026-09-02 — #387 arity fix landed

The wrong-arity compiler hole (the only audit class that broke two
shipped releases) is FIXED: `hard_swallow_diagnostic` in context.yo
extends the P0 re-raise to `Argument count mismatch` — the same three
silent trial sites now surface arity errors at check time, pinned by
`tests/cli-cases/check-wrong-arity-async-body/`. Acceptance: check
./std 172/172 + ./src 262/262 under the REBUILT compiler (no spurious
firing anywhere in the healthy tree); tier-1 gates failures=0; CLI
scorecard 57/0. #388/#389 moved the issue to issues/fixed/ and repointed
references. OPEN follow-up from that issue: the async-SM hollow POISON
GATE (a state machine whose body ExprInfos were never stamped must
poison its resume fn like C22 does for closures — catches every
hollow-SM cause, not just arity).

Also this evening: seed-bump develop run on 4851ff9c0 = SUCCESS (v0.2.22
bootstraps cleanly).

## 0c. NIGHT-2 ADDENDUM — poison-gate scoping (LANDED 2026-09-02 late; see §0d)

The async-SM hollow poison gate needs a FRESH session. What was measured
2026-09-02 night: a body whose def-time trial swallowed a TYPE error
(`i32 && i32` — "Expected bool type for and argument") produces a
FULLY-hollow async that never reaches the state machine AT ALL — with the
await analysis absent, codegen falls back to the SYNC-FUTURE path (the
C22 `_sync_fut_t` class, issues/closure-nested-inside-io-async-closure-
body-emits-abort-stub.md family). Three segment-statement sites in
state_machine.yo (branch arms ~2392, remaining ~2889, while-tail ~3009)
only see PARTIALLY-evaluated bodies; the correct poison point for the
fully-hollow case is the sync-future fallback emission in
exprs/async.yo (and/or an entry check on `get_expr_info(body_expr)`).
The `_sync_fut_t` stub's own resume is what "runs nothing and completes"
— start there. Repro (passes vacuously today):

```rust
do_bad :: (fn(io : Io) -> Impl(Future(unit, Io)))(
  io.async((io : Io) => { b := (i32(1) && i32(2)); println(b.to_string()); })
);
test("type error inside async body", { io.await(do_bad(io), io); });
```

## 0d. POISON GATE LANDED (2026-09-02 late)

§0c's scoping was executed end-to-end. Gates at BOTH io.async emitters in
`src/codegen/exprs/async.yo` — `generate_io_async_sync_call` (fully-hollow,
sync-future) and `generate_async_block` (FSM path) — `codegen_fatal` when the
closure's body block has no ExprInfo. Acceptance, all with the gen-2 rebuild
(seed v0.2.22 → develop@19e4b3817 + gate): both repro shapes (type error
before/after an await — both actually route SYNC) now fail with
`... body was never fully evaluated ... sync-future future would run nothing`;
the good twin prints `false`; a VALID DEAD (uncalled) io.async closure still
compiles (the def-time trial of a valid body succeeds even when uncalled —
no false positive there); nested io.async green; `compile src/main.yo
--skip-c-compiler` green; async_await.test.yo 188/188; async_trait_default_
await.test.yo 4/4; full CLI battery PASS 57 / GOLDEN-DIFF 0 / NO-GOLDEN 0.
New golden case `tests/cli-cases/compile-async-body-type-error` (recorded
with gen-2). Issue: `issues/async-body-type-error-compiles-vacuously.md`.
Two facts learned while pinning the repro: (1) a compiled entry point needs
`export(main);` and `main` may take ONLY `(io : Io)` — no `exn : Exception`
(docs updated in the cheatsheet); (2) the trait-`?=`-default variant of a
bad async body fails NOISILY at the C level (undeclared hollow type), so it
is not part of the silent class. The FSM gate's fire branch has no repro
(every failing body routes sync — await analysis is stamped only on full
trial success); kept as the same invariant, exercised-silent by valid FSMs.
Follow-up recorded in the issue: the trait-default shape deserves its own
clean evaluator-level diagnostic someday.

## 0e. POISON-GATE CI ROUND (same night) — the wasm "false positive" was a TRUE positive

PR #390's wasm leg failed on `tests/async_unit_tail_await.test.yo` — and the
chase (through two rejected fix designs: an enclosing-generic skip via
`current_function_type`, which prints `void*` at that emission site, and a
deferred-generic stamp machinery in context.yo, which chased a ghost) landed
on the REAL root: the failing closure was `outer_unit`'s **bare-`e` param**
(`io.async((e) => e.io.await(inner_unit(io), e.io))`). The def-time trial
cannot resolve `e.io.await` there — the effect bundle `E` is only bound at
call sites whose expected type carries a concrete effect, and
`Impl(Future(unit))` does not — so the swallow was ALWAYS silent: pre-gate,
the future compiled to a **runs-nothing sync stub** and the test's
`assert(true, "completed")` could not tell. The gate exposed a latent
vacuity, exactly its job. (The suspected generic shapes were innocent:
`put_all_generic`'s closure body evaluates fine at def time via where-trait
resolution; generic fn bodies need NO carve-out.)

Shipped in #390's second commit (`0897c642e`): the test's closure params
annotated (`(io2 : Io) => ...`, the form every other async test uses), and
the class filed as `issues/io-async-bare-e-closure-body-never-evaluates.md`
(open work: bind the bundle before the def-time trial from the enclosing
signature — the Step-6b call-site binding already does this when the
expected type is concrete). Re-verified with the gate binary: the file's
2 tests pass and the FULL fast suite is green (rc=0).

## 0g. FINAL STATE of the night (2026-09-02 ~21:45)

- **#390 (async hollow-body poison gate) MERGED** after three CI rounds:
  the wasm false-alarm (§0e, bare-`e`), the #386-formatter ordering trap
  (§0f — fixed by reformatting `std/regex/index.yo`, which also un-redded
  develop), and one macos-26-intel FLAKE ("Test spawn with multi-yield
  futures", rc=6 — passed on `--failed` rerun). Issue moved to
  `issues/fixed/` via #393.
- **#391 (regex POLISH row) MERGED**; **#392 (cheatsheet facts) MERGED**.
- Develop now carries: the poison gate + golden case, the regex row, the
  bare-`e` issue (OPEN — next session's candidate: bind the effect bundle
  before the def-time trial from the enclosing signature), three syntax
  facts in the cheatsheet.
- Worktrees: `/private/tmp/yo-al` (post-#390 develop + bookkeeping branch,
  removable), `/private/tmp/yo-rg`, `/private/tmp/yo-docs` (removable).
- **Develop VALIDATED**: the post-merge run on `487a5bd9b` (#393's head,
  run 33687129459) finished **success** — all four merges green together,
  intel leg included (the flake did not recur).

## 0h. 2026-09-03 — the bare-`e` ROOT FIX landed (#394)

`issues/io-async-bare-e-closure-body-never-evaluates.md` is FIXED (moved to
`fixed/` in the PR): the `.io` projection is now TOTAL — on a receiver whose
type is the bare `Io` effect struct, `X.io` is the IDENTITY (evaluator +
codegen twins in the two `property_access.yo` files; keyed on the
io-builtin side table so user structs with an `io` field are untouched;
`.exn` on a bare Io stays a field-miss). `io.async((e) => e.io.await(f,
e.io))` bodies now evaluate at def time AND run — repro's awaited inner
value flows out (regression test in async_unit_tail_await, 3/3). Verified:
`check ./std` 172/172, self-compile, FULL fast suite rc=0, CLI battery
57/0/0, fmt gate; #390's repro still fails (gate intact). Mechanism
discovered en route: Step 6b-nested already binds `E := Io` from the
receiver for this shape — the failure was purely the bundle-projection
`e.io` being partial. NEW orthogonal bug filed:
`issues/module-global-referenced-inside-async-closure-undeclared.md` (a
module-level global inside an async closure body emits
`use of undeclared identifier` + a mangled capture-struct member; the
ANNOTATED form fails identically; every existing async test works around it
with fn-local Boxes).

## 0i. 2026-09-03 (cont.) — the module-global capture fix (PR #396)

The §0h-filed bug is FIXED the same day, and measured WIDER than filed: a
plain inline anon closure referencing a module global broke identically
(not async-specific). One guard in `trackVariableUsage`
(src/evaluator/context.yo): bindings in the module-global registry
(`is_module_level_global` — the same registry the C-name mangler keys on)
are skipped from closure captures; a module global lowers to a
process-global C symbol, so closures reference it directly. All four
shapes compile AND run (named fn / inline anon / annotated async / the
filed repro); closure.test.yo 12/12 (+2 arms), async_await 189/189 (+1
arm), std 172/172, self-compile, FULL suite rc=0, CLI battery 57/0/0,
fmt clean. Two process notes: (1) test arms must be SELF-CONTAINED — the
batch runner does not persist module-global state across tests (an arm
asserting a prior arm's mutation aborts rc=6 with no message); (2) one
CLI-battery invocation reported 0/31/26 — a transient harness glitch,
identical re-run 57/0/0; if the battery ever reports near-total failure,
re-run before diagnosing.

## 0f. Same-night misc

- **WaitGroup**: the queue note ("waits on migration decision") was STALE —
  the audit already records **DECIDED KEEP (2026-08-29)** twice (D7 + §6).
  A migrate-and-delete attempt was prepared, then abandoned on reading the
  recorded decision; worktree reverted. Do not re-litigate without the
  user.
- **Regex POLISH row CLOSED** — PR #391: `Regex.escape`, flags-free
  `Regex.compile`, `replace_with`/`replace_all_with` (callback),
  `find_iter` → `RegexMatchIter` (an `Iterator`), `end()`/`span()`/
  `group_span(i)` byte spans; 182/182 regex tests, `check ./std` 172/172.
  Yo-syntax notes refreshed en route: `{...}` in ARG position is a struct
  literal (drop braces on single-expression closures); `=>` RHS with an
  operator chain needs the WHOLE RHS parenthesized; `"str" + var` in an
  assert is a `comptime_str`/`String` unification error — use
  `String.from("...") + var`.
- **develop run for #387 (#388/#389 head 19e4b3817) SUCCESS** — the arity
  fix is validated on develop.
- **Formatter-ordering trap (bit #391 → develop briefly RED on the T1 fmt
  gate)**: #386's redundant-paren-elision formatter landed on develop
  (8088de32d) AFTER this session's worktrees branched (19e4b3817), and the
  regex PR's `std/regex/index.yo` was formatted with a PRE-#386 binary — so
  #391 shipped old-style formatting that the new formatter flags, and
  develop's own T1 fmt gate + ubuntu fmt --check went red (both fixed by
  #390's follow-up reformat, bae863183). LESSON: before pushing any
  `.yo`-carrying PR, re-run `yo fmt` with a binary built from CURRENT
  develop — a stale worktree binary silently formats with stale rules, and
  `fmt --check` locally passes while CI fails.

## 1. Where develop stands

| commit | PR | what |
| --- | --- | --- |
| `fc6b6cb99` | #373 | `yield` parks on the loop; wasm smoke to stage-2 |
| `11c34a8b6` | #374 | re-land of the #370 prelude/std sweep |
| `95f81970a` | #377 | dyn on-demand type-body dedup (un-redded develop) |
| `a0c88eddf` | #375 | `sleep(0)` on Linux (timerfd disarm) |
| `938342f2b` | #376 | TLS as a per-target runtime backend + `tls_available()` |
| `d2a8e3f7f` | #378 | release: musl bundle ships gen-2; stage-3 byte-identity gate |
| `adf0dc887` / `22ec5f6e2` | release | **v0.2.21 published**; `SEED_VERSION` = v0.2.21 |
| `ec6650f14` | #380 | **D5/§5 closeout** (see §2) + `plans/reference/LAZY_TOPLEVEL_BINDINGS.md` |
| `e84def46b` | #364 | `yo version` curl→std/http (D6 PR-3) + OpenSSL CI plumbing + harness sed portability — **MERGED** |
| `a7dcc7bd2` | #381 | ci: apostrophe fix (develop un-red; musl leg green) |
| `7b8976438` | #382 | **ArrayList drain/remove/iter (§5 breaking change)** |

`yo version install` / `list --remote` work again as of v0.2.21 (curl path);
the std/http path lands with #364 and ships in the NEXT release.

## 2. #380 — the D5/§5 closeout (LANDED)

- `Dyn(Reader)` pinned (`tests/io/async_traits.test.yo`): vtable `read`, the
  `read_to_end` default through it, `BufReader(Dyn(Reader))`.
- One spelling per read operation (D2, Rust names): inherent
  `File.read_bytes`, `File.read_to_string`, `TcpStream.read_bytes` DELETED;
  the `Reader` defaults `read_to_end`/`read_to_string` are the API. The `fs`
  free functions go through them. `write_string`/`write_bytes`/`write_str`
  stay (no trait counterpart).
- `HttpRequest`/`HttpResponse` wire `to_string` → `impl(..., ToString(...))`.
- `str.join` row closed (already documented); ArrayList `remove`→`drain` row
  MEASURED (~20 typed sites) and left as its own PR (§5).
- **Found en route — a class `yo check` is blind to**: `impl(File,
  IoTraits.Reader(...))` sat BELOW the free functions that call its defaults;
  the def-time failure was swallowed, `check ./std` green, hollow stubs caught
  only by the C22 gate. Impls moved above the callers; rule recorded in
  `.github/skills/yo-syntax/syntax-cheatsheet.md` + `yo-syntax.instructions.md`
  ("trait impls are bindings too"). This motivated the plan in §6.
- Validation: seed (v0.2.21) `check ./std` 172/172 + seed `yo build` rc=0;
  io/async_traits 9, io/bufio 13, fs/file 16, net/tcp 13, http/http 21,
  http/server 8; gates failures=0, CLI 54/0; FIXPOINT_HOLDS; dyn canary 9/9.

## 3. #364 — curl→std/http on the v0.2.21 seed

**State at handover (pick this up FIRST):** the PR is OPEN at remote head
`0f3b0ca3c`; its CI run **33575192179** was still finishing (only the macOS
native legs, wasm-emscripten, ubuntu-24.04-arm, the Windows legs and fixpoint
stage-3 outstanding; everything else green, ONE failure = the musl job, fixed
below). Two commits are **committed locally but NOT pushed** in worktree
`/private/tmp/yo-d6` (branch `s6/version-cache-std-http`): `44c126b05` (the
musl fix) and `0a523d514` (merge of develop incl. #380 — clean). The merged
tree is validated: seed `check ./src` 262/262, `check ./std` 172/172, seed
`yo build` rc=0, `tests/dyn.test.yo` 9/9 (S1 = `/tmp/yo-d6m-s1`).

**To land**: (1) `gh run view 33575192179` — confirm the macOS native legs
and wasm-emscripten passed (they are the last two OpenSSL plumbing sites not
yet exercised: the brew `-I/-L -lssl -lcrypto` compile and the stage-2 line);
(2) `cd /private/tmp/yo-d6 && git push origin s6/version-cache-std-http`
(fast-forward, no force needed); (3) `gh pr merge 364 --admin --squash` —
the new run it triggers will still verify the musl fix on develop, and the
local coverage checklist (§4.1) is complete. If a macOS or wasm leg FAILED,
fix that site in the same push before merging (they are the lines in
`test.yml` under `test-native`'s `else` branch and `test-wasm32_emscripten`'s
"Build stage-2 for the smoke").

Content: the swap (`_http_get`/`_download_file` via
`fetch_with`), `tls_available()` gating with actionable errors, the weak
OpenSSL canary in the emitted TLS runtime (`&SSL_CTX_new != NULL` so the
weak-linked macOS bundle launches without the dylib), OpenSSL plumbing at
EVERY raw compiler-C compile site (test.yml ×8 incl. the shared
`.github/actions/build-stage1`, release.yml ×5, fixpoint-arm64, the
`fixpoint_only.sh` brew fallback), the BSD-sed-portable harness word
boundaries + re-recorded `version-install-pinned`.

First CI run (33575192179) failed ONLY the Static musl Linux bundle: Alpine
splits `libssl.a` out of `openssl-dev` into **`openssl-libs-static`**; the
fix (`44c126b05`, all three Alpine blocks incl. release.yml's) was verified
against pkgs.alpinelinux.org (no docker on this Mac). **release.yml's sites
are NOT exercised by PR CI — watch the first release run after this merges**
(the two Alpine `cc` lines, the macOS bundle weak-link flags, the portable-C
parse gate).

Local validation (S1 = `/tmp/yo-d6-0221s1-bin`, seed-built): emit/clang/
check green, live `version list --remote`, `tls: true` probe, gates
failures=0 (one `comptime rc=1` was my own concurrent test run in the same
worktree — see §4), FIXPOINT_HOLDS, CLI `--network` 55/0/0, dyn 9/9.

## 4. Rules learned this cycle (the ones not yet in AGENTS.md)

1. **Run `tests/dyn.test.yo` after any change that renumbers** (prelude/std
   edits). #374's validation skipped the full suite and this batch was the
   only place the on-demand double emission showed. Now a fixed item of the
   admin-merge checklist: seed `check`, affected tests, battery + fixpoint,
   CLI scorecard, dyn canary.
2. **Never run two `yo test` invocations in one worktree concurrently** — the
   runner's `tests/.yo_selftest_batch_*` names are fixed; the other run
   deletes your `.bin.c` mid-compile (`clang: no such file`, `hollow=NA`).
3. **Byte-identity A/B: do not edit sources while the baseline emit runs**
   (the module loader reads files for minutes; grep the emitted C for a
   string unique to your edit to detect pollution).
4. **Heavy builds/batteries: `nohup bash -c '...; echo rc=$?' &> log &
   disown` + a Monitor on the rc line.** Harness background tasks were
   killed twice; the other agent's `rungates.sh` failed only because its
   PATH lacked GNU `timeout` (`PASS: unbound variable` cascades from that).
5. **Docs-only PRs cannot merge without `--admin`**: the "Classify the diff
   (docs-only fast path)" job skips every test job, so the ruleset's required
   contexts never report (#379 stayed BLOCKED while green). Moot while admin
   merges are allowed; otherwise fold docs into a code PR or fix the fast
   path to report the contexts.
6. **Trait impls are bindings too** (§2) — until §6 lands, register
   `impl(T, ...)` before any same-module caller of its methods/defaults.

## 5. Queue (in order)

1. **Watch develop's post-merge run for #364** (test.yml musl job with the
   package fix) and the **next release run** for release.yml's OpenSSL sites.
2. **ArrayList `remove(start,count)` → `drain(range)` + `remove(idx) -> T` +
   `iter()`** — own PR, compiler-as-oracle: rename first (`remove` → `drain` /
   `remove_at`) so the compiler names every site, then re-spell. ~20 typed
   sites (std: async/channel ×2 FIFO pops, btree_map, array_list's retain;
   src: module_loader ×7, module_manager ×2, trait_checking ×3,
   unsafe_report ×2, type_trait_methods ×2). Pre-freeze breaking change;
   `plans/STD_API_AUDIT.md` §5 row has the measurement.
3. **`plans/reference/LAZY_TOPLEVEL_BINDINGS.md` P0** — the check-time "forward
   reference to X (defined at line N)" diagnostic replacing the silent
   swallow (small, independent; the rest of that plan is a campaign the user
   has not scheduled).
4. D7 `Thread.spawn` `join() -> T` result carry (S4 item; the compiler
   blocker measured fixed 2026-08-28).
5. Compiler holes tracked by the audit: C29 (generic type vars re-resolve per
   argument); arity validation OUTSIDE the def-eval swallow + the async-SM
   C22 equivalent (`issues/wrong-arity-call-silently-accepted-version-install-broken.md`).
6. Windows: stdin pipe WRITES (overlapped named pipes; reads landed #353);
   `issues/s3-fs-wrappers-windows-semantics-audit.md`; Schannel (D6 deferred).
7. Polish rows: regex extras, cli typed values + std/term adoption, O5
   Formatter routing; D4 LSP UTF-16 position encoding.
8. Next patch release once #364 has soaked: notes must say the curl
   dependency is gone and `yo version` speaks TLS via the compiler-emitted
   backend (Windows: `tls_available()` false until Schannel).

## 6. The forward-reference design (written, not scheduled)

`plans/reference/LAZY_TOPLEVEL_BINDINGS.md`: `::` / `comptime(x) :=` definitions and
`impl` registrations become order-independent via pending bindings forced on
first reference or module end; two-phase function forcing; pending impls by
receiver head; cycles are errors with a chain; statements stay ordered.
Acceptance = byte-identical C on today's corpus. P0 is the diagnostic (queue
item 3); P1+ needs a go from the user.

## 7. Worktrees & binaries

| path | branch | state |
| --- | --- | --- |
| `/Users/yiyiwang/Workspace/Yo` | shared with the peer session | never checkout here; the three handover docs are untracked files here |
| `/private/tmp/yo-d6` | `s6/version-cache-std-http` | #364 — 2 local commits NOT pushed (§3); remove after merge |
| `/private/tmp/yo-relg2`, `yo-sweep`, `yo-vfix`, `yo-o7`, `yo-fsw`, `yo-s4`, `yo-369`, `yo-370`, `yo-asandbg` | the other agent's | check `git status` before removing |

Seed: `/private/tmp/yo-seed-0221/yo-v0.2.21-aarch64-apple-darwin/bin/yo`.
Fresh stage-1s: `/tmp/yo-tail-s1` (= #380 tree ≈ develop), `/tmp/yo-d6m-s1`
(#364 ∪ develop, the tree to be pushed), `/tmp/yo-d6-0221s1-bin` (#364 before the merge). Build with `YO_STD=<wt>/std <seed> build` (~10 min, detached).

## 8. Standing constraints

Shared main checkout → `/private/tmp` worktrees + `git -c protocol.file.allow=always
submodule update --init`; one battery at a time, one heavy build at a time,
S1 outside the repo; `--optimize 2` (no `--release`); fmt twice then check;
`yo build` runs under the SEED — std/src source forms must be legal under it
(no forward refs in std/src until §6 ships and becomes the seed); CLI harness
reads `YO_SELF_BIN`; after any golden re-record rerun the FULL scorecard.

## 0j. 2026-09-03 (cont.) — the capture fix landed (#396) and v0.2.23 SHIPPED

#396 took three CI rounds, two of them finds beyond the diff:
(1) the windows runner images LOST libasan — every ASan-instrumented batch
link failed `cannot find -lasan` (uniform, rerun-stable, while develop's
windows legs were green minutes earlier) → the two windows full-suite
invocations now pass `--disable-sanitize` via a `RUNNER_OS` conditional
(`issues/windows-images-lost-libasan.md`, restore path documented);
(2) with ASan out of the way the REAL cross-platform bug showed: `_mg_canon`
canonicalized `file:///C:/a/b` → `/C:/a/b` but the CLI spelling prepended a
raw backslashed cwd → the module-global registry keys disagreed on windows
ONLY, the capture exclusion missed, and the batch C failed — fixed by
normalizing separators + drive-letter absolutes in `_mg_canon` (POSIX
inputs unchanged). #395's formatter landed mid-flight; the branch merged
it and re-formatted `expr_info.yo` with the NEW binary (the §0f lesson,
applied).

**v0.2.23 published** (user-approved): dispatched after develop went green
on the exact head (`8bfe53851`, run 33726602175); release run 33733863309
SUCCESS — 13 assets, Latest, notes set. Live-verified from the published
tarball: `yo --version` = 0.2.23, `yo version list --remote` speaks TLS
(std/http). `SEED_VERSION=v0.2.23` auto-bumped on develop (`060acdc26`,
no [skip ci]) — its develop run 33740596643 validates the new seed chain.
Carries: #386/#395 formatter rounds, #387 arity, #390 poison gate, #391
regex row, #392 docs, #394 bare-e identity, #396 capture fix + windows
canonicalization.

**Seed-bump validation COMPLETE**: develop run 33740596643 on `060acdc26`
(`SEED_VERSION=v0.2.23`) finished **success** — the v0.2.23 seed chain
holds end to end (bootstrap fixpoint, internal shards, hollow sweep, wasm,
musl, all OS legs). The v0.2.23 release cycle is fully closed.

## 0k. 2026-09-03 (cont.) — string row CLOSED (+ a codegen bug found & fixed en route)

Two PRs, stacked:

- **#397** `fix/match-arm-and-or-drop-scope` — pre-existing codegen bug the new
  string tests exposed: a `&&` whose RHS creates an RC temp inside a NON-BEGIN
  match arm leaked the temp's drop out of the arm's C scope ("use of
  undeclared identifier `_…_temp_N`"). Reachable by ordinary user code on
  develop (minimal repro: match on `index_of` + `assert((i > 0) && (String.from(...).len() > i))`).
  Root cause: the non-begin arm path of `generate_case_body` never published
  the arm value's `deferred_drop_expressions` as `pending_deferred_drops`, so
  the short-circuit branch claim found nothing. Fix = the same push the begin
  path / `generate_function_body` already do. Corpus 156/156 byte-identical.
  Issue filed+fixed in the same PR.
- **#398** `std-string-row-closure` (NOTE: no slash — a flat remote branch
  `std` blocks the `std/` namespace) — the string row of the audit: Unicode
  `to_lowercase`/`to_uppercase` (unicode.yo leaf-ified to
  `to_lowercase_bytes`/`to_uppercase_bytes` to break the import cycle),
  `to_ascii_*`, `Pattern.length_in` + rune/Regex impls, Pattern-generic
  `replace`/`replace_all` (empty pattern now Rust semantics `-a-b-c-`), 
  `split_once` (`Option((String; String))` — first tuple-returning std API),
  `strip_prefix`/`strip_suffix`, `parse_f64` (Rust grammar + atof),
  `parse_i64_radix`/`parse_u64_radix`; deleted `panic_dyn`/`assert_dyn`
  (subsumed by generic `panic`/`assert` — 4 tests/internal callers migrated)
  and `to_c_str` (`to_cstr().ptr()` covers the 2 callers).

Validation: string 267/267, regex 186/186, coverage/imm_string/dyn green,
check std 172/172 + src 262/262, gates battery green, corpus 156/156,
CLI 57/57 (1 network skip), fmt --check clean (fmt TWICE for string.yo).

**Rules learned (all in the cheatsheet now):** block bodies cannot START with
`match(`/`cond(` (hoist the scrutinee); typed assigns need `(x : T) = …`;
module-level fns need `::`; tuple TYPE is `(A; B)` semicolons, tuple VALUE
`(a, b)` commas, fields `p.0`, NO destructuring patterns (parser.yo's comment
states the mapping BACKWARDS — trust tests/internal/parser.test.yo); `1e-12`
exponent float literals do not lex; `__yo_panic` comptime-evaluates its
message (bind the pointer through a local, an `.unwrap()` chain has no
ExprInfo); `println` comes from `std/fmt`, and `join` is
`separator.join(list)`.

**Tooling notes:** gates_fast on this Mac needs GNU `timeout`
(`/tmp/gnubin/timeout` — brew coreutils symlink; a hand-rolled shim
DEADLOCKS diff-test.sh's `wait -n`) AND homebrew bash first on PATH
(`/bin/bash` 3.2 dies on `declare -A` with "PASS: unbound variable").
Seed for this cycle: the **published v0.2.23 bundle**
(`/tmp/yo-v0223-check/yo-v0.2.23-aarch64-apple-darwin/bin/yo`) — doubles as
the current-develop fmt binary (release head + version bumps only after).
Worktree `/private/tmp/yo-str` (branch std-string-row-closure) holds both
commits; patched compiler at `/private/tmp/yo-str/yo-out/aarch64-apple-darwin/bin/yo`.

### §0k addendum — #397 needed a round 2 (pending is unwind-owned)

The v1 fix (publish arm drops into `pending_deferred_drops`, like the begin
path) double-freed: the claim reached drops rolled up to the FUNCTION-BODY
pending list, whose emission belongs to the effect-unwind path
(`__yo_effect_escaped` → drop-locals-before-early-return) — an unconditional
in-branch drop beside the escape-only one. CI caught it as
`json_parse lone high surrogate` ASan heap-use-after-free (exit 256; exactly
one extra `__yo_decr_rc` line vs develop in the emitted C — emit both and
diff to find such things fast). Replacing pending with the arm-only list
instead broke unwind propagation (same test, throw swallowed, exit 6).
Landed design: new `arm_value_deferred_drops` context field — the claim
source when set, removed IN PLACE (the publication is the same shared
ArrayList the arm-tail flush reads; a filtered copy double-drops). The
timeout shim note above is now moot: `/tmp/gnubin/timeout` is a symlink to
brew coreutils' real GNU timeout (hand-rolled shims deadlock diff-test.sh's
`wait -n`).

### §0k final — #397 CLOSED, bug filed OPEN; #398 standalone

Round 3 (separate arm-list field) still failed the STAGE-2 SELF-COMPILE: the
claim's drop, emitted at `&&` chain close, can sit in a DIFFERENT C scope
than the temp's declaration when the arm body itself nests blocks (compiler
`declared_c_var_names` machinery: temp declared at stage2.c:1779890 inside a
nested if, claimed drop at :1780190 outside). The general fix needs the
emitter to track which C block each temp was declared in — architecture
work. Decision: #397 closed with the full analysis (branch deleted; three
attempted designs preserved in the issue text), bug filed OPEN at
`issues/match-arm-and-or-rhs-temp-drop-leaks-arm-scope.md` with the author
workaround (begin-form arm bodies). #398 was rebuilt standalone off develop
(branch force-pushed as std-string-row-closure; NOT stacked): the three
`&&`-in-non-begin-arm test asserts reshaped to `begin(...)` form — string
267/267 and regex 186/186 verified with the UNPATCHED v0.2.23 seed (develop
codegen). LESSON for future queues: run the stage-2 self-compile
(`yo-out compile src/main.yo --optimize 2 -o x`) BEFORE pushing any codegen
change — `yo build` (seed→stage-1) does not exercise it, and CI's "Build the
suite candidate" does.

### §0k final-final — the FromIterator regression (and the lesson)

PR398's first CI round failed on the WASI leg: `collect(String)` — "Type
String does not implement required trait FromIterator". Cause: the python
span-deletion of `panic_dyn`/`assert_dyn` (cut from the panic_dyn doc line to
`export(`) had also swallowed the `impl(String, FromIterator)` that sat
between them and the export list. A/B against pristine std + a 6-line
`collect(String)` probe found it in minutes; restored, and the whole file
structure-audited against develop (`grep -oE '^impl(|^  name : (fn' | sort |
uniq -c` diff — now exactly the intended additions/removals). LESSONS:
(a) after ANY scripted span deletion in a big file, run that structure diff
before trusting the edit; (b) `tests/iterator_combinators.test.yo` is the
only FromIterator-on-String consumer — add it to the string.yo validation
set; (c) the WASI leg failing while others pass is NOT wasi-specific — it
just reports the batch eval error first (reproduced locally in seconds).

### §0k CLOSED — #398 MERGED (a5a67d992), string + regex rows of the audit DONE

PR398 merged (squash) into develop after 26/26 green checks (three CI rounds:
round 1 = the staged codegen fix's json UAF; round 2 = the FromIterator
regression; round 3 clean). #397 closed with analysis; the codegen bug is
OPEN at issues/match-arm-and-or-rhs-temp-drop-leaks-arm-scope.md. The audit's
string row and regex row are now CLOSED. Post-merge develop run to watch;
next queue item unchanged (blocked set + polish rows: cli typed values, LSP
UTF-16, D4 PR 9, fmt dedup, collections drain/HashSet/BTreeMap real tree,
encoding D1/base32/toml, url, io wrappers, fs row, path row, env merge,
process current_dir, net leftovers, http row, async combinators, gc.stats,
testing bench, spec/ freeze banner).

### Post-merge validation — develop run 33794393216 on a5a67d992: SUCCESS

(The macos-26-intel leg was cancelled by the runner once — the known flaky
leg — and its `--failed` rerun completed green.) The string+regex row merge
is fully validated on develop. Worktree `/private/tmp/yo-str` is now
removable; its yo-out binary and the v0.2.23 seed stay useful for the next
polish row.

## 0l. 2026-09-04 — fs+path rows advanced (#402 MERGED 907908e7e); windows ftruncate bug fixed

PR402 (5 CI rounds): the fs row's "still:" list was STALE — copy/read_link/
set_permissions/try_exists/watch/remove_dir_all had all landed unrecorded
(audit row re-measured). Implemented the real gaps: `File.set_len`
(ftruncate), `File.from_fd` (Rust from_raw_fd ownership), `DirEntry.path()`
(+`parent : Path` field), and the path row's `Clone`/`Hash`/`Ord` (Path is
now a legal HashMap key). Local: file 19/19, dir 15/15, path 70/70,
walker 8/8, fetch 10/10, checks 172/263 — all with the v0.2.23 seed.

CI rounds 1/2/4 failed ONLY on windows: `set_len extends` threw EINVAL
(exit 22). The eprintln-in-handler diagnosis (see below) finally surfaced
"invalid input": the runtime opens files FILE_FLAG_OVERLAPPED and UCRT's
`_chsize_s` EXTEND path zero-fills via a plain CRT write → EINVAL on
overlapped handles (shrink = seek+SetEndOfFile, which is why truncation
passed). Fixed in runtime_io_windows.yo with
`SetFileInformationByHandle(FileEndOfFileInfo)` — one call, no file
pointer, legal on overlapped handles. Round 5: 26/26 green incl. windows.

**Diagnostic technique lessons (0l):**
- Buffered `println` inside an exception handler is LOST when the assert
  panic aborts — stdout is block-buffered to CI logs. `std/fmt.eprintln`
  (stderr, unbuffered) is the right tool; `panic(msg)` also works and
  terminates. Don't hand-roll `unsafe(fprintf(stderr, ..., to_cstr()))` —
  eprintln already wraps exactly that (user steer, adopted).
- An uncaught IoError unwind exits the test child with the ERRNO as rc
  (rc 22 = EINVAL) — rc encodes the failing errno.
- `.Write` OpenMode is create-or-OVERWRITE (O_TRUNC): set_len tests must
  open `.ReadWrite`; raw fd reads need a malloc'd `*u8` buffer (an
  ArrayList's length never advances).
- `Path` had NO Clone — `path.clone()` inside an io.async closure body was
  a deferred eval error caught by the #390 poison gate at compile time
  (nice gate!).

Post-merge develop run to verify; worktree /private/tmp/yo-str (now on the
merged branch) removable after that. Remaining fs row: OpenOptions builder,
Metadata btime/permissions()/stop re-stat, walker lazy, AsPath trait;
remaining path row: join(str), push, Windows separator in to_string,
ancestors, PATH split/join, `..` normalization revisit.

### §0l post-merge — develop run 33842520793 on 907908e7e: SUCCESS

The macos-26-intel leg was CANCELLED BY ITS RUNNER twice before a third
rerun completed green (25/26 green each time, only that leg). That is now
THREE cancellations of this leg in two days (also once on a5a67d992) — the
standing "macos-26-intel flake" queue item should probably be escalated to
"runner pool is being preempted": consider dropping the leg or moving to a
different intel label; a CI-policy call for the user. Everything else —
including both windows legs — green.

## 0m. 2026-09-04 — quick-wins sweep (#406 MERGED 16054559a); v0.2.24 cut from it

One PR with every remaining quick-win row (3 CI rounds): env (`remove`,
`vars()` with the three-way platform split — `_environ` / `_NSGetEnviron()`
via new `std/libc/darwin.yo` (`<crt_externs.h>`; macOS headers do NOT export
`environ`, the accessor returns `char ***` and is deref'd once) / `environ`;
`get`/`set`/`remove` take any ToString key), path (`join` ToString-generic
facade over private `_join_path`; `push`; `ancestors` Rust-parity; module-level
`split_paths`/`join_paths` on `PATH_DELIMITER`), fmt row CLOSED (print bodies
collapsed onto `_write_str`/`_write_newline`; 21 numeric ToString impls onto
`_snprintf_to_string(comptime fmt, T, v)` — comptime `str` params forward into
extern variadic calls as literals, probed before relying on it), spec/ FREEZE
banner executed, error.yo re-export narrowed to `{ String }`+`{ ToString }`,
gc/process rows corrected (CustomAllocator verified gone; `current_dir` stale
— `env.cwd()` already exists; `gc.stats()` deferred with rationale).
Local: env 18/18, path 74/74, fmt 7/7, checks 173/264, windows cross-emit rc=0.

**THE lesson (0m): generic method bodies RE-SPECIALIZE PER CALL SITE, and
relative imports inside them resolve against the CALLER's directory.** Making
`env.get`/`set` ToString-generic made the in-arm `import("./libc/windows")`
resolve to `<caller>/libc/windows.yo` when compiling src/main.yo (the CI
windows cross-emit leg caught it; reproduced locally with
`compile src/main.yo --std-path ./std --target x86_64-pc-windows-msvc`).
Rule: any import reachable from a GENERIC body must be package-absolute
(`import("std/libc/windows")`). Relative in-arm imports are fine in
NON-generic module-level fns (evaluated once in the defining module's
context). Also: platform-gated module loads (comptime cond arms) are what
keep platform-only headers (`crt_externs.h`) out of other targets' C —
`c_include(...)` (not extern blocks; those rely on system headers being
emitted) is the mechanism that both includes AND binds.

Other lessons: `export(print)` dropped during a body-collapse is caught by
`check ./src` via the compiler's own comptime_print — always run it on
fmt-adjacent changes; u8 does not implement Pattern (split on `rune(u32(n))`);
delimiter-portable tests construct fixtures from `u8(PATH_DELIMITER)` and
compare Path segment equality, never hardcoded `:` literals.

Post-merge develop run 33887236877 on 16054559a; v0.2.24 dispatched from it
(bump=patch). Release notes drafted at /tmp/v0.2.24-notes.md and set via
`gh release edit` — BREAKING: `to_c_str` and `panic_dyn`/`assert_dyn` deleted,
`replace_all` empty-pattern now Rust semantics, `DirEntry.parent` field added.

### §0m post-merge — develop GREEN; v0.2.24 SHIPPED

- develop run 33887236877 on 16054559a: SUCCESS, all legs incl. macos-26-intel
  (no reruns needed this time).
- release.yml bump=patch → run 33894332042 GREEN: version-bump commit
  0e218fed7, draft created, notes set from /tmp/v0.2.24-notes.md while the
  bundles built (publish only PATCHes draft=false — the body survives),
  13 assets (6 tarballs + 6 portable-C .c.gz + vsix), published 17:23Z as
  `latest`, tagged on the bump commit. Tarball verified: `yo 0.2.24`.
- SEED_VERSION auto-bump: 78abb90ba on develop (no [skip ci] → its Test run
  33900306095 validates the new seed).
- Successor handover written: **plans/HANDOVER_STD_AUDIT_NEXT.md** (queue,
  open bugs, decisions, process, pitfalls). The /private/tmp/yo-str worktree
  is gone (removed/OS-swept — branch was merged, nothing lost).

### §0m final CI note

The first full v0.2.24-seed run (33902170762, on the maintainer's #410
plans-reorg head — the seed-bump commit's own run was cancelled by that
merge's concurrency group) failed ONE leg: macos-latest, "Test spawn with
multi-yield futures" — the SAME flake that hit macos-26-intel during #390
(§0g). `--failed` rerun: GREEN. That test has now flaked twice on two
different mac legs; recorded in HANDOVER_STD_AUDIT_NEXT.md §5.3 — weaken it
when next touched. All work stopped here per the maintainer's instruction.
