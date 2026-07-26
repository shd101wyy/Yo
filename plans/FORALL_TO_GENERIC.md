# `forall` → `generic`: keyword migration plan

**Status: EXECUTED 2026-07-26.** One atomic commit, per the hard-cutover
decision below. See "Deviation from the plan" for the one place reality
overruled the design.

Rename the type-parameter binder keyword from `forall` to `generic`, and
reserve `forall` (and `∀`) exclusively for future Dafny-style verification
quantifiers. (`exists` / `∃` were in the original design but could not be
reserved — see "Deviation from the plan".)

```rust
// Before
sum :: (fn(forall(T), a : T, b : T) -> T)((a + b));
impl(forall(T), List(T), ...);

// After
sum :: (fn(generic(T), a : T, b : T) -> T)((a + b));
impl(generic(T), List(T), ...);

// Future (reserved, verification):
// ensures(forall(i, (i < result.len()) => (result(i) >= 0)))
```

## Why rename

1. **One keyword, one concept.** Yo plans to adopt Dafny-style verification
   syntax, where `forall` / `exists` are value-level logical quantifiers in
   `requires` / `ensures` / invariant clauses. Keeping `forall` as the
   signature-level type binder would give the keyword two roles with two
   different syntactic shapes (`forall(T)` — bare names, no body — vs
   `forall(i, pred)` — binders + predicate). A parser disambiguates by
   position; humans reading error messages, docs, and search results do not.
   "What does `forall` mean in Yo?" must have one answer.

2. **The existential side already chose a non-quantifier name.** Yo's
   `Impl(Future(T, E))` _is_ an existential type ("there exists a type
   implementing Future"). With `generic` / `Impl` as the type-level pair, the
   quantifier vocabulary `forall` / `exists` is left fully free for the
   value-level verification pair — which is exactly how Dafny itself divides
   the space (type params use `<T>`, quantifiers use `forall` / `exists`).
   Keeping Haskell's `forall` for generics while adopting Dafny's spec syntax
   would be a mixed metaphor relative to both inspiration sources.

3. **The keyword table already anticipated this.** `src/expr.ts` carries
   `forall: ["forall", "∀"]` next to the commented-out reservations
   `// Exists: ["exists", "∃"]` and `// In: ["in", "∈"]` — the quantifier
   family was always headed for verification. This plan completes that
   direction instead of fighting it.

4. **Precedent.** The `escape` → `unwind` rename (commit `a3510d20`)
   established that Yo prioritizes one-keyword-one-concept precision over
   naming inertia. Same call here.

5. **Audience.** Yo's surface syntax courts the Rust/C++/Java audience (the
   docs even use Rust highlighting). `generic(T)` reads instantly to that
   audience; `forall` reads instantly only to Haskell/verification folks —
   who are precisely the people who will expect `forall` to be a _logical
   quantifier_ once verification exists.

## Why a HARD CUTOVER (no dual-accept alias) — decision

We considered a transition period where both keywords parse (`forall`
deprecated, `fmt` rewrites). **Rejected.** Rationale:

1. **No external users to break.** Yo is pre-1.0 with no third-party code in
   the wild. The entire universe of Yo source is this repository (`std/`,
   `tests/`, `yo-self/`, embedded snippets). A compatibility alias protects
   nobody.

2. **An alias must be implemented twice and verified through the fixpoint.**
   Yo has TWO frontends now: the TS compiler and the self-hosted
   `yo-self/lexer.yo` + `parser.yo` + `expr.yo`. A dual-accept keyword means
   teaching both, keeping them byte-identical in behavior, and carrying the
   dialect through every stage-2/stage-3 emission — double the surface for
   zero benefit.

3. **The whole point is reserving the word.** As long as `forall(T)` still
   parses as a type binder, the migration hasn't happened: new code keeps
   being written in the old dialect, test corpora accumulate mixed usage, and
   the eventual verification work inherits the ambiguity anyway. The alias
   period just postpones the same atomic flip.

4. **The atomic flip is cheap.** The rename is a word-boundary text
   substitution plus `yo fmt` — one mechanical sweep, one commit, one gate
   run. A transition period costs more engineering than the cutover it
   avoids.

## Deviation from the plan — `exists` / `∃` are NOT reserved

The plan called for reserving `forall`, `exists`, `∀` and `∃`. Its risk table
surveyed collisions for the INCOMING word (`generic` — clean, re-verified at
execution time: zero identifiers named `generic`) but not for the OUTGOING
reservations. Reserving `exists` broke the build immediately:

