# plans/ — design and planning documents

One markdown file per feature design, migration plan or campaign. New design
and plan documents go here (see `AGENTS.md`). Every doc states its status in
its first lines, so this index does not repeat status or history — open the
doc.

## Layout

| Location     | Meaning                                                                                       |
| ------------ | --------------------------------------------------------------------------------------------- |
| `./*.md`     | **Active**: plans driving work right now, and nothing else.                                   |
| `reference/` | **Landed designs and decisions**: shipped, still true, authoritative.                         |
| `backlog/`   | **Backlog**: written but not started, or explicitly parked.                                   |
| `archive/`   | **Closed**: finished campaigns, rejected proposals, superseded handovers, each with a banner. |

## Active

- [`ROADMAP.md`](ROADMAP.md) — the language and product roadmap.
- [`EVALUATOR_MEMORY_REDUCTION.md`](EVALUATOR_MEMORY_REDUCTION.md) — cutting the evaluator's retained memory, measured per phase. PAUSED 2026-09-29 at its < 1 GB goal; §8 is where to resume.
- [`EVALUATOR_MEMORY_REDUCTION_HANDOVER.md`](handover/EVALUATOR_MEMORY_REDUCTION_HANDOVER.md) — the handover: recipes and per-item detail for the remaining work (entry point: the plan's §8).
- [`SELF_VERIFICATION.md`](SELF_VERIFICATION.md) — Yo verifies Yo: the compiler as the verifier's flagship user.
- [`CODEGEN_MEMORY_REDUCTION.md`](CODEGEN_MEMORY_REDUCTION.md) — cutting what `compile` holds beyond `check`: 2,895 → 2,484 MB with the scope-exit env release (§6.1), after #1041, #1054 and #1018. The 2.0 GB target is ~480 MB away; the next candidates are in §6.1 "Open".
- [`ASYNC_STATE_MACHINE_GENERATION.md`](ASYNC_STATE_MACHINE_GENERATION.md) — the async state-machine audit and its phased rewrite: loud failures, ownership/protocol fixes, fast paths, then a single-pass resumable lowering.
- [`ASYNC_PERFORMANCE_HANDOVER.md`](handover/ASYNC_PERFORMANCE_HANDOVER.md) — macOS async I/O at or above libuv: where the runtime and std rows stand, two open branches (await-site fusion #1073, the generic-aggregate future fix #1090), and the work left in order.
- [`ASYNC_IO_API_AUDIT.md`](ASYNC_IO_API_AUDIT.md) — the 2026-10-03 audit of the async API surface (`io.async`/`io.await`/`io.spawn`, `Future`, `JoinHandle`, `IoFuture`, the `std/async` combinators): what stays, eight findings (no suspending join, timing-dependent abort semantics, two S1 crashes, a six-way contract drift), phases A0–A5; the four design questions were decided 2026-10-03.
- [`CODEGEN_PERFORMANCE.md`](CODEGEN_PERFORMANCE.md) — closing the generated code's gap to Rust, measured (ACTIVE 2026-10-10): the first paired C numbers put float and index loops at parity, the integer overflow trap at 5.7–7× on integer reductions, `push` at 1.9× and `sort_by` at 4.3×; levers in order: CP0 (the paired suite + event counters), CP2f (a range pass that discharges the traps), CP2g (erase std's verifier-proved contracts in every build), `restrict`/LTO/`Rc`-assert/collector-tracking elision, CP2h (std's sort in place), layout and PGO.
- [`SAFE_MODE.md`](SAFE_MODE.md) — no undefined behavior in safe code: phases 0a–4 and 5b Phases 0–2 landed, the 2026-10-02 pointer-free unsafe-API audit closed; open: 5b Phase 3 (blocked) and strict mode (deferred). The 2026-10 handover is closed ([`archive/SAFE_MODE_HANDOVER.md`](archive/SAFE_MODE_HANDOVER.md)).
- [`TYPE_SYSTEM_SOUNDNESS.md`](TYPE_SYSTEM_SOUNDNESS.md) — make `yo check` a gate, not a filter: the type-system audit's phased fix plan.
- [`TYPE_SYSTEM_SOUNDNESS_HANDOVER.md`](handover/TYPE_SYSTEM_SOUNDNESS_HANDOVER.md) — where that plan stands: four pushed branches (flow orientation, registry retirement, Phase 6 closure re-raise, an option-self-field repro) and the work not started.
- [`VBD_HANDOVER_2026-10-20.md`](handover/VBD_HANDOVER_2026-10-20.md) — the current VALUES_BY_DEFAULT handover (2026-10-20, after v0.2.67; v0.2.68 runs on the 64 GB Linux box): §0 is where to start (machine setup, the §3.1 sharing prerequisites and the RSS attribution, the copy-guards and `Acyclic` branches, the B1 regeneration), the v0.2.67 merge ledger and release facts, the open questions, and this cycle's process lessons.
- [`VBD_RELEASE_SCHEDULE.md`](handover/VBD_RELEASE_SCHEDULE.md) — the living release-by-release schedule for the rest of VALUES_BY_DEFAULT (v0.2.68 → v0.2.75, three forced seed boundaries), with the maintainer-delegated picks of 2026-10-20 in §5.
- [`VBD_B1_EXPLICIT_COPY_LISTING_2026-10-22.md`](handover/VBD_B1_EXPLICIT_COPY_LISTING_2026-10-22.md) — the 1,956 sites the 2026-10-22 B1 regeneration of `src/` listed for hand edits (B3/B4 input; the NO-GO verdict is in VALUES_BY_DEFAULT.md, B1, "As-built 2026-10-22").
- [`VBD_B1_EXPLICIT_COPY_LISTING_2026-10-23.md`](handover/VBD_B1_EXPLICIT_COPY_LISTING_2026-10-23.md) — the 1,963 sites the final 2026-10-23 B1 regeneration (on develop with `Token.input` sharing, #1561, and B5, #1551; three hot paths) listed for hand edits; supersedes the 2026-10-22 listing as B3/B4 input (the verdict is in VALUES_BY_DEFAULT.md, B1, "As-built, re-run 2026-10-23", and its "Final regeneration" entry).
- [`VBD_B3_STD_EXPLICIT_COPY_LISTING_2026-10-22.md`](handover/VBD_B3_STD_EXPLICIT_COPY_LISTING_2026-10-22.md) — the explicit-copy dry run over `std/` (52 insertions, 162 sites listed; B3 input, nothing applied).
- [`VBD_LOOKAHEAD_2026-10-23.md`](handover/VBD_LOOKAHEAD_2026-10-23.md) — the implementation-ready breakdowns for v0.2.70 and v0.2.71 (B4, B6, B7, B8–B11, V3, Z11; `__yo_cell`, B12, allocator v2, V2c, W3/W4): PRs in order, files and functions with develop line numbers, measured site counts, the seed constraint and Tier 1 gate per PR, what starts now, and 30 design questions with recommended answers (those that amend the schedule are marked); `VALUES_BY_DEFAULT.md` stays authoritative.
- [`VBD_B8_PROBE_CENSUS_2026-10-22.md`](handover/VBD_B8_PROBE_CENSUS_2026-10-22.md) — the B8 flip probe (N4) on the never-merged branch `probe/v2b-b8-flip-census`: the 328-site residual E0901 list in std by kind and directory, the `src/` frontier and the B5 wall, the test census, the runtime results under the v0.2.68 seed and a develop-built binary (identical; the flip found no new seed-only bug, and the seed S1 that constrains the B6/B8 std shape is named), the eleven compiler bugs filed, and the work list by B-step.
- [`OWNERSHIP_AND_BORROWING_DOC_DRAFT.md`](OWNERSHIP_AND_BORROWING_DOC_DRAFT.md) — the draft user doc that replaces `docs/en-US/COMPILE_TIME_RC_WITH_OWNERSHIP_ANALYSIS.md`: ownership, moves, `Copy`, drops, borrows, projections, closures, sharing, references as values, each planned rule tagged with its phase; promoted to `docs/` (both languages) at VALUES_BY_DEFAULT's V5.
- [`VALUES_BY_DEFAULT.md`](VALUES_BY_DEFAULT.md) — every declared type is a value; `ref(...)`/`atomic(...)` leave the language; sharing is spelled `Rc(T)`/`Arc(T)`. Amended 2026-10-05 (§0): unique ownership (Hylo's model) replaces copy-on-write: buffers and `Box` have one owner and no count, copies of buffer-owning values are explicit (`.clone()`), a last use moves, resources are move-only, `Send` is a move.
- [`ATS_LESSONS_BEYOND_INDEXED_TYPES.md`](ATS_LESSONS_BEYOND_INDEXED_TYPES.md) — what else Yo takes from ATS beyond indexed types: the lemma layer, must-use results, an init proof token (fixes an S1 in `ArrayList.set_len`), spec-transparent pure functions, lexicographic `decreases`, the typestate idiom.
- [`AGENT_KNOWLEDGE_CONSOLIDATION.md`](AGENT_KNOWLEDGE_CONSOLIDATION.md) — one home per fact across the pack and the manuals. K0/K1 landed (stale claims fixed, unique facts moved into manuals). Amended 2026-10-13: after VBD V5, delete the shipped skills and `yo skills install` (`yo init` writes `AGENTS.md` + `CLAUDE.md`, and `yo context` is the version-matched source), type-check every ` ```yo ` docs block, and sweep the docs of pre-VBD forms and history narration.
- [`STRING_VALUE_SEMANTICS.md`](STRING_VALUE_SEMANTICS.md) — `String` becomes a value (amended 2026-10-05: uniquely owned, not copy-on-write; S3 keeps its model-independent half): copies are independent whether or not the string was empty, mutators take `inout(self)`, and `as_bytes` splits into `to_bytes`/`into_bytes`. E0908 (write through a borrowed value) is extended to `inout` arguments and receivers, which finds the code that relied on shared writes, and the count-accuracy tests come first. The collections follow as the next campaign.

## Reference (`reference/`)

| Area                   | Docs                                                                                                                                                                                                                                                                                                           |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Language policy        | [`FUNCTION_OVERLOADING_POLICY`](reference/FUNCTION_OVERLOADING_POLICY.md), [`OPERATOR_SET_AND_PRECEDENCE`](reference/OPERATOR_SET_AND_PRECEDENCE.md), [`PREFIX_OPERATOR_OPERAND_RULE`](reference/PREFIX_OPERATOR_OPERAND_RULE.md), [`MACRO_POLICY`](reference/MACRO_POLICY.md), [`LAZY_TOPLEVEL_BINDINGS`](reference/LAZY_TOPLEVEL_BINDINGS.md), [`MEMBER_VISIBILITY`](reference/MEMBER_VISIBILITY.md), [`REMOVE_OPEN_BUILTIN`](reference/REMOVE_OPEN_BUILTIN.md), [`MATCH_PATTERN_MATCHING`](reference/MATCH_PATTERN_MATCHING.md) |
| Types and traits       | [`ASSOCIATED_TYPES`](reference/ASSOCIATED_TYPES.md), [`HIGHER_KINDED_TYPES`](reference/HIGHER_KINDED_TYPES.md), [`GADTS`](reference/GADTS.md), [`DERIVE_TRAITS`](reference/DERIVE_TRAITS.md), [`INDEX_TRAIT`](reference/INDEX_TRAIT.md), [`COMPTIME_INDEX`](reference/COMPTIME_INDEX.md), [`TYPE_REFLECTION`](reference/TYPE_REFLECTION.md), [`TYPE_IDENTITY`](reference/TYPE_IDENTITY.md), [`ERROR_TRAIT_AND_TYPEID`](reference/ERROR_TRAIT_AND_TYPEID.md), [`FUNCTOR_APPLICATIVE_MONAD`](reference/FUNCTOR_APPLICATIVE_MONAD.md) |
| Memory and ownership   | [`MEMORY_SAFETY`](reference/MEMORY_SAFETY.md), [`RC_OWNERSHIP_IMPLEMENTATION`](reference/RC_OWNERSHIP_IMPLEMENTATION.md), [`REF_REFERENCE_SEMANTICS`](reference/REF_REFERENCE_SEMANTICS.md), [`ARC_TYPE`](reference/ARC_TYPE.md), [`THREAD_LOCAL_STORAGE`](reference/THREAD_LOCAL_STORAGE.md), [`FIXED_REGION_ALLOCATOR`](reference/FIXED_REGION_ALLOCATOR.md), [`EXPLICIT_ALLOCATORS`](reference/EXPLICIT_ALLOCATORS.md), [`WINDOWS_ALLOCATOR_DECISION`](reference/WINDOWS_ALLOCATOR_DECISION.md) |
| std                    | [`STRING_DESIGN`](reference/STRING_DESIGN.md), [`HASHER_REDESIGN`](reference/HASHER_REDESIGN.md), [`REGEX_ENGINE`](reference/REGEX_ENGINE.md), [`ASYNC_ITERATION_STREAM`](reference/ASYNC_ITERATION_STREAM.md) |
| Compiler               | [`ERROR_DIAGNOSTICS_OVERHAUL`](reference/ERROR_DIAGNOSTICS_OVERHAUL.md), [`INCREMENTAL_COMPILATION`](reference/INCREMENTAL_COMPILATION.md), [`INCREMENTAL_COMPILATION_ZIG_LESSONS`](reference/INCREMENTAL_COMPILATION_ZIG_LESSONS.md), [`CHUNKED_C_EMISSION`](reference/CHUNKED_C_EMISSION.md), [`CIRCULAR_DEPENDENCIES`](reference/CIRCULAR_DEPENDENCIES.md), [`C_INCLUDE_EXTERN_MODULE_VALUE`](reference/C_INCLUDE_EXTERN_MODULE_VALUE.md), [`WASM_SUPPORT`](reference/WASM_SUPPORT.md), [`MATCHING_LOGIC_RESEARCH`](reference/MATCHING_LOGIC_RESEARCH.md) |
| Build and distribution | [`BUILD_SYSTEM`](reference/BUILD_SYSTEM.md), [`STEP_API_AND_GLOBAL_CACHE`](reference/STEP_API_AND_GLOBAL_CACHE.md), [`DEPENDENCY_MANAGEMENT`](reference/DEPENDENCY_MANAGEMENT.md), [`VERSION_MANAGEMENT`](reference/VERSION_MANAGEMENT.md), [`TARGET_TRIPLES`](reference/TARGET_TRIPLES.md), [`RELEASE_ASSET_TRIPLES`](reference/RELEASE_ASSET_TRIPLES.md), [`PORTABLE_C_DISTRIBUTION`](reference/PORTABLE_C_DISTRIBUTION.md), [`DROP_LIBURING`](reference/DROP_LIBURING.md), [`LINUX_ASYNC_IO_PERFORMANCE`](reference/LINUX_ASYNC_IO_PERFORMANCE.md), [`MACOS_ASYNC_IO_PERFORMANCE`](reference/MACOS_ASYNC_IO_PERFORMANCE.md) |
| Tooling                | [`YO_CONTEXT`](reference/YO_CONTEXT.md), [`INIT_AGENT_SCAFFOLD`](reference/INIT_AGENT_SCAFFOLD.md), [`DOCUMENTATION_GENERATION`](reference/DOCUMENTATION_GENERATION.md), [`DOC_TAGS_AND_IDE`](reference/DOC_TAGS_AND_IDE.md), [`FMT_CALLEE_PREFIX_CANONICALIZATION`](reference/FMT_CALLEE_PREFIX_CANONICALIZATION.md) |

## Backlog and archive

`backlog/` holds the designs that are next or parked. The ones other docs lean
on most: [`FORMAL_VERIFICATION`](backlog/FORMAL_VERIFICATION.md) (the
verifier's design, V1–V7 landed),
[`SEED_VERSION_AUTOMATION`](backlog/SEED_VERSION_AUTOMATION.md),
[`DEPENDENT_TYPES_POSITION`](backlog/DEPENDENT_TYPES_POSITION.md) and its
2026-09-30 ATS audit [`ATS_STYLE_INDEXED_TYPES`](backlog/ATS_STYLE_INDEXED_TYPES.md)
(indexed types and existentials: what Yo has, what the verifier still needs),
[`BEND_LAWS_AND_AGENT_LOOP_LESSONS`](backlog/BEND_LAWS_AND_AGENT_LOOP_LESSONS.md)
and [`LLM_AUTHORING_AUDIT_2026-09-19`](backlog/LLM_AUTHORING_AUDIT_2026-09-19.md).
[`MACRO_AND_ISO_REMOVAL`](backlog/MACRO_AND_ISO_REMOVAL.md) is the 2026-10-20
maintainer decision record and campaign, revised after review and scheduled
inside the VBD campaign, for deleting the macro layer (`for` becomes a parse-time desugar following
the `if` → `cond` precedent, `for_await` is deleted with no desugar,
`unsafe.drop` becomes a direct `___drop` call, and the three collection
literals are replaced by ordinary `from` constructors — LLM authoring does
not need the sugar) and the builtin isolated-transfer type with its `^`
constructor (Rust's thread rule: cross-thread data is `Send`;
`Rc.try_unwrap` is the bridge; Part A, deleted at v0.2.68, pulled forward on
2026-10-21). It reverses
[`reference/MACRO_POLICY`](reference/MACRO_POLICY.md) and supersedes the
isolated-transfer carve-outs in [`VALUES_BY_DEFAULT`](VALUES_BY_DEFAULT.md) §3.6/§3.8.
Safe mode's open work is listed in [`SAFE_MODE`](SAFE_MODE.md); the
verifier-driven guard elision design, Phases 0–2 landed and Phase 3 open, is
[`SAFE_MODE_5B_VERIFIED_GUARD_ELISION`](backlog/SAFE_MODE_5B_VERIFIED_GUARD_ELISION.md)
(strict mode builds on it); its container bounds-check prerequisite is designed in
[`SAFE_MODE_5B_CONTAINER_BOUNDS_ELISION`](backlog/SAFE_MODE_5B_CONTAINER_BOUNDS_ELISION.md).
[`PARALLEL_COMPILATION`](backlog/PARALLEL_COMPILATION.md) is the measured
plan for using more than one core (forked emit and test runner first, a
threaded evaluator last; maintainer, 2026-10-16: secondary to VBD).
[`ASYNC_AWAIT_SITE_FUSION`](backlog/ASYNC_AWAIT_SITE_FUSION.md) is the
state-machine plan's phase 7 design for std's single-await I/O wrappers
(an immediately awaited wrapper runs in its caller's frame).
[`PACKAGE_MANAGER_DISTRIBUTION`](backlog/PACKAGE_MANAGER_DISTRIBUTION.md) is
the parked design for installing Yo through Homebrew, Scoop and the
Linux/nix system package managers — built entirely on the existing release
bundles, with per-channel start triggers instead of a schedule.
[`THEOREM_PROVING_NEXT`](backlog/THEOREM_PROVING_NEXT.md) is what remains
for theorem proving after the landed lemma layer (`law`, lemmas by
induction, `seq_of`/`produced`/`distinct`): the std lemma library,
auto-induction retry, calculational chains, trigger observability, and the
parked certificate / external-prover routes with their revisit triggers.
Its sibling audit of the K ecosystem's engineering,
[`K_FRAMEWORK_ENGINEERING_LESSONS`](backlog/K_FRAMEWORK_ENGINEERING_LESSONS.md),
takes the pieces that do not touch the declined matching-logic foundation:
obligation ids and single re-query, a std conformance corpus, clause-usage
coverage, a verifier bug-report bundler; the solver-daemon architecture and
proof-state viewers are rejected with recorded reasons.
[`RUST_REFERENCE_PATTERNS`](backlog/RUST_REFERENCE_PATTERNS.md) is the
Rust→Yo porting catalog for VALUES_BY_DEFAULT: every Rust shape that stores a
borrow (views into owned buffers, `Ctx<'a>` structs, guard objects,
`Rc<RefCell>` graphs with `Weak`, borrowing iterators, `RefCell`/`Cell`,
`Cow`, escaping closures, borrowing futures, `&'static`) mapped to its
post-VBD Yo shape through five replacements — own, share with `Rc`/`Arc`,
index, pass per call, re-derive — with the cost of each.
[`LANGUAGE_FEATURE_CANDIDATES`](backlog/LANGUAGE_FEATURE_CANDIDATES.md) is
the 2026-10-08 parking lot of six checked candidates, none adopted: scoped
parallel iteration as std (the `Sync` machinery is all landed; rayon-shaped
borrowing is impossible by design — owned chunks or `Arc` sharing are the Yo
shapes), a portable `std/simd` over clang/gcc vector extensions, pre-design
of the parked stateful-call/borrow-mode-fields trigger, array-rest and
str-prefix patterns whose tail bindings borrow, pulling FV Phase V6
(trait-method contracts, already designed) forward, and a comptime-generated
`Soa(T)` columnar container (rows are sibling places under one root; the
wrapper maintains the cross-column length invariant and the verifier can
prove it) — plus the standing rejections table so nothing is re-proposed.
[`RUST_ADOPTION_CANDIDATES`](backlog/RUST_ADOPTION_CANDIDATES.md) is the
2026-10-10 survey of what else Yo could take from Rust, each candidate
checked against the tree: a table of what is already here (so it is not
re-proposed, two of them found only by compiling a probe), seven language
candidates (second-class slice parameters, labeled `break` with a value,
`unreachable`/`todo`, record update syntax, `matches`, FFI enum
discriminants, associated comptime values), six std candidates (the missing
iterator adapters, container parity, `Lazy`, `Result.context`, `yo bench`,
128-bit integers rejected), six toolchain candidates (doc tests that run,
`--deny warnings`, LSP code actions and inlay hints, fuzzing, panic
backtraces), and the rejections it adds (shadowing, `PartialOrd`, `Weak`,
guards, `Cow`, `Deref` coercions).
[`WEAK_AND_UNCOLLECTED_RC`](backlog/WEAK_AND_UNCOLLECTED_RC.md) (2026-10-21,
reopening decision 46's "No `Weak`") is Rust's `Rc`/`Arc` model on Yo's
one handle pair: `Weak(T)`/`ArcWeak(T)` with a weak count in the bits
decision 46 freed, a per-program `--cycle-collector off` build, `Arc`
without its `Acyclic` bound, and `Acyclic` kept as a derived-only marker
(`Weak` edges excluded; the declared form goes); the collector is deleted
at W6, once `Weak` and the
`--allocator debug` leak oracle have shipped and one release has run with
it off (maintainer, 2026-10-21).
[`ZIG_ADOPTION_CANDIDATES`](backlog/ZIG_ADOPTION_CANDIDATES.md) is the Zig
half of the same 2026-10-10 survey: the table of what Yo already shares
with Zig (comptime, lazy analysis, `build.yo`, `c_include`, allocators as
values, in-file tests, no shadowing, the `Io` parameter), ten language
candidates (`defer`/`errdefer`, error return traces with `try`,
arbitrary-precision `comptime_int`, `source_location()`, packed structs and
alignment, `volatile`, `comptime_for`, a CTFE budget, labeled blocks, the
scoped safety toggle), seven std candidates (a tracking `--allocator debug`
that fails leaking tests, `InlineList`, enum containers, a comptime string
map, a replaceable panic handler, assert diffs), three toolchain items, and
the rejections (inferred error sets, allocator-per-call, `+%` operators,
first-class `u7`, `@fieldParentPtr`, `undefined`).
[`ZIG_STYLE_ALLOCATORS`](backlog/ZIG_STYLE_ALLOCATORS.md) (2026-10-21) is
Zig's `std.heap` catalog as a `std/heap/` plan on the version-2 allocator
interface (page, fixed-buffer, arena over a backing allocator, C, debug,
failing, logging, thread-safe, pool; `SmpAllocator` measured against
mimalloc with a go/no-go), and the real arena — bump allocation with no
count and no free, a dangling handle a compile error — as an `Origin`
(`arena.alloc(v) -> &mut(T, arena)`), which reverses
[`ARENA_ALLOCATOR_FEASIBILITY`](backlog/ARENA_ALLOCATOR_FEASIBILITY.md)'s
"no lifetimes" premise and lands at origins N2.
[`STATIC_ARGUMENT_INFERENCE`](backlog/STATIC_ARGUMENT_INFERENCE.md)
(maintainer, 2026-10-23) has two parts. The first is the rule that a static
method called through an unapplied type constructor (`Pair.mk(x)`,
`Rc.new(x)`) infers the constructor's arguments from every argument whose
declared parameter type mentions them. A method taking `Self` first keeps
decision 32's receiver rule; any other consults every argument, so
`Rc.new(some_rc)` is `Rc(Rc(X))`. Inferring from the expected type stays out
of scope. The second part, on a seed carrying the rule, replaces the
prelude's `box`/`rc`/`arc` with `Box.new`/`Rc.new`/`Arc.new` through one
`yo fix --migrate handle-ctors` sweep, then deletes the builtins a release
later.
[`ALLOCATOR_PLACEMENT`](backlog/ALLOCATOR_PLACEMENT.md) (maintainer,
2026-10-24, adopting the advisor's verdict) deletes the thread allocation
scope (`with_allocator`, `current_allocator`, `Arena.scoped` and the
codegen thread-local): a creation without `alloc :` goes to the global
allocator, placement is the one defaulted `alloc : Option(Allocator)`
argument at the creation site (containers included, so
`new_in`/`with_capacity_in` go), `clone()` still lands where its source
lives, and frees route by owner prefix. Steps A1 (#1572), A2 (a safe
file may name `Allocator` as a parameter type), B1 and B2 ride VBD from
v0.2.70 to v0.2.72; step C, after v0.2.75, makes the process heap
a `global_allocator` declaration in the root module over a `std/heap`
catalog and leaves `yo test --allocator debug` as the one `--allocator`
spelling. It rejects Zig's allocator parameter, a declared or `ctl`
`Alloc` effect, the same-day scoped-handler "hybrid" and `Dyn.new`.
[`FSTAR_ADOPTION_CANDIDATES`](backlog/FSTAR_ADOPTION_CANDIDATES.md) is the
2026-10-14 F\* audit, written when the maintainer asked whether Yo could
support dependent types "like F\* does": the verdict (F\* pays the costs
`DEPENDENT_TYPES_POSITION` names; what it ships is Yo's erased,
SMT-discharged layer, which Yo should make pervasive rather than
reopen), fifteen candidates with verdicts and triggers — refinements on
binders, results and fields, ghost fields, auto-firing lemmas, unsat-core
hint replay, seed sweeps, scoped `opaque`/`reveal`, fuel, inferred
`decreases`, split obligations, effect-operation contracts, the three
tactic jobs as fixed passes, the agent-loop lessons, in-body `assume` — and
the rejections (universes, WP-indexed effects, a tactic language).
[`LEAN_ADOPTION_CANDIDATES`](backlog/LEAN_ADOPTION_CANDIDATES.md) is the
2026-10-14 Lean survey of the same shape, scoped to formal verification:
a table of what the verifier already has where Lean needed to build the
equivalent (per-VC verdict caching, paste-able counterexamples,
`decreases` obligations, `assumed()` as a visible `sorry`), eight
candidates (a lemma search for authors over T1's index, trust provenance
rendered from unsat cores, shrunk counterexamples, verify-time regression
tracking, parallel cold verification, a library lint, "Try this"
diagnostics for T2's auto-induction, decide-by-evaluation measured first
and likely parked), the positions it records (Yo's verifier is the
Lean-blaster posture with compensations Lean lacks; D2's reopen condition
is incident-shaped), and the rejections it adds (in-kernel decision
procedures like `omega`/`grind`, ambient rewrite automation and simp
sets, proof-term tiers over the compiler).
[`REFERENCES_AND_ORIGINS`](backlog/REFERENCES_AND_ORIGINS.md) is the design of
VALUES_BY_DEFAULT decisions 42 and 43 (2026-10-10, amended 2026-10-19 to
the origin design, #1483): references are first-class types parameterized
by an origin — a declared set of places, a new comptime kind beside `Type`
(`generic(p : Origin)`), written as a trailing argument `&(T, p)` /
`&mut(T, p)` and elided only to defaults the checker verifies. A
reference, and any type containing one, may stand anywhere its origins
can follow, storage included (`Box`, `RefCell`, declared-union
containers, `Dyn(Trait, p)`); the positions that accept no origins
(`Send`/spawn, `extern`, module-level, `Rc`/`Arc` payloads) are the
restated E0909, spelled as a `where(T <: Escapable)` bound on them
(a structural marker like `Send`, Rust's `T : 'static`; no implicit
bound on generics; O10). Conflict compares a loan to an access, never two
reference values; a `&` through an `Rc` deref carries the handle's place
(O9). §3.1 there is the audit against Rust: after 2026-10-20's fills the
one remaining gap is lending stack data across threads. Checking is substitution plus set algebra — conflict is
intersection, coercion is subset in covariant positions and exact
through a `&mut` pointee — with no region variables, outlives, variance
lattice or spelled HRTB; `impl(&T, …)`, `.*` with auto-deref on `.`,
`FnMut`. It unlocks zero-copy views, borrowing iterators, the entry API,
guards, `Cow`, parser remainders and storage behind owning pointers; the
2026-10-13 `depends`-clause and root-joining-tracker design is superseded
(its mapping is O7; the R1–R7 numbers other docs cite are that
predecessor's). Its own phase after decision 42's Generation B and V2b.
[`LIFETIME_REPLACEMENT_PATTERNS`](backlog/LIFETIME_REPLACEMENT_PATTERNS.md)
is the toolbox companion to the catalog (2026-10-10): the complete
inventory of mechanisms that cover a lifetime's three jobs — express
within a frame (the reference machinery R1–R7), store beyond it
(own/share/index/cursor/Cow/frozen/runtime-handle/move, with the
"indices for storage, borrows for access" maxim), verify (freeze and
exclusivity, summaries, `RefCell` marks, bounds + generations, the
collector, verifier proofs), and six structural rewrites (split by root,
build-then-freeze, arena-per-phase, collect-then-apply, own-the-sink,
store-inputs-re-derive-views) — plus a need→pattern selection table and
the four-item boundary no pattern covers (the untyped arena-outlives-ids
invariant, slot reuse without generational ids, stored exclusivity, and
the one multi-root-beyond-frame-compile-time shape that is decision 43's
recorded `generic(r : Region)` trigger). It opens with the position
statement — everything safe Rust computes, safe Yo computes with the
same memory safety; the differences are where the checking happens and
what sharing costs, not what is computable. §8 compares Vale/Valen's
group borrowing (verdagon.dev, 2026-10), the closest live alternative:
path-typed references and aggregate invalidation — the same insight
independently reached, a trade triangle (Valen wins stored-ref
aliasing, Yo wins exclusivity and type location-freedom), a soundness
verdict, and three harvests (field-path `depends`, unique reachability
as a static `get_mut`, generational-reference evidence for the
`Arena(T)`/`Id(T)` candidate).
[`COMPTIME_METAPROGRAMMING_AUDIT`](backlog/COMPTIME_METAPROGRAMMING_AUDIT.md)
(2026-10-22) is the full audit of comptime support asked for by the macro
removal, written against the post-VBD end state: the verdict (no capability
Yo wants is lost; the one real delta, user-defined ad-hoc expression
splicing, is the removal decision's deliberate trade), the audit of the four
layers (values, signatures, the CTFE engine, the quote/Expr/derive layer)
with a nine-item gap table, the proposed additions C1–C9 (comptime template
strings, a comptime-only `ComptimeDict`, `Expr` constructors and provenance
with `source_location()`, `comptime_fn` promotion widened past
integer/float/`comptime_str` returns, an arbitrary-precision `comptime_int`,
`comptime_for`, a CTFE budget), two rules it needs (`comptime_eval`
restricted to declarations, and a `Comptime` storage exclusion that must land
by VBD's B8), and the plan for the demonstration that comptime-only
metaprogramming is sufficient: a Lisp interpreter with Lisp-level macros,
running entirely in Yo's comptime context (`tests/comptime_lisp.test.yo`,
not yet written). It supersedes
[`UNIFIED_COMPTIME_DESIGN`](archive/UNIFIED_COMPTIME_DESIGN.md) (stale,
TS-era, archived).

[`NO_LIBC_BY_DEFAULT`](backlog/NO_LIBC_BY_DEFAULT.md) (2026-10-22) is the
audit + phased plan for Zig's default: emitted programs link **no libc**
unless `--libc on` or a referenced libc symbol opts them in (`--libc
auto|on|off`, modeled on `--cycle-collector`) — a per-arch `__yo_os`
syscall seam under the existing async/RC/allocator runtime (which stays
emitted in place; §2 answers the "does the runtime move out" question
with no), owned startup (crt0, TLS, clone/futex threads), formatting
(ryu print, vendored musl `strtod` — also fixing `%g`'s 6-digit
lossiness, two open S2s), math (a vendored musl libm subset in both
modes), DNS (an async resolver behind the existing `std/net/dns`, fixing
its two open S2s in both modes) and the default allocator (mimalloc over
the seam); decisions D1–D10 with recommendations, phases P0–P10 whose
differential gates (traps, syscalls, math) demand byte-identical output
against the libc build. The compiler and its release bundles stay hosted
static musl. Every runtime phase starts only after VALUES_BY_DEFAULT so
the cycle collector that decision 48 deletes is never ported onto the
seam; the std-only P3 (formatting) and P7 (DNS) may start now.

`archive/` holds closed campaigns; their banners are the summaries. Good
starting points: [`BOOTSTRAPPING`](archive/BOOTSTRAPPING.md) and
[`SELF_HOSTING_COMPLETION`](archive/SELF_HOSTING_COMPLETION.md) (self-hosting,
finished), [`BUILD_AND_DEPENDENCY_SYSTEM_REDESIGN`](archive/BUILD_AND_DEPENDENCY_SYSTEM_REDESIGN.md),
[`STD_API_STABILIZATION`](archive/STD_API_STABILIZATION.md),
[`LLM_FRIENDLY_TOOLCHAIN_AND_SYNTAX`](archive/LLM_FRIENDLY_TOOLCHAIN_AND_SYNTAX.md),
[`BUILD_ON_8GB_MACHINES`](archive/BUILD_ON_8GB_MACHINES.md) (Yo builds on an 8 GB machine, closed
2026-09-26) and [`PARALLELISM_SOUNDNESS`](archive/PARALLELISM_SOUNDNESS.md) (data-race freedom
for safe code; its rules live on in [`reference/PARALLELISM_RULES.md`](reference/PARALLELISM_RULES.md)).

## Conventions

- When a plan completes, is refuted or is superseded, add a closing banner at
  the top (the outcome, plus the commit or run that proved it), then `git mv`
  it into `archive/` — or into `reference/` if it is a landed design that
  stays authoritative — and update every reference
  (`grep -rn "plans/<NAME>.md"`). Add or remove its line here.
- A doc that is written but not started goes to `backlog/`; move it to the
  root when work starts.
- Numbers inside archived docs are frozen at their writing dates. Do not
  update them; the banner is the authoritative summary.
