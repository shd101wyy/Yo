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
- [`V0251_RELEASE_HANDOVER.md`](handover/V0251_RELEASE_HANDOVER.md) — what must land for v0.2.51 before VALUES_BY_DEFAULT starts: the open PR stack (#1172–#1175, String S3, the newtype-retain fix), the S3 heap-corruption blocker, the release steps, and V1 step 0b as the next agent's first task.
- [`TYPE_SYSTEM_SOUNDNESS_HANDOVER.md`](handover/TYPE_SYSTEM_SOUNDNESS_HANDOVER.md) — where that plan stands: four pushed branches (flow orientation, registry retirement, Phase 6 closure re-raise, an option-self-field repro) and the work not started.
- [`VBD_HANDOVER_2026-10-06.md`](handover/VBD_HANDOVER_2026-10-06.md) — the 2026-10-06 handover of the VALUES_BY_DEFAULT campaign (in handover/): what landed since v0.2.52, the open PRs (#1200, #1231), the four pushed wave-2 Generation A branches and their known problems, the v0.2.53 release step, the Generation B queue, open bugs (an S1 cycle-collector resurrection UAF), and portable gate instructions.
- [`VBD_HANDOVER_2026-10-07.md`](handover/VBD_HANDOVER_2026-10-07.md) — the 2026-10-07 handover: all five wave-2/S1 PRs and the CI-hygiene layer landed (v0.2.53/v0.2.54), the new merge machinery (merge-gate, tree-hygiene, batch-merge pattern), and the queue the next agent picks up (FnOnce, the Generation B tranche on the v0.2.54 seed, the later phases).
- [`VBD_HANDOVER_2026-10-10.md`](handover/VBD_HANDOVER_2026-10-10.md) — the 2026-10-10 handover: v0.2.55–v0.2.58 (the Copy flip, the V3b by-value flip, `&x` only a borrow), the three in-flight branches (consuming match, decision 42 Gen A, the marker sweep + E0914), and the queue: decision 42 Gen B deletes `imm`/`mut`, the plan rewrite in the final spelling, then V3 async, V1 step 2, V2b/V2c, decisions 41/43/44, V4, V5.
- [`VALUES_BY_DEFAULT.md`](VALUES_BY_DEFAULT.md) — every declared type is a value; `ref(...)`/`atomic(...)` leave the language; sharing is spelled `Rc(T)`/`Arc(T)`. Amended 2026-10-05 (§0): unique ownership (Hylo's model) replaces copy-on-write: buffers and `Box` have one owner and no count, copies of buffer-owning values are explicit (`.clone()`), a last use moves, resources are move-only, `Send` is a move.
- [`ATS_LESSONS_BEYOND_INDEXED_TYPES.md`](ATS_LESSONS_BEYOND_INDEXED_TYPES.md) — what else Yo takes from ATS beyond indexed types: the lemma layer, must-use results, an init proof token (fixes an S1 in `ArrayList.set_len`), spec-transparent pure functions, lexicographic `decreases`, the typestate idiom.
- [`AGENT_KNOWLEDGE_CONSOLIDATION.md`](AGENT_KNOWLEDGE_CONSOLIDATION.md) — one home per fact across the pack, the skills and the manuals: fix the cheatsheets' stale and self-contradicting rules, move unique facts into manuals, slim each skill to a trigger plus `yo context` pointers, make `yo skills install` prune, and compile documentation code blocks.
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
Safe mode's open work is listed in [`SAFE_MODE`](SAFE_MODE.md); the
verifier-driven guard elision design, Phases 0–2 landed and Phase 3 open, is
[`SAFE_MODE_5B_VERIFIED_GUARD_ELISION`](backlog/SAFE_MODE_5B_VERIFIED_GUARD_ELISION.md)
(strict mode builds on it); its container bounds-check prerequisite is designed in
[`SAFE_MODE_5B_CONTAINER_BOUNDS_ELISION`](backlog/SAFE_MODE_5B_CONTAINER_BOUNDS_ELISION.md).
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
[`NON_ESCAPABLE_TYPES`](backlog/NON_ESCAPABLE_TYPES.md) is the design of
VALUES_BY_DEFAULT decisions 42 and 43 (2026-10-10): references `&T`/`&mut T`
are types, second-class, with lifetimes elided — they may live anywhere laid
out inline (fields, enum payloads, tuples, arrays, `Option(&T)`) and in
root-joining buffer containers (`ArrayList(&T)`, whose roots grow with
every `&` pushed in), never in a cell; a function returns one only when
every root is its own parameter, inferred, narrowed by `depends(...)`
(§3.13 A2's rule for borrowing futures, generalized); `impl(&T, …)`, `.*`
with auto-deref on `.`, `FnMut`. It unlocks zero-copy views, borrowing
iterators, the entry API, guards, `Cow` and parser remainders, keeps
mutable value semantics for owned values, and rejects named regions and
origins. Its own phase after decision 42's Generation B and V2b.
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
what sharing costs, not what is computable.

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
