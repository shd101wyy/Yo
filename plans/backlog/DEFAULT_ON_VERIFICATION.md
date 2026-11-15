# Verification on by default

**Status: DECIDED 2026-11-13 — backlog. Lane E's first track after VALUES_BY_DEFAULT
closes: it starts at v0.2.80.** The maintainer accepted the staged path of §1 and asked
for it to lead the post-VBD work. The default itself flips only when the gates of §4
hold; what starts first is the work that makes them hold.

**Amended 2026-11-15 (D7–D10), after the measurement of §2.2 and §2.3:** the flip is
two steps (report by default, then erase by default), S1 waits for a new S0, the
solver's distribution is a step (SD) and a gate (G6), and `yo build` proves every
module of its package (D10).

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
| D6 | **The default keeps the runtime guard of an unannotated partial operation and reports it; the strict pragma rejects it** (§2.1) |
| D7 | **The flip is two steps** (maintainer, 2026-11-15). *Report by default* (S6a): with no pragma the compiler proves what it can, fails the build on a refuted written contract, and keeps every runtime check. *Erase by default* (S6b): the default also removes the checks it proved, behind G1 and G2. D4's collapse to one pragma happens at S6b |
| D8 | **S1 waits for S0** (maintainer, 2026-11-15): the `verify+` defect found by §2.2 is fixed and every valid fixture runs in both modes before `yo init` scaffolds the pragma |
| D9 | **The solver must run wherever `yo` runs before the default depends on it** (maintainer, 2026-11-15): step SD, gate G6 (§2.3) |
| D10 | **Which command proves which module** (maintainer, 2026-11-15; §5 item 11). `yo build` proves every module of the package it builds, once each. `yo check <file>` proves that file. A dependency, std included, is not proved by its consumer: its contracts are the consumer's assumptions |

Both behaviours survive the flip. Only one spelling goes, because its behaviour becomes
what a module gets with no pragma:

| | Today | After S6a (report by default) | After S6b (erase by default) |
| --- | --- | --- | --- |
| No pragma | `runtime` (nothing proved) | report mode: prove what the solver can, fail on a refuted written contract, keep every runtime check | `verify+` (the same, and a proved check is erased) |
| `pragma(Pragma.VerifyOrAssert);` | `verify+` | `verify+`, unchanged: how a module asks for erasure early | deleted: it would restate the default |
| `pragma(Pragma.Verify);` | `verify` (strict) | still `verify` (strict), under a clearer name | the same |
| Opt-out pragma | none exists | new: puts a module back in `runtime` | the same |

**Why two steps (D7).** The reason for the default is the counter-example at compile
time (the paragraph above the verdict table). Erasing proved checks is a separate
benefit with a separate risk: a proof may rest on an `assumed()` contract that nothing
validates (§2, third bullet), and most std bodies are assumed. Report mode is exactly as
safe as `runtime` mode is today, so it does not have to wait for std to be proved (G1)
or for the assumption probes (G2). It needs only that the default is cheap, stable and
runnable everywhere (G3, G5, G6).

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
  source, and every existing program breaks. D6 settles it (§2.1): that rule is the
  strict pragma's, not the default's.
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

### 2.1 An unannotated partial operation under the default (D6)

The question was what a default-on build does with an index, a division or a shift in
a function that carries no contract. The two answers considered:

- **(a) A compile error**, as both pragmas behave today: every such operation is proved
  or guarded in the source. It turns the flip into a migration of every program.
- **(b) Keep the runtime guard and report it.** A refuted automatic obligation in an
  uncontracted function means "some caller could pass a bad value", which is not a bug
  in that function.

**Verdict (maintainer, 2026-11-13): (b) for the default, (a) for the strict pragma.**

| | Default (`verify+`) | Strict pragma (`verify`) |
| --- | --- | --- |
| Automatic obligation, proved | guard erased | guard erased |
| Automatic obligation, refuted, function has no contract | guard kept, site reported | build fails |
| Automatic obligation, refuted, function has a contract | build fails | build fails |
| A written `requires` / `ensures` / `invariant` / `assert`, refuted | build fails | build fails |
| Any obligation the solver gives up on | check kept, reported | build fails |

