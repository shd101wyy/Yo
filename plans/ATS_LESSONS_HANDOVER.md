# ATS lessons: handover

**Status:** written 2026-10-01 by the session (yo-7a) that ran the ATS-lessons
stack, handing over to an agent on another machine. The plan is
[`ATS_LESSONS_BEYOND_INDEXED_TYPES.md`](ATS_LESSONS_BEYOND_INDEXED_TYPES.md) and
its predecessor is
[`backlog/ATS_STYLE_INDEXED_TYPES.md`](backlog/ATS_STYLE_INDEXED_TYPES.md) (R1 is
done). Both stay authoritative for what each item means. This doc says where the
work stands and what to do next. Move it to `archive/` with a banner once §3 is
empty.

## 1. Where the plan stands

The plan's own status table predates the stack; it is updated in §3.2. The truth
on 2026-10-01:

| Item | State |
| --- | --- |
| A1 lemma layer (= R2) | slice 1 in #1075: a recursive `ghost_fn` becomes a declared function with a triggered definitional axiom. **The rest is open** (§3.3). |
| A2 must-use | in #1075: E0617, an expression statement may not drop a `Result` or a future |
| A3 spec-transparent pure fns | slice 1 in #1075: an uncontracted pure callee is transparent to specs. **Slice 2 is open** (§3.4). |
| A4 init proof token (S1) | in #1075: `set_len` deleted; the token is `Option(*(T))` (§3.6 says why not `RawSlice`) |
| A5 lexicographic `decreases` | in #1075 |
| A6 typestate idiom | docs in #1075; **its S3 dependency is still open** (§3.5) |
| §4 verified unsafe std | not started |

"In #1075" means **not yet on develop**: #1075 is open (§3.1).

## 2. Landed in this stretch (2026-09-30 → 2026-10-01)

