# Handover: what must land for v0.2.51, before VALUES_BY_DEFAULT starts

**Status: ACTIVE handover, written 2026-10-04; §0 records the outcome.** The session that ran
v0.2.50 stopped here. Develop is at `692399851` and `SEED_VERSION` is
v0.2.50 (published, notes curated).

**The goal.** v0.2.51 must carry everything
[`VALUES_BY_DEFAULT.md`](VALUES_BY_DEFAULT.md) needs from a seed. Once
v0.2.51 is published and the release pipeline bumps `SEED_VERSION` to it, the
values-by-default migration starts with **V1 step 0b** (§5 below).

## 0. Outcome (updated 2026-10-04, after the release)

RELEASE_LINE

**What landed for v0.2.51:**

| PR | What |
| --- | --- |
| #1172, #1173, #1174, #1176 | As planned in §1 (merged 2026-10-03/04). |
| **#1178** | Replaces #1164, #1165 and the WIP `fix/newtype-ctor-retain`, folded into one PR with one battery: the newtype ctor retain fix (S1), `ref_count(x)` (V1 step 0a), and `?=` defaults (resolve in the defining module; a runtime-call default is E1105). The #1165 restack items of §1 are done. 42/42 CI jobs green. |
| #1171, #1177 | s3 batches 1 and 3 (another session). |
| #1179 | Fixes the macOS/Linux build break #1171 introduced (`poll` declared with `*u8`). |
| #1167 | Async audit A2–A5 + A1 Generation B (yo-37). |
| `fix-test-one-path` | `yo test` with a second path is an error (yo-37). |

**S3's heap corruption (§3.1) is solved: it was the seed.**
- A compiler built from S3 by the v0.2.50 seed corrupts its heap. A compiler built from the same S3 tree by a stage-1 of #1178, which carries the newtype-retain fix and #1172, passes `tests/string/string.test.yo` **302/302** with no corruption.
- So S3 lands on a v0.2.51 seed, with no S3 code change. The suspects listed in §3.1 are cleared.
- The test-file fix of §3.2 (`(f : Impl(Fn() -> String)) = …`) is committed (`d5699aece` on `feat/string-cow`, carried by `feat/string-cow-on-1178`).

**Branches ready for the post-release agent.** All are pushed.

- **`chore/flatten-on-1178`** (`15a0f7fcb`): the #1163 sweep regenerated on #1178.
  - 542 groups in std/src.
  - Token guard: 0 files differ once parens and whitespace are stripped.
  - Formatted with #1178's stage-1.
  - The scanner is committed on that branch as `scripts/flatten-andor-chains.py`. Its rule is §2's.
  - Not gated yet. #1163 can be closed in its favour.
