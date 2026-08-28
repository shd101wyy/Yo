# STD_API_AUDIT — handover

**Written 2026-08-26.** Hand-off of the `plans/STD_API_AUDIT.md` campaign. Read
this file, then `plans/STD_API_AUDIT.md` (the audit itself) and
`plans/STD_API_AUDIT_D4_PLAN.md` (the string-indexing sub-plan, which is the
only large piece still in flight).

---

## 0. WHERE THIS STANDS — updated 2026-08-27 (end of the CI-repair day)

**S3 P0 item 6 is merged and develop is green again.** PR **#309**
(`07072ec3c`) landed the async combinators + `std/async/channel` + `std/async/mutex`
along with the five CI reds that had kept develop red since 2026-08-25 (C28's
effect-argument memcpy being the big one). Run 33083020070: 26/26.

**Release gating (user instruction, 2026-08-27):** a new patch release requires
**develop's own** test.yml run to be green — the PR run passing is not
sufficient. So the order is: merge → watch develop's push run → dispatch
`release.yml` with `bump=patch` (that workflow checks out develop itself and
auto-bumps the three `SEED_VERSION` pins). v0.2.18 is what unblocks every
seed-gated item below (§3.5, and the bufio consumer migration in §3.2).

**In flight on branch `std/api-truthfulness`** (off `07072ec3c`, not yet pushed —
battery running): the dead-public-surface audit that item 6 prompted, plus the
four bugs it found. See §2b.

The main worktree is on `develop`.

---

## 1. The battery — the gate every `.yo`-touching change must pass

There is no shared script in the repo; this is the one that was used for every
merge below. Write it to a scratch path, set the two paths at the top, run it
detached, and read `/tmp/<P>.log`.

```bash
#!/bin/bash
W=/private/tmp/yo-integ            # integration worktree
P=local                            # prefix for /tmp artefacts
cd "$W" || exit 2
export YO_STD="$W/std"
echo "check std + src"
yo check ./std > /tmp/${P}_cstd.txt 2>&1; echo "check std rc=$? ($(tail -1 /tmp/${P}_cstd.txt))"
yo check ./src > /tmp/${P}_csrc.txt 2>&1; echo "check src rc=$? ($(tail -1 /tmp/${P}_csrc.txt))"
echo "build"
yo build > /tmp/${P}_build.txt 2>&1; rc=$?; echo "build rc=$rc"
[ $rc -ne 0 ] && { tail -8 /tmp/${P}_build.txt; exit 1; }
unset YO_STD
S1=$PWD/yo-out/aarch64-macos/bin/yo
# FRESH-BINARY check: the seed `yo check` above lacks any evaluator gate the
# change itself introduces (2026-08-27 lesson: the io.await effect-bundle
# contract check only exists in the BUILT compiler — seed-check green told
# us nothing about the tree's own violations).
YO_STD=$PWD/std "$S1" check ./std > /tmp/${P}_fcstd.txt 2>&1; echo "fresh check std rc=$? ($(tail -1 /tmp/${P}_fcstd.txt))"
YO_STD=$PWD/std "$S1" check ./src > /tmp/${P}_fcsrc.txt 2>&1; echo "fresh check src rc=$? ($(tail -1 /tmp/${P}_fcsrc.txt))"
echo "full suite"
"$S1" test ./tests --exclude tests/internal --exclude tests/cli-cases --bail --disable-sanitize > /tmp/${P}_suite.txt 2>&1
echo "suite rc=$? :: $(tail -3 /tmp/${P}_suite.txt | tr '\n' ' ')"
install -m 755 "$S1" /tmp/yo-${P}bin
echo "goldens + scorecard"
YO_SELF_BIN=/tmp/yo-${P}bin scripts/cli-diff-test.sh --record > /tmp/${P}_rec.txt 2>&1
echo "record rc=$? :: $(tail -2 /tmp/${P}_rec.txt | tr '\n' ' ')"
echo "GOLDEN DRIFT (stage ALL before merge):"; git status --short | sed 's/^/    /'; echo "END GOLDEN DRIFT"
YO_SELF_BIN=/tmp/yo-${P}bin scripts/cli-diff-test.sh > /tmp/${P}_score.txt 2>&1
echo "scorecard rc=$? :: $(tail -2 /tmp/${P}_score.txt | tr '\n' ' ')"
echo "gates";     S1=/tmp/yo-${P}bin P=$P bash scripts/bootstrap/gates_fast.sh    > /tmp/${P}_gates.txt 2>&1; echo "gates rc=$? :: $(tail -2 /tmp/${P}_gates.txt | tr '\n' ' ')"
echo "fixpoint";  S1=/tmp/yo-${P}bin P=$P bash scripts/bootstrap/fixpoint_only.sh > /tmp/${P}_fix.txt   2>&1; echo "fixpoint rc=$? :: $(grep -E 'STAGE3_RC|FIXPOINT|hollow' /tmp/${P}_fix.txt | tr '\n' ' ')"
echo "hollow";    BIN=/tmp/yo-${P}bin OUT=/tmp/${P}_hsweep bash scripts/bootstrap/hollow_sweep69.sh > /tmp/${P}_hollow.txt 2>&1; echo "hollow rc=$? :: $(tail -2 /tmp/${P}_hollow.txt | tr '\n' ' ')"
echo "DONE"
```

