# Handover — std API stabilization, P0 sweep nearly complete (2026-09-06, 17:30 CST)

**For the agent taking over the std campaign.** Written for the 17:30 CST
handover on 2026-09-06; the state below was last refreshed at the time given
in §8. Everything was verified against `origin/develop` at `c733b1a92` (the
merge of #448) unless marked otherwise. This supersedes
`HANDOVER_STD_AUDIT_NEXT.md` for the std campaign; that file's §0 (the
standing goal, the pre-authorizations) still applies verbatim.

---

## 0. The standing goal and the maintainer's standing constraints

> "Finish @plans/HANDOVER_STD_AUDIT_NEXT.md. Document and fix any surfaced bug
> and issue along the way. No workaround is allowed. Feel free to open PRs or
> stacked PRs, and admin merge when needed to save CI cycles."

And, from this session:

> "lets do a thorough audit on our ./std api design and update related docs.
> The goal is to stabilize std apis and make yo battery included. I also would
> like to follow rusts patterns when we can"

Constraints the maintainer stated in this session — follow them exactly:

- **At most 5 concurrent agents** ("eating my usage"). **Do NOT use the
  `Workflow` tool** ("No dont use dynamic workflows for this"). Read and
  implement directly; plain `Agent` fan-out ≤ 5 if you must.
- **Admin merges are pre-authorized** when CI is green
  (`gh pr merge N --squash --admin --delete-branch`). Required checks take
  ~55 min; the wasm and macos-26-intel legs are the slow ones.