- **`feat/string-cow-on-1178`** (`06391cdbf`): S3 rebased onto the flatten above (clean).
  - Next: rebase onto the post-release develop, then run S3's remaining gates (§3.2).
  - After that, S4 (#1175) restacks on it.
- **`feat/ref-count-0b`**: **V1 step 0b**, prepared on #1178 and light-verified only.
  - `rc.test` 75/75, `rc_binding_gives_way` 5/5, a dozen std test files, fmt clean.
  - About 226 count reads renamed to `ref_count`, 37 `rc` bindings renamed.
  - `BF_RC`, `_evaluate_rc_or_call`, `_rc_call_gave_way` and `name_resolves_to_binding` are deleted.
  - Prelude `rc(own(value)) -> Box(V)` mirrors `box`.
  - **Blocked on markdown_yo:** v0.0.9 binds a local `(rc : bool)` in `src/block/table.yo`, a shadowing error once the prelude exports `rc`. markdown_yo#14 now also renames it (`89853b7`).
  - Needed before 0b can land: merge markdown_yo#14 and tag **v0.0.10** (the maintainer's call), then bump `yo.toml` to `^0.0.10` and refresh `yo.lock`.
  - Once markdown_yo no longer binds `ref_count` either, reserving `ref_count` is a one-line follow-up.
  - Heavy gates still owed (all on the v0.2.51 seed): `check ./src`, build, fixpoint, `gates_fast`, the suite. Re-record the two skill goldens the light pass could not run (`build-stamp-dotted-dir`, `init-build-test`).

**Order after the release:**
1. Step 0b.
2. The flatten.
3. S3, then S4.
4. V1 proper.

S3 and step 0b are independent, so either can go first if markdown_yo v0.0.10 is late.

Every item is a pushed branch or PR. No state lives only on the old machine.
Re-create worktrees with `git worktree add`, then
`git -c protocol.file.allow=always submodule update --init`. Do not skip the
submodule step: a stage-1 built without `vendor/mimalloc` fails GATE 7 on the
`compile-emit-chunks` golden.

## 1. Open PRs and branches, in landing order

| # | Branch @ head | What | Local gates | Next action |
| --- | --- | --- | --- | --- |
| **#1172** | `fix/own-arg-retain` @ `c6459fb58` | **S1 use-after-frees.**<br>• Method-call arguments (`Type.m(x.f)`, `recv.m(..)`, vtable, builtin) lost their pending +1: `_dispatch_arg_code` in `src/codegen/exprs/other_fn_call.yo`.<br>• A move in a returning arm was released again at the tail: `variable_moved_at_cleanup_point` in `src/env.yo`.<br>• Cost: `check ./src` +2.9 % (18.5k receiver dup/drop pairs), accepted for correctness. | All green, including both fast-suite halves and `gates_fast` on the rebased head | Merge first. S3 depends on it. |
| **#1173** | `plans/box-count-invisible` | Plans only. `Box`'s count is invisible; `ref_count` reads only `Rc`/`Arc` in safe code; a statically unique `Box` skips `make_unique`. | docs | Merge (docs-only). |
| **#1174** | `std/push-element-clause-reland` @ `2b821fc16` | Re-lands #1128, `ArrayList.push`'s element clause. It was reverted in #1170 because CI's verify sweep runs the **seed**, and only v0.2.50 carries #1166. | Seed v0.2.50 sweep rc=0; fixtures prove with `0 assumed`; `verifier_list_len` 25/25; `gates_fast` green | Merge (independent of the stack). |
| **#1163** | `chore/flatten-andor-chains` @ `07b731b97` | The `&&`/`||` flatten sweep: 539 groups in std and src, parens only. Generated on top of #1172. | Fixpoint holds; `gates_fast` GATEs 1–7 green (GATE 7 run separately) | After #1172 squash-merges, **regenerate** rather than rebase (§2). |
| **#1164** | `feat/ref-count-builtin` @ `813c0d6d7` | **V1 step 0a.**<br>• `ref_count(x)` is the count builtin's new name.<br>• `rc(x)` gives way to a binding named `rc`: the evaluator decides in `_evaluate_rc_or_call` and codegen follows ExprInfo.<br>• `ref_count` is not reserved yet, because markdown_yo used a local named `ref_count`. | build, check src 278/278, fmt, fixpoint, rc.test 71/71; **`gates_fast` was still running when the session stopped** | Re-run `gates_fast` on the restacked head, then merge. |
| **#1165** | `fix/default-param-values` @ `042e9f339` | **S1 and S2 default-parameter fixes.**<br>• `?=` defaults resolve in the defining module (the definition env is stored with the default exprs; `default_param_eval_env`).<br>• A runtime-call default is **E1105**.<br>• The compiler's own runtime defaults became `Option(T) ?= .None` or required parameters. | Fixpoint holds; `gates_fast` green (CLI 360 pass) | Restack and merge. At restack (§2):<br>• move `issues/a-default-parameter-value-*.md` (2 files) to `issues/fixed/`;<br>• update DESIGN §Default parameter values (en + zh) and the `?=` bullet in `.github/instructions/yo-syntax.instructions.md`: "enforced as E1105; names resolve where the function is defined". |
| — | `fix/newtype-ctor-retain` @ `cd2bebfd5` (**WIP**, no PR) | **S1 use-after-free.** A newtype built from a field or a local (`V(_b : s._b)`, `b := …; V(_b : b)`) is emitted as a bare C cast with no retain. A subagent started the fix (`emit_deferred_dup_or_code` in the newtype constructor branch of `other_fn_call.yo`). The issue doc is on the S4 branch: `issues/fixed/a-newtype-built-from-a-field-projection-is-not-retained.md`. | none yet | Finish: the fix, tests (field / local / parameter / fresh local moved without a leak / call result), the issue doc moved to `issues/fixed/`, and full gates. Stack it on #1172. |
| — | `feat/string-cow` @ `fd7d1deeb` (**S3**, no PR yet) | **String copy-on-write** (`plans/STRING_VALUE_SEMANTICS.md` S3, "As implemented").<br>• A uniqueness step in every mutator; `clone` is O(1).<br>• `as_bytes` is gone: `to_bytes`, `into_bytes(own)`, `get_byte`; `from_bytes`/`from_utf8` take `own`.<br>• No `Index(usize)` on String.<br>• 313 `as_bytes` sites migrated, mostly to O(1) String snapshots.<br>• markdown_yo pinned by `rev` to markdown_yo#14 (`c950b8a`). | build ✓, check src 278/278 ✓, check std 178/178 ✓, fixpoint ✓, `--skip-c-compiler` compile ✓ | **Blocked:** §3.1. Then the remaining gates (§3.2). |
| **#1175** | `docs/string-values-s4` @ `98831e238` (draft, base `feat/string-cow`) | **S4.**<br>• DESIGN, STRINGS, INDEX_TRAIT, EXPLICIT_ALLOCATORS and PARALLELISM (en + zh), instructions and skills.<br>• The seven skill-tree goldens re-recorded. | Docs examples compiled and run; scorecard diffs are S3's, not S4's (§3.2) | Restack on S3 after S3 lands. Move the newtype issue doc out of this PR and into the newtype-fix PR. |
| **markdown_yo#14** | `chore/string-value-semantics` @ `c950b8a` | markdown_yo without `as_bytes`. Compiles against both the 0.2.47 std and the S3 std; 1056/1067 fixtures pass (11 skipped) on both; the footnote local is renamed `backref_count`. | green on both stds | Merge. Tagging a markdown_yo release (v0.0.10) is the maintainer's call. Until then the compiler pins it by `rev`. |
| **#1169** | `plans-vbd-async` | Plans only: VALUES_BY_DEFAULT §3.13 (async under values). | — | Review posted 2026-10-04 with two blocking gaps:<br>• combinators and timeouts over a borrowing future;<br>• an `Rc`-rooted borrow held across an await.<br>Plus one correction (`_execute_batch` can take `inout`). Needs the author's revision and the maintainer's verdict on open questions 13 and 14. Not a v0.2.51 blocker. |

**Merging.** The auto-mode classifier blocks an agent's
`gh pr merge --admin`. Hand the maintainer the exact
`! gh pr merge <n> --squash --admin --delete-branch`. The local branch delete
then fails because a worktree uses the branch:
1. run `git worktree remove --force <path>`;
2. run `git branch -D <name>`;
3. check the remote with `git ls-remote --heads origin <name>`.

Before deleting a base branch, retarget its stacked children.

## 2. Restacking after #1172 squash-merges

The stack was built on #1172's pre-squash head `c6459fb58`.

1. **Flatten (#1163).** Do not rebase a 539-group mechanical diff. Regenerate it on develop:
   - run the scanner from the PR body, which only removes the parens of a right-nested group whose depth-0 operators are all the same `&&`/`||`;
   - run `yo fmt` with the **tree's** stage-1, not the seed;
   - check the token-identity guard: with every `(`, `)` and whitespace stripped, each file equals develop's.
   Then `git push -f`, retarget the PR to `develop` (`gh pr edit 1163 --base develop`), `gh pr ready`, and run the gates.
2. **#1164 and #1165.** `git rebase --onto <new flatten head> 07b731b97 <branch>`. Both diffs are small. In #1164, `tests/rc.test.yo` conflicts with #1172's tests: the resolution is #1172's file plus #1164's appended block. Do not strip conflict markers by hand; that truncated a block once.
3. **The newtype fix, then S3, then S4**, in that order on top.

Each merge to develop needs a green local battery on the PR's final head (AGENTS.md):
- `check ./src`, `check ./std --std-path ./std`, `fmt --check` with the tree's stage-1;
- fixpoint and `gates_fast`;
- for a `src/` or `std/` change, the fast suite and the hollow sweep.

On this 32-core / 47 GB box, **at most two `gates_fast` runs at a time**: three concurrent runs each hit the 2-hour background limit.

## 3. String S3: what is left

### 3.1 Blocker: the S3-built compiler corrupts its own heap

`yo test ./tests/string/string.test.yo --std-path ./std` with a stage-1 built from `feat/string-cow` prints `mimalloc: error: … corrupted free list entry of size 48b`. It happens on every batch, deterministically. The **pre-S3** compiler (develop + #1172) compiles the same S3 test file without any error. So the bug is in S3's own runtime paths inside the compiler binary, not in the tests.

Next step: build an AddressSanitizer compiler from the S3 tree and run it on the String tests:

```bash
yo compile src/main.yo --std-path ./std --sanitize address --allocator system -o /tmp/yo-s3-asan
YO_TEST_LEAK_VERDICT=0 /tmp/yo-s3-asan test ./tests/string/string.test.yo --std-path ./std --parallel 1
```

Suspects, in order:
1. **The newtype-retain bug.** Any other `String(_bytes : <local or field>)` construction, or a newtype built the same way elsewhere in std or src that S3's new code paths now reach. Look for newtype constructions whose argument is a variable rather than `.Some(...)`/`.None`.
2. **`String._byte_list()`**, which returns a match binding of `self._bytes` from a by-value `self`.
3. **`String.into_bytes(own(self))`**, which returns the binding when the buffer is unique.
4. **`_make_unique` and `clear`**, which assign `self._bytes` inside a `match` on it.

`String.clone` itself is already safe: it rebuilds through `.Some(al)`, checked under ASan with the v0.2.50 seed.

### 3.2 Remaining S3 items

- **Test-file fix.** In `tests/string/string.test.yo` (around line 2580, in the test "COW: collection elements, struct fields and closures hold independent copies"), the closure binding needs a type: `(f : Impl(Fn() -> String)) = (() => { … })`. Today it fails with "Expected a function type". Run it through the tree formatter.
- **Re-record the `compile-profile` golden.** S3 adds a std function, so the count goes 92 → 93. With the clone fix, S4's scorecard should no longer show `compile-allocator-fixed-oom-shapes` or `test-in-file-tests` (both came from the clone use-after-free). Re-check `compile-allocator-fixed-oom` (NO-GOLDEN) against develop.
- **Full gates:** the fast suite in two halves, the hollow sweep, `yo test ./std`, and `gates_fast`.
- **Measure, as the plan requires:**
  - `check ./src` time on an **idle** machine, S3 against develop + #1172. The 439 s taken under load is not usable.
  - Stage-2 compile RSS with `--optimize 2`, no `--emit-c`.
  - Re-baseline the memory ratchet past ±10 %.
- **Seed rule for S3's std.** v0.2.51's bundles are built by the v0.2.50 seed, so S3's std must not rely on the newtype fix. Keep the `.Some(al)` clone shape until a seed carries the fix.
- **Two issues S3 closes,** already moved to `issues/fixed/` on the branch: the String byte-index place, and the lost write on an empty copy.

## 4. Other pre-v0.2.51 items

- **File an issue for a `check` gap.** `yo check` does not evaluate a generic body per instantiation, so an E0907 inside a generic std body appears only at `yo build`. S3 hit this in `std/http/wire.yo`, `std/io/bufio.yo` and `src/main.yo`.
  - **Workaround:** `yo compile src/main.yo --skip-c-compiler --std-path ./std` evaluates exactly what the build does, about 3× faster than a build.
  - It needs an `issues/` doc with a severity (S3 likely, as a quality rough edge) and a test.
- **Dangling issue refs.** `scripts/check-issue-refs.sh` reports **204** dangling `issues/…` references on develop, for example `docs/*/DESIGN.md` → `issues/fixed/method-on-a-phantom-generic-enum-is-not-found-through-a-comptime-type-param.md`. It is a cleanup, not a release blocker; batch it in one docs PR.
- **Step 0a follow-up (0b).** Once markdown_yo#14 is merged, step 0b can reserve `ref_count` (add it to `is_reserved_builtin_binding_name` in `src/token.yo`).

## 5. Releasing v0.2.51

AGENTS.md "Release notes" and the CI-run rules apply.

1. Freeze develop and announce it to any peer sessions (`ListAgents`).
2. Get one green develop battery on the tip. Diff the code dirs against the battery's head before dispatching: `git diff --stat <head>..origin/develop -- src/ std/ tests/ .github/ scripts/ build.yo` must be empty.
3. `gh workflow run release.yml --ref develop -f bump=patch`. Never cancel a `Release` run.
4. When it publishes, rewrite only `## Changes`. Keep line 1 and `## Native bundles` byte-for-byte; v0.2.38 and v0.2.50 are the models. Then confirm the auto-bump commit `ci: bump SEED_VERSION to v0.2.51`.

## 6. Then VALUES_BY_DEFAULT (for the next agent)

Start on a v0.2.51 seed. Read
[`VALUES_BY_DEFAULT.md`](VALUES_BY_DEFAULT.md):
- §3.2 constructors: `box`/`rc`/`arc` with `alloc : Option(Allocator) ?= .None`; the types are not callable;
- §3.5 cells: `__yo_cell` / `__yo_atomic_cell`; `Box` and `Rc` are distinct nominal wrappers over one cell;
- §3.11 allocators: a copy-on-write clone lands with its source's owner;
- decisions 11 and 12;
- V1 step 0.

**First task, step 0b.** It is only legal on a seed that carries 0a.
- Rename every count read `rc(x)` to `ref_count(x)` in std, src, tests, docs, skills and the pack: about 180 sites.
- Rename the 29 locals and parameters named `rc`.
- Delete `BF_RC` and the give-way helpers, `_evaluate_rc_or_call` and `_rc_call_gave_way`.
- Reserve `ref_count`.
- Add the prelude constructor `rc :: (fn(generic(T : Type), own(v) : T, (alloc : Option(Allocator)) ?= .None) -> Rc(T))`.
- Re-record the skill goldens.

**Then V1 proper:** the `Box` → `Rc` rename, the value `Box`, `Deref` auto-dereference with the `.*` rule, and the exclusivity assert at writes through `Rc`.

## 7. Lessons from this cycle

- **CI's front-end verify sweep runs the SEED** (`.github/actions/install-seed`). A std change that needs a compiler fix (Generation B) waits for a seed carrying the fix. #1128 shipped one release too early and had to be reverted (#1170). Verify a std contract change with `scripts/verify-src-sweep.sh` under the installed seed, not the tree's stage-1.
- **`yo check ./src` needs `--std-path ./std`** once src depends on a std change. Without it, the check runs against the seed's bundled std.
- **Format with the tree's stage-1.** The seed's formatter differs: GATE 6 failed on a file the seed formatted.
- **`git add -A ':!tmp'` exits non-zero** when `tmp` is gitignored, and a following `&& git commit` silently does not run. Check `git log` after committing.
- **zsh does not word-split an unquoted `$VAR`**, and an `echo` of a line of `=` signs is an `=`-expansion error. Use `bash -c` or quote.
- **The newtype-retain bug is in every seed up to and including v0.2.50.** Until a seed carries the fix, do not write `Newtype(_f : <field or local>)` with an RC payload in std; rebuild the payload through an enum constructor (`.Some(x)`).
