# v0.2.79: the retirements ledger and the claim text

**Status: ACTIVE LEDGER, opened 2026-11-17 by the v0.2.79 docs lane (VERDICTS-58 decision 30), read against develop
`916b279c1` (#1980).** It is a working record, not a design: the schedule
([`VBD_RELEASE_SCHEDULE.md`](VBD_RELEASE_SCHEDULE.md) §1, §5g, §5h) decides what ships and when; this file tracks what
each v0.2.79 PR retired, which docs and tables it must touch, and the sentence the release notes may assert. A lane
that merges a row flips its **State** and fills its PR number in the same PR. At the release it is frozen and
`plans/archive/` takes it, like the earlier handovers.

## 1. What the release retires

"Retire" is used in three senses, one per table column group: a **spelling** leaves the language (it becomes an error
with a help text), a **`yo fix --migrate` mode** leaves the CLI, and an **internal mechanism** is deleted. Each row says
which, and where the user-visible text lives.

| # | What | Sense | After the change | Last release of the old form | PR | State |
| --- | --- | --- | --- | --- | --- | --- |
| R1 | The std/src exemption from the reference-reading rule (`is_deref_rule_exempt`; `deref_spelling_applies` folded into `deref_rule_applies`) | mechanism | A bare reference binding used as a whole value is E0926 in every file, std, src, `scripts/`, `build.yo` and a fetched dependency included; `&r` lends the reference itself (a `&&T`). The 92 `io.async` capture lists read `{ p : &p.* }`; `MaybeUninit.as_ptr` reads `addr_of(self.*)`. User code never had the exemption, so nothing changes outside std and the compiler | v0.2.78 (inside std and src only) | #1976, with std follow-ups #1977 (`Arc.make_mut`) and #1978 (about twenty generics no test instantiated) | merged |
| R2 | The legacy `str` value type as a sized type | spelling | `str` is unsized and `&str` is the fat reference (`__yo_str`); a string literal is `&(str, static)`. A value `str` written in a sized position stays as the legacy alias of `&(str, static)` in every position, so code that only writes `str` keeps its meaning. One break: a generic `x : &T` parameter at `T : Type` that takes a string binds `T := str`, which is E0619 unless the binder says `T : ?Sized`; the help names the fix. The alias itself is deleted by R9 (v0.2.80) | v0.2.78 (v0.2.79 publishes the alias, not the old type) | #1980 | merged |
| R3 | `yo fix --migrate unsized`'s `str` family | mode | Writes a value `str` type as `&(str, static)` at a parameter, result, typed local, field, array element and type argument, but only in std and in files E0922's wall exempts (safe code cannot spell `static` while P12 is blocked); lists `sink(s) : str`. The mode does not retire here (R10) | the mode's last release is v0.2.80 | #1980 | merged |
| R4 | `dyn(v)` of a plain value (the legacy alias of `dyn(Box.new(v))`), and the S3b-`Dyn` family of `unsized_legacy_spellings` | spelling | to fill: the error code and its help | v0.2.78 | to fill | pending (S3b-`Dyn`, d49 lane; first PR after the flips) |
| R5 | `Deref` as a marker trait with no `deref` method, read natively for the cell handles only (VERDICTS-63 Generation A) | surface change, not a deletion | `Deref` gains the projection `deref`, `DerefMut` its write half; an owner's `.*` is the `deref` call; outside the prelude a `Deref` impl needs an unsized `Target`; `Array(T, N)` implements both; `TMisnamed` in `tests/fixtures/cell_handles.yo` becomes a type error at the impl. The two std impls (`ArrayList`, `String`) are v0.2.80 | n/a | to fill | pending (compiler PR, day 2–3, wall 2026-11-28 12:00) |
| R6 | `Token`, `AstExpr`, `EvalValue` as `ref(struct)` / `ref(enum)` | internal | Read-only `Rc`, one PR each (3c, 3d, 3e), each behind its prep PR; no user-visible change. Gate: compiler-swap identity (schedule §5i decision 54). 3c's prep is #1979 | v0.2.78 | #1979 (prep) / to fill (3c, 3d, 3e) | prep merged; 3c, 3d, 3e pending |
| R7 | `ref(...)` and `atomic(...)` as declaration forms | spelling | E0009 naming the `Rc(S)` / `Arc(S)` spelling; the `BK_REF` / `BK_ATOMIC` arms, the `is_reference_semantics` / `is_atomic_rc` sites (160 on 2026-11-09, reread as cell-payload flags), the LSP keywords, the VS Code grammar and the hints are deleted; the tests V5 part B kept on `ref` and 13 cli fixtures are rewritten; the effect records' `Copy` lands. The `ref`-era backstop (VERDICTS-42) and audit §8's `f(&h.xs, h2)` residual close with it | v0.2.78 | to fill | pending |
| R8 | `--migrate record-literal` | mode | Retired: the E0007 help and `yo fix --help` stop naming it; the `Retired migrations` table gains its row (§2) | v0.2.78 (its Generation B swept the trees there) | to fill | pending (one PR; touches `src/main.yo`, `src/parser.yo`, `src/diagnostics_registry.yo` (E0007's help) and the cli cases, so any lane outside the retype's files may take it) |
| R9 | The value-`str` alias, `slice_copy`/`slice_copy_inclusive`, `unsized_legacy_spellings` (S3b-`str`) | spelling | The std/src `str` sweep first; then the alias and the legacy arms are deleted. **v0.2.80, not here** (§5h decision 51: the swept spellings do not compile on a seed without the flip) | v0.2.79 | n/a | planned for v0.2.80 |
| R10 | `--migrate deref`, `--migrate unsized` | mode | `deref` retires in v0.2.80 (v0.2.79 is its last release); `unsized` is in its last release in v0.2.80. Neither retires here, so the table in §2 gains no row for them yet | v0.2.79 / v0.2.80 | n/a | planned for v0.2.80 / v0.2.81 |
| R11 | `--migrate module-names` | mode | **Not shipped.** Kebab-case Part C did not land in v0.2.78 (`src/main.yo` accepts three modes: `deref`, `record-literal`, `unsized`), so there is nothing to retire in v0.2.79: the schedule's "retires in v0.2.79" (§5f decision 32) is superseded. See the open question in §4 | n/a | n/a | open |
| R12 | `Box`'s layout L3: a placed `Rc`/`Arc` cell's 16-byte extent | internal | The placed cell stops carrying the extent once S2 has typed every release path; the C size of a placed handle shrinks | v0.2.78 | to fill | pending (d49 lane; or with the collector's deletion, if the sweep still needs a type-erased free) |

Two merged PRs of this window retire nothing and are recorded here only so the notes cite them: **#1975** (audit A57:
a bare reference binding passed to a reference parameter roots the call result, so a call result stored through a
`&mut` capture is checked against the capture's outer place) is a soundness fix and feeds §3's count; **#1979** is R6's
prep, with no behaviour change.

## 2. Draft rows for the user docs

Both `docs/en-US/ERROR_DIAGNOSTICS.md` and `docs/zh-CN/ERROR_DIAGNOSTICS.md` carry the `Retired migrations` table. Its
last sentence ("`yo fix --migrate deref`, `yo fix --migrate record-literal` and `yo fix --migrate unsized` are the three
modes this release ships") and its "Run them in phase order" paragraph change in the same PR as each retirement. The R8
PR adds this row (translate the cells for zh-CN; the error and release columns are identical):

```text
| `record-literal` | a bare brace group of fields in expression position to the record `.{ … }` (the brace-group rule, `plans/reference/BRACE_BLOCKS.md`), the punned one-field group and the empty group included | E0007 | v0.2.78 |
```

The paragraph that introduces the mode (`yo fix <path> --migrate record-literal` … "It retires in v0.2.79.") is deleted
with the row, and the sentence naming the shipped modes drops to two (`deref`, `unsized`). The R8 PR also removes
`record-literal` from `yo fix --help` (English and zh-CN), from the `argv(next_m)` check in `src/main.yo` and its
`fix-migrate-record-literal*` cli cases, and re-records the help goldens. Each later retirement repeats that checklist.

## 3. The claim

### 3.1 What "VBD complete" asserts

Two statements and only these two (VERDICTS-58 decision 1; schedule §5g):

- **(L), the language migration.** Every declared type is a value; `ref(...)` and `atomic(...)` are E0009;
  `?Sized`, `Dyn`, `[T]` and `str` are the unsized types with no legacy spelling; every `--migrate` mode is retired or in
  its last release.
- **(S), soundness on what the checker accepts.** No known program in safe code that `yo check` accepts is memory-unsafe
  through ownership, moves, drops, references, origins or captures. A finding blocks (S) iff it is accepted-and-unsafe,
  its cause is in VBD's own machinery (the audit's clusters 1–8, plus A40 and A43), and it is neither fixed nor walled.

It does not assert Rust-parity expressiveness (a separate claim, made when `DIVERGENCES.tsv` has no row "rejected
pending a parity item"), data-race freedom for safe code (`ROADMAP.md`'s known-gap clause for A41 and A42), or that a wall
is absent. A wall is a limitation a user sees as an error; a hole is a use-after-free, and only the second falsifies
the claim.

### 3.2 Where each statement is made

(L) is **not** complete at v0.2.79: its `str` half (R9) is seed-forced to v0.2.80 (§5h decision 51). So v0.2.79's notes
say "(L) complete except the value spelling of `str`", and (L) is asserted in v0.2.80's notes. (S) is asserted by test 7
on the v0.2.79 release candidate; if test 7 has not passed at the cut, the notes say so and (S) moves to v0.2.80 too.
The release and the claim are decoupled (VERDICTS-58 decision 8).

### 3.3 Draft sentences for the v0.2.79 release notes

Use one of the two blocks; the numbers in brackets come from the test-7 run on the candidate and are copied, not
estimated.

(S) holds on the candidate:

> **The language migration is complete except the value spelling of `str`, and the checker is sound on what it
> accepts.** Every declared type is a value, `ref(...)` and `atomic(...)` are error E0009, and the unsized types
> (`?Sized`, `Dyn`, `[T]`, `str`) have no legacy spelling except the value `str` alias, which v0.2.80 deletes. No known
> program in safe code that `yo check` accepts is memory-unsafe through ownership, moves, drops, references, origins or
> captures. On the release candidate: the origins corpus, the must-reject directory and the totality audit are green
> (G-A [n]/[n], G-B [n]/[n], G-E); the audit's probe corpus ([n] programs) was re-run with [0] accepted programs that
> ASan reports dirty in clusters 1–8; one G-D nightly on the candidate was clean ([n] programs); and a second
> adversarial pass of ten agents after the parser drop found [0] new S1 in clusters 1–8 ([n] walled, each listed
> below). This is not a Rust-parity claim, and the thread reach walk's two open holes (A41, A42) are listed below.

(S) pending:

> **The language migration is complete except the value spelling of `str`; the soundness claim is pending.** [Which
> part of test 7 has not passed, with its counts.] The claim is made in v0.2.80's notes.

Both blocks are followed by the known-issues list by document path (§3.5) and, under "Retracted claims", any earlier
sentence the cycle falsified. Candidate: v0.2.78's notes said the one-block `Rc`/`Arc(Dyn)` cell "moves to v0.2.79"; per
§5h decision 50 it lands before 3c only if READY by 2026-11-28 12:00, else behind the parser drop, else v0.2.80, so the
v0.2.79 notes say which happened.

### 3.4 Draft sentence for v0.2.80

> **The language migration is complete.** `str` is unsized with no value spelling, `slice_copy` is gone, `--migrate
> deref` is retired, and every other `--migrate` mode is retired or in its last release. [If test 7 moved: the
> soundness claim and its counts, as in §3.3.]

### 3.5 Known issues, by document path

The list is generated, not remembered, at the cut: from the audit's §3 `Where` column, every row whose document is
still under `issues/` and not `issues/fixed/` or `issues/retired/`, plus the open documents filed since the previous
release. The allowed families are A41, A42 and A44; B1–B3 and B5–B7 (loud compiler failures: a crash or invalid C,
never a wrong binary); C1–C13; and every wall (N2c–N2f, P4, P5, P6, P7, P10, P11, P15). B4 and B8 were fixed in
v0.2.78. Anything else open in clusters 1–8 or A40/A43 blocks (S) instead of being listed.

## 4. What is not decided here

- **K7 and K4** (`plans/backlog/AGENT_KNOWLEDGE_CONSOLIDATION.md`).
  - **K7, the docs sweep, first slice landed (2026-11-17, the docs lane's PR), both languages.** The declaration forms
    `ref(struct(...))`, `ref(enum(...))` and `atomic(ref(...))` are gone from every user manual, `README.md` and
    `pack/context.md`, each replaced by the spelling the language now has and each new snippet checked with a
    develop-tree binary: `ARC`, `THREAD_SAFETY`, `PARALLELISM`, `MEMORY_SAFETY`, `FLOWABILITY`, `ALGEBRAIC_EFFECTS`
    (the unwind example now writes through `&mut Ctx`), `TYPE_REFLECTION`, `INLINE_ASSEMBLY`, the README, and
    `DESIGN`'s type overview, shared-cell chapter, closures, testing, typestate, match-scrutinee table and
    collections. Three kinds of stale text that no grep list names came out with them, because each sat beside a `ref`
    example: "the collections are still shared handles" (they are values and `Send` when their elements are), the
    implicit-copy rule for `String` and collections at a by-value parameter, and the `imm(p)` parameter in
    `DESIGN`'s `match` example (E0009 today). One example was invalid under v0.2.78 and is rewritten: the closure
    in "Closure Capture Semantics" wrote an implicit capture from an `Fn` closure (E0913).
  - **K7, what is left.** (1) Text that describes compiler behaviour that stays until the parser drop (R7) and goes
    with it: `DESIGN` §"mut gates four writes" (the `ref` handle exemption), §"Replacing a `ref` declaration" and the
    deleted-mode-words note; `ERROR_DIAGNOSTICS`' two `ref`-handle sentences in the E0917/E0916 paragraphs and its
    `Retired migrations` table (rows stay: they are the record). (2) `DESIGN`'s `Rc` chapter, which predates the
    read-only payload: "Rc with Assignments" and "Auto-dereference" show `p.x = 5` through an `Rc` (E0919), and
    "Only `Box`, `Rc` and `Arc` implement `Deref`" is VERDICTS-63's to rewrite with its Generation A. (3)
    `COMPILE_TIME_RC_WITH_OWNERSHIP_ANALYSIS.md` (both languages) is mostly history under its own banner but still
    describes machinery that exists (`___dup`, the dup/drop pair optimizer, `ref_count`); it needs a decision, not a
    sweep. Recommendation: rewrite it as a short "Reference counting in the generated C" page and delete the
    ownership-model sections it already marks as history; README, `DESIGN` and two instruction files link to it.
    (4) The doc comments in `std/`, `.github/instructions/` and the nine ` ```rust ` fences in `pack/context.md`
    (K3's rework of the pack converts them). (5) K5's snippet gate has not run, so this slice is checked by hand for
    what it touched only; the first K5 run is the inventory for the rest, and it will find more (`DESIGN.md` has 169 ` ```yo `
    blocks, and the English manuals 483 in all).
  - **K4 (delete the shipped skills and `yo skills install`) is not a docs item**: it deletes `src/skills_command.yo`,
    edits `src/main.yo`, three cli cases, the `init*` goldens, `scripts/install.sh`, `scripts/bootstrap/gates_fast.sh`
    and `release.yml`'s bundles, so it needs a build, `cli-diff-test` and a re-record. Recommendation: a separate small
    PR by whichever lane is idle after the retype's first PR, because none of those files is in the retype's surface;
    it must not wait for K5, whose snippet gate is the inventory K7 would use but not a dependency of the deletion.
- **Kebab Part C and `--migrate module-names` (R11).** Part C was scheduled last in v0.2.78 "unless the flip has started
  merging"; the flip merged and Part C did not land, and no document gives it a new release. It renames most of std,
  src and tests, so it cannot share a window with the retype (decision 37's #1813 precedent). Recommendation: v0.2.80,
  after the parser drop, with `module-names` shipping there and retiring in v0.2.81; the schedule's v0.2.79 and v0.2.80
  rows then lose the "module-names" clause and `KEBAB_CASE_NAMES.md`'s status line says so.
- **The count of mode retirements.** VERDICTS-58 decision 28 lists "the four mode retirements". After §5h only one
  (`record-literal`, R8) retires in v0.2.79; `deref` and `unsized` move to v0.2.80 and v0.2.81 and `module-names` to
  v0.2.81 (R10, R11). The schedule row already says "`record-literal` and `module-names` only"; it needs the R11 edit.
