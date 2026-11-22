# v0.2.79: the retirements ledger and the claim text

**Status: ACTIVE LEDGER, opened 2026-11-17 by the v0.2.79 docs lane (VERDICTS-58 decision 30), read against develop
`70a203d0c` (#1981).** It is a working record, not a design: the schedule
([`VBD_RELEASE_SCHEDULE.md`](VBD_RELEASE_SCHEDULE.md) §1, §5g, §5h) decides what ships and when; this file tracks what
each v0.2.79 PR retired, which docs and tables it must touch, and the sentence the release notes may assert. A lane
that merges a row flips its **State** and fills its PR number in the same PR. At the release it is frozen and
`plans/archive/` takes it, like the earlier handovers.

**Amended 2026-11-19 (schedule §5l, decisions 57 and 58).** The parser drop (R7) is in v0.2.79: the 06:00 hard stop of
2026-11-19 had moved it to v0.2.80, and the maintainer re-admitted it, so v0.2.79 is cut WITH it. VERDICTS-66 adds the
derive-later `Clone`/`Hash` fix and the `?Sized` associated-type fix to the release, with the blanket `Hash(&T)` /
`ToString(&T)` as riders that ride only if READY by R7's merge + 24 h (rider rows are filled as they merge, see §6).
Kebab-case Part C ships as the last step before the cut, and `module-names` is a permanent flag, not a retirement
(R11, VERDICTS-67). The mode retirements of this release are `record-literal` (R8) only.

## 1. What the release retires

"Retire" is used in three senses, one per table column group: a **spelling** leaves the language (it becomes an error
with a help text), a **`yo fix --migrate` mode** leaves the CLI, and an **internal mechanism** is deleted. Each row says
which, and where the user-visible text lives.

| # | What | Sense | After the change | Last release of the old form | PR | State |
| --- | --- | --- | --- | --- | --- | --- |
| R1 | The std/src exemption from the reference-reading rule (`is_deref_rule_exempt`; `deref_spelling_applies` folded into `deref_rule_applies`) | mechanism | A bare reference binding used as a whole value is E0926 in every file, std, src, `scripts/`, `build.yo` and a fetched dependency included; `&r` lends the reference itself (a `&&T`). The 92 `io.async` capture lists read `{ p : &p.* }`; `MaybeUninit.as_ptr` reads `addr_of(self.*)`. User code never had the exemption, so nothing changes outside std and the compiler | v0.2.78 (inside std and src only) | #1976, with std follow-ups #1977 (`Arc.make_mut`) and #1978 (about twenty generics no test instantiated) | merged |
| R2 | The legacy `str` value type as a sized type | spelling | `str` is unsized and `&str` is the fat reference (`__yo_str`); a string literal is `&(str, static)`. A value `str` written in a sized position stays as the legacy alias of `&(str, static)` in every position, so code that only writes `str` keeps its meaning. One break: a generic `x : &T` parameter at `T : Type` that takes a string binds `T := str`, which is E0619 unless the binder says `T : ?Sized`; the help names the fix. The alias itself is deleted by R9 (v0.2.80) | v0.2.78 (v0.2.79 publishes the alias, not the old type) | #1980 | merged |
| R3 | `yo fix --migrate unsized`'s `str` family | mode | Writes a value `str` type as `&(str, static)` at a parameter, result, typed local, field, array element and type argument, but only in std and in files E0922's wall exempts (safe code cannot spell `static` while P12 is blocked); lists `sink(s) : str`. The mode does not retire here (R10) | the mode's last release is v0.2.80 | #1980 | merged |
| R4 | `dyn(v)` of a plain value (the legacy alias of `dyn(Box.new(v))`) | spelling | E0620; its help names `dyn(Box.new(v))` and v0.2.78's migration, and a named value carries a structured repair (`yo fix` rewrites it). `yo fix --migrate unsized` keeps only the `&b` → `&b.*` lend rewrite and the listing of `dyn(h)` over a named handle, and finds sites by position, so a template literal, a bracket in a string or a multi-line argument is rewritten instead of listed. Also in this PR, an S1 present on v0.2.78: a boxed or lent `FnOnce`/`FnMut` closure erased into a `Dyn(Fn(...))` is E0913 again (the second call freed the captures twice). Still to come (S3a's remainder, d49 lane): the legacy dyn runtime arms, the fat cells, B | v0.2.78 | #1981 | alias merged; remainder → v0.2.80 |
| R5 | `Deref` as a marker trait with no `deref` method, read natively for the cell handles only (VERDICTS-63 Generation A) | surface change, not a deletion | `Deref` gains the projection `deref`, `DerefMut` its write half; an owner's `.*` is the `deref` call; outside the prelude a `Deref` impl needs an unsized `Target`; `Array(T, N)` implements both; `TMisnamed` in `tests/fixtures/cell_handles.yo` becomes a type error at the impl. The two std impls (`ArrayList`, `String`) are v0.2.80 | n/a | #1983 | merged |
| R6 | `Token`, `AstExpr`, `EvalValue` as `ref(struct)` / `ref(enum)` | internal | Read-only `Rc`, one PR each (3c, 3d, 3e), each behind its prep PR; no user-visible change. Gate: compiler-swap identity (schedule §5i decision 54). 3c's prep is #1979 | v0.2.78 | #1979 (prep) / #1986 (3c), #1992 (3d) / to fill (3e, merging before the cut) | prep, 3c, 3d merged; 3e pending (merging before the cut) |
| R7 | `ref(...)` and `atomic(...)` as declaration forms | spelling | E0009 naming the `Rc(S)` / `Arc(S)` spelling; the `BK_REF` / `BK_ATOMIC` arms, the `is_reference_semantics` / `is_atomic_rc` sites (160 on 2026-11-09, reread as cell-payload flags), the LSP keywords, the VS Code grammar and the hints are deleted; the tests V5 part B kept on `ref` and 13 cli fixtures are rewritten; the effect records' `Copy` lands. The `ref`-era backstop (VERDICTS-42) and audit §8's `f(&h.xs, h2)` residual close with it | v0.2.78 | the R7 PR | in the cut (re-admitted 2026-11-19, schedule §5l decision 57): branch `v0279/parser-drop`, merges FIRST, ahead of every rider. As built: `ref(...)` carries a `ref` → `Rc` structured repair, `atomic(...)` help only (a one-span repair cannot drop the surplus `)`); the ~50 compiler records that were `ref(struct(...))` are value structs or `Rc` handles; PR number to fill |
| R8 | `--migrate record-literal` | mode | Retired: the E0007 help and `yo fix --help` stop naming it; the `Retired migrations` table gains its row (§2) | v0.2.78 (its Generation B swept the trees there) | #1989 (`cli` lane) | landed 2026-11-17: the mode, `_run_migrate_record_literal` and its helpers, the parser's `set_brace_legacy_records` flag and the `fix-migrate-record-literal` case are deleted; E0007's help says `yo version install 0.2.78 && yo fix <path> --migrate record-literal`; the `Retired migrations` row is in both languages |
| R9 | The value-`str` alias, `slice_copy`/`slice_copy_inclusive`, `unsized_legacy_spellings` (S3b-`str`) | spelling | The std/src `str` sweep first; then the alias and the legacy arms are deleted. **v0.2.80, not here** (§5h decision 51: the swept spellings do not compile on a seed without the flip) | v0.2.79 | n/a | planned for v0.2.80 |
| R10 | `--migrate deref`, `--migrate unsized` | mode | `deref` retires in v0.2.80 (v0.2.79 is its last release); `unsized` is in its last release in v0.2.80. Neither retires here, so the table in §2 gains no row for them yet | v0.2.79 / v0.2.80 | n/a | planned for v0.2.80 / v0.2.81 |
| R11 | `--migrate module-names` | mode (never built) | **No retirement, ever.** Kebab-case Part C did not land in v0.2.78 (`src/main.yo` accepts three modes: `deref`, `record-literal`, `unsized`), and VERDICTS-67 (2026-11-19, schedule §5l decision 58) settles the question: the tool ships in v0.2.79 as `yo fix <path> --module-names`, a permanent opt-in flag OUTSIDE the `--migrate` family, so there is no mode to retire, no row in ERROR_DIAGNOSTICS' retired-migrations table and no effect on claim (L). The schedule's "retires in v0.2.79" (§5f decision 32) is superseded. The std/src/tests module renames are a breaking change the notes state (`yo fix <path> --module-names` for a package's own files; the did-you-mean import repair, which may slip to v0.2.80, or a manual rename for std import paths) | n/a | the kebab lane, branch `v0279/kebab-part-c`; PR number to fill | in progress: the last step before the cut |

Two other merged PRs of this window retire nothing and are recorded here only so the notes cite them: **#1975** (audit A57:
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
Test 7 itself is v0.2.80 (maintainer override, 2026-11-17; schedule §5k), so the release asserts §3.3's "(S) pending"
variant. §3.6 is how test 7 runs and what passing means.

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

### 3.6 Test 7: how to run it, and what "passed" means

Test 7 is VERDICTS-58 decision 7's four legs, on the release candidate (since §5k, the v0.2.80 candidate). Legs (a)
and (b) are one command; (c) is a CI run the same command reads; (d) is agents.

```bash
# on a detached worktree of the candidate, with a stage 1 built from it (`yo build --std-path ./std`), clang on PATH
systemd-run --user --unit=test7 -p MemoryMax=16G --working-directory="$PWD" bash -c \
  'source scripts/heavy-lock.sh; heavy_take "test7: <sha>"; bash scripts/test7.sh --yo <stage1>; heavy_drop'
cat tmp/test7-<sha>/summary.txt                                  # the verdict of (a) and (b), and the [n] slots
bash scripts/test7.sh --gd-howto                                  # (c): how to dispatch G-D on the candidate
bash scripts/test7.sh --gd-verdict <run-id> --sha <sha>           # (c): read that run
```

| Leg | What runs | Passed means |
| --- | --- | --- |
| (a) | test.yml's `origins-corpus` steps: `check-origin-sinks.sh`, `origins-corpus.sh today`, `origins-unsound.sh`, `check-origin-sinks.sh --totality` | every one exits 0: G-A `n/n` passed, G-B `n/n` passed, "origin sinks: ok", "origin totality: 0" |
| (b) | the audit's frozen probe corpus (`scripts/test7/audit-corpus.tar.gz`: the ten areas' probes, the audit's 231 reproducers, the re-probe's 40 pass-2 programs; 2,047 files) — `yo check`, then for an accepted program an ASan compile (`--optimize 1 --sanitize address --allocator system`) and a run with `detect_stack_use_after_return=1` | every program ran, and **zero BLOCKING dirty programs**: an accepted program whose run reports `ERROR: AddressSanitizer` is attributed (`scripts/test7/attribution.tsv`, or a reproducer's basename) to an audit row; it blocks when the row is in clusters 1–8, is A40, A43 or an S1 row §9 does not place (A55–A57), or when it is not attributed yet |
| (c) | `origins-generator.yml` on the candidate SHA (it checks out `develop`, so dispatch it while the candidate is develop's tip, or take the nightly that ran on it) | the run's head is the candidate, it succeeded, the generator printed "0 new", and every `tests/origins/gen-known.tsv` row is a listable issue |
| (d) | `plans/handover/TEST7_ADVERSARIAL_BRIEF.md`: ten agents, one day, after the parser drop | zero new S1 in clusters 1–8 that are neither fixed nor walled |

What (b) does not count against the claim, and lists instead: a LeakSanitizer-only report (a leak, not a
use-after-free), a C compile failure or a checker crash (B class, loud), a run that fails without a sanitizer report
(a panic), and a dirty program attributed to A41, A42, A44, a B or C row, or `none:<reason>`. A program that turns the
unsafe gate off (`Pragma.AllowUnsafe`) is outside safe code and is skipped. The corpus is frozen while the language
moves, so the summary also prints its drift (positives now rejected, negatives rejected with another code): a drifted
negative no longer reaches the shape it was written for, which narrows what (b) proves without failing it (`drift.tsv`
lists them). **Before (S) is claimed in v0.2.80, the drifted negatives of clusters 1–8 are respelled** to today's
language, in the tarball, so (b) reaches their shapes again (coordinator's decision, 2026-11-19). A std module renamed
since the corpus was written (kebab-case Part C) is followed automatically (`scripts/test7/respell_imports.py`).
`scripts/test7/audit-corpus.tar.gz` is the canonical copy of the audit's probe corpus; the audit worktree's
`tmp/probes/` is not needed.

**Rehearsal, 2026-11-19, develop `939fe7160`** (stage 1 of `d8f0d89fa`, the same `src/` and `std/`; about 3 h on the
shared box, G-B the long pole). (a) passed: sinks ok, G-A 150/150, G-B 392/392, totality 0. (c) passed: nightly run
44451066581 ran on `939fe7160` with 291 programs and "0 new". (b) failed: of 2,047 programs (9 excluded as unsafe),
1,614 were rejected, 6 crashed the checker, and 418 were accepted. The accepted ones split into 334 clean, 7 leak-only,
17 C compile failures, 13 runs that failed without a sanitizer report, and **47 ASan-dirty**, all of them blocking.
Drift: 94 positives rejected, 342 negatives rejected with another code, 93 negatives accepted (47 are the dirty set, 42 run clean, 4 fail to compile).
The 47 dirty programs, re-run with `--only` on a stage 1 of the pending cluster branch `v0279/clusters`
(`76f6aaf03`), went to 36 rejected (A3, A5, A10, A14, A15, A17, A23) and 11 still dirty. Ten of the 11 are six
issues filed 2026-11-19 (`issues/fixed/2026-11-19-*.md`: clusters 2, 3, 5, 6 and 7, fixed since by #2020 and #2038),
and one is the ref-era residual (`f(&h.xs, h2)`, audit §8), which the parser drop closes. So on develop plus the
cluster branch, (b) would report **11 blocking**: the claim needed those six issues fixed or walled first.

**Run, 2026-11-23, develop `f06ff5889`** (stage 1 of the test 7 branch merged with it, `8c2424568`: the same `src/`
and `std/`, which develop kept unchanged through `369ff6491`; `--jobs 4` on the shared box, about 5 h, G-B the long
pole). **(a) and (b) pass.** (a): sinks ok, G-A 150/150, G-B 504/504, totality 0. (b): of 2,047 programs (9 excluded
as unsafe), 1,691 were rejected, 6 crashed the checker, and 341 were accepted: 305 clean, 7 leak-only, 17 C compile
failures, 12 runs that failed without a sanitizer report (index, capacity and `RefCell` re-entry panics), and **0
ASan-dirty**. Against the rehearsal, all 47 dirty programs are rejected now; 29 programs that ran clean, and 1 that
panicked, are rejected too, and no program changed to a worse verdict. Drift: 94 positives rejected (the rehearsal's
set), 352 negatives rejected with another code, 21 negatives accepted (17 run clean, 4 fail to compile; all 21 were
accepted in the rehearsal too). (c): no nightly has run on `f06ff5889` yet. The newest, 44980366531 on `1c7aeb015`
(before #2038), was clean: 291 programs, "0 new", and its one known finding was the `args:named/*/closure/*` row that
#2038 fixed and deleted. **The respelling of the drifted negatives is not mechanical.** Of the 352, 212 now fail with
another borrow code (E0909–E0923), 59 hit a wall without a code (the local-borrow and capture walls), 44 fail with a
type or name error, and 37 hit a spelling diagnostic (E0926, E0009, E0927). `yo fix --migrate deref` does not
evaluate a program the checker rejects. In a whole-reference read or write, it cannot tell whether the probe means
re-pointing or writing through, or copying the reference or the value. So each program needs its probe's intent
read.

**(c) on the candidate, 2026-11-23.** Run 45062393402 of `origins-generator.yml` ran on `369ff6491`, whose `src/` and
`std/` are the candidate's. It is clean: 291 programs, 0 findings after minimization, 0 new, and
`tests/origins/gen-known.tsv` has no rows. `--gd-verdict` also reads it CLEAN when given the short SHA.

**Respell, 2026-11-23 (the pre-claim task).** All 352 drifted negatives were triaged one by one. Each has a row in
`scripts/test7/respell-manifest.tsv` that records what was changed and why, or why the program was kept.

- **137 respelled** to today's language, each keeping its probe's unsafe pattern:
  - 73 of the 81 that stopped at a type, name or spelling diagnostic;
  - 64 of the 271 borrow-coded or uncoded rows whose stopping diagnostic was unrelated to the probed hole: a
    call-site `&` marker, an implicit capture that moves, a closure binding without its type, an incidental `static`
    origin, `&&T` written for `&(&T)`, and similar.
- The respelled files are in `scripts/test7/respelled/`, which `test7.sh` overlays on the frozen tarball.
- **215 kept**:
  - in 192, the stopping diagnostic is the probed hole or its wall under another code;
  - 15 have no spelling today (a re-pointable reference field, `Dyn(T, p)`, shadowing, an array of lends, a
    temporary-handle lend);
  - 8 are malformed probes, or stop at a code their own header lists.

**The 137 respelled programs, re-run** with `--only` on the same binary. 124 are rejected:

- 96 with a code their header expects;
- 28 with another code. Most of these stop at the probed hole or its wall. Four E0621s are a symptom of the with-body
  issue below, and one is an internal evaluator error,
  `issues/2026-11-23-a-generic-constructor-at-a-reference-type-argument-fails-with-an-internal-evaluator-error.md`.

13 are accepted:

- **5 ASan-dirty, all new S1.** Each is attributed in `scripts/test7/attribution.tsv`, and each blocks the claim:
  - `issues/fixed/2026-11-23-a-binding-pattern-over-a-mut-match-may-overwrite-the-value-its-box-sub-pattern-binding-borrows.md` (`t06`);
  - `issues/fixed/2026-11-23-a-tuple-literal-may-lend-a-place-shared-after-an-earlier-element-lends-it-mut.md` (`t09`, `t10`);
  - `issues/fixed/2026-11-23-a-call-result-reference-argument-to-a-future-making-call-gives-the-future-no-origin.md` (`e04`);
  - `issues/fixed/2026-11-23-an-fnmut-closure-stores-its-by-value-holder-parameter-through-a-mut-capture-unchecked.md` (`e07`).
- 2 C compile failures, filed as
  `issues/2026-11-23-a-with-body-returning-its-reference-parameter-is-accepted-and-emits-invalid-c.md`.
- 2 `RefCell` re-entry panics: the `ref`-object probes, respelled as `Rc(RefCell(..))`.
- 4 run clean. One of them, `gu10`, hides a fifth S1 issue that only a `Box` payload exposes under ASan:
  `issues/2026-11-23-a-projection-may-return-a-reference-read-through-a-temporary-guard-whose-drop-rewrites-the-place.md`.

So (b) on the respelled corpus reports **5 blocking dirty programs**. The claim needs those four issues and the guard
projection fixed or walled first.

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
  - **K4 landed 2026-11-17** (the K4 PR; see the plan's K4 section). It is kept below as the record of why it was a
    separate PR.
  - **K4 (delete the shipped skills and `yo skills install`) is not a docs item**: it deletes `src/skills_command.yo`,
    edits `src/main.yo`, three cli cases, the `init*` goldens, `scripts/install.sh`, `scripts/bootstrap/gates_fast.sh`
    and `release.yml`'s bundles, so it needs a build, `cli-diff-test` and a re-record. Recommendation: a separate small
    PR by whichever lane is idle after the retype's first PR, because none of those files is in the retype's surface;
    it must not wait for K5, whose snippet gate is the inventory K7 would use but not a dependency of the deletion.
- **Kebab Part C and `module-names` (R11): decided 2026-11-19.** Part C was scheduled last in v0.2.78 "unless the flip
  has started merging"; the flip merged and Part C did not land. The maintainer placed it in v0.2.79 as the last step
  before the cut (it renames most of std, src and tests, so it follows the retype and the parser drop, decision 37's
  #1813 precedent, and is regenerated on the release tip), and VERDICTS-67 (schedule §5l decision 58) keeps the tool
  permanently as `yo fix <path> --module-names`, outside the `--migrate` family: nothing retires, there is no old-name
  table, and an unresolved import gets a generic did-you-mean repair (exactly one module matching under `_` → `-` plus
  lower case) in the `.NotFound` arm of `src/evaluator/exprs/import.yo`. The repair is not cut-blocking and may slip to
  v0.2.80. The schedule's v0.2.79 row says so; `KEBAB_CASE_NAMES.md`'s status lines are the kebab lane's to amend.
- **The count of mode retirements.** VERDICTS-58 decision 28 lists "the four mode retirements". After §5h and
  VERDICTS-67 only one (`record-literal`, R8) retires in v0.2.79; `deref` retires in v0.2.80 and `unsized` in v0.2.81
  (R10); `module-names` is not a mode and never retires (R11). The schedule row says "`record-literal` only".

## 5. Moved to v0.2.80 (maintainer override, 2026-11-17)

The maintainer's override of 2026-11-17 (schedule §5k) moves `Box`'s layout L3 (R12) out of v0.2.79; the row text is
unchanged from §1, and only the State column differs. The parser drop (R7) was re-admitted to v0.2.79 behind 3e by the
maintainer's second override, 2026-11-17 later that day, and stays in §1: the 2026-11-19 hard stop moved it to v0.2.80
for a few hours, and the maintainer re-admitted it the same day (schedule §5l decision 57), so no R7 row moves.

| # | What | Sense | After the change | Last release of the old form | PR | State |
| --- | --- | --- | --- | --- | --- | --- |
| R12 | `Box`'s layout L3: a placed `Rc`/`Arc` cell's 16-byte extent | internal | The placed cell stops carrying the extent once S2 has typed every release path; the C size of a placed handle shrinks | v0.2.78 | to fill | moved to v0.2.80 |

## 6. Riders of the 2026-11-19 scope (VERDICTS-66, schedule §5l decision 57)

Not retirements: fixes that ride the release behind R7, one row each, filled as each merges. The wall is R7's merge + 24 h
for the two blankets; only blocker 1 holds the cut past it.

| # | What | Branch | Gate | PR | State |
| --- | --- | --- | --- | --- | --- |
| F1 | Blocker 1: a generic impl's `where` bound forces the bound type's later impls and derives (`derive(Clone)`/`derive(Hash)` on a struct with a `Deref`-owner field saw later derives) | `v0279/derive-later-clone` | the pinned test, stage 2, the fixpoint, zero emit-diff | to fill | holds the cut |
| F2 | An associated type declared `?Sized` is an associated type (`Deref.Target : ?Sized`) | `v0279/sized-assoc` | as F1 | to fill | in the cut |
| F3 | Blocker 4: blanket `ToString(&T)` | `v0279/blanket-tostring` | as F1 | to fill | rider: READY by the wall, else v0.2.80 |
| F4 | Blocker 3: blanket `Hash(&T)` (the occurs check descends into references) | `v0279/blanket-hash` | as F1 | to fill | rider: READY by the wall, else compiler fix v0.2.80 and std `Hash(&T)` v0.2.81 |
| F5 | The compiler's own leak since the retype: a value a later `cond` condition moves is dropped in the earlier arms (G4 75,897 B against the 378 B bar) | `v0279/g4-leak` | G4 back at the bar | to fill | gates the cut (G4 is a cut gate, §5k decision 56) |