```
Lexer Error at row 15: `exists` is reserved for verification quantifiers.
  yo-self/init.yo  <- via yo-self/tests/init.test.yo
```

`std/fs/file.yo:324` defines `exists(path, io)` — a public filesystem API used
in **72 files / 101 occurrences** (`build_runner.yo`, `lock_file.yo`,
`init.yo`, …). Reserving the word would break the standard library for a
feature that does not exist yet, so:

- **RESERVED:** `forall`, `∀` — the word this migration actually frees.
- **NOT reserved:** `exists`, `∃` — left as ordinary identifiers.

When verification work starts it must either choose another spelling for the
existential quantifier or rename `fs.exists` in its own deliberate commit;
either way that is a decision for `plans/VERIFICATION.md`, not a side effect of
a keyword rename. A negative test pins the current behaviour
(`src/tests/reserved-quantifiers.test.ts`, "`exists` is NOT reserved").

Instead of an alias, the cutover ships **reserved-word diagnostics**: after
the rename, `forall` (and `exists`, `∀`, `∃`) become _reserved keywords_ that
produce a targeted error —

```
`forall` is reserved for verification quantifiers. Use `generic(T)` to
declare type parameters.
```

— so any stale code fails loudly with the exact fix, not with a mystery
"unknown identifier" cascade. This is strictly better UX than an alias for a
zero-user language.

## Timing constraint

**Do NOT land this mid-bootstrap-campaign.** The rename touches
`yo-self/**/*.yo` (759 occurrences in 50 files), `std/` (260 in 24), and
`tests/` (169 in 29) — the stage-2 fixpoint (`stage2.c ≡ stage3.c`) is only
meaningful when the TS compiler, the yo-self sources, and every `.yo` corpus
change in the SAME commit. Sequencing:

- Wait for the current #69 campaign (`plans/YO_SELF_STAGE2_HANDOFF.md`) to
  reach a committed, gates-green resting point.
- Land this migration as ONE atomic commit, gated by the full battery below.
- Any in-flight yo-self work must be committed or reverted first; the rename
  rebases trivially (it is mechanical) but must never interleave.

## Scope inventory (surveyed 2026-07-23)

| Surface                                        | Where                                                                                                                     | Size                                                                      |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| TS keyword table                               | `src/expr.ts:662` `forall: ["forall", "∀"]`                                                                               | 1 entry + `BuiltinKeywords.forall` references across ~20 files            |
| TS literal strings                             | `src/evaluator/types/function.ts:244` (error message), `src/doc/builder.ts:406,797` (doc-pipeline token checks), comments | handful                                                                   |
| TS tests with embedded Yo                      | `src/tests/comptime-ref-gate.test.ts` (+ grep sweep for others)                                                           | ~5 occurrences                                                            |
| yo-self keyword constant                       | `yo-self/expr.yo:233` `BK_FORALL :: "forall";` + export + all `BK_FORALL` uses                                            | 1 constant, many refs                                                     |
| yo-self sources (as Yo code using the keyword) | `yo-self/**/*.yo`                                                                                                         | 50 files / 759 occurrences                                                |
| std                                            | `std/**/*.yo`                                                                                                             | 24 files / 260 occurrences                                                |
| tests                                          | `tests/**/*.yo`                                                                                                           | 29 files / 169 occurrences                                                |
| yo-self tests                                  | `yo-self/tests/*.yo` (incl. source-string literals fed to the self-hosted lexer/parser)                                   | 8 files                                                                   |
| Docs                                           | `docs/en-US/` + `docs/zh-CN/` (both languages, per repo rule)                                                             | 12 files each, ~130 occurrences total                                     |
| Instructions & skills                          | `.github/instructions/*.md` (5 files), `.github/skills/*` (5 files)                                                       | prose + snippets                                                          |
| VS Code extension                              | `vscode-extension/syntaxes/yo.tmLanguage.json`, `syntaxes/yo.vim`                                                         | keyword lists; rebuild with `bun package`                                 |
| Plans                                          | `plans/*.md` containing `forall` snippets                                                                                 | update opportunistically; historical docs may keep old syntax with a note |

**Non-goal (deliberate):** internal implementation identifiers —
`FuncMeta.forall_labels`, `forall_types`, `forallTypes`, `fa_bound_names`,
etc. in both compilers — are NOT renamed in this migration. They are
invisible to users, and renaming them would churn thousands of lines through
the bootstrap fixpoint for zero user-facing gain. An optional follow-up
commit may align them (`generic_labels`, …) once the bootstrap is fully
closed; it must be a separate commit so the keyword flip stays reviewable.

