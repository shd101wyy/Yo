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

Only VALUES_BY_DEFAULT is in progress (until v0.2.79). Everything else is in
`backlog/`, ordered by [`backlog/POST_VBD_PLAN.md`](backlog/POST_VBD_PLAN.md).

- [`ROADMAP.md`](ROADMAP.md) — the language and product roadmap.
- [`VALUES_BY_DEFAULT.md`](VALUES_BY_DEFAULT.md) — every declared type is a
  value, `ref(...)`/`atomic(...)` leave the language, sharing is spelled
  `Rc(T)`/`Arc(T)`, references carry origins (decisions 1–50).
  - [`handover/VBD_RELEASE_SCHEDULE.md`](handover/VBD_RELEASE_SCHEDULE.md) —
    the release-by-release schedule (v0.2.76–v0.2.79) and every scheduling
    decision.
  - Its design sub-plans, in `backlog/` because they are designs rather than
    campaigns:
    - [`REFERENCES_AND_ORIGINS`](backlog/REFERENCES_AND_ORIGINS.md), decision
      43's design;
    - [`BORROW_CHECKER_COMPLETENESS`](backlog/BORROW_CHECKER_COMPLETENESS.md),
      decision 50's plan: O-1…O-6 and parity P1–P16;
    - [`OWNERSHIP_BORROWING_ORIGINS_AUDIT`](backlog/OWNERSHIP_BORROWING_ORIGINS_AUDIT.md),
      the 2026-11-11 audit of both against the built checker: findings,
      design corrections, the patch for the two docs above;
    - [`ALLOCATOR_PLACEMENT`](backlog/ALLOCATOR_PLACEMENT.md), the `Box` layout
      L1–L3;
    - [`MACRO_AND_ISO_REMOVAL`](backlog/MACRO_AND_ISO_REMOVAL.md), Part C;
    - [`KEBAB_CASE_NAMES`](backlog/KEBAB_CASE_NAMES.md), Part C;
    - [`AGENT_KNOWLEDGE_CONSOLIDATION`](backlog/AGENT_KNOWLEDGE_CONSOLIDATION.md),
      K2–K7;
    - [`OWNERSHIP_AND_BORROWING_DOC_DRAFT`](backlog/OWNERSHIP_AND_BORROWING_DOC_DRAFT.md),
      the user guide promoted at the end.
  - Campaign records in `handover/`:
    - the dated handovers `VBD_HANDOVER_*`;
    - `VBD_LOOKAHEAD_2026-10-23`;
    - `D43_STEP3_N2_DESIGN`;
    - `V5_PART_B_CLASSIFICATION`;
    - the B1/B3/B8 listings.

    They are historical: the schedule and the plan are authoritative.

## Reference (`reference/`)

