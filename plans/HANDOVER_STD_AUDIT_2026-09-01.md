# Handover — std API audit campaign, session ending 2026-09-01 (evening)

Supersedes `plans/HANDOVER_STD_AUDIT_2026-08-30.md` (keep it — the deep
background on C-numbered issues, the E-class arc, and the smoke-hang
investigation lives there; THIS doc is the current state).

The active /goal is unchanged: finish everything in `plans/STD_API_AUDIT.md`,
well-designed stable std APIs, document + fix every surfaced bug, **no
workarounds**, admin merges authorized to save CI cycles.

---

## 0a. ADDENDUM 2026-09-02 (morning — #364 pushed, riding CI)

**State**: v0.2.21 is published (assets + notes done), SEED_VERSION is
v0.2.21 on develop (`22ec5f6e2`, CI green). **PR #364 was force-pushed at
`0f3b0ca3c`** (rebased on that develop) and is riding CI — **merge only on
green, no admin merge** (standing user rule).

**What the night session left**: the 0221-seeded stage-1 of the #364 tree
(`/tmp/yo-d6-0221s1-bin`, emit/clang/check green, live `version list
--remote` + `tls: true` probe) and a prepared `/tmp/rungates.sh` whose run
FAILED only for environmental reasons — `timeout: command not found` under
its bash/PATH, cascading into `PASS: unbound variable` in the scorecards.
Not a tree problem.

**Found + fixed this morning (commit `0f3b0ca3c`)**: the OpenSSL CI plumbing
was incomplete. The compiler's own emitted C now carries OpenSSL includes on
unix targets, so EVERY raw `clang`/`cc` that compiles compiler C needs the
flags; six sites in test.yml (`test`-matrix stage-2, suite-candidate + its
install step, test-native's macOS compile via the brew keg, bootstrap-fixpoint
stage-2 + install, the Alpine musl static build, the wasm-emscripten stage-2)
and the shared `.github/actions/build-stage1` (wasm32 emscripten + wasi jobs)
were missed. An awk sweep over test.yml / release.yml / fixpoint-arm64.yml /
the action now shows every compiler-C `-o` covered (Windows/wasm emits carry
stubs). release.yml's sites are still NOT exercised by PR CI — watch the
next release run.

**Validation of the pushed tree (S1 = `/tmp/yo-d6-0221s1-bin`)**: tier-1
gates all green (corpus 156/0, std 172/172, src 262/262, CLI 54/0; the one
`comptime rc=1` was MY concurrent dyn canary deleting the battery's batch
.bin.c in the same worktree — rerun under GATE 1's exact conditions 31/31
hollow=0; memory-of-record written); fixpoint **FIXPOINT_HOLDS**, CLANG_RC=0
via fixpoint_only.sh's new OpenSSL flags, stage-2 hollow=0; CLI scorecard
`--network` **55/0/0**; dyn canary 9/9.

**Next**: on #364 green → plain squash merge → the audit's curl-swap row
closes → continue §4.4's audit tail. If a CI leg fails on an OpenSSL flag
or a missing libssl-dev, it is one of the sites above — fix in place, do not
revert the plumbing.

---

## 0b. ADDENDUM 2026-09-02 (late morning — audit tail + forward-ref plan)

**In flight**
- **#364** riding CI at `0f3b0ca3c` (see §0a) — merge on green, plain squash.
- **D5/§5 closeout** on branch `s8/audit-tail-d5-http` (worktree
  `/private/tmp/yo-tail`, commits `a451edd66` + `f8583c83a`, NOT yet pushed/PR'd —
  battery running with S1 = `/tmp/yo-tail-s1`, the v0.2.21-seed build of that
  tree; seed `check ./std` 172/172; tests green: io/async_traits 9 (new
  `Dyn(Reader)` pin), io/bufio 13, fs/file 16, net/tcp 13, http/http 21,
  http/server 8). Content: `Dyn(Reader)` pinned (vtable read, default through
  it, `BufReader(Dyn(Reader))`); inherent `File.read_bytes`,
  `File.read_to_string`, `TcpStream.read_bytes` DELETED in favour of the
  `Reader` defaults (D2, one Rust name per operation); `HttpRequest`/
  `HttpResponse` `to_string` → `ToString` impls; plan §5/D5 rows updated;
  ArrayList remove/drain row MEASURED (~20 typed sites) and left as its own PR.
  **Found en route**: `impl(File, IoTraits.Reader(...))` sat BELOW the free
  functions that now call the trait defaults — def-time failure swallowed,
  `check` green, hollow stubs caught only by the C22 gate. Impls moved above
  the callers; rule recorded in the syntax skill + instruction files
  ("trait impls are bindings too"). PR body draft:
  `<scratchpad>/pr-tail-body.md` (fill the BUILD/BATTERY placeholders).
