# Yo Roadmap

**Updated 2026-11-28.** One line per item. The linked doc holds the detail,
the status and the history. A PR that lands, starts, slips or adds an item
updates its line here in the same PR.

## Positioning

Memory-safe without a collector or region lifetimes, verifies gradually,
compiles to readable C11, designed for the LLM era. Yo takes Rust's ownership
model (unique values, `Rc`/`Arc`/`Weak`, exclusivity-checked references whose
origins name *what* is borrowed) and adds explicit capabilities, comptime and a
built-in verifier.

## Now: VALUES_BY_DEFAULT finishes

[`VALUES_BY_DEFAULT.md`](VALUES_BY_DEFAULT.md); each release's full scope is in
[`handover/VBD_RELEASE_SCHEDULE.md`](handover/VBD_RELEASE_SCHEDULE.md).

| Release | Content |
| --- | --- |
| v0.2.80 | Published 2026-11-26. The language migration is complete. The soundness claim is not made while known S1s stay open |
| v0.2.81 | Implicit dup deleted (VERDICTS-70 rows 7–14); owned destructuring consumes its source (landed); `Deref` forwarding deleted; `Display`/`Debug` replace `ToString`; std's Rust alignment S-1–S-4 and S-6; IO-1b; variant patterns (VERDICTS-88); the spec/proof soundness rules ([`SPEC_AND_PROOF`](backlog/SPEC_AND_PROOF.md) PR 0, 1a, 1b); the async allocation baseline ([`ALLOCATION_FREE_ASYNC`](backlog/ALLOCATION_FREE_ASYNC.md) AFA-0); errors as values adopted ([`ERRORS_AS_VALUES`](backlog/ERRORS_AS_VALUES.md) E-0a) |
| v0.2.82 | Implicit drop deleted (VERDICTS-70 row 15); VBD closes; a run-time `ensures` checked on every `return` (ERRORS_AS_VALUES E-0b) |

## Next: after VBD

Six lanes, at most four at once
([`backlog/POST_VBD_PLAN.md`](backlog/POST_VBD_PLAN.md)):

- **A. Soundness.** [`TYPE_SYSTEM_SOUNDNESS`](backlog/TYPE_SYSTEM_SOUNDNESS.md);
  the walls VBD dropped in [`REFERENCES_AND_ORIGINS`](backlog/REFERENCES_AND_ORIGINS.md),
  then the D1 thread-reach holes (A41/A42), scoped threads and lending iterators.
  `ctl`/`unwind` deleted, errors are values
  ([`ERRORS_AS_VALUES`](backlog/ERRORS_AS_VALUES.md)): `try` in v0.2.83, std
  in v0.2.84, the compiler in v0.2.84–85, the mechanism out in v0.2.86.
- **B. Runtime.** The `Io` interface
  ([`IO_INTERFACE_AND_STD_RUNTIME`](backlog/IO_INTERFACE_AND_STD_RUNTIME.md)),
  then allocation-free async ([`ALLOCATION_FREE_ASYNC`](backlog/ALLOCATION_FREE_ASYNC.md)),
  `global_allocator`, and no libc by default
  ([`NO_LIBC_BY_DEFAULT`](backlog/NO_LIBC_BY_DEFAULT.md),
  [`ZIG_STYLE_ALLOCATORS`](backlog/ZIG_STYLE_ALLOCATORS.md)).
- **C. Performance.** Compiler memory and time
  ([`EVALUATOR_MEMORY_REDUCTION`](backlog/EVALUATOR_MEMORY_REDUCTION.md),
  [`CODEGEN_MEMORY_REDUCTION`](backlog/CODEGEN_MEMORY_REDUCTION.md),
  [`PARALLEL_COMPILATION`](backlog/PARALLEL_COMPILATION.md)) and the generated
  code ([`CODEGEN_PERFORMANCE`](backlog/CODEGEN_PERFORMANCE.md)).
- **D. Docs and agents.** One source of truth for agents
  ([`AGENT_KNOWLEDGE_CONSOLIDATION`](backlog/AGENT_KNOWLEDGE_CONSOLIDATION.md))
  and an evals corpus
  ([`BEND_LAWS_AND_AGENT_LOOP_LESSONS`](backlog/BEND_LAWS_AND_AGENT_LOOP_LESSONS.md)).