| Area                   | Docs                                                                                                                                                                                                                                                                                                           |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Language policy        | [`DEPENDENT_TYPES_POSITION`](reference/DEPENDENT_TYPES_POSITION.md), [`FUNCTION_OVERLOADING_POLICY`](reference/FUNCTION_OVERLOADING_POLICY.md), [`OPERATOR_SET_AND_PRECEDENCE`](reference/OPERATOR_SET_AND_PRECEDENCE.md), [`PREFIX_OPERATOR_OPERAND_RULE`](reference/PREFIX_OPERATOR_OPERAND_RULE.md), [`MACRO_POLICY`](reference/MACRO_POLICY.md), [`LAZY_TOPLEVEL_BINDINGS`](reference/LAZY_TOPLEVEL_BINDINGS.md), [`MEMBER_VISIBILITY`](reference/MEMBER_VISIBILITY.md), [`REMOVE_OPEN_BUILTIN`](reference/REMOVE_OPEN_BUILTIN.md), [`MATCH_PATTERN_MATCHING`](reference/MATCH_PATTERN_MATCHING.md), [`BRACE_BLOCKS`](reference/BRACE_BLOCKS.md) |
| Types and traits       | [`ASSOCIATED_TYPES`](reference/ASSOCIATED_TYPES.md), [`HIGHER_KINDED_TYPES`](reference/HIGHER_KINDED_TYPES.md), [`GADTS`](reference/GADTS.md), [`DERIVE_TRAITS`](reference/DERIVE_TRAITS.md), [`INDEX_TRAIT`](reference/INDEX_TRAIT.md), [`COMPTIME_INDEX`](reference/COMPTIME_INDEX.md), [`TYPE_REFLECTION`](reference/TYPE_REFLECTION.md), [`TYPE_IDENTITY`](reference/TYPE_IDENTITY.md), [`ERROR_TRAIT_AND_TYPEID`](reference/ERROR_TRAIT_AND_TYPEID.md), [`FUNCTOR_APPLICATIVE_MONAD`](reference/FUNCTOR_APPLICATIVE_MONAD.md) |
| Memory and ownership   | [`MEMORY_SAFETY`](reference/MEMORY_SAFETY.md), [`RC_OWNERSHIP_IMPLEMENTATION`](reference/RC_OWNERSHIP_IMPLEMENTATION.md), [`REF_REFERENCE_SEMANTICS`](reference/REF_REFERENCE_SEMANTICS.md), [`ARC_TYPE`](reference/ARC_TYPE.md), [`THREAD_LOCAL_STORAGE`](reference/THREAD_LOCAL_STORAGE.md), [`FIXED_REGION_ALLOCATOR`](reference/FIXED_REGION_ALLOCATOR.md), [`EXPLICIT_ALLOCATORS`](reference/EXPLICIT_ALLOCATORS.md), [`WINDOWS_ALLOCATOR_DECISION`](reference/WINDOWS_ALLOCATOR_DECISION.md) |
| std                    | [`STRING_DESIGN`](reference/STRING_DESIGN.md), [`HASHER_REDESIGN`](reference/HASHER_REDESIGN.md), [`REGEX_ENGINE`](reference/REGEX_ENGINE.md), [`ASYNC_ITERATION_STREAM`](reference/ASYNC_ITERATION_STREAM.md) |
| Compiler               | [`ERROR_DIAGNOSTICS_OVERHAUL`](reference/ERROR_DIAGNOSTICS_OVERHAUL.md), [`INCREMENTAL_COMPILATION`](reference/INCREMENTAL_COMPILATION.md), [`INCREMENTAL_COMPILATION_ZIG_LESSONS`](reference/INCREMENTAL_COMPILATION_ZIG_LESSONS.md), [`CHUNKED_C_EMISSION`](reference/CHUNKED_C_EMISSION.md), [`ASYNC_AWAIT_SITE_FUSION`](reference/ASYNC_AWAIT_SITE_FUSION.md), [`CIRCULAR_DEPENDENCIES`](reference/CIRCULAR_DEPENDENCIES.md), [`C_INCLUDE_EXTERN_MODULE_VALUE`](reference/C_INCLUDE_EXTERN_MODULE_VALUE.md), [`WASM_SUPPORT`](reference/WASM_SUPPORT.md), [`MATCHING_LOGIC_RESEARCH`](reference/MATCHING_LOGIC_RESEARCH.md) |
| Build and distribution | [`BUILD_SYSTEM`](reference/BUILD_SYSTEM.md), [`STEP_API_AND_GLOBAL_CACHE`](reference/STEP_API_AND_GLOBAL_CACHE.md), [`DEPENDENCY_MANAGEMENT`](reference/DEPENDENCY_MANAGEMENT.md), [`VERSION_MANAGEMENT`](reference/VERSION_MANAGEMENT.md), [`TARGET_TRIPLES`](reference/TARGET_TRIPLES.md), [`RELEASE_ASSET_TRIPLES`](reference/RELEASE_ASSET_TRIPLES.md), [`PORTABLE_C_DISTRIBUTION`](reference/PORTABLE_C_DISTRIBUTION.md), [`DROP_LIBURING`](reference/DROP_LIBURING.md), [`LINUX_ASYNC_IO_PERFORMANCE`](reference/LINUX_ASYNC_IO_PERFORMANCE.md), [`MACOS_ASYNC_IO_PERFORMANCE`](reference/MACOS_ASYNC_IO_PERFORMANCE.md) |
| Tooling                | [`YO_CONTEXT`](reference/YO_CONTEXT.md), [`INIT_AGENT_SCAFFOLD`](reference/INIT_AGENT_SCAFFOLD.md), [`DOCUMENTATION_GENERATION`](reference/DOCUMENTATION_GENERATION.md), [`DOC_TAGS_AND_IDE`](reference/DOC_TAGS_AND_IDE.md), [`FMT_CALLEE_PREFIX_CANONICALIZATION`](reference/FMT_CALLEE_PREFIX_CANONICALIZATION.md) |