Roughly 90 minutes on a Mac Mini M4. **Never run two batteries at once** — 16 GB
is not enough and the swapping manufactures failures that do not reproduce.

Green means: `check` both green, `build rc=0`, suite `N passed / N total`,
scorecard `PASS 52 GOLDEN-DIFF 0 NO-GOLDEN 0`, gates `failures=0`, fixpoint
`stage2 hollow=0 STAGE3_RC=0 FIXPOINT_HOLDS`, hollow `SWEEP_GATE_OK`.

**Golden drift is normal and must be committed**, not reverted — but only after
the *full* scorecard passes over the re-recorded set. A drift line that is only
a type-id renumbering is expected whenever declarations are added or removed;
confirm that by normalising the ids before believing it.

---

## 2. What is DONE (merged 2026-08-25/26, PRs #269–#289)

S0 correctness, S1 (D1–D3 conventions + prelude traits), and **almost all of S2**:

| audit section | state |
| --- | --- |
| §5 the rename sweep | **DONE** (chunks 1–4, plus sleep/Duration) |
| §6 deletions, rounds 1 and 2 | **DONE** |
| D1 error styles, D2 naming, D3 prelude traits | **DONE** |
| D7 sync/concurrency | **DONE** (#287) |
| D8 module layout | **DONE** (#283, #286) |
| **D4 string indexing** | PRs 0–8 ALL MERGED (#286, #288, #290, #291, #292 — incl. the Rust-shape amendment); only PR 9 (decoder dedup, vendor-gated) open |
| **D5 async io traits** | slice 1 MERGED (#293); slice 2 unblocked by #294/#295 except generic wrappers — see §3.2 |
| D6 TLS | untouched, decided (O2) |

---

## 3. What is LEFT

### 3.1 D4 — PRs 4–8 ALL DONE 2026-08-26; only PR 9 remains — `plans/STD_API_AUDIT_D4_PLAN.md` §4 has the full table

| PR | content | note |
| --- | --- | --- |
| ~~4~~ **DONE 2026-08-26** | `imm.String`: `len()` → bytes O(1), `at()` byte-indexed | deviation: `bytes_len()` DELETED (measured dead), not aliased; imm_string tests 34→44 with an 8-test red-first split |
| ~~5~~ **DONE 2026-08-26** | `imm.String` → `ImmString` rename | also renamed the iterators (`ImmStringChars`/`ImmStringCharIndices`); four consumer test files, not three |
| ~~6~~ **DONE 2026-08-26** | ~~Regex: delete `_byte_to_char_index` and the three char→byte re-walks; `RegexMatch.index()` becomes a byte index~~ | landed on `s2/d4-pr6-regex` — SIX walks deleted, not four (the `` $` ``/`$'` replacement arms re-walked too, and the third listed site was `split`, not `replace_all_fn`); regex suite 156→166 with 5 tests that fail against the pre-PR6 std; corrections recorded in the D4 plan §4 row 6 + §5.3. **Release note still owed at release time**: `RegexMatch.index()` / `Regex.search` now return BYTE offsets |
| ~~7~~ **DONE 2026-08-26** | Comptime basis (O1c) — aligned to bytes; `s(i)` yields the rune starting at byte `i` (result-type split vs runtime `u8` kept deliberately); mid-rune offsets are compile errors | seed-safety re-measured STRONGER: `std/`+`src/`+`build.yo` have ZERO comptime string len/slice/index call sites |
| ~~8~~ **DONE 2026-08-26** | Docs + skills sweep, `docs/{en-US,zh-CN}` both — new `STRINGS.md` pages; rune-count idiom documented as `s.chars().count()` per the newer no-char-indexed-slicing decision (`char_len`/`char_substring`/`truncate_chars` deprecated pending removal) | see the §4 PR 8 row in the D4 plan |
| 9 | Dedup the remaining hand-rolled UTF-8 decoders onto `std/encoding/utf8.yo` | includes `vendor/markdown_yo`, which needs **companion upstream commits + a pointer bump** |

Not done and explicitly deferred by PR 3: **the UTF-16 half of §5.4** (LSP's
position encoding). It is protocol-visible, wants a `positionEncoding`
capability, and is a pre-existing defect unrelated to `String`'s basis. The
rune⟷byte helpers PR 3 added to `src/lsp/protocol.yo` are the seam to build it
on.

### 3.2 D5 — async `Reader`/`Writer` traits — SLICE 1 LANDED 2026-08-26

Slice 1 (traits + stdio + File/TcpStream impls + the usize/IoExn unification)
merged as #293; slice 2 (the `read_to_end`/`read_to_string`/`write_all`
defaults, `copy`, `IoError.InvalidData`/`WriteZero`, validating
`File.read_to_string`) LANDED 2026-08-26 after #294/#295 unblocked it — C25
(the unit tail await) was found and fixed en route. The loop-await issue is
FIXED on all three facets, C21 is FIXED (both layers) and the generic
wrappers LANDED 2026-08-27 (`std/io/bufio.yo`, 11 tests) — fixing C26 (the
silent `=`-assign await no-op) en route. Remaining: the compiler's
`std/sys/bufio` consumers migrate (SEED-GATED, see
plans/backlog/SEED_VERSION_AUTOMATION.md) and C17 blocks only the
`Dyn(Reader)` spelling. Full current state: `plans/STD_API_AUDIT.md` §D5.

### 3.3 §7 additions — S3 (P0) and S4 (P1)

Untouched, and much larger than everything above combined. Ranked list is in
`plans/STD_API_AUDIT.md` §7. P0: percent-encoding, `std/encoding/utf8` *(done)*,
the io redesign *(= D5)*, `fs.copy`/`remove_dir_all`/`read_link`/
`set_permissions`/`try_exists`, `process.Child`/`spawn`/`Stdio`, async
combinators + async channel/mutex + `timeout`, crypto (HMAC, SHA-1, SHA-512,
CRC32, `Digest`) + `std/rand`, `Duration` integration, `net.UnixStream`.

### 3.4 S5 — the stability freeze

Stable/unstable markers in `yo doc` output, additive-only policy written into
`.github/instructions/yo-design.instructions.md`.

### 3.5 Known seed-gated item

`std/time/sleep.yo`'s `sleep_blocking` keeps a two-statement body **only**
because `yo build` compiles `std/`+`src/` with the SEED, which predates the
inline-alias codegen fix. Collapsing it to the natural one-expression form fails
the bootstrap LOUDLY (clang rejects the seed's output), so just retry it at each
seed bump. Parked in `plans/backlog/SEED_VERSION_AUTOMATION.md` with the three
other generation-gated follow-ups.

---

## 2b. The dead-surface audit — 2026-08-27, branch `std/api-truthfulness`

Item 6's own `HttpError.Timeout` question turned into a scripted sweep of the
public surface, which found four defects. Two were memory-safety or
silently-wrong-value bugs, and both are FIXED with tests; the ledger rows are
C32–C35 in `plans/STD_API_AUDIT.md` §2.

| row | what | state |
| --- | --- | --- |
| C32 | `ThreadPool` queued work to a worker with no OS thread, so `join_all` blocked forever (a CI leg spun **3.4 h**); `Thread.spawn` swallowed the same failure and leaked its captures | **FIXED** — both spawn paths run the task inline; the WASI test skip #309 shipped is removed and vacuity-probed |
| C33 | `HttpError.{Timeout,TooManyRedirects,ResponseTooLarge}` are documented and never produced — no deadline, no redirect cap, no size ceiling anywhere in the request path | **OPEN**, with the implementation shape and the C22 constraint on the timeout recorded in the issue |
| C34 | `json_parse` validated NO number: `1.`, `1e`, `01`, `+1` all parsed, and any non-empty garbage (`"hello"`, `"<html>"`) came back as the number **0** | **FIXED** — RFC 8259 §6 grammar, 3 tests (2 red-first) |
| C35 | every collection multiplied `sizeof(T) * count` unchecked: `with_capacity(2^61)` for `u64` asked malloc for 0 bytes and pushed outside it; `ensure_total_capacity` spun forever | **FIXED** — guards via `size_would_overflow` (which shipped exported and unused), new tests/allocator.test.yo |

The method is worth reusing: script the audit rather than reading files. Both
sweeps are one-off Python in the scratchpad — enumerate every `enum(...)` /
`export(...)` in `std/`, then grep the tree for producers. Two rules make the
output trustworthy: count BARE `.Variant` production (a unit variant is
constructed without parens or a type prefix, which a naive grep misses), and
separate library-produced ERROR variants (lies) from user-supplied INPUT
variants like `Optimize.ReleaseFast` (not lies). §9's S5 entry carries both
measurements.

---

## 4. Bugs found and fixed during the campaign (for context on what to expect)

Every batch surfaced at least one real compiler bug. All are in `issues/fixed/`:

- **inline-builtin wrappers re-emitted with the CALLER's arguments** — a wrapper
  whose body is one inline-builtin call had its own argument expressions
  discarded. Measured 202 ms for a requested 100 ms.
- **`void* tmp = <void call>` at `R = unit`** — `Mutex.with_lock((v) => { … })`,
  the flagship std/sync form, did not C-compile.
- **a trait `?=` default evaluated under the impl block's ambient `EvalContext`**
  instead of a function-body one, so `io.async` could not bind its effect
  generic and the body hollowed. This was D5's blocker.
- **`yo test --std-path` dropped for the batch compile** — the runner honoured
  the flag, the spawned child did not.
- **release builds discarded every C diagnostic** (`-w` is absolute in clang).
- **`RwLock.write_unlock` never woke blocked readers.**
- **the hollow detector was line-anchored**, so mid-line markers scored clean.
- **`count-transpile-failures.sh` scored a MISSING file as `0 real`, exit 0** —
  and `fixpoint_only.sh` gates on that exit code.

`issues/` root still has **83 open** docs. Ones most likely to bite this work:
`fmt-not-idempotent-call-wrapped-match-in-block.md`,
`ftt-stub-in-live-closure-falls-off-non-void-function.md` (partially fixed; the
`unit`-returning residue is described concretely enough to act on),
`closure-nested-inside-io-async-closure-body-emits-abort-stub.md`.
(`generic-implementor-async-method-awaiting-self-emits-uncompilable-c.md` —
C23 — was FIXED 2026-08-26 and moved to `issues/fixed/`.)

---

## 5. Traps that cost real time — read before measuring anything

- **`yo check` has four blind spots**: macro `quote(...)` bodies, generic
  trait-impl bodies, generic helpers in the defining module, and **async closure
  bodies** (`io.async((e) => …)`) — the last fails SILENTLY. A green `check`
  proves nothing about those. Compile to C and read it.
- **`yo fmt` is NOT a syntax gate.** `{ single_expr }` with no trailing
  semicolon is a STRUCT LITERAL, and fmt pretty-prints it happily. It is also
  **not idempotent** — a `match` wrapped in a call inside a brace block needs two
  passes, so `yo fmt f.yo && yo fmt --check f.yo` fails on a file just
  formatted. Run fmt twice, then `yo check <file>`.
- **In a worktree, always pass `YO_STD=<worktree>/std`.** Without it `yo check`
  silently validates against the INSTALLED std. And `yo test --std-path` is
  fixed in-tree but **a released `yo` on PATH still drops it** — D4 PR 3 lost a
  full run to a vacuous `253/253` that way. Prefer `YO_STD` for `yo test`.
- **"The suite is green" ≠ "this file is green."** Batch composition changes
  behaviour; measured twice. Run the specific file too.
- **Byte-identity of emitted C is NOT a usable gate for `std/` source
  additions.** Generated identifiers embed a global declaration counter, so
  adding declarations shifts every later id by a uniform amount — measured
  +1004, including in files never touched. It remains the right gate for
  `src/codegen/` edits where the `.yo` source is unchanged. For `std/` changes,
  A/B the two trees with `--std-path` against a behavioural probe and diff the
  program's OUTPUT (recipe in `STD_API_AUDIT_D4_PLAN.md` §6.1).
- **`count-transpile-failures.sh` is structurally blind to the abort-stub
  class.** Since #275 an untranspilable body in a value-returning function
  carries no marker — it becomes `abort()`. The script prints a stub count
  separately; read it whenever "0 real" is the claim.
- **A `-O0` binary that SIGSEGVs on deep recursion is stack exhaustion**, not
  heap corruption. Use `--release`, or `YO_MAIN_STACK_MB=4096`.
- **Comptime-folded assertions pass vacuously.** Read values from a mutable
  local so the assertion runs at RUNTIME.

---

## 6. The working method that actually caught things

Every batch ran as: **N implementation agents in parallel worktrees → one
skeptical reviewer per branch → merge all branches into one integration branch →
ONE shared battery → PR → admin-merge.**

The review pass earned its cost every single time. It refuted a central claim in
four of five batches, and its two most valuable findings were things no battery
could have caught:

- the `void* tmp` hole, invisible because both the module header and the test
  file had been written telling readers to avoid the shape;
- eleven rune-column sites in six files the D4 plan never named, invisible
  because they are *inert today* and only become wrong after the flip.

Reviewers were told, specifically: re-measure rather than trust, hunt for claims
of "verified" that were not, check the four `yo check` blind spots, grep for
missed call sites across `std/ src/ tests/ docs/ .github/ vendor/`, and look for
tests that pass vacuously. That prompt is worth reusing verbatim.

**`plans/STD_API_AUDIT.md` is not reliable as a specification.** Roughly a dozen
of its rows have been measured wrong so far — dead things that were alive
(`WaitGroup`, `StringError`), live things that were dead (`MAX_SLOTS`),
mis-stated mechanisms (`starts_with(position)` is a *broken char walk*, not
byte-indexed), and gates that cannot be met (`byte-identity` for std additions).
Re-measure every row before executing it, and correct the row in the same PR.

---

## 7. Housekeeping

- `vendor/markdown_yo` is a submodule and is **EMPTY in a fresh worktree**. Run
  `git -c protocol.file.allow=always submodule update --init` before any
  `yo check ./src`, `yo build`, or vendor grep — a vendor grep in an
  uninitialised worktree is vacuous, and one agent's load-bearing count was
  taken that way.
- ~~The main worktree is currently on `s2/d4-pr3-flip`.~~ Merged (#290); the
  main worktree is back on `develop`.
- A stale memory note in the operator's private store says
  "`String.len()` = CHARACTER count". **PR 3 makes that false.** It is outside
  the repo; flagging it here because it will otherwise mislead.