## Migration steps

Each step lists its verification. The whole sequence is ONE commit; the gate
battery runs once at the end (plus quick checks along the way).

1. **TS compiler keyword flip.**

   - `src/expr.ts`: rename the `BuiltinKeywords` key `forall` → `generic`,
     value `["generic"]` (drop `∀` — it follows the quantifier, returning
     only with verification).
   - Rename all `BuiltinKeywords.forall` references (mechanical; TypeScript
     compiler enforces completeness — `bun run build` fails on any miss).
   - Update literal strings: `function.ts:244` error message,
     `doc/builder.ts:406,797` token-value checks.
   - Verify: `bun run build` clean.

2. **Reserved-word diagnostics (TS).**

   - Add `forall`, `exists`, `∀`, `∃` to a reserved-keywords set checked at
     parse time; parsing any of them yields the targeted error above (for
     `exists`/`∃`: "…reserved for verification quantifiers." without the
     generic hint).
   - Add a negative test (`tests/` + expected error) for each.
   - Verify: new tests fail before, pass after.

3. **yo-self frontend flip.**

   - `yo-self/expr.yo`: `BK_FORALL :: "forall"` → `BK_GENERIC :: "generic"`;
     update the export and every `BK_FORALL` reference (`grep -rn BK_FORALL
yo-self/`).
   - Port the reserved-word diagnostics identically (parser parity is a
     STRICT_FIXPOINT prerequisite).

4. **Mechanical source rewrite.**

   - Word-boundary substitution `forall` → `generic` across `std/`, `tests/`,
     `yo-self/` (including `yo-self/tests/` source-string literals),
     `examples/` if present, and the embedded Yo snippets in `src/tests/*.ts`.
   - Prose comments that _mention_ the keyword are rewritten too — after this
     commit the word `forall` must appear in the tree only in (a) the
     reserved-word diagnostics/tests, (b) internal identifiers (see
     non-goal), and (c) historical docs in `plans/`/`issues/`.
   - Verify: `grep -rn '\bforall\b' std tests yo-self --include='*.yo'`
     returns ONLY internal identifiers (e.g. `forall_labels`) — audit the
     residue list explicitly.

5. **Format.**

   - `./yo-cli fmt` over every touched `.yo` file; `./yo-cli fmt --check` to
     verify. (Also confirms the new keyword round-trips the formatter.)

6. **Docs, instructions, tooling.**

   - `docs/en-US/` AND `docs/zh-CN/` (12 files each — both languages, per
     repo rule).
   - `.github/instructions/*.md` and `.github/skills/*` cheatsheets.
   - `vscode-extension/syntaxes/yo.tmLanguage.json` + `yo.vim` keyword lists;
     rebuild: `cd vscode-extension && bun package`.

7. **Gate battery (the same discipline as the bootstrap campaign).**

   - `bun run build && bun test src/tests/fixme.test.ts`.
   - Full integration suite: `./yo-cli test --bail` (~30 min).
   - Bootstrap chain: build s1 from `yo-self/main.yo`; s1 battery on the
     known-sensitive test files; corpus diff-test
     (`scripts/diff-test.sh tests/codegen-bootstrap --release --parallel 4`,
     baseline PASS/DIFF counts must match pre-rename); `s1 check ./std`;
     stage2 emit → clang → stage3 emit → **STRICT_FIXPOINT** (`cmp stage2.c
stage3.c`).
   - The 183-file `s2 test ./tests` sweep count must match the pre-rename
     baseline exactly.

8. **Post-land bookkeeping.**
   - Update `.github/skills/yo-syntax/syntax-cheatsheet.md` "reserved words"
     section with `forall`/`exists`/`∀`/`∃` and the rationale pointer to this
     plan.
   - Note the rename in `plans/YO_SELF_STAGE2_HANDOFF.md` (or its successor)
     so future bootstrap sessions don't "fix" `generic` back.
   - When the verification feature work starts, `exists: ["exists", "∃"]`
     and the quantifier `forall: ["forall", "∀"]` graduate from reserved to
     real — that design belongs to a separate `plans/VERIFICATION.md`.

## Execution log — 2026-07-26

### Counts at execution (the plan's were surveyed 2026-07-23)

| surface    | plan   | actual (word-boundary `\bforall\b`) |
| ---------- | ------ | ----------------------------------- |
| `std/`     | 260/24 | 255 in 24 files                     |
| `tests/`   | 169/29 | 167 in 28 files                     |
| `yo-self/` | 759/50 | **316 in 41 files**                 |
| `docs/`    | ~130   | 119 in 22 files                     |
| `src/*.ts` | —      | 335 in 50 files                     |