- **E. Verification.** Soundness first (SPEC_AND_PROOF PR 1a/1b and
  DEFAULT_ON_VERIFICATION S2, v0.2.81); then in parallel `logic` and `lemma`
  replace `ghost_fn` ([`SPEC_AND_PROOF`](backlog/SPEC_AND_PROOF.md), ~v0.2.83)
  and verification on by default
  ([`DEFAULT_ON_VERIFICATION`](backlog/DEFAULT_ON_VERIFICATION.md) §3.1: the
  solver shipped and incremental verification, then report by default); verified
  std bodies after the split, then erase by default
  ([`SAFE_MODE`](backlog/SAFE_MODE.md),
  [`THEOREM_PROVING_DIRECTION`](backlog/THEOREM_PROVING_DIRECTION.md),
  [`SELF_VERIFICATION`](backlog/SELF_VERIFICATION.md)); a proved core
  ([`PROVEN_CORE`](backlog/PROVEN_CORE.md)).
- **F. std and reach.** [`STD_RUST_ALIGNMENT`](backlog/STD_RUST_ALIGNMENT.md),
  [`STABLE_C_ABI`](backlog/STABLE_C_ABI.md),
  [`GITHUB_LINGUIST_SUPPORT`](backlog/GITHUB_LINGUIST_SUPPORT.md), a package
  registry ([`PACKAGE_MANAGER_DISTRIBUTION`](backlog/PACKAGE_MANAGER_DISTRIBUTION.md)),
  [`SEED_VERSION_AUTOMATION`](backlog/SEED_VERSION_AUTOMATION.md).

## Done

- Self-hosting, from the previous release ([`archive/BOOTSTRAPPING.md`](archive/BOOTSTRAPPING.md)).
- Formal verification V1–V7 with Z3 ([`backlog/FORMAL_VERIFICATION.md`](backlog/FORMAL_VERIFICATION.md)).
- Incremental and chunked compilation ([`reference/INCREMENTAL_COMPILATION.md`](reference/INCREMENTAL_COMPILATION.md)).
- Coded diagnostics, `yo explain`, `yo fix` ([`reference/ERROR_DIAGNOSTICS_OVERHAUL.md`](reference/ERROR_DIAGNOSTICS_OVERHAUL.md)).
- `yo.toml`, `yo.lock` and `yo build` ([`reference/BUILD_SYSTEM.md`](reference/BUILD_SYSTEM.md)).
- macOS, Linux, Windows, wasm and a portable `yo.c` ([`reference/WASM_SUPPORT.md`](reference/WASM_SUPPORT.md)).
- `yo context` and agent scaffolding ([`reference/YO_CONTEXT.md`](reference/YO_CONTEXT.md)).
- Parallelism rules D1–D10 ([`reference/PARALLELISM_RULES.md`](reference/PARALLELISM_RULES.md)); two D1 S1 holes are open (lane A).
- Pattern matching ([`reference/MATCH_PATTERN_MATCHING.md`](reference/MATCH_PATTERN_MATCHING.md)).
- Async state machines ([`reference/ASYNC_AWAIT_SITE_FUSION.md`](reference/ASYNC_AWAIT_SITE_FUSION.md)).
- Safe mode phases 0a–5b.2 ([`backlog/SAFE_MODE.md`](backlog/SAFE_MODE.md)).
- VBD through v0.2.80: values, `Rc`/`Arc`/`Weak` without a collector, origins.

## Non-goals

- Out-competing Rust's zero-overhead abstractions or C's manual control.
- Region lifetimes in the surface language: an origin is a set of places
  ([`backlog/REFERENCES_AND_ORIGINS.md`](backlog/REFERENCES_AND_ORIGINS.md)).
- Runtime dependent types ([`reference/DEPENDENT_TYPES_POSITION.md`](reference/DEPENDENT_TYPES_POSITION.md)).
- A native or LLVM backend.
- A self-hosted prover: SMT solvers are the backend.
- Moving a started async task between threads.