- **API-shape decisions are delegated** ("feel free to prioritize tasks and
  adjust the std APIs"); prefer Rust's shape when one exists.
- **Patch releases are pre-authorized**; every breaking std change must be
  called out in the release notes. v0.2.26 is the next one (§6).
- The `gh` token lacks the `workflow` scope, so PRs touching
  `.github/workflows/*` cannot be merged by an agent (#442 is blocked on this).
  The maintainer must run, in their terminal: `! gh auth refresh -h github.com -s workflow`.

The authoritative plan is **`plans/STD_API_STABILIZATION.md`** (merged as
#444). §3 is the P0 list (18 items, each with `file:line`); every fixed item is
marked **FIXED yyyy-mm-dd** in place with its issue record (the marks for items
still in open PRs live on those PR branches and land with them). §2 holds the
decisions D9–D18 (made), §4 the P1 batteries, §5 the maintainer decisions
still needed, §6 the phasing. Raw per-group findings:
`plans/STD_API_STABILIZATION_FINDINGS.md`.

---

## 1. The PR stack — what is open, in which order, and how to land it

Two stacks plus independents. **Before merging a PR whose branch is another
PR's base, retarget the dependent PR to `develop` first** (`gh pr edit N
--base develop`) — GitHub CLOSES a stacked PR when its base branch is deleted
(memory `retarget-stacked-prs-before-base-merge`). Squash-merging a base and
then the dependent is safe: the dependent's net diff is only its own commits.

Stack A (thread/Send), all carry the wasm TZ-gate cherry-pick:

| PR | branch | base | content |
| --- | --- | --- | --- |
| **#449** | `fix/std-p0-path-glob-base64-datetime` | develop | §3 items 8–10: `Path.strip_prefix -> Option` (+ `relative_to` = old node behaviour; compiler callers moved); polynomial glob with `[a-z]`; base64 `InvalidLength`/`InvalidLastSymbol`; `DateTime.now` real zone offset (`localtime_r` / `_localtime64_s`); cheatsheet + skills goldens. Its first run was red on the wasm legs (my `TZ=Asia/Tokyo` test — no zone db on wasm; gated by `0ed3cf707`) and on **`test (macos-latest)`: "Test basic spawn of two futures … counter should be 12 after yield in task2"** — an async test #449 does not touch. Treat as a flake ONLY if the rerun passes it; otherwise it is a real, pre-existing scheduling-order bug to file. |
| **#450** | `fix/std-p0-thread-log-html` | #449 | §3 items 3–5: `Thread` is a `ref` struct with join-once + `Dispose` detaches via NEW runtime fn `__yo_thread_detach`; re-entrant pool submission lock (`__yo_thread_self`); log globals under the mutex; eager html tables; cli-case `thread-join-twice-panics`; cheatsheet + goldens. First run red on the wasm legs for the same TZ test — the gate was cherry-picked (`da32fb57d`). |
| **#451** | `fix/std-p0-send-enforcement` | #450 | §3 item 2: **`Send` enforced at spawn boundaries** — `validate_capture_trait_requirements` is the faithful TS port, called from both closure routes; rejection routed through `flag_flow_violation` (def-eval swallow); a captured CLOSURE is judged by ITS captures (`_capture_judgement_type` resolves the `Impl(Fn)` wrapper to the concrete capture struct). Full fast suite: 3561 passed / 0 failed under a stage-1 with it. Gate cherry-picked (`7af469648`). |

Stack B (independent of A, based on develop):

| PR | branch | base | content |
| --- | --- | --- | --- |
| **#452** | `fix/std-p0-btree-insert-child-kill` | develop | §3 items 16–17: `BTreeMap.insert -> Option(V)` (replaced value), push `Result`s guarded in `BTreeMap`/`PriorityQueue`; `Child.kill(signum, exn)` throws `IoError` via `IoError.check`. Its first run failed BOTH Windows legs on my new ESRCH test (spawns `/bin/sleep`, no Windows guard) — guarded in `bdbb4d794`, cherry-picked into #453 (`3a9ee6008`) and #454 (`9209ed6dc`) so the stack never reverts it. |
| **#453** | `fix/std-p0-http-server-resilience` | #452 | §3 item 18: `read_http_message` returns `Result(String, HttpError)` (D13); `serve_once` answers 413/400 and keeps serving; `## Stability: unstable` on `http/server`; two codegen shapes recorded (below). |
| **#454** | `fix/std-p0-http-parse-error` | #453 | §3 item 15, HTTP half: `parse_request`/`parse_response` return `Result(_, HttpParseError)` (variants carry the offending text; `to_string` keeps today's messages). Also carries the SIGSEGV addendum + reproducer for the `unwind`-inside-`io.async` issue. |

Other open PRs:

| PR | what | blocker / next |
| --- | --- | --- |
| **#442** | D6 step 1: Schannel TLS backend compiles+links on Windows (suites still skipped). 32/32 green. | `workflow` scope — maintainer refreshes the token, then `gh pr merge 442 --squash --admin` |
| **#443** | D6 step 2 (diagnostic), base = #442's branch: `tls.test.yo` un-gated, `http.test.yo` re-gated, FOUR bisecting probes in `tests/net/tcp.test.yo`. See §5. | read its Windows legs' verdict |
| **#441** | issue doc: `json_parse` accepts trailing content. Green. | merge or fold into a fix |

Merged this session (all in develop): #437 (unit is a true ZST — **breaking**:
`sizeof(unit)` 0 again), #444 (plan), #445 (imm/vec), #446 (net), #447
(Writer/Rng/derive pins), #448 (hash tombstones / retain / html_decode);
earlier #440, #434, #436, #438.

---

## 2. Work in progress — none uncommitted

Every change made this session is committed and pushed on one of the branches
above. The working tree on `fix/std-p0-http-server-resilience` holds only
two untracked docs, this file and `plans/RELEASE_NOTES_v0.2.26_DRAFT.md` —
commit them to develop (a docs-only PR is fine to admin-merge).

Nine worktrees under `/private/tmp/yo-*` were used for the stacked branches
and D6; `git worktree list` shows them. They are disposable
(`git worktree remove <path>`).

---

## 3. Binaries, commands, and the rules that bit this session

**Binaries** (all in `/tmp`, all built from this tree; they vanish on reboot —
rebuild with `yo build --std-path ./std`, ~10 min, output
`yo-out/aarch64-apple-darwin/bin/yo`):

| path | contents | use for |
| --- | --- | --- |
| PATH `yo` | v0.2.25 seed | `yo build` ONLY. Never for std tests: its bundled std and evaluator lag the tree |
| `/tmp/yo-zst5` | develop stage-1 before the thread changes | anything not touching threads |
| `/tmp/yo-thr` | + `__yo_thread_detach` (#450) | thread tests |
| `/tmp/yo-send3` | + Send enforcement with re-raise + closure resolver (#451) — **the current head** | everything |
| `/tmp/yo-d6bin` | develop + the D6 `AcceptEx` runtime (built from `/private/tmp/yo-d6`) | Windows cross-emits of the D6 fix |
| `/tmp/yo-send`, `/tmp/yo-send2` | intermediate Send builds | do not use |

**Commands:**

```bash
/tmp/yo-send3 check ./std --std-path ./std        # evaluator-only; async-codegen rules are NOT checked here
/tmp/yo-send3 check ./src --std-path ./std
/tmp/yo-send3 test ./tests/X.test.yo --std-path ./std --parallel 1 -v &> out.txt
/tmp/yo-send3 test ./tests --exclude tests/internal --exclude tests/cli-cases --std-path ./std   # ~35 min, 3561 tests
find tests -name '.yo_selftest_batch_*' -delete   # stray batch files after a killed run
# cli-case goldens — YO_SKILLS is MANDATORY for a binary outside the checkout
YO_SKILLS=$PWD/.github/skills YO_SELF_BIN=/tmp/yo-send3 bash scripts/cli-diff-test.sh --record <case>
# Windows gate for emitted C (~1 min instead of a 50-min leg)
/tmp/yo-send3 compile tmp/fixme.yo --std-path ./std --target x86_64-pc-windows-msvc --emit-c --skip-c-compiler --optimize 2 -o /tmp/x
zig cc -target x86_64-windows-gnu -c /tmp/x.c -o /tmp/x.o -Wno-everything -Wincompatible-pointer-types -Wint-conversion -Wimplicit-function-declaration -Werror=return-type
# find the error a def-eval trial swallowed
YO_DEBUG_SWALLOW=1 /tmp/yo-send3 check <file> --std-path ./std 2>&1 | grep -a "\[swallow\]"
```

**Rules learned the hard way this session** (all in
`.github/skills/yo-syntax/syntax-cheatsheet.md` or memory; the cheatsheet
edits live on the branches that made them):

- `__yo_panic` takes the ENCLOSING FUNCTION's return type: make it the
  `cond`'s VALUE with the real body in the `true =>` arm (std/rand.yo).
- A `c_include` opaque struct type (`tm : Type`) is emitted as bare `tm` in C;
  type such pointers as `*(void)`. MSVC's `localtime_s` has REVERSED
  arguments vs C11 Annex K — never call the Annex-K binding on Windows.
- `extern("Yo", …)` runtime symbols come from DIFFERENT preambles:
  `__yo_get_thread_id` is async-core-only (absent without `io`);
  `__yo_thread_self()` is always present. Probe new std→runtime dependencies
  with a `main` that has NO `io`.
- **No mid-loop `return(...)` inside an `io.async` body** — `check` is clean,
  codegen dies with "this io.async closure's body was never fully evaluated".
  Record the outcome in a local, end the loop, produce the value in the tail.
- **No `io.await` inside a `match` scrutinee in an async body** — the value
  comes back empty. Hoist it into a binding first.
- **`unwind` from an `Exception` handler installed INSIDE an `io.async` body
  is memory-unsafe**: one frame shape exits 0 in silence, another SIGSEGVs
  (`issues/unwind-from-a-handler-installed-inside-io-async-exits-main-with-rc-0.md`,
  reproducer `issues/repros/unwind-inside-io-async-helper-sigsegv.yo`). The
  runtime's "main future Aborted → panic" path is NOT what fires; the emitted
  C unwinds to the wrong frame. Recommended: make the evaluator REJECT an
  unwinding `ctl` bound inside an `io.async` body first, then design the
  semantics. Until then there is no way to catch an error inside an async
  body — use D13's shape (a `Result`-returning core).
- A local `(fn(...) -> T)(body)` literal cannot capture enclosing locals.
- Backtick literals cannot be nested inside `${…}` — hoist to a local.
- `{ expr }` without a semicolon is a struct literal (E0007): `io => ()`, not
  `io => { () }`.
- A def-eval rejection you add to the evaluator must go through
  `flag_flow_violation` before the throw or the trial wall swallows it.
- The Send check is over CAPTURES: a module-level binding is a global, not a
  capture — regression tests must make the offending value a function local.
- Editing ANYTHING under `.github/skills/` reds the tier-1 CLI gate until
  `skills-install` / `skills-install-zh` are re-recorded WITH `YO_SKILLS` set
  (without it the record "succeeds" and writes goldens of the failure).
- Don't edit `src/`/`std/` while a build or a test run is in flight; two
  `yo test` runs over `tests/` collide on `.yo_selftest_batch_*` files.
- A test that spawns `/bin/sleep` or any POSIX binary needs the file's
  Windows guard (`if(platform == Platform.Windows, { return(()); });`) — the
  Windows legs run `tests/process` too.
- A PR whose branch still carries commits that were squash-merged elsewhere
  turns `mergeable=CONFLICTING` and GitHub then runs NO Actions for any push to
  it (no run, no check-suite, an empty-commit push changes nothing). Rebase the
  branch onto develop (git drops the upstream patches), force-push with
  `--force-with-lease`, then re-stack the dependents on the new base.
- `sed -n "…" $f` with an EMPTY `$f` reads stdin and hangs a script forever.

---

## 4. §3 P0 scoreboard (plans/STD_API_STABILIZATION.md)

| item | subject | status |
| --- | --- | --- |
| 1 | `imm/vec` leaks / drop-of-uninit; `Deque`/`vec` C35 guards | MERGED #445 |
| 2 | `Send` not enforced at spawn | PR #451 |
| 3 | pool `spawn` self-deadlock in inline fallback | PR #450 |
| 4 | `Thread.join` re-callable, no Dispose | PR #450 (new runtime fn `__yo_thread_detach`) |
| 5 | html lazy-init race; log globals raced | PR #450 |
| 6 | `IpAddr.parse_v4` octets | MERGED #446 |
| 7 | `UdpSocket.bind` echoes arg; no `connect` | MERGED #446 |
| 8 | `Path.strip_prefix` was node's relative | PR #449 |
| 9 | `DateTime.now` returned UTC | PR #449 |
| 10 | base64 tails; glob ranges + exponential `*` | PR #449 |
| 11 | derive fallbacks (WITHDRAWN — builtin guard already rejects); `Rng.range(x,x)` SIGFPE | MERGED #447 |
| 12 | `Writer.to_string` aliases buffer | MERGED #447 |
| 13 | hash tombstones never reclaimed | MERGED #448 |
| 14 | `html_decode` O(n²); `retain` O(n²) | MERGED #448 |
| 15 | `Result(_, String)` in `env.cwd/current_exe/chdir` and `http.parse_request/parse_response` | http half: PR #454. **env half TODO** — the only P0 work left: 48 compiler call sites match on `env`'s `Result(_, String)` (`grep -rn "cwd()\|current_exe()\|chdir(" src/`); do it in the v0.2.27 breaking window per §6 |
| 16 | `BTreeMap.insert -> unit`; push `Result`s discarded | PR #452 |
| 17 | `Child.kill -> i32` errno | PR #452 |
| 18 | one malformed request kills `HttpServer.serve`; no `## Stability` | PR #453 (peer-reset I/O errors still propagate — needs the catch primitive) |

After 15: §2's D9–D18 decisions that change signatures (infallible `push` +
`try_push`, `replace` = all, max-heap `PriorityQueue`, `FromStr -> Result`,
`Debug` split from `ToString`, `HashSet := HashMap(T, unit)`, stable `sort`,
`timeout -> Result`) — one release window (v0.2.27 per §6). Then §4 P1
batteries module by module (`## Stability` marker on every module). §5 lists
the maintainer decisions still pending (Box name, `imm/Vec` structure,
`MemoryOrder.Consume`, HashMap random keys) — ask, don't guess.

Also filed today: `issues/yield-resumption-order-differs-on-macos-latest-ci.md`
(the "Test basic spawn of two futures" failure on #449's first run — CI-only so
far, 3/3 green locally; correlate with #449's rerun).

Held for later (not P0): #433 (dyn trait check), #420 (`comptime_assert` in fn
bodies — 1559 dormant assertions), #441 (json trailing junk),
`issues/type-impls-reports-true-for-a-blanket-impl-whose-where-clause-fails.md`
(soundness; gates full `Send` enforcement for pointers/arrays),
`issues/unwind-from-a-handler-installed-inside-io-async-exits-main-with-rc-0.md`
(runtime: rc 0 on an aborted main future; language: no catch inside async),
`issues/unit-zst-residual-gaps.md`,
`issues/equality-operator-without-an-eq-impl-evaluates-to-unit.md`.

---

## 5. D6 — Windows TLS (Schannel) re-land — ROOT CAUSE FOUND, FIX PUSHED

Record: `issues/d6-schannel-hangs-the-windows-test-legs-for-four-hours.md`
(read its "Root cause" section). Plan: `plans/D6_TLS_PLAN.md`. Worktree
`/private/tmp/yo-d6`, branch `d6/step2-unskip` (PR #443, base = #442's branch).

**Root cause.** `__yo_async_accept_start` in
`src/codegen/async/runtime_io_windows.yo` was a plain BLOCKING `accept()` on
the event-loop thread (and `connect_start` a blocking `connect()`). A server
task that awaits `accept` before the client on the same loop has connected
blocks the whole loop forever. Every pre-existing TCP test connects first, so
nothing noticed; the redirect test and the round-2 probe spawn the server
first. Both Windows legs hung identically. The Schannel code was never at
fault.

**Fix (on `d6/step2-unskip`, last commits of this session):** an overlapped
`AcceptEx` path — extension pointers via `WSAIoctl(SIO_GET_EXTENSION_FUNCTION_POINTER)`
(`<mswsock.h>` typedefs only, NO new import library, so the four Windows
link-flag sites are untouched), an `is_accept` overlapped record, completion
does `SO_UPDATE_ACCEPT_CONTEXT` + `GetAcceptExSockaddrs` + IOCP association;
blocking `accept()` kept only as the no-extension fallback. `check ./src`
clean; the emitted C was gated with `zig cc -target x86_64-windows-gnu` and
`aarch64-windows-gnu` (see §8 for whether that finished). `http.test.yo` is
un-gated again in the same push so the Windows legs test the real redirect
test; `server.test.yo` is still `SkipWindows` — un-gate it next.

**What to read next:** #443's Windows legs on the new head. A pass (~30 min
legs) means D6 is done: un-gate `server.test.yo`, merge #442 (needs the token
scope) then #443 (retarget to develop first), ship in v0.2.26. A failure now
shows as a test failure with the probes' stderr progress lines, not a hang.
Follow-up in the same class: `__yo_async_connect_start` is still a blocking
`connect()` (harmless on loopback) — `ConnectEx` is the proper form.

---

## 6. v0.2.26 release

Draft notes: **`plans/RELEASE_NOTES_v0.2.26_DRAFT.md`** (update it). Breaking
entries to call out: `sizeof(unit)` is 0 again (was 1 in v0.2.25; all-unit
aggregates are 1 byte, MSVC gives empty aggregates 4); `Path.strip_prefix ->
Option` (old behaviour is `relative_to`); `Thread` is a ref type with join-once
+ detach-on-drop; `base64_decode` rejects non-canonical input (`EncodingError`
gained `InvalidLength`/`InvalidLastSymbol`); `Rng.range` panics on empty
ranges; `Writer.to_string` resets the writer; `DateTime.now` is really local;
`BTreeMap.insert` returns `Option(V)`; `Child.kill` takes `exn` and throws;
`read_http_message` returns `Result`; `Send` is enforced at spawn boundaries
(a spawn closure capturing an `ArrayList`/`String`/`ref(struct)` is now a
compile error — wrap in `Arc`/`Iso`).

Mechanics (memory `draft-release-patch-resets-tag-name`): the release workflow
creates a DRAFT, `publish-release` flips it public; a body-only PATCH on a
draft resets `tag_name` to `untagged-…` — always send `tag_name` too and
re-read before publishing. The release gate must see ≥3 real `test (…)` legs.
SEED_VERSION bumps on develop after the release.

---

## 7. Background monitors / tasks at handover

All monitors and background jobs of this session are stopped at 17:30. Nothing
depends on them; the states above were read from GitHub directly. Re-arm what
you need with `gh pr checks N --json name,bucket`.

---

## 8. Live state at 17:30

_(filled in at handover time — see the bottom of this file)_
