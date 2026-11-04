# What Yo can take from Ada and SPARK (and whether to add SMT solvers)

**PROPOSED 2026-11-04 — backlog.** This is the keep/reject audit after studying Ada 2022 (the RM at ada-auth.org) and SPARK/GNATprove (the SPARK User's Guide, "UG") against Yo's language and verifier. It is a sibling of [`BEND_LAWS_AND_AGENT_LOOP_LESSONS.md`](BEND_LAWS_AND_AGENT_LOOP_LESSONS.md), whose 2026-11-04 addendum (keep Z3; items Z1–Z5) this doc extends. Four research reports were each checked by a critic against Yo's plans and decisions: the Ada language, SPARK verification, multiple solvers, and tooling/process. Items Yo already has or deliberately rejected are listed in §6.

**Filed from this audit:**
- `issues/fixed/2026-11-04-the-verifier-walks-past-a-panic-so-a-diverging-path-refutes-or-is-ill-sorted.md` (S2)
- `issues/fixed/2026-11-04-the-verify-cache-stores-wall-clock-unknown-verdicts-and-keys-on-the-pinned-z3-version-not-the-binary.md` (S3)
- `issues/questions/2026-11-04-should-a-generic-body-be-checked-against-its-where-bounds.md`
- a new reproducer appended to `issues/generic-trial-degrades-a-failed-evaluation-to-unit.md`

**Maintainer decision (2026-11-04):** keep Z3 as the one user-facing solver. Multi-solver work stops at the CI-only cvc5 oracle (§2 phases 0–2) until the phase-3 trigger fires.

The numbers marked "measured" came from `yo 0.2.73` and a tree binary of develop `8559f3a26`. The multi-solver corpus is 367 queries captured 2026-11-04.

## 1. Bottom line

The short answer on solvers: don't add a second solver that users run, and don't build a SPARK-style portfolio. Do the cvc5 CI-only consensus oracle that the 2026-11-04 addendum already accepted (item Z3), and write a measured reopen trigger into D2.

- **SPARK supports the single-solver choice.** GNATprove runs only cvc5 by default (UG, [Alternative Provers](https://docs.adacore.com/spark2014-docs/html/ug/en/appendix/alternative_provers.html)). Its own guide says `--level` portfolios are "not reproducible across different machines" ([How to Run GNATprove](https://docs.adacore.com/spark2014-docs/html/ug/en/source/how_to_run_gnatprove.html)).
- **The portfolio adds little.** In published SPARK projects the extra provers cover about 1–4% of VCs, and mostly floats, nonlinear arithmetic and quantifiers. Yo's subset excludes floats.
- **Yo's own corpus measures no gain.** Pinned Z3 5.1.0 proves 364 of the 364 provable queries (367 unique, captured 2026-11-04).
- **Bugs found during this audit:**
  - `panic` paths are mis-verified (`src/verifier/vc.yo:4601-4605`).
  - Wall-clock `unknown` verdicts are cached (`src/verifier/driver.yo:391-399`).
  - The cache is keyed on the `Z3_VERSION` constant, not on the binary that ran (`driver.yo:267`).
  - A never-instantiated generic body with an undefined name passes `yo check` (appended to `issues/generic-trial-degrades-a-failed-evaluation-to-unit.md`).
- **What to take from Ada and SPARK:** contracts that run as checks and are proved from the same text (executable refinements, type invariants at the `_` boundary), and SPARK's discipline about proof honesty (unreachable panics, validated counter-examples).
- **What not to take:** most of the rest of Ada is already in Yo in another form, or was rejected on purpose.

## 2. Multi-solver recommendation, in phases

| Phase | Work | Cost | Gate for the next phase |
|---|---|---|---|
| 0 | Addendum Z1 (timeout outcome) and Z2 (sha256 pin). **New:** cache an `Unproven` only when the rlimit ran out, never on a wall-clock timeout (SPARK: "Only conclusive results are cached", [UG §7.3.6](https://docs.adacore.com/spark2014-docs/html/ug/en/source/how_to_use_gnatprove_in_a_team.html)). Key the cache on `<binary> --version`, because `YO_Z3_PATH` accepts any Z3 (`z3.yo:243-247`) and issues/fixed already shows 4.16 in use. Musl hosts should get the "no pinned asset" error, not a glibc Z3 (`target.yo:236`, `z3.yo:64-65`) | Days | — |
| 1 | Addendum Z3: a solver-neutral encoding (SMT-LIB 2.7 `int_to_bv`/`ubv_to_int` in place of `encode.yo:108,193`, isolated options, isolated model parser). **New:** `yo verify --emit-smt <dir>`, so the oracle has a corpus to run on | 1–2 weeks | Z3 verdicts byte-identical over the dumped corpus before and after the refactor |
| 2 | cvc5 CI oracle over the dump with `--no-cache`. An unsat/sat disagreement fails the job. A cvc5 `unknown` is only recorded. Counter: `cvc5-only-proved: N of M z3-unproven` | CI minutes; `rlimit-per` needs calibrating (worst case ~18 min) | — |
| 3 | No code. Add a paragraph to D2: reopen a user-facing `--prover z3,cvc5` fallback if (a) the oracle shows cvc5 proving ≥10% of Z3's `unproven`, sustained over tests/spec and std, or (b) it catches a Z3 soundness disagreement. The fallback would run on `unknown` only and name the prover in the cache key; `refuted` would never depend on the prover | Hours | A maintainer decision. D2 says the multi-backend matrix was "dropped, not deferred" (`plans/backlog/FORMAL_VERIFICATION.md:1948`) |

**Why not a portfolio:**
- It breaks D7's byte-identical verdicts (`FORMAL_VERIFICATION.md:766`).
- It makes `verify+` guard elision trust the union of every solver's soundness bugs. YinYang found 29 soundness bugs in Z3 and CVC4 ([PLDI 2020](https://dl.acm.org/doi/10.1145/3385412.3385985)).

**Other solvers, rejected:**
- Bitwuzla: no datatypes, and 84% of queries declare `List_bv32`.
- Yices: no deterministic budget, GPLv3.
- Alt-Ergo: non-commercial licence; its strength is floats.

**Measurement caveat:** today the post-escalation `unproven` set is empty, so phase 3's trigger needs a harder corpus (§5, item 4). The cvc5 coverage figures in the multi-solver report were inferred from the query text, not run.

## 3. Adopt — verification

| # | Item | SPARK | Yo shape | Effort | Value |
|---|---|---|---|---|---|
| 1 | Fix `panic` handling; add a `panic-unreachable` obligation (question) | Raise points must be proved unreachable (UG §5.2.7) | Statement position: dead path. Value position: a fresh variable of the sibling arm's sort. Then an obligation like `assert(false)` | S, plus a sweep | High |
| 2 | Counter-example validation by CTFE | `--check-counterexamples` is on by default (UG §7.2.8) | Run the function on the model's inputs: `confirmed` / `[SPEC]` / `unconfirmed`; the verdict never changes | M; giant-step stage L | High |
| 3 | Loop frame facts for index-only writes | Generated loop frame conditions ([UG §7.7](https://docs.adacore.com/spark2014-docs/html/ug/en/source/how_to_write_loop_invariants.html)) | An L7 template: snapshot, then `forall(j, (j > i) ==> (a(j) == entry(j)))`; havoc per field, not per struct | S–M | Medium |
| 4 | `contract_cases(...)` | Contract_Cases, checked disjoint and complete (UG §5.2.3) | Desugars to `cases-complete`, `cases-disjoint` and `ensures(old(g) ==> e)`. Not named `cases`: that name is a local in tests | S–M, Gen A/B | Medium |
| 5 | Ghost `MathInt` plus arithmetic lemmas | Big_Integers, SPARK.Lemmas (UG §5.11.2, §5.11.7) | `VcSort.IntS`, `to_math(x)` in ghost context only; study together with the overflow question | M | Medium |
| 6 | Close open frames using `mutation_summary` | A default Global is generated (UG §5.2.4) | `_callee_frame_open` (`vc.yo:6674`) trusts the existing summary (`src/evaluator/effects/mutation_summary.yo:6-15`) | S, but the summary joins the trusted base | Medium |
| 7 | `--deny unproven:aorte` (filter by obligation kind) | Silver = AoRTE (UG §8.1) | A kind filter on `--deny`; no named presets | S | Low |
| 8 | A mandatory reason on F15's `ghost(assume(P, "why"))` | Annotate needs all four arguments (UG §7.3.4.1) | A new E-code when the reason is missing | XS | Low |

**1. Panic.** The docs claim "`panic` paths ✅ verified" (`docs/en-US/FORMAL_VERIFICATION.md:709`). The code returns `BoolLit(true)` and keeps walking past the panic. I confirmed it at develop dc24349c5. Three symptoms, measured with yo 0.2.73:
- A spurious REFUTED with x = 0 in statement position.
- A SOLVER-ERROR from the ill-sorted term `(ite c (_ bv1 32) true)`.
- A spurious REFUTED when the value is bool-sorted.

It is incomplete, not unsound, so I'd file it as S2. The plan text also misstates "SPARK's stance" (`plans/backlog/FORMAL_VERIFICATION.md:488,734`): SPARK proves panics are unreachable. Decide the obligation together with `issues/questions/2026-10-14-overflow-trap-freedom-as-a-default-obligation.md`. Between them they turn "verified modulo traps" into "trap-free".

**2. CE validation.** No Yo plan validates a counter-example. LE3 only shrinks them (`plans/backlog/LEAN_ADOPTION_CANDIDATES.md:136`). Validation would have flagged every panic-bug refutation above automatically. It also tells an agent whether to fix the code or strengthen the spec. It depends on rendering counter-examples as Yo literals (`FORMAL_VERIFICATION.md:835`); today they are raw `#x…` text (`z3.yo:634`).

**3. Frame facts.** Today `_havoc_assigned` (`vc.yo:3505`) loses every cell of an array after one `a(i) = v`. The boring half of most invariants is "the rest of the array didn't change", and SPARK infers exactly that half.

## 4. Adopt — language

| # | Item | Ada | Yo shape | Effort | Value |
|---|---|---|---|---|---|
| 1 | Executable refinements | A predicate is checked at subtype conversion (RM 3.2.4(31/5)) | In runtime mode, the compiler splices the `ghost_fn` predicate in as an entry assert; `verify+` erases it once proved | M–L, Gen A/B, question first | High |
| 2 | Checked narrowing | Out of range raises Constraint_Error (RM 4.6(57/5)) | Std `TryFrom` impls for narrowing pairs, `x.narrow(u8)`, `x.truncate(u8)` | S, std only | Medium |
| 3 | Type invariants at the `_` boundary | Type_Invariant on private types, checked at boundary exits (RM 7.3.2(15/5)-(19/5)) | `type_invariant(T, ghost_fn)`, legal when T has a `_` field | L, after VBD | Medium |
| 4 | Template vs. contract model for `where` (`issues/questions/2026-11-04-should-a-generic-body-be-checked-against-its-where-bounds.md`) | Generic bodies are checked against the formals (RM 12.3(11/5)) | Warning, then error, for an op on T that no bound provides | Question S; check L | Medium |
| 5 | Static "potentially blocking" check in `io.async` | Nonblocking aspect (RM 9.5(20/5),(34/5)) | A body call-graph walk seeded from `__yo_mutex_lock` and friends; `spawn_blocking` exempt | M | Medium |
| 6 | Arithmetic derives on `newtype` | Derived types inherit their operators (RM 3.4) | `derive(Meters, Add(Meters), …)`, Self-only | S, std only | Low |
| 7 | `--deny recursion` | No_Recursion (RM 13.12.1) | SCC check, conservative on `dyn` calls | M | Low |

**1. Executable refinements.** `refine(T, p)` erases to T (`docs/en-US/FORMAL_VERIFICATION.md:403-405`), so a refinement fact is an unchecked assumption. Two existing documents already say so: `issues/fixed/verify-mode-requires-is-unchecked-when-the-caller-is-outside-the-subset.md:102-106` and `plans/backlog/SAFE_MODE_5B_VERIFIED_GUARD_ELISION.md:369,609-612`, which says "the fix is making refinements enforceable at entry". No plan owns that fix.

The predicate stays a `ghost_fn`, because a plain `fn` is rejected (`FORMAL_VERIFICATION.md:1613-1616`). This is SPARK's Assertion_Policy(Ghost => Check). It also lets 5b elide guards on the flagship example.

```yo ignore
non_zero :: ghost_fn((fn(x : i32) -> bool)(x != i32(0)));
recip :: (fn(d : refine(i32, non_zero)) -> i32)(i32(100) / d);
recip(i32(0)); // proposed runtime: abort "refinement non_zero failed for d"; today: accepted
```

**2. Checked narrowing.** `u8(i32(300))` gives 44 (measured). The prelude says "Narrowing stays with TryFrom" (`std/prelude.yo:10999`), yet std implements TryFrom for no integer pair. This change only adds methods. Whether `u8(x)` itself should trap would reverse `plans/SAFE_MODE.md:558`, so that belongs in a separate question.

```yo ignore
b := x.narrow(u8);   // abort "300 not in [0, 255]"; verify: narrow-in-range obligation
c := x.try_into(u8); // Result(u8, RangeError)
d := x.truncate(u8); // today's u8(x), spelled explicitly
```

**3. Type invariants.** This answers FV Open Question 6 (`FORMAL_VERIFICATION.md:2001`). Ada checks invariants only at boundary exits, and code inside the boundary may break them temporarily. Yo's E0405 `_` rule already defines that boundary, so aliasing through Rc cannot break the invariant from outside. SPARK assumes the invariant everywhere else; the Ada RM only checks it.

```yo ignore
Span :: struct(_lo : usize, _hi : usize);
_span_ok :: ghost_fn((fn(s : &Span) -> bool)(s._lo <= s._hi));
type_invariant(Span, _span_ok); // proved at exits of public fns returning Span or taking &mut Span
```

## 5. Adopt — tooling and process

| # | Item | Ada/SPARK | Yo shape | Effort | Value |
|---|---|---|---|---|---|
| 1 | Whole-closure restriction set | Partition-wide `pragma Restrictions` (RM 13.12(8/3)) | `restrictions : "no-unsafe,no-extern,no-parallelism,no-io-async"` on `build.executable` plus `--restrict`; std exempt | 1–2 weeks, seed-gated | Medium |
| 2 | Residual-assumption catalogue | `--assumptions` list (UG §7.3) | Doc section "What a proof assumes" plus per-function JSON `assumptions` ids, from the `ctx.unenforced` data (`vc.yo:1482-1505`) | ~1.5 weeks | Medium |
| 3 | Verified-algorithms corpus | SPARK by Example | `tests/spec/by_example/<chapter>`, `--strict`, ratcheted TSV; also supplies the phase-3 corpus | 1–2 weeks | Medium |
| 4 | Per-obligation-class summary | `gnatprove.out` table | `summary.by_class` in JSON; text behind `--summary-table` | 2–3 days | Low |
| 5 | Branch coverage at Yo `cond`/`match` arms | GNATcoverage source instrumentation | Line coverage from llvm-cov via `#line`, plus arm counters in LCOV | 1–2 weeks | Low |

## 6. Considered and rejected, or already in Yo

- Limited and controlled types: Yo has move-only values and `Drop` (`docs/en-US/DESIGN.md:1282,1334`).
- Accessibility levels: references with origins already do this statically (`plans/backlog/REFERENCES_AND_ORIGINS.md`).
- Exceptions: typed `Exception` capabilities exist (`DESIGN.md:4093`).
- `'Old`/`'Result`: covered by `old()` plus named returns (`FORMAL_VERIFICATION.md:276`).
- Declare expressions: blocks are already expressions.
- Conflict_Check_Policy: covered by `Send`/`Sync` (`plans/reference/PARALLELISM_RULES.md`).
- Delta aggregates: already adopted as Rust L5 (`RUST_ADOPTION_CANDIDATES.md:181`).
- Representation clauses, volatile, enum-indexed arrays: planned as Zig Z5/Z6/Z13 (`ZIG_ADOPTION_CANDIDATES.md:157,178,305`).
- Parallel loops and `par_reduce`: belong in `LANGUAGE_FEATURE_CANDIDATES.md` §1 and Bend B6. Also, a law evaluates to unit.
- Global/Depends and `writes(...)`: open as `issues/questions/modifies-clause-for-callee-side-effects.md`.
- Information-flow analysis: deferred by D10.
- Runtime discriminants: they are dependent types, which Yo rejects (`DEPENDENT_TYPES_POSITION.md`).
- Static predicates in `match`: refine is erased for typing (`ATS_STYLE_INDEXED_TYPES.md:84`).
- `Ranged`/`Modular`: `Bounded` already exists (`std/spec/refine.yo:55`); `wrapping_*` covers powers of two.
- Order-free named arguments, user-defined literals: standing rejections (`LANGUAGE_FEATURE_CANDIDATES.md:25-26`).
- NoHeap: Yo has no allocation effect; `noalloc` is backlog (`ALLOCATOR_PLACEMENT.md:517`).
- A `[profile]` table in yo.toml: yo.toml is dependency data (`src/manifest.yo:1-11`).
- `--level` proof-level presets: they would alias `--strict`, and AGENTS.md forbids aliases. SPARK itself maps silver and gold to the same `--mode=all`.
- Per-site `justify`: the critiques disagree. I side with dropping it, because `verify+` already keeps the runtime assert per obligation (`docs/en-US/FORMAL_VERIFICATION.md:476`).
- Default overflow obligations: already the 2026-10-14 question.
- `loop_entry`: a ghost binding already does it (`tests/spec/fixtures/valid/ghost_binding.yo:15`).
- Assumption ledger and `assumed("reason")`: planned (`plans/SELF_VERIFICATION.md:317-340`, LE2, Z4).
- Ghost Map: SELF_VERIFICATION L4. Lemma library: T1. `paranoid`: `FORMAL_VERIFICATION.md:448`. Vacuity: `FORMAL_VERIFICATION.md:846`.
- Replay, evidence bundles, session files: F4 and K L1/L5 cover them. With one deterministic solver, re-running is the replay.
- Coded warnings, lint tables, GNATcheck: Rust T2 settles it (`RUST_ADOPTION_CANDIDATES.md:333-344`).
- ACATS-style traceability: `tests/internal/diagnostics_registry_examples.test.yo` already does it.
- Structural variants and Always_Terminates: F8 and D12.
- Exceptional_Cases: `issues/questions/2026-10-14-effect-operation-contracts.md`.
- Floats, Relaxed_Initialization, Abstract_State: non-goals (`FORMAL_VERIFICATION.md:115`).
- MC/DC and DO-333 credit: Yo has no certification goal.
- Alire-style index, per-function SPARK_Mode: not needed for a single user; Yo decided on per-file modes (MEMORY_SAFETY Q10).

## 7. Suggested sequencing

**v0.2.75**, small items that don't collide with VBD:
- Fix the panic bug (`issues/fixed/2026-11-04-the-verifier-walks-past-a-panic-so-a-diverging-path-refutes-or-is-ill-sorted.md`): the `k2`/`k3`/`kb` fixtures and a bugged twin, plus the plan-text correction.
- Phase 0: Z1 with no caching of wall-clock unknowns, Z2, the solver-identity cache key, the musl fix.
- Std-only K3 narrowing and newtype derives.
- File the remaining questions: executable refinements and `panic-unreachable`. The `where` contract model is already filed (`issues/questions/2026-11-04-should-a-generic-body-be-checked-against-its-where-bounds.md`).

**v0.2.76–0.2.77:**
- Phase 1–2: `--emit-smt`, the solver-neutral encoding, the cvc5 oracle and the D2 trigger paragraph.
- CE validation stage 1.
- Loop frame facts.
- The by-class summary and the assumption-catalogue doc.
- The by-example corpus can start at any time.

**After the VBD campaign**, when the `&mut` model and containers-as-values settle:
- Type invariants.
- Executable refinements (Gen A/B).
- `contract_cases` (Gen A/B).
- MathInt, together with the overflow study.
- Mutation-summary frames (re-check whether VBD's signature-derived frames make them redundant).
- The restriction set (seed-gated builtin).
- The blocking check.
- CE giant-step.
- Coverage, `--deny recursion`.

