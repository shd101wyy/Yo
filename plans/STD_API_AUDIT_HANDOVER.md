# STD_API_AUDIT — handover

**Written 2026-08-26.** Hand-off of the `plans/STD_API_AUDIT.md` campaign. Read
this file, then `plans/STD_API_AUDIT.md` (the audit itself) and
`plans/STD_API_AUDIT_D4_PLAN.md` (the string-indexing sub-plan, which is the
only large piece still in flight).

---

## 0. THE ONE THING TO DO FIRST

**Branch `s2/d4-pr3-flip` is finished and reviewed but has NOT had a full
battery and is NOT merged.** It is the D4 byte-indexing flip — the change the
audit says cannot be made after stability.

```
6ca247773 review(D4 PR 3): one live regression the flip introduced, one contract hole, and the measurements re-derived
7466ca440 plans: strike the D4-indexing rows PR 3 closed in STD_API_AUDIT
898705c8a tests: base64 decode_string's multibyte payload asserts both bases
6efc980f0 std: D4 PR 3 — the flip. String is byte-indexed
```

It is currently **checked out in the main worktree** (`git branch --show-current`
→ `s2/d4-pr3-flip`), tree clean.

What it already has, self-reported and then independently re-derived by a second
agent (see §6 for why that second pass matters):

- `yo build` green, `fixpoint_only.sh` → `FIXPOINT_HOLDS` with `stage2 hollow=0`,
  `gates_fast.sh` → `T1_DONE failures=0`, cli-diff 52 PASS / 0 GOLDEN-DIFF,
  `check ./std` 154/154, `check ./src` 262/262.
- What it does **not** have: `hollow_sweep69.sh` (the full-corpus ratchet) and a
  single end-to-end battery run over the merged result.

**Action:** merge it into an integration branch off `develop`, run the battery in
§1, and if green open a PR and admin-merge. Do not skip the sweep — it is the
arm that catches a per-file regression the aggregate suite hides.

Two findings from its review that should go in the PR body, because they are the
argument for the change rather than footnotes:

- **A live regression the flip introduced, now fixed on the branch.**
  `src/codegen/exprs/async.yo:366` `_capitalize_last_segment` used
  `substring(0, 1)` to take the first *character*. Yo identifiers may start with
  a non-ASCII rune, so post-flip that is a continuation byte and `substring`
  panics — the compiler would abort at rc=134 while emitting an effect setter.
- **A contract hole, docs corrected and behaviour deliberately left alone.** The
  empty needle: `index_of("", 2)` returns `Some(2)` — a continuation byte — and
  `index_of("", 99)` returns `Some(99)`, past `len()`. Both are pre-D4
  behaviours, verified at the parent commit. What was new was PR 3's doc comment
  claiming *every* returned index is a rune boundary, which is false and matters
  because the same comment invites feeding results straight into `substring`,
  which now panics. Two tests pin it.

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
| **D4 string indexing** | PRs 0–2 merged (#286, #288); **PR 3 awaiting battery**; PRs 4–9 open |
| **D5 async io traits** | **UNBLOCKED** (#289) but not started |
| D6 TLS | untouched, decided (O2) |

---

## 3. What is LEFT

### 3.1 D4, PRs 4–9 — `plans/STD_API_AUDIT_D4_PLAN.md` §4 has the full table

| PR | content | note |
| --- | --- | --- |
| 4 | `imm.String`: `len()` → bytes, `at()` aligned, `bytes_len()` aliased, `chars()`/`char_indices()`/`char_len()` wired | **low urgency, measured**: `imm.String` has ZERO production consumers and there are ZERO cross-type index feeds, so this is insurance, not a bug fix |
| 5 | `imm.String` → `ImmString` rename | ~15 lines |
| ~~6~~ **DONE 2026-08-26** | ~~Regex: delete `_byte_to_char_index` and the three char→byte re-walks; `RegexMatch.index()` becomes a byte index~~ | landed on `s2/d4-pr6-regex` — SIX walks deleted, not four (the `` $` ``/`$'` replacement arms re-walked too, and the third listed site was `split`, not `replace_all_fn`); regex suite 156→166 with 5 tests that fail against the pre-PR6 std; corrections recorded in the D4 plan §4 row 6 + §5.3. **Release note still owed at release time**: `RegexMatch.index()` / `Regex.search` now return BYTE offsets |
| 7 | Comptime basis (O1c) — align `comptime_str.len()`/`slice`/`s[i]`, or document the split | measured safe from the seed's point of view: every `comptime_str` use in `std/`+`src/` is ASCII |
| 8 | Docs + skills sweep, `docs/{en-US,zh-CN}` both | PR 3 already inverted `syntax-cheatsheet.md:1481` because leaving it would actively mislead; the rest remains |
| 9 | Dedup the remaining hand-rolled UTF-8 decoders onto `std/encoding/utf8.yo` | includes `vendor/markdown_yo`, which needs **companion upstream commits + a pointer bump** |

Not done and explicitly deferred by PR 3: **the UTF-16 half of §5.4** (LSP's
position encoding). It is protocol-visible, wants a `positionEncoding`
capability, and is a pre-existing defect unrelated to `String`'s basis. The
rune⟷byte helpers PR 3 added to `src/lsp/protocol.yo` are the seam to build it
on.

### 3.2 D5 — async `Reader`/`Writer` traits

Unblocked by #289 and **not started**. Content is in `plans/STD_API_AUDIT.md`
§D5: async `Reader`/`Writer` with default methods (`read_to_end`,
`read_to_string`, `write_all`, `lines()`), implemented by `File`, `TcpStream`,
`BufReader`, `BufWriter`, `Stdin`/`Stdout`; `BufReader`/`BufWriter` move from
`std/sys/bufio` to `std/io` and adopt `IoExn`; new `std/io/stdio.yo`.

Carry-over that must land *with* it, not before: `File.read` and the bufio side
still return `i32`/`Result(i32, IoError)` while net already returns
`Future(usize, IoExn)`. Three error models, one conversion — the audit says do
them together.

`std/io/` is currently an **empty namespace** — its two orphaned sync traits were
deleted in #283 and moved into `tests/io/reader_writer.test.yo`, which was their
only implementor.

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
`closure-nested-inside-io-async-closure-body-emits-abort-stub.md`,
`generic-implementor-async-method-awaiting-self-emits-uncompilable-c.md`.

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
- The main worktree is currently on `s2/d4-pr3-flip`. Switch it back to
  `develop` once that branch is merged.
- A stale memory note in the operator's private store says
  "`String.len()` = CHARACTER count". **PR 3 makes that false.** It is outside
  the repo; flagging it here because it will otherwise mislead.
