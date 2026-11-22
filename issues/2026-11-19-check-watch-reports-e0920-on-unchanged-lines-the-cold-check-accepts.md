# `check --watch` reports E0920 on unchanged lines the cold check accepts

**Severity:** S3 — a watch round reports false E0920 errors on code that a cold `yo check` of the same tree accepts. The incremental loop cannot be trusted while it happens, and a user falls back to the ~105 s cold check. No wrong code is accepted and nothing is miscompiled.

**Status:** OPEN (found 2026-11-19 by the R7 lane during its `check ./src` loop; seed v0.2.78)

## What was seen

The R7 lane ran `yo check ./src --std-path ./std --watch` with the v0.2.78 seed while it converted the compiler's ~50 `ref(struct(...))` records to value structs. Those edits touched about 50 files in `src/codegen/**`, `src/evaluator/**` and `src/verifier/**`.

**The session**
- The initial pass printed per-file verdicts.
- Round 1: `revalidated 0 definition(s), rechecked 71 file(s), 37 failed (203358ms)`.
- Round 2: `revalidated 173 definition(s), rechecked 148 file(s), 143 failed (735811ms)`.

**The false errors.** Round 2 reported 304 E0920 errors (`` `x` is a `&mut` borrow: … `.*` does not apply to a borrow ``) at two lines of `src/evaluator/utils.yo`:

```text
error[E0920]: `rr_el` is a `&mut` borrow: a borrow reads as its value, and `.*` does not apply to a borrow until decision 43 (references become types).
  --> src/evaluator/utils.yo:11208:65
      origin := if(match(rr_o, Rc(.OriginSet(_, rr_el)) => rr_el.*, _ => false), {

error[E0920]: `fargs` is a `&mut` borrow: …
  --> src/evaluator/utils.yo:8434:240
      … && _lb_any_binds_name(&fargs.*, name.clone()))
```

- `rr_el.*` produced 10 of the errors; `fargs.*` at 8434 produced 142.
- The `fargs` binder comes from `Rc(.FnCall(_, fc, Rc(fargs), _, _))` at line 8430.

**Why they are false**
- Both lines are byte-identical to develop `939fe7160` (lines 11178 and 8435 there).
- The R7 edits never touched either line.
- A cold `yo check ./src --std-path ./std` of the same tree, with the same seed, passed 273/273 files. That run was at `532584e0a`, where the lines sit at 11226 and 8434.

**What the two sites share.** In both, the binder comes from a pattern under an `Rc(...)` deref pattern (`Rc(.OriginSet(_, rr_el))`, `Rc(.FnCall(_, fc, Rc(fargs), _, _))`). Its `.*` is read inside a function that the round re-forces as a dependent. The notes name `_rigidify_elided_origins`, `rigid_param_slot`, `param_declared_origin_slot` and `_bind_join_subset_check`. Each is "evaluated here because it is referenced before its definition", so the re-force goes through the forward-reference path.

The watch round binds the pattern's binder as a `&mut` borrow binding; the cold pass binds it as a value. The likely cause is that the re-forced definition is evaluated under a different scrutinee mode, or a different binding-mode table, than the definition-order cold pass uses. This was not confirmed in the code.

## Reproduction (best available)

1. With the v0.2.78 seed, run `yo check ./src --std-path ./std --watch` on a tree at R7's pre-rebase state.
2. While the watcher runs, apply a batch of body edits across files that `src/evaluator/utils.yo`'s importers depend on. The R7 package-2 edits were `get(` → `get_cloned(` and adding `.clone()`.
3. The round that re-forces `utils.yo`'s dependents (the 148-file recheck above) reports E0920 at the two lines.
4. Stop the watcher and run a cold `yo check ./src --std-path ./std`. Neither line is reported.

The full session log was `tmp/watch.log` in the R7 worktree. `tmp/` is gitignored, so it is not part of the branch. Its first E0920 is at log line 3823, right after round 1's summary.

## Why there is no failing test yet

- The trigger is a large multi-file edit sequence inside one resident session. Reproducing it needs a whole-compiler watch session (~6–10 GB, 10+ minutes per round).
- The only harness is `tests/internal/check_watch.test.yo`, whose fixtures are small projects. Isolating which edit flips the binder needs a minimized trigger, and that was out of scope for the R7 PR.
- It was observed only with the v0.2.78 seed, not with a tree-built binary.

The next step is a fixture for `check_watch.test.yo`:
1. A module whose function matches `Rc(.Variant(_, x))` and reads `x.*`.
2. A second module that references that function before its definition.
3. A body edit to the second module.

A failing row there would be the test this doc needs.
