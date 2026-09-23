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
- [`MATCH_PATTERN_MATCHING.md`](MATCH_PATTERN_MATCHING.md) — the `match` redesign (pattern IR, exhaustiveness, general lowering).
- [`EVALUATOR_MEMORY_REDUCTION.md`](EVALUATOR_MEMORY_REDUCTION.md) — cutting the evaluator's retained memory, measured per phase.
- [`SELF_VERIFICATION.md`](SELF_VERIFICATION.md) — Yo verifies Yo: the compiler as the verifier's flagship user.
- [`SAFE_MODE.md`](SAFE_MODE.md) — no undefined behavior in safe code: phases 0a–4 landed, elision and strict mode next.

## Reference (`reference/`)

| Area                   | Docs                                                                                                                                                                                                                                                                                                           |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Language policy        | [`FUNCTION_OVERLOADING_POLICY`](reference/FUNCTION_OVERLOADING_POLICY.md), [`OPERATOR_SET_AND_PRECEDENCE`](reference/OPERATOR_SET_AND_PRECEDENCE.md), [`PREFIX_OPERATOR_OPERAND_RULE`](reference/PREFIX_OPERATOR_OPERAND_RULE.md), [`MACRO_POLICY`](reference/MACRO_POLICY.md), [`LAZY_TOPLEVEL_BINDINGS`](reference/LAZY_TOPLEVEL_BINDINGS.md), [`MEMBER_VISIBILITY`](reference/MEMBER_VISIBILITY.md), [`REMOVE_OPEN_BUILTIN`](reference/REMOVE_OPEN_BUILTIN.md) |
| Types and traits       | [`ASSOCIATED_TYPES`](reference/ASSOCIATED_TYPES.md), [`HIGHER_KINDED_TYPES`](reference/HIGHER_KINDED_TYPES.md), [`GADTS`](reference/GADTS.md), [`DERIVE_TRAITS`](reference/DERIVE_TRAITS.md), [`INDEX_TRAIT`](reference/INDEX_TRAIT.md), [`COMPTIME_INDEX`](reference/COMPTIME_INDEX.md), [`TYPE_REFLECTION`](reference/TYPE_REFLECTION.md), [`ERROR_TRAIT_AND_TYPEID`](reference/ERROR_TRAIT_AND_TYPEID.md), [`FUNCTOR_APPLICATIVE_MONAD`](reference/FUNCTOR_APPLICATIVE_MONAD.md) |
| Memory and ownership   | [`MEMORY_SAFETY`](reference/MEMORY_SAFETY.md), [`RC_OWNERSHIP_IMPLEMENTATION`](reference/RC_OWNERSHIP_IMPLEMENTATION.md), [`REF_REFERENCE_SEMANTICS`](reference/REF_REFERENCE_SEMANTICS.md), [`ARC_TYPE`](reference/ARC_TYPE.md), [`THREAD_LOCAL_STORAGE`](reference/THREAD_LOCAL_STORAGE.md), [`FIXED_REGION_ALLOCATOR`](reference/FIXED_REGION_ALLOCATOR.md), [`WINDOWS_ALLOCATOR_DECISION`](reference/WINDOWS_ALLOCATOR_DECISION.md) |
| std                    | [`STRING_DESIGN`](reference/STRING_DESIGN.md), [`HASHER_REDESIGN`](reference/HASHER_REDESIGN.md), [`REGEX_ENGINE`](reference/REGEX_ENGINE.md), [`ASYNC_ITERATION_STREAM`](reference/ASYNC_ITERATION_STREAM.md) |
| Compiler               | [`ERROR_DIAGNOSTICS_OVERHAUL`](reference/ERROR_DIAGNOSTICS_OVERHAUL.md), [`INCREMENTAL_COMPILATION`](reference/INCREMENTAL_COMPILATION.md), [`INCREMENTAL_COMPILATION_ZIG_LESSONS`](reference/INCREMENTAL_COMPILATION_ZIG_LESSONS.md), [`CHUNKED_C_EMISSION`](reference/CHUNKED_C_EMISSION.md), [`CIRCULAR_DEPENDENCIES`](reference/CIRCULAR_DEPENDENCIES.md), [`C_INCLUDE_EXTERN_MODULE_VALUE`](reference/C_INCLUDE_EXTERN_MODULE_VALUE.md), [`WASM_SUPPORT`](reference/WASM_SUPPORT.md), [`MATCHING_LOGIC_RESEARCH`](reference/MATCHING_LOGIC_RESEARCH.md) |
| Build and distribution | [`BUILD_SYSTEM`](reference/BUILD_SYSTEM.md), [`STEP_API_AND_GLOBAL_CACHE`](reference/STEP_API_AND_GLOBAL_CACHE.md), [`DEPENDENCY_MANAGEMENT`](reference/DEPENDENCY_MANAGEMENT.md), [`VERSION_MANAGEMENT`](reference/VERSION_MANAGEMENT.md), [`TARGET_TRIPLES`](reference/TARGET_TRIPLES.md), [`RELEASE_ASSET_TRIPLES`](reference/RELEASE_ASSET_TRIPLES.md), [`PORTABLE_C_DISTRIBUTION`](reference/PORTABLE_C_DISTRIBUTION.md) |
| Tooling                | [`YO_CONTEXT`](reference/YO_CONTEXT.md), [`INIT_AGENT_SCAFFOLD`](reference/INIT_AGENT_SCAFFOLD.md), [`DOCUMENTATION_GENERATION`](reference/DOCUMENTATION_GENERATION.md), [`DOC_TAGS_AND_IDE`](reference/DOC_TAGS_AND_IDE.md), [`FMT_CALLEE_PREFIX_CANONICALIZATION`](reference/FMT_CALLEE_PREFIX_CANONICALIZATION.md) |

## Backlog and archive

`backlog/` holds the designs that are next or parked. The ones other docs lean
on most: [`FORMAL_VERIFICATION`](backlog/FORMAL_VERIFICATION.md) (the
verifier's design, V1–V7 landed),
[`SEED_VERSION_AUTOMATION`](backlog/SEED_VERSION_AUTOMATION.md),
[`DEPENDENT_TYPES_POSITION`](backlog/DEPENDENT_TYPES_POSITION.md),
[`BEND_LAWS_AND_AGENT_LOOP_LESSONS`](backlog/BEND_LAWS_AND_AGENT_LOOP_LESSONS.md)
and [`LLM_AUTHORING_AUDIT_2026-09-19`](backlog/LLM_AUTHORING_AUDIT_2026-09-19.md).

`archive/` holds closed campaigns; their banners are the summaries. Good
starting points: [`BOOTSTRAPPING`](archive/BOOTSTRAPPING.md) and
[`SELF_HOSTING_COMPLETION`](archive/SELF_HOSTING_COMPLETION.md) (self-hosting,
finished), [`BUILD_AND_DEPENDENCY_SYSTEM_REDESIGN`](archive/BUILD_AND_DEPENDENCY_SYSTEM_REDESIGN.md),
[`STD_API_STABILIZATION`](archive/STD_API_STABILIZATION.md) and
[`LLM_FRIENDLY_TOOLCHAIN_AND_SYNTAX`](archive/LLM_FRIENDLY_TOOLCHAIN_AND_SYNTAX.md).

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
