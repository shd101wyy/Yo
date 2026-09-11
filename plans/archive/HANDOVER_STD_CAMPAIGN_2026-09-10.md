> **CLOSED 2026-09-11 — superseded by the work it handed over.** This was a
> handover note for the agent picking up the std campaign on the morning of
> 2026-09-11. Everything in §3 and §7.1 has landed, most of §7.2 with it, and
> §7.4's three maintainer decisions were answered the same day
> (`plans/STD_API_STABILIZATION.md` §5). It is kept as a record of that day's
> state, not as live instructions — **the live plan is
> `plans/STD_API_STABILIZATION.md`**, and the campaign's per-step waker status
> is in `plans/WAKER_BASED_SCHEDULING.md`.
>
> **Never committed until now.** It lived as an untracked file in the main
> checkout for a day, one `git clean` from being lost; it is committed here so
> the record survives.
>
> What became of each section:
>
> | section | outcome |
> | --- | --- |
> | §3.1 PR #547 keep-alive framing | **MERGED** |
> | §3.2 PR #548 integer math batteries | **MERGED** — and it absorbed §7.2 item 2, collapsing the ten per-type bit batteries onto `T.BITS` / `T.Unsigned` |
> | §7.1 uncommitted `/private/tmp/yo-conc` work | **LANDED** — `OrderedMap.swap_remove` with its position index, and `race_first`/`any_first` with the loser cleanup |
> | §7.2 item 3 `Stream` trait + `TcpListener.incoming` | **LANDED** (#555, `std/async/stream.yo`) |
> | §7.2 item 4 TOML | **DONE 2026-09-11** — a real parser |
> | §7.2 item 5 HTTP client pool | PR #556, still open (a Linux-only 204 timeout) |
> | §7.2 item 7 module-prefix stutter | 6 of 7 done; `glob_match` deferred to `plans/backlog/MODULE_PREFIX_STUTTER_REMAINDER.md` |
> | §7.2 item 8 `imm` `remove` shape | **ANSWERED** by adding `extract`, not by changing `remove` |
> | §7.2 item 10 waker-based scheduling | steps 1, 3a and 3b landed (#561, #576, #586); step 2 is seed-gated; 4-5 open |
> | §7.4 three maintainer decisions | **DECIDED 2026-09-11** |
>
> Two things in here outlived the campaign and are worth reading on their own:
> §4 (three "Yo has no X" comments that were false, each having already produced
> a workaround) and §9's standing instruction that produced it — *probe before
> working around*.

# Handover — std campaign, 2026-09-10 (evening)

**Status:** CLOSED (see the banner above). Written for the agent taking over
on 2026-09-11. Everything below is measured, not remembered; every claim names
the file, PR or log it came from — and is frozen at its writing date, as
`plans/README.md` says archived numbers are.

> **HISTORICAL:** this file was written into `~/Workspace/Yo` (the main
> checkout), which was then on branch `docs/std-audit-handover-2026-09-06`, 105
> commits behind `origin/develop`, so the note below said not to work in it.
> That checkout was returned to `develop` and brought up to date on 2026-09-11;
> the worktree advice under "How to set up" still stands on its own merits.

---

## 1. Read these first (30 seconds each)

| file | why |
| --- | --- |
| `AGENTS.md` | the workflow rules; they are enforced, not advisory |
| `plans/STD_API_STABILIZATION.md` | THE campaign document. §4b (new, added today) lists every language feature the campaign is blocked on |
| `plans/README.md` | plan taxonomy + the new index of language-feature docs |
| `.github/instructions/testing.instructions.md` | the gate battery, and the new GATE 8 note |

---

## 2. Where the campaign stands

**Phase 4 of 5.** `plans/STD_API_STABILIZATION.md` §6 phasing:

1. P0 memory/UB/deadlock — **DONE**
2. P0 wrong values + cliffs — **DONE**
3. The breaking window — **SHIPPED in v0.2.28**
4. **P1 additive work — IN PROGRESS ← you are here**
5. Freeze — re-run the five measurements per module group

All 18 rows of §3 carry a FIXED/LANDED marker.

### Merged today (this session)

| PR | commit | what |
| --- | --- | --- |
| #544 | `5dcbca9da` | GATE 8 — compiles the Yo programs EMBEDDED in scripts/workflows |
| #545 | `78752b5ea` | `Mutex.try_with_lock`/`is_unlocked`, `Cond.wait_timeout`, `RwLock.try_with_read`/`try_with_write` |
| #546 | `c39ed2246` | `Child` pipes as `Reader`/`Writer` handles; `Watcher` `Dispose` (a use-after-free) |

(Other agents also landed #535, #541, #542 today — the tree moves under you.)

---

## 3. IN FLIGHT — do these first

### 3.1 PR #547 — `std-http-keep-alive` (worktree `/private/tmp/yo-ka`)

**State:** OPEN, MERGEABLE, CI running (13 checks pending, 0 failed at handover).
Rebased onto develop and force-pushed; commit `607ad940a`.

Two things in one PR because writing the second surfaced the first:

- **codegen fix.** `src/codegen/exprs/atom.yo` asked "is this variable captured
  by the current closure?" twice, keyed on DIFFERENT names — the emitter on the
  source token, the early-return guard on `ExprInfo.variable_name`. For a bare
  variable in a cond/match ARM-VALUE position `variable_name` is a spurious
  temp, so the guard said "not captured" and emitted a bare identifier inside a
  closure body → `error: use of undeclared identifier`. Fixed by deleting the
  duplicate: one `_is_captured_here`. Issue +
  repro: `issues/fixed/captured-variable-as-a-cond-arm-value-emits-a-bare-identifier.md`.
- **`std/http/wire.yo`** gains `read_http_message_buffered(…, carry, …)`,
  `Dechunk.Done` carries an `end`, the stopping decision moved into
  `_frame_status`, and `HttpResponse` gains `version`. This is the FRAMING
  prerequisite for keep-alive, not keep-alive itself.

**Local coverage already run and green:** suite 3982/0; the 4 broken capture
shapes verified failing on a pre-fix compiler and passing after; tests/http
{wire 5, server 13, http 35, http_limits 6}; gates_fast failures=0; fixpoint
FIXPOINT_HOLDS. **NOTE those ran BEFORE the rebase**; CI on the rebased branch
is the authority now.

**Next action:** wait for CI green → `gh pr merge 547 --squash --admin` →
**separately** `git push origin --delete std-http-keep-alive`.

### 3.2 PR #548 — `std-integer-math-batteries` (worktree `/private/tmp/yo-num`)

**State:** OPEN but **CONFLICTING** as of handover. Commits `0352099a5`,
`446024ff5`, `9ae444351` (all pushed).

> ⚠️ **A CONFLICTING PR gets NO Actions run at all.** You must rebase before
> any CI runs. See §6.3.

Contents:
- `BITS : u32(N)` as an associated constant on all ten integer types (beside
  `MIN`/`MAX`, and beside `_USIZE_BITS` for `usize`/`isize`).
- The six shifts as ONE blanket impl over `T.BITS`
  (`checked_shl`/`shr`, `wrapping_shl`/`shr`, `overflowing_shl`/`shr`).
- `wrapping_pow`, `overflowing_pow`, `wrapping_div`, `wrapping_rem`,
  `saturating_div`, `overflowing_neg`, `checked_div_euclid`,
  `checked_rem_euclid`, `ilog2`, `ilog10`, `ilog`.
- `unsigned_abs` as ONE blanket impl over a new `UnsignedCounterpart` trait
  with an ASSOCIATED TYPE.
- The five plan docs of §5 below, the new issue of §4.3, and four re-recorded
  cli-case goldens.

**Local coverage run and green on the final tree:** suite 3982/0;
`tests/int_checked_arithmetic` 38/38; gates_fast + `cli-diff-test.sh` full
scorecard `PASS 92 GOLDEN-DIFF 0 NO-GOLDEN 0`; fixpoint **FIXPOINT_HOLDS**.

**Next action:** rebase onto develop (the conflict is `plans/STD_API_STABILIZATION.md`
only — keep BOTH sides in landing order, recipe in §6.3), force-push, wait for
CI, merge, delete branch.

---

## 4. What I corrected rather than implemented — read this before trusting any comment

**Three "Yo has no X" claims in the tree were measured today and are FALSE.**
Each had already cost a per-type workaround.

### 4.1 `T.BITS` — Yo DOES have associated constants
`MIN`/`MAX` are ordinary associated constants declared in an `impl`
(`MIN : u8(0)`), and a blanket body already read `T.MIN`. The bit-battery
banner's claim that a width-dependent method "cannot" be a blanket impl was
wrong. **Landed in #548.**

### 4.2 Associated TYPES work
`docs/en-US/DESIGN.md` specifies `Iterator`/`IntoIterator` with `Item : Type`,
`Self.Item`, `Trait(Item := X)`. A probe confirmed the exact shape needed:

```rust
Unsig :: trait(Unsigned : Type);
impl(i8, Unsig(Unsigned : u8));
impl(generic(T : Type), where(T <: Unsig), T,
  mag : (fn(self : T) -> T.Unsigned)(T.Unsigned(self)));
```

Compiles, runs, correct. An associated type in a RETURN position, supplied
per-type, consumed from a blanket impl, used as a CONSTRUCTOR. **`unsigned_abs`
went from five copies to one in #548.**

**The ten per-type bit batteries (`count_ones`, `leading_zeros`, `rotate_left`,
…) can collapse the same way** — they need the receiver widened through its own
unsigned type, which `T.Unsigned` now names. That is a REFACTOR nobody has
done, not a language limitation. Good next task: contained, deletes ~500 lines,
and the fixpoint's byte-identity gate proves it behaviour-preserving.

### 4.3 `async/channel.try_recv` already returns `Result`
The concurrency STILL-OPEN row said it "still returns `Option(T)`". It returns
`Result(T, TryRecvError)` (`std/async/channel.yo:145`) over the same
`TryRecvError`, and has since #506. Row corrected in the plan.

### 4.4 `JoinHandle` `Dispose` is impossible AND wrong — the ask is answered differently
The plan had two CONTRADICTORY rows. The real motivation (from
`STD_API_STABILIZATION_FINDINGS.md:174`) is that `race`/`any` leave a manual
contract whose losers leak. But:
- `JoinHandle(T)` is a bare copyable `struct(__future : *(T))`, not an `Rc`, and
  `Dispose` is `where(Self <: Rc)`.
- Dropping Yo's async `JoinHandle` DETACHES, exactly as Tokio's does — that is
  what makes fire-and-forget `io.spawn` work. Abort-on-drop is Tokio's opt-in
  `AbortOnDropHandle`, not its default.

So the fix belongs in the combinator. **See §7.1 — this work is written but NOT
committed anywhere.**

### 4.5 A REAL defect found by probing
An associated constant in a TYPE position — `-> Array(u8, T.BYTES)` — silently
resolves to length **0** in the signature while specialized bodies emit the
right widths, producing invalid C. Filed with a repro:
`issues/associated-constant-in-a-type-position-resolves-to-zero.md`,
`issues/repros/associated-constant-as-an-array-length-in-a-return-type.yo`.
Design: `plans/backlog/VALUE_SUBSTITUTION_IN_TYPE_POSITIONS.md`. **Step 1 (make
it an error, not a 0) is small and worth doing on its own.**

---

## 5. Language features the campaign is blocked on — five NEW plan docs

All in `plans/backlog/`, all written today from the blocked call sites, indexed
in `plans/README.md`, cross-referenced from the new **§4b** of
`plans/STD_API_STABILIZATION.md`. They ship in PR #548.

| doc | blocks | note |
| --- | --- | --- |
| `WAKER_BASED_SCHEDULING.md` | waker-based `yield`/async `channel`/async `mutex`; `spawn_blocking` | **the largest remaining std item.** Everything that waits on a PEER polls a 1 ms timer, putting a millisecond floor under every hand-off |
| `MEMBER_VISIBILITY.md` | `_raw_lock`/`_raw_unlock`/`_raw_handle_ptr`; `ctrl`/`data`/`size`; `imm/*` internals | 752 members in `std/` are private by underscore and enforced as public |
| `ASYNC_ITERATION_STREAM.md` | `TcpListener.incoming` | **needs NO compiler change** — pure `std/`. Cheapest of the five |
| `VALUE_SUBSTITUTION_IN_TYPE_POSITIONS.md` | the ten byte conversions; `usize`/`isize` byte conversions at all; `Array(T,N)` `Default` | §4.5's defect |
| `THREAD_LOCAL_STORAGE.md` | `rand.thread_rng` | destruction is the hard part; recommends RC-free types first |

Each doc has: the measured evidence, design options with a recommendation,
an implementation sketch across parser/evaluator/codegen, seed-gating
consequences, an acceptance list, and open questions for the maintainer.

`ErrorChain`/`root_cause` is a sixth blocker but is a compiler DEFECT, not a
missing feature — `issues/self-trait-in-a-return-type-loses-the-trait-on-an-erased-receiver.md`
(#521).

---

## 6. How to set up, and the traps that cost me time today

### 6.1 Worktree setup (never branch in the main checkout)

```bash
cd ~/Workspace/Yo
git fetch origin
git worktree add /private/tmp/yo-<name> -b <branch> origin/develop
cd /private/tmp/yo-<name>
git -c protocol.file.allow=always submodule update --init --recursive   # REQUIRED: fresh worktrees have EMPTY vendor/
```

### 6.2 The local-coverage checklist (the surviving pre-merge rule)

Run in THIS order, ONE heavy job at a time (16 GB machine; a self-build peaks
11–20 GB, and two concurrent ones get OOM-killed mid-flight):

```bash
yo check ./std                     # seed compiler; catches source forms std/ may not use yet
yo build                           # -> yo-out/<target>/bin/yo   (~12 min)
cp yo-out/<target>/bin/yo /tmp/yo-s1-<name>          # S1 MUST live OUTSIDE the repo
YO_STD=$PWD/std ./yo-out/<target>/bin/yo test ./tests --exclude tests/internal --exclude tests/cli-cases
S1=/tmp/yo-s1-<name> P=<p> bash scripts/bootstrap/gates_fast.sh
S1=/tmp/yo-s1-<name> P=<p> bash scripts/bootstrap/fixpoint_only.sh
```

- **Run `yo test` with the TREE-BUILT compiler, never the seed.** The seed lacks
  post-release codegen fixes and manufactures failures.
- The suite must include `tests/dyn.test.yo` — that canary is why the admin-merge
  ban happened once.
- `gates_fast.sh` now has **GATE 8** (new today, #544): it extracts and compiles
  the Yo programs embedded in `scripts/install.sh`, `install.ps1`,
  `install-scripts.yml` and `release.yml`. If you change the language, those
  count as call sites.

### 6.3 Rebasing a PR that conflicts on `plans/STD_API_STABILIZATION.md`

Every std PR appends to that file, so **every PR after the first conflicts**.
This is expected and cheap:

```bash
cd /private/tmp/yo-<name>
git fetch origin && git rebase origin/develop
# The conflict is one region: both sides rewrote the same summary paragraph and
# then each added its own record.
#   -> Keep ONE summary paragraph naming BOTH facts,
#   -> then BOTH records, in landing order (merged-first).
git add plans/STD_API_STABILIZATION.md
git rebase --continue
git push --force-with-lease
```

### 6.4 Merge sequence — NEVER chain the delete

```bash
gh pr view N --json mergeable --jq .mergeable    # must be MERGEABLE, not UNKNOWN/CONFLICTING
gh pr merge N --squash --admin
gh pr view N --json state --jq .state            # must be MERGED
git push origin --delete <branch>                # SEPARATE command, only after MERGED
```

This has bitten twice (#504, #522): a conflicting merge FAILS while a chained
delete still runs, and GitHub then CLOSES the PR.

### 6.5 cli-case goldens track prelude CONTENT

Editing `std/prelude.yo` moves up to four goldens: two print
`check: parsed N top-level exprs`, `lsp-member-definition` reports a line
NUMBER in prelude.yo, `lsp-analysis-resilience` carries the LSP completion
payload size. Re-record and rerun the full scorecard:

```bash
YO_SKILLS=$PWD/.github/skills YO_SELF_BIN=/tmp/yo-s1-<name> \
  scripts/cli-diff-test.sh --record <case> <case> …
YO_SKILLS=$PWD/.github/skills YO_SELF_BIN=/tmp/yo-s1-<name> scripts/cli-diff-test.sh
```

**`YO_SKILLS` is not optional** for an out-of-repo S1: without it,
`skills-install`/`init-existing` fail at rc=1 with "Could not locate bundled
skill files" and you will chase a phantom regression. `gates_fast.sh` exports
it for you; a direct invocation does not.

### 6.6 Traps that cost real time today

- **`-1` cannot be spelled `T(0) - T(1)` in a blanket impl over `Integer`.** On
  an unsigned instantiation that is a comptime overflow and a HARD error
  (`Result -1 exceeds u8 range [0, 255]`), and it fires even from an arm the
  unsigned type would never take. Use the file's idiom:
  `rhs < T(0) && (T(0) - rhs) == T(1)` — the `<` short-circuits first.
- **A tuple RETURN TYPE is `Tuple(A, B)`; `(a, b)` is only the value
  constructor.** `-> (T, bool)` type-checks and then fails oddly.
- **`unwind` is illegal in a test body** (it is inlined into the batch's
  `__yo_user_main`, which has no enclosing function). Use `.unwrap()`.
- **A `ctl` handler cannot be returned from a helper** ("result type cannot be
  control-bound") — each test installs its own `Exception`.
- **A comptime `str` does not coerce to `String`.** `raw == _R1` where `_R1 :: "…"`
  fails to unify; write `String.from(_R1)`.
- **An impl block's own field names are in scope in sibling method bodies, and
  Yo forbids shadowing.** An `fd :` accessor plus a local `fd :=` in another
  method of the same impl is a hard error.
- **A method that calls a trait DEFAULT must be registered in a LATER impl block
  than the trait impl**, or its `io.async` body is hollow at definition time.
- **A test whose oracle is a resource LIMIT is probably vacuous on macOS.** My
  first `Watcher` leak test asserted 200 create-and-drop cycles all succeed
  (Linux caps inotify at 128) and it PASSED with the fix removed, because this
  machine's `RLIMIT_NOFILE` swallowed the leak. The oracle that works on both is
  the DESCRIPTOR NUMBER: open/close a probe file before and after and compare,
  since the kernel hands out the lowest free descriptor.
- **A test that hangs on regression burns a CI job's whole timeout.** Bound it
  with `std/async`'s `timeout` (see `tests/process/command.test.yo`, "dropping a
  ChildStdin closes the pipe": 8s to a clean failure instead of never).

---

## 7. Remaining work, ranked

### 7.1 UNCOMMITTED work you should pick up or discard

**Worktree `/private/tmp/yo-conc`, branch `std-concurrency-small-items`, based
on develop at `ca39b152a`. Nothing is committed. No gates have been run.**

It contains, all `yo fmt`-clean but otherwise unverified:

1. **`OrderedMap.swap_remove`** (`std/collections/ordered_map.yo`) — Rust's
   `IndexMap::swap_remove`. Needed a `_index : HashMap(K, usize)` side table to
   be genuinely O(1) (without it, finding the slot to swap into means scanning
   `_order`, which defeats the purpose). The side table is maintained at the four
   sites that write `_order`: `new`, `insert`, `remove` (rebuilds — that path is
   already O(n)), `clear`. Plus 6 tests in
   `tests/collections/ordered_map.test.yo`, one of which specifically pins that
   the side index stays in step across interleaved operations (a naive
   implementation leaves a stale position after a swap and then removes the
   WRONG slot).
2. **`race_first` / `any_first`** (`std/async/index.yo`, exported) — §4.4's
   answer. They abort **and await** every loser (aborting alone leaves the await
   outstanding, which is the same leak one step later). Plus 4 tests in
   `tests/async/combinators.test.yo`.
3. **Plan corrections** in `plans/STD_API_STABILIZATION.md`: the two
   contradictory `JoinHandle Dispose` rows, the stale `try_recv` row, and the
   `OrderedMap.swap_remove` record.

**To finish it:** run §6.2's checklist, then PR. Expect a
`plans/STD_API_STABILIZATION.md` conflict (§6.3). I never compiled it — treat
every line as unverified.

### 7.2 Actionable std work, in the order I would do it

| # | item | size | notes |
| --- | --- | --- | --- |
| 1 | Finish §7.1 (`swap_remove`, `race_first`/`any_first`) | small | written, unverified |
| 2 | Collapse the ten per-type bit batteries onto `T.Unsigned` | small–medium | newly possible (§4.2); byte-identity provable |
| 3 | `plans/backlog/ASYNC_ITERATION_STREAM.md` — the `Stream` trait + `TcpListener.incoming` | medium | **no compiler change**; `Watcher` already has the shape |
| 4 | TOML: floats, arrays, dates, inline tables, escapes, comments, serializer | medium | mechanical; `std/encoding/toml*` |
| 5 | HTTP keep-alive part 2 — the `HttpClient` pool | medium | framing prerequisite lands in #547; design is in the plan's keep-alive record |
| 6 | `Sender`/`Receiver` split with auto-close on last sender | medium | |
| 7 | Module-prefix stutter (`json_parse` → `json.parse`, 7 sites) | small, wide | a rename sweep — read `yo-rename-sweep-blind-spots` first |
| 8 | `imm` `remove` shape | small | |
| 9 | `VALUE_SUBSTITUTION_IN_TYPE_POSITIONS.md` step 1 (error, not 0) | small | removes a silently-wrong-type class |
| 10 | `WAKER_BASED_SCHEDULING.md` | **large** | the one real engineering piece; do it deliberately, in the doc's five stages |

### 7.3 Blocked, with the reason recorded

- Member visibility (3 rows) → `plans/backlog/MEMBER_VISIBILITY.md`
- `rand.thread_rng` → `plans/backlog/THREAD_LOCAL_STORAGE.md`
- `ErrorChain`/`root_cause` → #521, a compiler defect
- `TcpListener.incoming` → §7.2 item 3 unblocks it
- `JsonValue` integer arms → deliberately deferred to a breaking window
- `Array(T,N)`/`str` `Default` → §4.5 / language gaps

### 7.4 Three MAINTAINER decisions gate the freeze (phase 5)

From `plans/STD_API_STABILIZATION.md` §5 — these need the user, not an agent:

1. `imm/Vec`: implement structural sharing (RRB), or re-document as a flat COW
   array and accept O(n) on shared mutation?
2. `MemoryOrder.Consume`: keep (C11 has it; every compiler promotes it to
   `Acquire`; Rust omits it) or remove?
3. `HashMap.new()` stays deterministic-keyed (the fixpoint gate depends on
   byte-identical emitted C) — ship `with_random_keys()` for programs facing
   untrusted keys?

---

## 8. Live worktrees at handover

| path | branch | state |
| --- | --- | --- |
| `/private/tmp/yo-ka` | `std-http-keep-alive` | PR #547, pushed, CI running. Clean tree |
| `/private/tmp/yo-num` | `std-integer-math-batteries` | PR #548, pushed, **CONFLICTING** — rebase needed. Clean tree |
| `/private/tmp/yo-conc` | `std-concurrency-small-items` | **UNCOMMITTED work** (§7.1). Never compiled |
| `/private/tmp/yo-child`, `/private/tmp/yo-openfix`, `/private/tmp/yo-trylock` | merged branches | safe to `git worktree remove` |

There are ~70 other stale worktrees under `/private/tmp/yo-*` from earlier
sessions. `git worktree list` shows several marked `prunable`;
`git worktree prune` is safe when no battery is running in one.

Logs from this session are in
`/private/tmp/claude-501/-Users-yiyiwang-Workspace-Yo/f6aaabd8-75eb-4960-83b0-c77fe6f58409/scratchpad/`
(`*_suite.log`, `*_gates.log`, `*_fixpoint.log` per branch).

---

## 9. The one standing instruction that shaped today

> "Lets not workaround. For the language features we need to add to Yo, please
> make plan docs in ./plans"

That is why §4 exists. Three of the "Yo has no X" comments in this tree were
false, and each had already produced a per-type workaround that I then deleted.
**Probe before working around** — a 15-line `tmp/probe.yo` compiled with the
tree binary settles it in under a minute, and `plans/backlog/` is where a
genuine gap goes.