- **`plans/LAZY_TOPLEVEL_BINDINGS.md`** (+ AGENTS.md row): the design for
  lifting the no-forward-reference rule. Was PR #379 (docs-only, CI green) —
  **CLOSED and folded into the closeout branch** because a docs-only PR is
  structurally unmergeable under the no-admin rule: the "Classify the diff
  (docs-only fast path)" job skips every test job, so the ruleset's required
  contexts (`test (<os>)`, fixpoint, tier-1 gates) never report and the PR
  stays BLOCKED. **User decision needed**: either allow `--admin` for
  docs-only PRs, or teach the fast path to report the required contexts as
  success (a `test.yml` change), or keep folding docs into code PRs. Its **P0** (a check-time "forward reference to X (defined at line N)"
  diagnostic replacing the silent swallow) is the next compiler item worth
  doing before the audit's remaining compiler holes (C29, arity-outside-the-
  swallow); P1+ is a campaign, not a PR.

**Queue after these**: ArrayList `remove`→`drain`/`remove(idx)->T` (own PR,
compiler-as-oracle rename first); D7 `Thread.spawn` `join() -> T` (S4); C29;
arity validation outside the def-eval swallow + async-SM C22 equivalent;
Windows stdin pipe WRITES; `issues/s3-fs-wrappers-windows-semantics-audit.md`;
polish rows (regex extras, cli typed values + std/term adoption, O5 Formatter
routing).

---

## 0. LATE ADDENDUM 2026-09-01 (night session — supersedes §2/§4 ordering)

**Constraint change from the user (standing)**: merge PRs only on fully
green CI — **no admin merges**. #375 and #376 were merged this way.

**Merged tonight**: #375 `a0c88eddf` (sleep(0) timerfd), #376 `938342f2b`
(TLS runtime backend).