## Backlog and archive

`backlog/` holds everything that is written but not in progress. Each doc's
first lines carry a dated status: every doc was trued against the tree on
2026-11-07, and those notes start with "Trued 2026-11-07". The order of work
after VBD is [`POST_VBD_PLAN`](backlog/POST_VBD_PLAN.md), whose lanes group
the backlog:

| Lane | Docs |
| --- | --- |
| A. Soundness and language | [`TYPE_SYSTEM_SOUNDNESS`](backlog/TYPE_SYSTEM_SOUNDNESS.md), [`COMPTIME_METAPROGRAMMING_AUDIT`](backlog/COMPTIME_METAPROGRAMMING_AUDIT.md), [`BORROW_CHECKER_COMPLETENESS`](backlog/BORROW_CHECKER_COMPLETENESS.md), [`REFERENCES_AND_ORIGINS`](backlog/REFERENCES_AND_ORIGINS.md) |
| B. Runtime and platform | [`IO_INTERFACE_AND_STD_RUNTIME`](backlog/IO_INTERFACE_AND_STD_RUNTIME.md), [`THREAD_POOL_OWNED_WORKERS_AND_SHARED_QUEUE`](backlog/THREAD_POOL_OWNED_WORKERS_AND_SHARED_QUEUE.md), [`ALLOCATOR_PLACEMENT`](backlog/ALLOCATOR_PLACEMENT.md), [`ZIG_STYLE_ALLOCATORS`](backlog/ZIG_STYLE_ALLOCATORS.md), [`NO_LIBC_BY_DEFAULT`](backlog/NO_LIBC_BY_DEFAULT.md) |
| C. Performance | [`EVALUATOR_MEMORY_REDUCTION`](backlog/EVALUATOR_MEMORY_REDUCTION.md), [`CODEGEN_MEMORY_REDUCTION`](backlog/CODEGEN_MEMORY_REDUCTION.md), [`PARALLEL_COMPILATION`](backlog/PARALLEL_COMPILATION.md), [`CODEGEN_PERFORMANCE`](backlog/CODEGEN_PERFORMANCE.md) |
| D. Docs and the agent loop | [`AGENT_KNOWLEDGE_CONSOLIDATION`](backlog/AGENT_KNOWLEDGE_CONSOLIDATION.md), [`OWNERSHIP_AND_BORROWING_DOC_DRAFT`](backlog/OWNERSHIP_AND_BORROWING_DOC_DRAFT.md), [`RUST_REFERENCE_PATTERNS`](backlog/RUST_REFERENCE_PATTERNS.md), [`BEND_LAWS_AND_AGENT_LOOP_LESSONS`](backlog/BEND_LAWS_AND_AGENT_LOOP_LESSONS.md) |
| E. Verification | [`SAFE_MODE`](backlog/SAFE_MODE.md), [`SAFE_MODE_5B_VERIFIED_GUARD_ELISION`](backlog/SAFE_MODE_5B_VERIFIED_GUARD_ELISION.md), [`DEFAULT_ON_VERIFICATION`](backlog/DEFAULT_ON_VERIFICATION.md), [`SELF_VERIFICATION`](backlog/SELF_VERIFICATION.md), [`PROVEN_CORE`](backlog/PROVEN_CORE.md), [`FORMAL_VERIFICATION`](backlog/FORMAL_VERIFICATION.md), [`THEOREM_PROVING_DIRECTION`](backlog/THEOREM_PROVING_DIRECTION.md), [`THEOREM_PROVING_NEXT`](backlog/THEOREM_PROVING_NEXT.md), [`ADA_SPARK_LESSONS`](backlog/ADA_SPARK_LESSONS.md) |
| F. std and reach | [`ASYNC_DEADLINE_COMBINATOR`](backlog/ASYNC_DEADLINE_COMBINATOR.md), [`ASYNC_LINES_NEEDS_A_NONTHROWING_READ`](backlog/ASYNC_LINES_NEEDS_A_NONTHROWING_READ.md), [`RAW_AND_FENCED_STRING_LITERALS`](backlog/RAW_AND_FENCED_STRING_LITERALS.md), [`MODULE_PREFIX_STUTTER_REMAINDER`](backlog/MODULE_PREFIX_STUTTER_REMAINDER.md), [`LANGUAGE_FEATURE_CANDIDATES`](backlog/LANGUAGE_FEATURE_CANDIDATES.md), [`PACKAGE_MANAGER_DISTRIBUTION`](backlog/PACKAGE_MANAGER_DISTRIBUTION.md), [`SEED_VERSION_AUTOMATION`](backlog/SEED_VERSION_AUTOMATION.md) |
| VBD tail (finishes by v0.2.79) | [`MACRO_AND_ISO_REMOVAL`](backlog/MACRO_AND_ISO_REMOVAL.md), [`KEBAB_CASE_NAMES`](backlog/KEBAB_CASE_NAMES.md) |
| Candidate catalogues (pull-only) | [`RUST_ADOPTION_CANDIDATES`](backlog/RUST_ADOPTION_CANDIDATES.md), [`ZIG_ADOPTION_CANDIDATES`](backlog/ZIG_ADOPTION_CANDIDATES.md), [`FSTAR_ADOPTION_CANDIDATES`](backlog/FSTAR_ADOPTION_CANDIDATES.md), [`LEAN_ADOPTION_CANDIDATES`](backlog/LEAN_ADOPTION_CANDIDATES.md), [`GOOSE_ADOPTION_CANDIDATES`](backlog/GOOSE_ADOPTION_CANDIDATES.md), [`K_FRAMEWORK_ENGINEERING_LESSONS`](backlog/K_FRAMEWORK_ENGINEERING_LESSONS.md) |

