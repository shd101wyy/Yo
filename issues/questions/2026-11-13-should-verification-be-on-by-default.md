# Should verification be on by default?

**Kind:** design question — an open decision, not a defect. Filed 2026-11-13 while
writing [`plans/backlog/PROVEN_CORE.md`](../../plans/backlog/PROVEN_CORE.md) §5.4.

## The question

Today a module is verified only when it carries `pragma(Pragma.Verify);` or
`pragma(Pragma.VerifyOrAssert);`. With no pragma the mode is `runtime`: contracts and
the automatic bounds, division and shift checks are runtime assertions.

Yo is written mostly by language models, and a model benefits from a counter-example
at compile time more than a human does. Should the default flip, so that every module
is verified unless it opts out?

Two standing texts say no:

- `plans/backlog/FORMAL_VERIFICATION.md` §Non-goals: "No mandatory verification. Code
  without contract annotations and without a verification pragma compiles exactly as
  today."
- `plans/backlog/SELF_VERIFICATION.md` §Non-goals: "`runtime` stays the default for
  everyone else."

## Facts (measured 2026-11-13, `yo 0.2.77`, unless dated otherwise)

- **Default-on is a language policy, not a flag.** An unannotated function that indexes
  a list is a compile error under both pragmas:

  ```yo
  pragma(Pragma.VerifyOrAssert);
  { ArrayList } :: import("std/collections/array_list");

  get_unchecked :: (fn(xs : &ArrayList(i32), i : usize) -> (r : i32))(xs(i));
  ```

  ```text
    refuted  fn@user_demo_plus.yo:3 [verify+]
      fn@user_demo_plus.yo:3/index-in-bounds@4:69: REFUTED  counter-example: i = #xffffffffffffffff, …
  ```

  So the flip means: every partial operation is proved safe or guarded in the source.
  That is a strong and defensible rule for an LLM-first language, and it is a breaking
  change to every existing program.
- **Most code is outside the subset.** On the compiler's own tree, 3,992 of 4,049
  verify targets were `outside-subset` and 57 were `ok`, 50 of those vacuous
  (`plans/backlog/SELF_VERIFICATION.md`, baseline of 2026-09-18, before VBD). Default-on
  today would mostly print `n/a`.
- **`verify` mode is the less safe mode when an assumption is wrong.** It erases the
  runtime contract checks on the strength of the proofs, and the proofs rest on
  `assumed()` contracts nothing validates
  (`issues/2026-11-13-a-contradictory-assumed-contract-makes-every-caller-proved.md`:
  the same program aborts in `runtime` mode and silently returns the wrong value in
  `verify` mode). Most std bodies are `assumed()`.
- **Solver time is not the overhead on small code.** A three-function module checks in
  about 7 s with or without the pragma; the time is the prelude, and the three queries
  take 91 ms.
- **Memory is the overhead at scale.** `yo verify ./src` peaked at 9.33 GB and 195 s
  (2026-09-18) against 1.72 GB for `check src/main.yo`
  (`plans/backlog/POST_VBD_PLAN.md` §0). Incremental verification (SELF_VERIFICATION
  lever L8) is not built.
- **`unknown` exists.** Nonlinear bit-vector goals stay `unknown` after about 44 s
  (`plans/backlog/THEOREM_PROVING_DIRECTION.md` §2). Under `verify` an `unknown` is a
  compile error; under `verify+` it falls back to a runtime check.
- **An obligation the solver cannot decide is slow in both modes.** One nonlinear
  `ensures(r <= (a * c))` over `u32` made a cold `yo compile` take 102 s under
  `Pragma.Verify` (which then failed: `UNPROVEN unknown: rlimit exhausted`) and 108 s
  under `Pragma.VerifyOrAssert` (which succeeded: "verify+ fallback: the runtime assert
  stays"). A default-on build pays that for every such obligation it cannot cache.
- **`yo init` already scaffolds a verified `spec/`** (`src/init.yo`: the claims wall,
  `yo verify ./spec --strict`).

## Options

**A. Flip the language default to `verify` now.** Every existing program breaks; every
solver `unknown` becomes a build failure; proofs rest on unvalidated std assumptions
while the runtime checks that would catch a wrong one are erased.

**B. Flip the language default to `verify+` now.** Same breakage as A for unannotated
partial operations; `unknown` no longer fails a build. The other costs of A remain.

**C. Never.** Keep `runtime` as the default. Leaves the compile-time counter-example,
which is the feature an LLM author gains most from, behind an opt-in the model has to
remember.

**D. Staged: new projects first, the language default behind gates.**

1. `yo init` scaffolds `pragma(Pragma.VerifyOrAssert);` in the source modules it
   generates, and the scaffolded `AGENTS.md` says so. New code, which is the code models
   write, is verified by default; nothing existing breaks; the choice is visible in the
   file.
2. The language default flips to `verify+` when all of these hold, each re-derived by a
   gate and not asserted:
   - the std bodies the verifier walks are proved, not `assumed()` (POST_VBD phase 4,
     item 1);
   - the hypothesis-provenance issue above is fixed;
   - incremental verification (L8) has landed, with `yo check` on an edited module
     inside a stated budget of the unverified time;
   - a stated share of `tests/` is inside the subset.
3. `verify` (an `unknown` fails the build) and `--strict` stay opt-in gates for CI and
   for `spec/` directories. They are never the default.

## Recommendation

**D.** The direction is right: for a language written by models, proving should be the
normal path and a pragma should be how you leave it. The flip itself is premature. Today
it would reject most existing code, print `n/a` for most of what it accepts, and trade
runtime checks for proofs that rest on assumptions nobody has checked. `verify+` is the
right default mode when the flip comes, because a solver limit must never fail a build.

If accepted, step 1 is a small `src/init.yo` change with a cli-case golden, after VBD.
Step 2 amends the two standing texts quoted above in the PR that flips the default.

## Verdict (maintainer, 2026-11-13)

**D, accepted.** Nothing starts before VBD closes.

- Step 1 (`yo init` scaffolds `pragma(Pragma.VerifyOrAssert);`) is a lane-E quick win in
  `plans/backlog/POST_VBD_PLAN.md` phase 1.
- Step 2 (the language default becomes `verify+`) waits for its four gates. The PR that
  flips it amends the two standing texts quoted at the top.
- `verify` and `--strict` stay opt-in.

One consequence to settle in the flip PR, not before: once `verify+` is the default,
`pragma(Pragma.VerifyOrAssert);` says nothing, and the two pragmas a module can still
need are the strict one (an `unknown` fails the build, no runtime fallback) and the
opt-out. Whether `Pragma.Verify` keeps its name then is part of that PR.