**PR #378 (fix/release-musl-gen2, worktree /private/tmp/yo-relg2)**: the
musl-bundle release leg emitted the SHIPPED C with the SEED — the shipped
Linux bundle (and the next cycle's SEED_VERSION download) was gen-1, i.e.
its own compiled-in `yo build`/`yo version` machinery carried the seed's
codegen (the hang). The Linux portable yo.c arms were seed-emitted too.
#378 makes it: seed → Alpine cc → static stage-1 → **stage-1 re-emits the
shipped C** → Alpine cc; the portable arms are emitted by the shipped
binary; the pre-release gate becomes a **stage-3 byte-identity fixpoint**;
the glibc smoke gains `yo init` + `yo build run` (15-min step timeout);
job timeout 180→240. Non-Linux cross bundles were already gen-2. **#378
must merge before v0.2.21.** Its PR CI does NOT exercise release.yml —
watch the actual release run.

**#364 RESCHEDULED — the second-order bootstrap veil (found tonight)**:
after rebasing on post-#376 develop, the v0.2.20 seed CANNOT build the
compiler tree with std/http in its closure: #376's `extern("Yo")
__yo_tls_*` ABI has its runtime emitted only by #376-codegen compilers,
and the seed emits bare undeclared `__yo_tls_*` calls (stage-1 clang:
`call to undeclared function '__yo_tls_available'`). So CI's seed-built
stage-1 fails the moment the swap enters the tree. **Merge gate moved to
SEED_VERSION v0.2.21** — cut v0.2.21 WITHOUT #364, let publish-release
auto-bump the seed, then rebase #364 and ride CI. Local verification of
the rebased #364 is DONE (all green, using /tmp/yo-tls-s1 — a #376-tree
stage-1 — as the seed stand-in): emit→clang→check ./src+./std, tls probe
`tls: true`, LIVE `version list --remote`, LIVE `version install 0.2.18`
(download + pre-triple name fallback + cache). Branch state (worktree
/private/tmp/yo-d6, NOT pushed — do not push before the seed bump): 5
commits on predictive base develop+#376 (rebase --onto real develop when
the time comes), including tonight's follow-up commit `3cae9af08`
(weak-canary `__yo_tls_available`, version_cache `tls_available()` gating
with clean errors, rewritten PR-3 note in plans/STD_API_AUDIT.md).

**Still to fold into #364 when it rides (post-v0.2.21)**:
release.yml OpenSSL sites — (a) seed-cross-emit apt `libssl-dev
pkg-config` (candidate build is compiler-driven clang), (b)
seed-bundles-cross macOS legs: pkg-config cflags +
`-Wl,-weak_library,$(brew --prefix openssl)/lib/libssl.3.dylib` (and
libcrypto) so the shipped macOS bundle launches without brew openssl
(verified locally: weak canary pattern compiles, links weak, launches
with the dylib ABSENT and reports false — /tmp/weakcanary*.c); (c)
musl-bundle BOTH Alpine cc lines: `apk add openssl-dev` + assert
/usr/lib/libssl.a + `-lssl -lcrypto`; (d) portable-c gate: apt libssl-dev
+ `$(pkg-config --cflags openssl)` on the `gcc -fsyntax-only yo.c`. Then
the CLI golden scorecard WITH `--network` (version-install-pinned is
substring-matched on `0\.2\.1`, unaffected), the battery, and push.

**v0.2.21 release notes draft (edit into the DRAFT after the run creates
it, before publish flips it — or after; it stays editable)**: hang fix +
gen-2 bundles; sleep(0); dyn dedup; E-class ASan; TLS backend +
tls_available contract; **`yo version install` / `list --remote` were
broken in v0.2.19/v0.2.20 — the hollowing fix (#366) restores the curl
path in v0.2.21; the curl→std/http swap (no curl dependency) is the next
release, gated on the v0.2.21 seed**.

---

## 1. What landed today (develop timeline, oldest first)

| commit | PR | what |
| --- | --- | --- |
| `fc6b6cb99` | #373 | async: `yield` parks on the event loop (1 ms timer park); `_async_override_return_type` no longer bails on a bare-SomeT registry result; join_handle test made race-free (bounded drive loop); **the wasm-emscripten smoke migrated to stage-2** (was the last stage-1 self-application in CI — the bootstrap veil hid seed codegen bugs there) |
| `11c34a8b6` | #374 | **re-land of the #370 sweep** (dead `KeyNotFound`/`ElementNotFound` variants deleted, prelude `if`-macro deleted, `Command.current_dir` generation B) + re-recorded goldens (check-watch-once 1156→1154, lsp-completion yo_id −1) |
| `95f81970a` | #377 | **fix: dedup on-demand type-body emission** — un-redded develop (see §3) |

All three admin-merged per the goal. #373 was full-CI green first; #374 was
validated locally (battery FIXPOINT_HOLDS, CLI 54/0, gen-2 smoke) — but see
§3's lesson about what that validation did NOT cover.

## 2. Open PRs — both expected green, merge on green

- **#375 `fix/sleep-zero-timerfd`** (head `7e0ebfa70`, CI run 33506595533,
  worktree `/private/tmp/yo-sleep0`): `sleep(0)` never completed on Linux —
  POSIX defines a zero `it_value` to `timerfd_settime` as DISARMING the
  timer. Fix: clamp the arm to 1 ns (`__yo_async_sleep_start`,
  `src/codegen/async/runtime_io_common.yo`). Pinned by "Test zero-length
  sleep completes" in `tests/sys/timer.test.yo` (plain-context + in-task
  await). Verified: stage-1 timer test 2/2 on macOS; Linux cross-emit
  carries the clamp. **The ubuntu CI legs are the real proof of the Linux
  path** (stage-2 templates) — that's why this one rode full CI instead of
  being admin-merged early. `issues/fixed/sleep-zero-disarms-linux-timerfd.md`.
  On green: squash-merge (not workflow-touching, `--admin` fine).

- **#376 `fix/tls-runtime-backend`** (head `9ca08e4a4`, CI run 33506618725,
  worktree `/private/tmp/yo-tls`): the predecessor's TLS backend move
  (std's OpenSSL `c_include` → per-target runtime emission behind
  `g_uses_tls`, extern("Yo") `__yo_tls_*` ABI, Windows stubs) **plus a
  gating fix found revalidating it**: the first version emitted the TLS
  runtime from inside `generate_async_runtime` (gated on `uses_async`), so a
  SYNC program calling only `tls_available()` got
  `call to undeclared function '__yo_tls_available'`, and wasm could never
  see the ABI. Now emitted as a sibling of the parallelism runtime in
  `generate_all_functions`, gated only on `get_uses_tls()`; the C guard is
  `#if !defined(_WIN32) && !defined(__wasm__)` so Windows AND wasm get
  stubs. Pinned by `tests/crypto/tls_available_sync.test.yo` — an
  **async-free batch** (one async test in the file would mask the gate),
  which **runs on the Windows legs deliberately** (stub → `false` is the
  contract; it is the only Windows TLS coverage).
  `issues/fixed/tls-runtime-emission-gated-behind-uses-async.md`.
  Local validation: check 262/262 + 172/172; gating matrix (plain program 0
  TLS refs / sync TLS program links + prints `tls: true` / windows + wasm
  emits carry guard + stubs); tls 2/2 (live HTTPS), http 34/34, async
  24/24; gates_fast failures=0 CLI 54/0; **FIXPOINT_HOLDS CLANG_RC=0**.
  On green: admin-merge. This unblocks #364's Windows story.

Both PRs already contain the #377 merge (develop merged in at
`7e0ebfa70` / `9ca08e4a4`). Their previous runs failed ONLY on the develop
breakage (§3) — verified by log: the same `redefinition of '__yo_t60_struct'`
in the dyn batch on both.

