# Verification on by default

**Status: DECIDED 2026-11-13 — backlog. Lane E's first track after VALUES_BY_DEFAULT
closes: it starts at v0.2.80.** The maintainer accepted the staged path of §1 and asked
for it to lead the post-VBD work. The default itself flips only when the gates of §4
hold; what starts first is the work that makes them hold.

Filed the same day as a design question and promoted to a plan when the verdict was
given. (The file is not called `VERIFICATION_BY_DEFAULT`: that abbreviates to "VBD",
which already names VALUES_BY_DEFAULT.) Tree citations are to `origin/develop`
`0f82f79ee`; measurements were taken with `yo 0.2.77` and Z3 5.1.0 on 2026-11-13 unless
dated otherwise. *Judgment* marks an assessment.

## 1. The decision

Today a module is verified only when it carries `pragma(Pragma.Verify);` or
`pragma(Pragma.VerifyOrAssert);`. With no pragma the mode is `runtime`: contracts and
the automatic bounds, division and shift checks are runtime assertions.

Yo is written mostly by language models, and a model gains more from a counter-example
at compile time than a human does. So proving becomes the normal path, and a pragma
becomes how a module leaves it.

| # | Verdict (maintainer, 2026-11-13) |
| --- | --- |
| D1 | **Staged.** `yo init` scaffolds the pragma into new projects first; the language default flips later, behind gates |
| D2 | **The default mode is `verify+`, never `verify`.** A solver limit must not fail a build |
| D3 | **`verify` and `--strict` stay opt-in**, for CI gates, `spec/` directories and modules that claim to be fully proved |
| D4 | **The two pragmas collapse to one at the flip.** Until then both stay exactly as they are |
| D5 | **This track leads lane E after VBD** ([`POST_VBD_PLAN.md`](POST_VBD_PLAN.md) phase 0) |

Both behaviours survive the flip. Only one spelling goes, because its behaviour becomes
what a module gets with no pragma:

| | Today | After the default flips |
| --- | --- | --- |
| No pragma | `runtime` (nothing proved) | `verify+` (prove what the solver can, keep a runtime check for the rest) |
| `pragma(Pragma.VerifyOrAssert);` | `verify+` | deleted: it would restate the default |
| `pragma(Pragma.Verify);` | `verify` (strict) | still `verify` (strict), under a clearer name |
| Opt-out pragma | none exists | new: puts a module back in `runtime` |

The two modes differ in one case only:

| Solver's answer | `verify` | `verify+` |
| --- | --- | --- |
| Proved | runtime check erased | runtime check erased |
| Refuted, with a counter-example | build fails | build fails |
| Gave up (budget exhausted) | build fails | build succeeds, runtime check kept |

## 2. Why the default cannot flip today

- **It is a language policy, not a flag.** An unannotated function that indexes a list
  is a compile error under both pragmas:

  ```yo
  pragma(Pragma.VerifyOrAssert);
  { ArrayList } :: import("std/collections/array_list");

  get_unchecked :: (fn(xs : &ArrayList(i32), i : usize) -> (r : i32))(xs(i));
  ```

  ```text
    refuted  fn@user_demo_plus.yo:3 [verify+]
      fn@user_demo_plus.yo:3/index-in-bounds@4:69: REFUTED  counter-example: i = #xffffffffffffffff, …
  ```

  Flipped as it stands, every partial operation must be proved safe or guarded in the
  source, and every existing program breaks. §5 question 1 asks whether that is the
  rule wanted.
- **Most code is outside the subset.** On the compiler's own tree, 3,992 of 4,049 verify
  targets were `outside-subset` and 57 were `ok`, 50 of those vacuous
  ([`SELF_VERIFICATION.md`](SELF_VERIFICATION.md), baseline of 2026-09-18, before VBD).
- **A proving mode is the less safe mode when an assumption is wrong.** It erases
  runtime checks on the strength of proofs that rest on `assumed()` contracts nothing
  validates
  (`issues/2026-11-13-a-contradictory-assumed-contract-makes-every-caller-proved.md`:
  the same program aborts in `runtime` mode and silently returns the wrong value in
  `verify` mode). Most std bodies are `assumed()`.
- **Memory at scale.** `yo verify ./src` peaked at 9.33 GB and 195 s (2026-09-18)
  against 1.72 GB for `check src/main.yo` ([`POST_VBD_PLAN.md`](POST_VBD_PLAN.md) §0).
  Incremental verification (SELF_VERIFICATION lever L8) is not built.
