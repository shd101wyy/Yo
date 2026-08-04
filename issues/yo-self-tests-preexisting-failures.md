# `yo-self/tests`: 12 pre-existing failures (OPEN), 6 fixed

Full-directory run at `e1e004a84` (`./yo-cli test ./yo-self/tests --parallel 2`):
**787 passed / 18 failed**. All 18 were triaged against a clean `2b6aa1db7`
worktree; **none are caused by the r15/r16 memory work** — the per-file failure
counts are IDENTICAL on both sides:

| file                         | at `e1e004a84` | at `2b6aa1db7` (isolated) |
| ---------------------------- | -------------- | ------------------------- |
| `value.test.yo`              | 5 failed       | **5 failed**              |
| `type_trait_methods.test.yo` | 3 failed       | **3 failed**              |
| `types_guards.test.yo`       | 1 failed       | **1 failed**              |
| `evaluator_index.test.yo`    | 1 failed       | **1 failed**              |

Also verified directly: no test in the suite references any field r15/r16 moved
(all thirteen `ExprInfo` rare names, plus `Variable.parameter_alias` /
`doc_comment`) — the only hit was `open.test.yo`, migrated in that commit.

## FIXED in `ba4c55a03` (6 of the 18)

Both were tests left stale by EARLIER landed changes, not by r15/r16.

1. **`env.test.yo` — "Variable.id is stable after shadowing"** (1).
   Three `.None` arms returned `String.from("missing")` while `v.id` has been a
   `usize` since `2b6aa1db7` made `Variable.id` a counter instead of a rendered
   String. The match arms disagreed on type, so the whole FILE failed to compile
   (which is why a single stale arm showed up as one failure among passes).
   Fixed to `usize(0)` — already the missing/err sentinel `make_err_variable`
   uses. **10/1 → 11/11.**

2. **`value.test.yo` — the five `PtrVal` tests** (5).
   They passed a bare `EvalValue` where the variant is
   `PtrVal(target_value : ArrayList(Self), target_index : usize)` — the first
   field is the shared mutable CELL (the same one-element list a `Variable` holds
   as its `value`). `value_to_string` reads `cell.get(0)` and only indexes with
   `target_index` when that element is an `ArrayVal`. Added a `_ptr_cell` helper
   and moved the `ArrayVal` inside the cell. **26/5 → 31/31.**

## STILL OPEN (12)

### a. The documented known-heavy trio (3) — expected, not a bug

`eval_basics.test.yo`, `eval_tail_1.test.yo`, `eval_tail_2.test.yo` exceed the
runner's 1800 s isolated-process limit; they `check` clean and are validated via
yo-self-bin sweeps instead. This is why the suite is excluded from CI
(`.github/workflows/test.yml`). Reported as a whole-file
`✗ Module evaluation` + "Failed to import module".

### b. `evaluator_index.test.yo` (1) — a known-baseline consequence

Fails at its own import line:

```
{ has_comment_attribute, Evaluator } :: import("../evaluator/index.yo");
```

`yo-self/evaluator/index.yo` is one of the 10 files in the standing
`check ./yo-self` **295/305** baseline (`evaluator/eval.yo` + 9 cascading
circular-import failures — see `plans/YO_SELF_STAGE2_HANDOFF.md` §1). So this test
cannot pass until that baseline is repaired; it is not independent debt.

### c. Four `phase6*` whole-file failures (4) — undiagnosed

`phase6f_macro_helpers`, `phase6c_macro`, `phase6_verify`, `phase6d_reflection`
each fail as `✗ Module evaluation` / "Failed to import module <the test file>"
with **no nested cause printed**. Next step: run one in isolation with `-v` to get
the real error —

```bash
YO_MAIN_STACK_MB=4096 ./yo-cli test ./yo-self/tests/phase6c_macro.test.yo --parallel 1 -v
```

Suspicion (unverified): the same class as the two fixed above — a stale
construction or a renamed export that fails the file's compile, since the failure
is at module import rather than inside a test body.

### d. `type_trait_methods.test.yo` (3) and `types_guards.test.yo` (1) — undiagnosed

- `type_trait_methods`: `get_receiver_methods_by_name_from_env` — "SomeT with
  required trait", "TypeApplication HKT walk", "env-frames compatible-SomeType
  scan".
- `types_guards`: "is_rc_type: SomeT with Future trait constraint is RC".

All four report `Yo compilation error: Failed to import module
"…/.yo_test_batch_*.yo"` with no nested cause, and sibling tests in the same files
pass — so it is the per-test batch that fails to compile, not the file. `-v` on a
single test name is the way in:

```bash
YO_MAIN_STACK_MB=4096 ./yo-cli test ./yo-self/tests/types_guards.test.yo \
  --test-name-pattern "Future trait constraint" --parallel 1 -v
```

## Reproducing the triage

```bash
# full directory (~35-90 min; NEVER run two `yo-cli test` on one dir at once)
rm -f yo-self/tests/.yo_selftest_batch_* yo-self/tests/.yo_test_batch_*
YO_MAIN_STACK_MB=4096 ./yo-cli test ./yo-self/tests --parallel 2

# per-file, and the same file on a pre-change worktree for attribution
git worktree add /tmp/wt-pre <base-commit>
YO_MAIN_STACK_MB=4096 ./yo-cli test ./yo-self/tests/<f>.test.yo --parallel 1
```

`yo-cli test` takes ONE path — passing several makes yargs reject the extras as
"Unknown arguments" and exit 1, which looks exactly like a test failure. Loop
instead.