## 3. The develop breakage and the dyn dedup fix (#377) — read this before touching prelude/yo_ids

**What happened**: the moment #374 landed, every full-suite CI leg went red
on `tests/dyn.test.yo`'s batch: `error: redefinition of '__yo_t60_struct'`
("Generic Future interface for Future[Future](usize) IoExn"). #375's first
run surfaced it (all 9 legs red).

**Mechanism** (`issues/fixed/dyn-async-future-trait-body-emitted-twice.md`):
a dyn method's async Future-trait return type is minted lazily WHILE the
fifth declaration pass renders the dyn vtable; the on-demand hook
(`_on_demand_collect_and_declare`, `src/codegen/codegen_c.yo`) emits its
forward typedef + body, then the pass iteration reaches the same entry and
emits the body again. The defect predates #370/#374 — the prelude shrink
merely re-shifted collection order enough to make a Future-trait arrive
lazily at pass time (the registry-perturbation family).

**The fix shape matters**: the predecessor's shared-set fix was RETRACTED
for renumbering the type table (~1.7k C lines) and flipping async_await +
smoke legs. #377's set is **asymmetric**: `on_demand_body_cnames` is
populated ONLY by the hook with the C names whose bodies IT emits (already
rendered there — no new interning); the declaration passes
(`src/codegen/types/generation.yo`: simple-enum, topological
struct/enum/tuple, nullable-pointer-enum, fifth pass's union/future-trait
arms — the dyn arm deliberately unguarded, the hook never emits dyn bodies)
skip exactly those names. On a healthy tree the set is empty at pass time.

**Proof**: pre-fix and post-fix compilers emit **hash-identical** stage-2 C
for the same input tree (sha256 `b94924bd…`) — the perturbation class is
structurally excluded, and the fixpoint argument is free. dyn 9/9,
async_await 188/188, battery FIXPOINT_HOLDS CLANG_RC=0.

**Lessons, hard-won today**:
1. **`tests/dyn.test.yo` is the canary for any yo_id/prelude-shifting
   change.** #374's local validation (targeted suites + battery + gen-2
   smoke + CLI scorecard) did NOT include the full `tests/` sweep, and the
   battery does not run it either — the dyn batch was only covered by the
   full-suite CI legs. Run it (2 min) after ANY change that renumbers.
2. When doing a byte-identity A/B, **do not edit sources while the baseline
   emit runs** — the module loader reads files over several minutes and my
   first "baseline" silently contained the edits (grep the emitted C for a
   string unique to your edit to detect pollution).
3. This machine killed harness-background builds twice today (cause
   unknown; possibly the peer session or memory pressure). Long builds run
   reliably as `nohup bash -c '... ; echo rc=$?' &> log & disown` + a
   Monitor polling the log for the rc line.