- **An obligation the solver cannot decide is slow once.** One nonlinear
  `ensures(r <= (a * c))` over `u32` made a cold `yo compile` take 102 s under
  `Pragma.Verify` (the build failed: `UNPROVEN unknown: rlimit exhausted`) and 108 s
  under `Pragma.VerifyOrAssert` (the build succeeded: "verify+ fallback: the runtime
  assert stays"). The verdict is cached: the second compile took 14 s.

What is *not* an obstacle: solver time on ordinary code. A three-function module checks
in about 7 s with or without the pragma; the time is the prelude, and its three queries
take 91 ms.

## 3. The steps

In order. S1 and S2 need nothing else and start at v0.2.80.

| Step | What | Size | Depends on |
| --- | --- | --- | --- |
| **S1** | `yo init` scaffolds `pragma(Pragma.VerifyOrAssert);` in the source modules it generates, and the scaffolded `AGENTS.md` says so. `src/init.yo` already scaffolds a verified `spec/` | S: `src/init.yo` plus a cli-case golden | nothing |
| **S2** | A proved result is capped by what it rests on: the satisfiability probe per `assumed()` contract, the feasibility probe after a call, and `ok` naming the assumed contracts it used | about a week, with the vacuity probes of [`SELF_VERIFICATION.md`](SELF_VERIFICATION.md) | nothing |
| **S3** | std bodies the verifier walks instead of `assumed()` | weeks; it is the shared bottleneck of [`POST_VBD_PLAN.md`](POST_VBD_PLAN.md) phase 4, item 1 | the raw-buffer model ([`THEOREM_PROVING_DIRECTION.md`](THEOREM_PROVING_DIRECTION.md) R1) |
| **S4** | Incremental verification: an edit re-proves only the functions it changed, and a default-on `yo check` does not hold every function's state at once | L (SELF_VERIFICATION lever L8) | nothing |
| **S5** | Subset growth until the coverage gate holds: strings, exceptions as exit paths, trees as datatypes, collections through contracts | L (SELF_VERIFICATION levers L1–L4) | S3 for L4 |
| **S6** | **The flip.** One PR, seed-gated where it adds or removes a pragma name | M, plus the tree sweep below | every gate of §4 |

What the flip PR (S6) contains:

- the default mode becomes `verify+`;
- `Pragma.VerifyOrAssert` is deleted, with no alias and no deprecation window;
- an opt-out pragma back to `runtime` is added (none exists today);
- the strict pragma is renamed: `Verify` reads as the ordinary choice and is the strict
  one, which is the wrong way round for an author choosing by name;
- **the tree sweep:** every module of `src/`, `std/` and `tests/` that does not verify
  green at that commit gets the opt-out pragma, and the count of opted-out modules
  becomes a ratchet that may only fall. Without the sweep the flip breaks the
  repository's own build;
- the two standing texts are amended: [`FORMAL_VERIFICATION.md`](FORMAL_VERIFICATION.md)
  §Non-goals ("No mandatory verification") and [`SELF_VERIFICATION.md`](SELF_VERIFICATION.md)
  §Non-goals ("`runtime` stays the default for everyone else").

## 4. The gates for the flip

Each is a number or a verdict a CI job re-derives. None is asserted in prose.

| Gate | Holds when |
| --- | --- |
| **G1** std is proved | the std modules a default-on program reaches report no `assumed` outcome outside the published FFI and raw-pointer list (S3) |
| **G2** assumptions are checked | the issue of S2 is in `issues/fixed/`, with its fixtures |
| **G3** the overhead is bounded | on the compiler's front-end modules, a warm default-on `yo check` after a one-function edit is within a stated factor of the unverified time and a stated RSS; both numbers are set from the first S4 measurement, not before |
| **G4** the subset covers real code | a stated share of the functions in `tests/` and `std/` is inside the subset; the share is set from the first measurement after S5's first lever |
| **G5** no flaky builds | over the language suite, no obligation's verdict differs between two cold runs on two machines (the pinned Z3 and `rlimit` budgets make this checkable) |

## 5. Open questions

1. **What does default-on do with an unannotated partial operation?** Two answers:
   - **(a) A compile error**, as both pragmas behave today. This is "no hidden traps":
     every index, division and shift is proved or guarded in the source. It suits an
     author who never tires of writing `requires`, and it turns the flip into a
     migration of every program.
   - **(b) Keep the runtime guard and report it**, when the function carries no
     contract. A refuted automatic obligation in an uncontracted function means "some
     caller could pass a bad value", which is not a bug in that function. The tree has
     this treatment already for overflow obligations, which are elision-only: "the
     compile still succeeds, the function is still `ok`, and the overflow guard stays"
     (`tests/spec/fixtures/elision/add_unbounded_kept.yo`). Written contracts stay hard
     obligations in both answers.

   *Judgment:* (b) for the default and (a) for the strict pragma. Then the flip changes
   no accepted program's behaviour, erases the checks it can prove away, and still gives
   a counter-example for every contract the author wrote. Needs the maintainer's
   verdict before S6 is designed; S1–S5 do not depend on it.
2. **The names** of the strict pragma and of the opt-out pragma.
3. **Do `*.test.yo` files default too?** *Judgment:* yes, with the same rule; a test
   body that indexes with a literal proves trivially.
4. **G3's and G4's numbers.** Set by measurement, as the table says.

## 6. What does not change

- A Yo author never needs anything but `yo` and the solver it fetches.
- `--strict` keeps its meaning, and a `spec/` directory keeps its gate.
- An `assumed()` contract never elides a guard
  ([`SAFE_MODE_5B_VERIFIED_GUARD_ELISION.md`](SAFE_MODE_5B_VERIFIED_GUARD_ELISION.md)).
- Partial correctness stays the default (D12); termination is not made mandatory.