- The flip then changes no accepted program's behaviour: it erases the checks it can
  prove away and gives a counter-example for every contract the author wrote.
- Under D7's first step (S6a) the two "guard erased" cells of the default column read
  "guard kept". Nothing else in the table changes, and S6b restores them.
- The tree has this treatment already for overflow obligations, which are
  elision-only: "the compile still succeeds, the function is still `ok`, and the
  overflow guard stays" (`tests/spec/fixtures/elision/add_unbounded_kept.yo`). D6
  extends it to the other automatic obligations of an uncontracted function.
- "Has a contract" means the function writes at least one `requires`, `ensures` or
  refinement. An author who states a precondition has said what callers may pass, so a
  bad index under that precondition is a bug in the function.
- The kept guards are what the per-site report of
  [`PROVEN_CORE.md`](PROVEN_CORE.md) §8 item 4 lists, and the strict pragma is how a
  module claims it has none.

### 2.2 What it costs, measured 2026-11-15

Measured with `yo 0.2.77` and Z3 5.1.0 on the 64 GB Linux box (32 cores, other
jobs running, so wall times carry a few seconds of noise). *Judgment* marks an
extrapolation.

**On today's code the cost is close to zero, because the coverage is.** `yo
verify --no-cache` against `yo check` on the same path:

| Path | `check` | `verify` | Functions | Outside the subset | Solver queries |
| --- | --- | --- | --- | --- | --- |
| `std/collections` | 19.3 s, 294 MB | 19.4 s, 351 MB | 13 | 3 (9 more `assumed`) | 0 |
| `std/string` | 5.6 s | 5.6 s | 179 | 175 | 0 (6 with `--elision`) |
| `std/encoding` (7,118 lines) | 46.2 s, 291 MB | 54.8 s, then 44.5 s, 344 MB | 281 | 250 | 0 (6 with `--elision`) |
| `std/fmt` | 10.5 s | 10.6 s | 78 | 78 | 0 |
| `src/lexer.yo` | 40.9 s, 316 MB | 38.2 s, 309 MB | 6 | 6 | 0 |
| `src/parser.yo` | 43.7 s, 322 MB | 64.2 s loaded, 46.2 s on the next run, 324 MB | 52 | 52 | 0 |
| `src/formatter.yo` | 41.8 s, 354 MB | 39.7 s, 356 MB | 57 | 54 | 0 |

The 31 `ok` functions of `std/encoding` have no obligation at all. The reasons
a function is outside the subset, in `std/encoding`: 148 "parameter outside
the integer/bool/array subset", 57 "call to a callee without contracts", 15
"untyped expression". The three compiler modules give the first of these for
110 of their 112 outside-subset functions. An unannotated `while` is outside
the subset too ("while loop without a leading invariant"). With no query to
send, a run's cache state does not matter, and the differences between the
two time columns are machine load.

**Inside the subset, the cost is per obligation.** A generated module of small
contracted functions (integer arithmetic, a `cond`, a counting loop with an
invariant, a loop over an `Array`, an `ArrayList` index, a division and a
shift), with and without `pragma(Pragma.VerifyOrAssert);`, and a fresh
`YO_CACHE_DIR` for the cold runs:

| Functions (lines) | Command | No pragma | Cold cache | Warm cache | Queries |
| --- | --- | --- | --- | --- | --- |
| 71 (453) | `check` | 10.4 s | +3.9 s | +1.0 s | 120 |
| 281 (1,773) | `check` | 11.8 s | +18.3 s | +1.2 s | 480 |
| 1,121 (7,053) | `check` | 16.8 s, 308 MB | +77.1 s, 490 MB | +7.5 s | 1,920 |
| 71 (453) | `compile --skip-c-compiler` | 9.7 s | +6.9 s | none measurable | 200 |
| 281 (1,773) | `compile --skip-c-compiler` | 12.3 s | +31.6 s | +0.5 s | 800 |
| 1,121 (7,053) | `compile --skip-c-compiler` | 16.2 s, 588 MB | +125.9 s, 774 MB | +12.5 s | 3,200 |

- **A cold obligation costs about 40 ms**, and they run one after another:
  one fresh `z3` process per query through `system(3)`. Starting `z3` on a
  trivial script is 12 to 14 ms of that.
- **A warm obligation costs about 4 ms**: the walk that builds the query, its
  hash, and one cache file read. About 10 s of each "no pragma" time is the
  prelude, so the largest module itself costs about 7 s to check, and a warm
  verification doubles it.
- `compile` asks more than `check` (3.3 against 2 queries per function here)
  because it also generates the overflow obligations that let it remove a
  guard.
- Memory grew by about 185 MB (60 %) on the largest module.

**The tail is heavy.** Most obligations took 25 to 200 ms. A product of two
`i32` values whose `requires` bounds include negative numbers took 3 to 5 s
for each of its three obligations (13.6 s for one function), all proved. A
lower budget turns that into a bounded give-up: `--rlimit 200000` answers
`unproven` in about 1.1 s each, `--rlimit 50000` in about 0.35 s. §2's 102 s
example is the far end of the same tail, at the default budget of 5,000,000.

**A line shift empties the cache for the rest of the file.** A 70-function
module verified twice answers all 140 queries from the cache in 14 ms. After
one comment line is added at line 2, the third run solves all 140 again
(3.3 s): the query text names its variables by the function's path and row
(`issues/2026-11-15-one-inserted-line-invalidates-the-verify-cache-for-every-function-below-it.md`).
So for the file being edited, today's "warm" cost is the cold cost.

**The compiler at full coverage: the count is measured, the times are
*Judgment*.** Each runtime guard the compiler emits is one obligation a
verifier at full coverage would try to discharge. Counted in a `yo.c` emitted
from a develop-based worktree on 2026-11-08 (2,081,860 lines of C):

| Guard | Sites |
| --- | --- |
| overflow checks (`__yo_add_chk_*`, `__yo_sub_chk_*`, `__yo_mul_chk_*`, `__yo_neg_chk_*`) | 18,166, of which 2,368 are multiplications |
| division guards (`__yo_div_guard*`) | 1,189 |
| shift checks (`__yo_sh_chk`) | 91 |
| array index checks (`__yo_idx_chk`) | 86 |
| calls into bounds-checked container index functions | not counted exactly; several thousand |

That is 20,000 to 30,000 obligations, as an upper bound: the C counts a
generic function once per instantiation where the source would be verified
once, and a constant case folds without a query. `src/` has about 5,800
function definitions and 75 written contract clauses, so the automatic
obligations are nearly all of it.

What "verifying `./src`" means matters here. `yo compile <entry>` arms only
the entry file as a verification target; `yo check <dir>` and `yo verify
<dir>` arm every file under the directory (§5 item 11). The estimate is for every module
of `src/` being verified, against a `compile src/main.yo --skip-c-compiler`
of about 3 minutes:

| Scenario | Added time |
| --- | --- |
| today's coverage | none: no query is sent (the table at the top of this section) |
| full coverage, today's verifier, cold | 15 to 20 minutes at 40 ms each, plus the tail: 1 % of the multiplications exhausting the default budget, at about 100 s each, is another 40 minutes |
| full coverage, today's verifier, warm and no line moved | 1 to 2 minutes at 4 ms each |
| full coverage, after S4, cold, a pool of 16 | 1 to 2 minutes |
| full coverage, after S4, nothing changed | a few seconds |
| full coverage, after S4, one function edited | under a second of solving |

"After S4" assumes its three parts (§5 items 5 to 7) and position-independent
cache keys (item 12). None is built. Memory is the other open cost: `yo verify
./src` peaked at 9.33 GB in September (§2) with almost everything outside the
subset, and was not re-measured here.

### 2.3 A machine without a usable solver

What `yo 0.2.77` does with `~/.cache/yo/solvers/` empty and `YO_Z3_PATH` unset:

| | `yo check` | `yo compile` |
| --- | --- | --- |
| `verify+` module | passes, one `verify: no Z3 solver found …` line | passes, same line; every contract stays a runtime assert |
| `verify` module | passes, with the hint | fails: its runtime asserts are suppressed, so it cannot ship unproved |

Only `yo verify` downloads the solver. Three facts that matter once `verify+`
is the default:

- **The same source then builds two different programs.** A module whose
  `ensures` is false fails the build on a machine with the solver (`REFUTED`,
  with the counter-example). Without it the build passes and the program
  aborts at run time (`ensures failed: r > x`). Both are sound; they disagree
  on when the author finds out.
- **A solver that is installed but cannot run is reported once per function.**
  A `z3` that exits with a loader error gives a `SOLVER-ERROR` block for every
  function, with the loader's message repeated. The official Linux assets the
  pin names need glibc 2.39 (x86_64) or 2.38 (arm64), while the `yo` binary is
  static musl and runs on older and musl systems, so this is the case a user
  on Debian 12, Ubuntu 22.04 or Alpine meets.
- **The install is 157 MB** for a 36 MB binary: the release archive also
  carries `libz3.a`, `libz3.so` and the Java and .NET bindings, and all of it
  is unpacked.

## 3. The steps

In order. S0, S2 and SD need nothing else and start at v0.2.80. S1 follows S0 (D8).

| Step | What | Size | Depends on |
| --- | --- | --- | --- |
| **S0** | Fix `issues/2026-11-15-under-verify-plus-a-function-with-a-requires-no-ensures-and-a-block-body-is-not-verified.md`, and add the both-modes sweep: every fixture of `tests/spec/fixtures/valid/` runs under `Pragma.Verify` and under `Pragma.VerifyOrAssert` and must prove the same set of functions | S to M: the root cause is not known | nothing |
| **S1** | `yo init` scaffolds `pragma(Pragma.VerifyOrAssert);` in the source modules it generates, and the scaffolded `AGENTS.md` says so. `src/init.yo` already scaffolds a verified `spec/` | S: `src/init.yo` plus a cli-case golden | S0 |
| **SD** | Solver distribution (D9): a static build of the pinned Z3 for each release target, published with the release, and an install that keeps only that binary; the installer and `yo version install` fetch it with the compiler, and `yo build` fetches it on first need; a missing solver and one that cannot execute are probed once and reported in one line for the build; `--require-solver` / `YO_REQUIRE_SOLVER=1` for CI; solver presence in the artifact's input stamp (§5 items 8 and 9) | M | nothing |
| **S2** | A proved result is capped by what it rests on: the satisfiability probe per `assumed()` contract, the feasibility probe after a call, and `ok` naming the assumed contracts it used | about a week, with the vacuity probes of [`SELF_VERIFICATION.md`](SELF_VERIFICATION.md) | nothing |
| **S3** | std bodies the verifier walks instead of `assumed()` | weeks; it is the shared bottleneck of [`POST_VBD_PLAN.md`](POST_VBD_PLAN.md) phase 4, item 1 | the raw-buffer model ([`THEOREM_PROVING_DIRECTION.md`](THEOREM_PROVING_DIRECTION.md) R1) |
| **S4** | Incremental verification: an edit re-proves only the functions it changed, and a default-on `yo check` does not hold every function's state at once. Its three parts by §2.2: a solver pool, a per-function cache key, and a small budget for automatic obligations (§5 items 5 to 7) | L (SELF_VERIFICATION lever L8) | nothing |
| **S5** | Subset growth until the coverage gate holds: strings, exceptions as exit paths, trees as datatypes, collections through contracts | L (SELF_VERIFICATION levers L1–L4) | S3 for L4 |
| **S6a** | **Report by default** (D7). One PR, seed-gated where it adds or renames a pragma | M, plus the tree sweep below | S0, S4, SD; gates G3, G5, G6 |
| **S6b** | **Erase by default** (D7). One PR, seed-gated where it removes a pragma name | S | S6a; gates G1, G2 |

S3 and S5 no longer stand between the project and its first flip: S6a does not need
std to be proved or the subset to be wide. They gate S6b (S3, through G1) and decide
how much the default proves (S5).

What S6a contains:

- the default mode becomes report mode, with D6's treatment of uncontracted functions.
  Report mode is the `verify+` walk with its two erasures off. Both are single switches
  today: the strip pass (`strip_proved_ensures_asserts`, one mode test in
  `verify_and_strip_tasks`, `src/verifier/driver.yo`) and guard elision
  (`record_elidable_guard_sites`, which `compile` calls). `requires` entry guards are
  kept in every mode already. Its `--verify-mode` spelling is the PR's to choose;
- `yo build` proves every module of the package it builds (D10). Today `yo compile
  <entry>` arms only the entry file, so without this the default would report on
  `main.yo` and stay silent on every other module. It rests on S4's per-function
  cache, which is why S4 is among this step's dependencies;
- an opt-out pragma back to `runtime` is added (none exists today);
- the strict pragma is renamed: `Verify` reads as the ordinary choice and is the strict
  one, which is the wrong way round for an author choosing by name;
- the build's verify summary states the share of functions inside the subset, so the
  default never reads as "verified" while most code is outside it (§4, the note on G4);
- **the tree sweep:** every module of `src/`, `std/` and `tests/` that does not verify
  green at that commit gets the opt-out pragma, and the count of opted-out modules
  becomes a ratchet that may only fall. Without the sweep the flip breaks the
  repository's own build;
- the two standing texts are amended: [`FORMAL_VERIFICATION.md`](FORMAL_VERIFICATION.md)
  §Non-goals ("No mandatory verification") and [`SELF_VERIFICATION.md`](SELF_VERIFICATION.md)
  §Non-goals ("`runtime` stays the default for everyone else").

What S6b contains:

- the default mode becomes `verify+`: the two erasures are switched on for it;
- `Pragma.VerifyOrAssert` is deleted, with no alias and no deprecation window (D4).

## 4. The gates for the flip

Each is a number or a verdict a CI job re-derives. None is asserted in prose.

| Gate | Holds when |
| --- | --- |
| **G1** std is proved | the std modules a default-on program reaches report no `assumed` outcome outside the published FFI and raw-pointer list (S3) |
| **G2** assumptions are checked | the issue of S2 is in `issues/fixed/`, with its fixtures |
| **G3** the overhead is bounded | on the compiler's front-end modules, a warm default-on `yo check` after a one-function edit is within a stated factor of the unverified time and a stated RSS; both numbers are set from the first S4 measurement, not before |
| **G4** the subset covers real code | a stated share of the functions in `tests/` and `std/` is inside the subset; the share is set from the first measurement after S5's first lever |
| **G5** no flaky builds | over the language suite, no obligation's verdict differs between two cold runs on two machines (the pinned Z3 and `rlimit` budgets make this checkable) |
| **G6** the solver runs wherever `yo` runs (D9) | on every release target, the release's smoke job proves one obligation with the solver the installer fetched; and a build with no solver, or with one that cannot execute, passes in the default mode with exactly one line |

Which gate holds which step (D7):

| Step | Gates |
| --- | --- |
| S6a, report by default | G3, G5, G6 |
| S6b, erase by default | G1, G2, and those of S6a |

**G4's place is not ruled on.** *Judgment:* it is not a gate for S6a, because a default
that reports and erases nothing is safe at any coverage, provided S6a's summary line
states the coverage. It is a gate for S6b, and for any sentence in the docs or the
roadmap that says Yo code is verified by default.

## 5. Open questions

1. **The names** of the strict pragma and of the opt-out pragma.
2. **Do `*.test.yo` files default too?** *Judgment:* yes, with the same rule; a test
   body that indexes with a literal proves trivially.
3. **G3's and G4's numbers.** Set by measurement, as the table says.
4. **Decided 2026-11-15: D8, step S0.** `verify+` must be tested as the default it is
   about to become, before S1.
   One fixture of `tests/spec/fixtures/valid/` uses `Pragma.VerifyOrAssert`,
   and the measurement of §2.2 found
   `issues/2026-11-15-under-verify-plus-a-function-with-a-requires-no-ensures-and-a-block-body-is-not-verified.md`
   within an hour. *Judgment:* fix it and add a sweep that runs every valid
   fixture in both modes and requires the same proved set; S1 scaffolds this
   pragma into every new project.
5. **Solve in parallel.** Every obligation is already its own process and its
   own cache entry, and the verdicts do not depend on order. *Judgment:* a
   pool of solver processes sized by `--jobs`; the cold numbers of §2.2
   divide by the pool size.
6. **Key the cache on the function, not only on the query.** A warm run
   re-walks every function to rebuild queries it then finds cached, which is
   the 4 ms per obligation of §2.2. *Judgment:* S4 stores, per function, a
   hash of its body and of the contracts of everything it calls, with its
   verdicts; an unchanged function is neither walked nor hashed per
   obligation. G3 should be stated against this.
7. **Two budgets.** An automatic obligation that the solver gives up on costs
   nothing but a kept guard, so it does not deserve the budget of a written
   contract. *Judgment:* the default mode gives automatic obligations a small
   `rlimit` (the 200,000 of §2.2 is about one second) and keeps 5,000,000 for
   written `requires`, `ensures` and `invariant` clauses and for the strict
   pragma. Both are deterministic, so G5 holds.
8. **Decided in principle 2026-11-15: D9, step SD; the details below are SD's to
   confirm.** What a missing solver means under the default. *Judgment:*
   - never an error in the default mode, and never silent: the build keeps
     every runtime check (today's `runtime` behaviour) and prints one line for
     the whole build, not one per file;
   - make it rare: the installer and `yo version install` fetch the pinned
     solver with the compiler, and `yo build`, the one command that already
     fetches, fetches it on first need; `check`, `compile` and the editor
     never touch the network;
   - a flag and an environment variable (`--require-solver`,
     `YO_REQUIRE_SOLVER=1`) turn the line into an error, for CI: what CI
     proves is then what ships;
   - the strict pragma keeps today's rule (`compile` fails);
   - a solver that cannot execute is the same case as a missing one: probe it
     once, print one line;
   - whether the solver ran is part of the artifact's input stamp, so a build
     cached without it is not served after it is installed *(grep:
     `src/build_runner.yo` does not mention the solver today; not run)*.
9. **Decided 2026-11-15: D9, step SD, gate G6.** Solver coverage must equal compiler
   coverage. *Judgment:* Yo builds
   the pinned Z3 itself as a static binary for each release target and
   publishes it with the release, the way it publishes its own bundles, and
   the install keeps only that binary (36 MB, against 157 MB today). Until
   then gate G6 cannot be met on the systems §2.3 names.
10. **The verify cache is never collected.** It holds one JSON file per
    obligation in one directory (22,206 files and 90 MB on the measuring
    box), and `yo cache gc` and `yo cache clean` do not know it *(grep:
    `verify-cache` appears only in `src/verifier/`)*. *Judgment:* an S-sized
    item for S4.
11. **Decided 2026-11-15: D10.** Which command proves which module. `yo compile <entry>` arms only the
    entry file (`set_verify_target_paths` in `src/main.yo`); a module it
    imports is proved only when `yo check`, `yo verify` or a `build.verify`
    step is pointed at it. Under a default that would mean a counter-example
    for `main.yo` and silence for every other module of the project.
    *Judgment:* `yo build` proves every module of the package it builds, once
    each, through the per-function cache; `yo check <file>` keeps proving that
    file, which is the editing loop; a dependency, std included, is not proved
    by its consumer, and its contracts are the consumer's assumptions (that is
    what G1 is for). S6b's erasure inside an imported module needs that
    module's proofs in the same build, which is SAFE_MODE 5b Phase 3. What a
    bare `yo compile <entry>` proves beyond its entry file is left to S6a's PR.
12. **Cache keys must not carry a position.** §2.2: one inserted line re-solves
    every function below it, and an absolute entry path puts the machine's
    path in the key. *Judgment:* fix it in S4, before the per-function key of
    item 6 is built on the same text
    (`issues/2026-11-15-one-inserted-line-invalidates-the-verify-cache-for-every-function-below-it.md`).
13. **Sharing verdicts.** A verdict is deterministic and its key is the query,
    the solver's version and the budget, so once item 12 holds a cache
    directory is valid on any machine. *Judgment:* CI persists
    `<cache>/verify-cache` between runs, which makes its cold run a warm one;
    no new mechanism is needed beyond `YO_CACHE_DIR`. Shipping std's verdicts
    in a release was considered and is not useful under item 11's judgment: a
    consumer never proves std's bodies.

## 6. What does not change

- A Yo author never needs anything but `yo` and the solver it fetches.
- `--strict` keeps its meaning, and a `spec/` directory keeps its gate.
- An `assumed()` contract never elides a guard
  ([`SAFE_MODE_5B_VERIFIED_GUARD_ELISION.md`](SAFE_MODE_5B_VERIFIED_GUARD_ELISION.md)).
- Partial correctness stays the default (D12); termination is not made mandatory.