- **R1 of the indexed-types plan** (#1037, #1038, #1045, #1048, #1050, #1053, #1057):
  the verifier's ArrayList list model; `get`/`pop`; the alias subset error;
  `old(self)` in every `assumed()` mutator's contract. All five DML examples prove.
- **#1086** (in v0.2.48): `yo fmt` no longer moves a trailing comment after a comma
  onto the next item, and keeps the blank line after a comment.
- **markdown_yo v0.0.9** (the compiler's dependency; that repo's #12 and #13):
  - no `set_len` calls;
  - fixes for a heap overflow on escape-dense text and a 256-byte leak per render;
  - CI runs `yo fmt --check` and `yo test`;
  - `release.yml` tags the bump commit and bumps `yo.toml`.
  Its AGENTS.md now says: publish only through `release.yml`, never a hand-pushed
  tag.

## 3. Open work, in order

### 3.0 The branches (2026-10-01)

- `feat/verifier-recursive-ghost-fn` = **#1075**, base `develop`, head `0b6d44499`.
  It holds the WHOLE stack. GitHub's stack feature refused both retargeting a
  stacked PR (`Cannot change the base branch because the pull request is part of
  a stack`) and merging one into its parent (`base branch policy prohibits the
  merge`, with no rules on that branch). So #1075's branch was fast-forwarded to
  the stack tip.
- #1076 shows as merged (GitHub saw its head inside its base). #1077–#1080 are
  closed with a "folded into #1075" comment.
- Their branches still exist and are all ancestors of `0b6d44499`. Delete them
  after #1075 merges:
  - `fix/arraylist-init-token`
  - `feat/verifier-lexicographic-decreases`
  - `docs/typestate-idiom`
  - `feat/must-use-results`
  - `feat/verifier-transparent-pure-fns`

### 3.1 Merge #1075

The user's instruction for this work (2026-10-01): **admin-merge as long as the
local gates pass.**

1. **The local gate on `0b6d44499`.** yo-7a started gate A (§4) at 16:06 on
   2026-10-01; the run is recorded in the §3.1 log below. If the log shows both
   gates green and #1075 merged, skip to step 4.
2. **develop moved after that tree** (at least #1074, `std/net` stream writes).
   E0617 is a new error, and code that landed after the gated tree was never
   checked against it. Merge `origin/develop` into the branch, then run on the
   MERGED tree, with a tree-built compiler:
   - `check ./std --std-path ./std`
   - `check ./src`
   - `check ./tests --test-bodies --exclude tests/cli-cases`
   - plus the test files of whatever landed.

   Every E0617 is a statement that drops a `Result` or a future. Fix it in that
   code: an assert where the test cares about the result, or `_ := ...;` where it
   does not.
3. Admin-merge (`gh pr merge 1075 --squash --admin --delete-branch`), then delete
   the five branches in §3.0. Cancel #1075's PR battery (36826336015, or its
   successor); never cancel a `develop` or `Release` run.
4. **yo-0e's #1073 (await-site fusion F0–F3) and #1090 (generic-aggregate
   futures)** are in yo-0e's handover. Gate them on develop WITH #1075, for the
   same E0617 reason.

Log (filled in by yo-7a while it still had the machine):

- gate A: running
- gate B: not started

### 3.2 Update the plan's status table

`ATS_LESSONS_BEYOND_INDEXED_TYPES.md`'s table still says "A2 not started" and so
on. With #1075 merged, rewrite it from §1 above, and change A4's bullets as #1075
already did (the token type). Docs only; fold it into the next code PR.

### 3.3 A1, the lemma layer (R2): the largest remaining item

Slice 1 landed with #1075. It covers recursive `ghost_fn` as a `VcFunDecl` plus a
`:pattern`-triggered definitional axiom, and the `body_abstract` obligations are
non-elidable (5b rule 5). Open:

- **Lemmas:** a `ghost_fn` returning `unit` with `requires`/`ensures`/`decreases`,
  checked once by induction over the measure. The recursive call's `ensures` is
  the induction hypothesis. At each use its `ensures` becomes a quantified axiom
  with a trigger.
- **std's lemmas:** the frame and point-update lemmas for every list measure std
  defines. Without them `push`, `swap` and every inductive list property stay
  `unknown`.
- **The exit fixtures** (none exist yet): `dml_append_seq`, `dml_sorted_insert`
  and `dml_member` prove, and their `_false` twins refute.
- **Two leftovers from the indexed-types plan:**
  - an alias-aware frame condition. Today a list mutation beside a possible alias
    is a subset error, the honest stopgap from #1053.
  - `for` over lists, which needs a `produced()` ghost. The user deferred it into
    R2.

Lesson from R1, for every slice: a verifier slice is not validated until a
TREE-built compiler runs its fixtures. A `(error ...)` from z3 followed by `sat`
looked like a real counterexample until #1050.

### 3.4 A3 slice 2

Slice 1 makes a callee with NO contracts transparent when its body is in the
subset and changes none of its arguments. The attempt is silent: an impure body
restores the ordinary "callee without contracts" subset error. Open:

- recursive callees, transparent only with a `decreases`;
- the message the plan asks for, naming the missing property (impure, outside the
  subset, or not terminating) instead of the generic subset error.

### 3.5 A6's dependency: an S3

`issues/method-on-a-phantom-generic-enum-is-not-found-through-a-comptime-type-param.md`
is still open. The struct twin is fixed. The typestate docs work today with
struct handles; the enum form waits on this.

### 3.6 Known limits found on the way (not bugs, or already filed)

- **The safe-mode VALUE gate (`_surfaces_raw_pointer`) does not look inside
  structs.** It catches a `*(T)` and an enum whose payload IS one, so a safe file
  may hold a `RawSlice(T)` (`String.raw_bytes()`). That is by design: a
  `RawSlice` is flow-checked, and returning one not rooted in caller storage is
  rejected (measured). It is also why the A4 token had to be `Option(*(T))`: the
  `Option(RawSlice(T))` first cut passed through safe code and read an
  uninitialized slot.
- **`check` reports one E0617 per file.** A sweep must re-check each file until
  it is clean. The 2026-10-01 sweep found 1 + 38 sites that way.
- **A directory `check ./tests` stops at
  `tests/cli-cases/doc-name-manifest-malformed`** (a deliberately bad
  `yo.toml`; a manifest error is fatal). Always pass `--exclude tests/cli-cases`;
  the first sweep was hollow past that file.
- **`tests/sync/channel.test.yo` fails `check --test-bodies` with E0906:**
  `issues/check-cannot-see-function-bodies-from-other-modules.md` (S2, open). It is
  a check-only limit; `yo test` passes it.

## 4. How to gate (read before merging anything)

Run on the exact tree you will merge. Take the heavy lock if peers share the
machine. On this machine the lock was `~/Workspace/Yo-wt/.heavy-lock`: mkdir to
take it, `rm -rf` to release. Build with the seed CI uses, which is
`SEED_VERSION` in `.github/workflows/test.yml`, v0.2.48 now. Use
`yo version install 0.2.48`; the binary is
`~/.cache/yo/versions/0.2.48/bin/yo`.

```bash
SEED=~/.cache/yo/versions/0.2.48/bin/yo
$SEED build && B=$PWD/yo-out/<target>/bin/yo
# Gate A (~60 min)
$B check ./std --std-path ./std && $B check ./src --std-path ./std
$B fmt --check ./std ./tests ./src
$B check ./tests --test-bodies --exclude tests/cli-cases --std-path ./std   # the E0617 sweep (loop per file, §3.6)
$B test ./tests --exclude tests/internal --exclude tests/cli-cases --std-path ./std
# Gate B (~60 min)
$B test ./std --std-path ./std
YO_TEST_Z3=1 $B test ./tests/spec --std-path ./std
for t in verifier_list_len verifier verifier_negative verifier_refine verifier_assumed \
         diagnostics_registry_examples diagnostics_registry formatter; do
  YO_TEST_Z3=1 YO_TEST_LEAK_VERDICT=0 $B test ./tests/internal/$t.test.yo --parallel 1 --std-path ./std
done
python3 scripts/check-guard-elision.py --bin "$B"            # expect N/N passed
YO_SELF_BIN=$B bash scripts/cli-diff-test.sh                  # expect 0 GOLDEN-DIFF, 0 NO-GOLDEN
cp $B /some/dir/outside/the/repo/yo-s1                        # S1 inside the repo reorders the C
S1=/some/dir/outside/the/repo/yo-s1 P=<unique> bash scripts/bootstrap/fixpoint_only.sh   # rc is the verdict
```

Then the verifier fixtures this stack added. Each `valid/` file must be all
`ok`, and each `negative/` twin must refute:

```bash
yo verify tests/spec/fixtures/<valid|negative>/<name>.yo --std-path ./std --no-cache
```

The fixtures:

- `generic_body_abstract`
- `ghost_fn_recursive`
- `decreases_lexicographic`
- `transparent_pure_fn`
- `dml_list_*`
- `variant_payload_construction`

Two traps:

- A `NO-GOLDEN ... vacuous` line from `cli-diff-test.sh` is a real failure, not a
  case to record over. The A4 cli-case was vacuous for a day: its keep-match never
  matched, and that hid the safe-code hole.
- `lsp-completion` and `lsp-member-definition` pin std method lists and line
  numbers, so any `std/collections/array_list.yo` edit re-records them:
  `cli-diff-test.sh --record lsp-completion lsp-member-definition`.