`archive/` holds closed records: landed campaigns, refuted or superseded
proposals, and finished audits, each with a banner. Its numbers are frozen at
their writing dates. The 2026-11-07 audit archived these, among others:
- landed: `ASYNC_IO_API_AUDIT`, `ASYNC_STATE_MACHINE_GENERATION`,
  `STRING_VALUE_SEMANTICS`, `WEAK_AND_UNCOLLECTED_RC`,
  `STATIC_ARGUMENT_INFERENCE`, `ATS_STYLE_INDEXED_TYPES`,
  `ATS_LESSONS_BEYOND_INDEXED_TYPES`, `OVERLOADING_REDESIGN`;
- superseded by later decisions: `ARENA_ALLOCATOR_FEASIBILITY`,
  `LIFETIME_REPLACEMENT_PATTERNS`, `NODEJS_API_IMPLEMENTATION_PLAN`,
  `TYPEVALUE_HASH_CONSING`, `UNSAFE_SCOPING_AND_POINTER_ITERATORS`;
- 2023 scratch: `IDEA`, `IN_DESIGN`.

`AGENT_LOOP_NEXT` was folded into `BEND_LAWS_AND_AGENT_LOOP_LESSONS`, and the
backlog copy of `ASYNC_ITERATION_STREAM` was deleted in favour of the
`reference/` copy.

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