The yo-self gap is not missing files: the plan's 759 counted the `forall`
SUBSTRING (695 today), which includes the ~370 `forall_*` internal identifiers
the plan excludes as a non-goal. A `\bforall\b` substitution cannot touch those
(`_` is a word character), so the identifiers are protected automatically —
verified: `forallParameters` 133 occurrences before AND after the sweep.

### Beyond the plan's list

The plan named two TS literal-string sites. Sweeping found more that are
user-visible, not prose: `types/function.ts:385` (`Use "comptime(x)" or put this
in "forall(...)"`) and `:1710` (`name: "forall(...)"`, a signature-zone label).
All of `src/**/*.ts` was swept for `\bforall\b` instead of a hand-picked list.

### Verification

| gate                                           | result                                       |
| ---------------------------------------------- | -------------------------------------------- |
| `bun run build`                                | clean                                        |
| `bun test src/tests/fixme.test.ts`             | 1 pass                                       |
| `bun test build-system.test.ts`                | 121 pass                                     |
| `src/tests/reserved-quantifiers.test.ts` (new) | 5 pass                                       |
| residue audit `\bforall\b` in `.yo`            | **0** (130 `forall_*` identifiers preserved) |
| `./yo-cli fmt --check std tests yo-self`       | clean                                        |
| positive: `fn(generic(T : Type), …)`           | compiles and runs                            |
| negative: `fn(forall(T : Type), …)`            | rejected with the targeted diagnostic        |

Full suite (`./yo-cli test`, no `--bail`): 3393 passed / 92 failed. Accounting
for every failure:

- **79 are in `tmp/`** — a git-ignored scratch directory (0 tracked files, 78
  leftover `test_debug*` / `test_phase5f*` files from earlier sessions) that a
  bare `./yo-cli test` sweeps up. Not corpus.
- **3 are the documented known-heavy yo-self files** (`eval_basics`,
  `eval_tail_1`, `eval_tail_2`) that exceed the runner's isolated-process limit
  — see `AGENTS.md`.
- **1 is `await_analysis`**, confirmed pre-existing: it fails identically with
  the migration stashed (`Type mismatch for type member "resolved_concrete"`).
- **The remaining 9** were re-run SEQUENTIALLY against a stashed HEAD and the
  migrated tree, and the two runs are identical file for file: `effect_analysis`
  19, `macro_registry` 5, `phase6_verify` 3, `phase6c_macro` 2,
  `phase6f_macro_helpers` 3 all pass in BOTH (they only fail under the
  10-worker sweep — parallel-load timeouts), and `type_trait_methods` (14/3)
  and `types_guards` (44/1) fail in BOTH.

**Net: zero regressions attributable to the rename.**

### Still outstanding

The bootstrap chain (step 7's second half) has NOT been run: s1 build, s1
battery, corpus diff-test, `s1 check ./std`, stage2 → clang → stage3 →
STRICT_FIXPOINT, and the 183-file sweep against the
132 GREEN / 32 HOLLOW / 19 RED baseline. That is ~2.5 h of wall clock and must
pass before this is considered landed.

## Risks

| Risk                                                                                                   | Mitigation                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Missed occurrence in an embedded source string (TS tests, yo-self tests feeding the self-hosted lexer) | Step 4's residue audit is an explicit gate; the reserved-word diagnostic makes any miss fail LOUDLY with the exact fix.                                                                                                          |
| Golden/expected-output strings containing `forall` (error-message snapshots)                           | The full `./yo-cli test --bail` run catches these; update goldens in the same commit.                                                                                                                                            |
| Bootstrap fixpoint churn (every yo-self file's ids shift)                                              | Expected and harmless — the fixpoint compares stage2 vs stage3 of the SAME tree; both move together. The risk is only interleaving with other yo-self work → the Timing rule.                                                    |
| `generic` colliding with existing identifiers named `generic` in Yo source                             | Surveyed 2026-07-23: every `\bgeneric\b` hit in `std/`, `tests/`, `yo-self/` is prose (test names, comments, error-message strings) — NO identifier is named `generic`. Re-run the grep before landing in case new code appears. |
| VS Code extension staleness                                                                            | Rebuild + reload is a documented step; stale highlighting is cosmetic and known-stale per AGENTS.md.                                                                                                                             |

## Estimate

One focused session: the rewrite itself is < 1 hour mechanical; the gate
battery dominates (~30 min TS suite + ~2.5 h bootstrap chain wall-clock).