## 4. Immediate queue (in order)

1. **Merge #375 and #376 on green** (runs 33506595533 / 33506618725 were
   in flight when this session ended; both heads include the #377 heal).
2. **#364 / D6 PR-3** (curl→std/http swap, branch `s6/version-cache-std-http`,
   worktree `/private/tmp/yo-d6`): rebase onto post-#376 develop; drop the
   duplicated install-fix commit (those landed via #366); fold in the
   battery-script OpenSSL flags fix (`scripts/bootstrap/fixpoint_only.sh`
   stage-2 clang line + gates_fast equivalent need `pkg-config openssl`
   flags once the COMPILER's own closure carries `__yo_tls_*` — with the
   #376 backend that happens exactly when version_cache starts using
   std/http); verify the strict CLI golden. The wrong-arity compiler hole
   it exposed stays open
   (`issues/wrong-arity-call-silently-accepted-version-install-broken.md`).
3. **v0.2.21**: after the queue lands and develop CI is green on HEAD,
   `gh workflow run release.yml --ref develop -f bump=patch`. Release notes
   MUST say `yo version install` / `yo version list --remote` were broken
   in v0.2.19 and v0.2.20.
4. **Audit tail** (unchanged from the previous handover §5, minus what
   landed): C29 unification arc; arity-validation outside the swallow + the
   async-SM C22-gate equivalent; builtin-shadowing decision; Windows stdin
   pipe WRITES (overlapped named pipes; reads landed in #353);
   `issues/s3-fs-wrappers-windows-semantics-audit.md`; module-level
   control-bound binding hole; polish rows (regex extras, cli typed values
   + std/term adoption, O5 Formatter routing, D5 Dyn(Reader)); the
   systematic registry arc (per-ExprInfo reads at await-future typing
   sites, order-stable intern table — #377 fixed the dyn double-emission
   INSTANCE of that family, the systematic rework is still open).
5. **Timer-free yield** stays seed-gated (new runtime extern to enqueue own
   completion); the `sleep(0)` fix (#375) removes the Linux blocker for a
   granularity-free park as an interim step if wanted.

## 5. Worktrees & binaries inventory (this machine)

| path | branch | state |
| --- | --- | --- |
| `/Users/yiyiwang/Workspace/Yo` | (shared with peer session) | **never checkout branches here**; this doc + the 08-30 handover are untracked files here |
| `/private/tmp/yo-sleep0` | `fix/sleep-zero-timerfd` | = PR #375, pushed |
| `/private/tmp/yo-tls` | `fix/tls-runtime-backend` | = PR #376, pushed |
| `/private/tmp/yo-dedup` | `fix/dyn-on-demand-dedup` | = #377, MERGED — worktree removable |
| `/private/tmp/yo-resweep` | `s7/seed-gated-sweep-reland` | = #374, MERGED — worktree removable |
| `/private/tmp/yo-ecls` | `fix/smoke-yield-gate` | = #373, MERGED — worktree removable |
| `/private/tmp/yo-d6` | `s6/version-cache-std-http` | #364, needs the §4.2 rebase |

Binaries: `/private/tmp/yo-seed-0220/bin/yo` (the SEED, v0.2.20);
`/tmp/yo-dedup2-s1` (develop+#377 stage-1 — the freshest post-heal compiler,
good for local test runs); `/tmp/yo-tls-s1` (PR #376 tree stage-1);
`/tmp/yo-sleep0-s1` (PR #375 tree stage-1). Older `/tmp/yo-*-s1/g1/g2` are
stale — prefer rebuilding over trusting them.

## 6. Standing constraints (unchanged)

- Main checkout is SHARED with a peer Claude session — work in
  `/private/tmp` worktrees, `git -c protocol.file.allow=always submodule
  update --init` after creating one.
- One battery at a time (shared `/tmp/local_*` scratch); one heavy build at
  a time (16 GB machine); S1 must live OUTSIDE the repo.
- `--release` is removed — `--optimize 2`. Always fmt twice then check.
- `yo build` runs under the SEED: std/ + src/ source forms must be correct
  under the seed's bugs; tests/ are not seed-gated.
- CLI diff harness reads `YO_SELF_BIN` (not YO_BIN); after any golden
  re-record, rerun the FULL scorecard.
