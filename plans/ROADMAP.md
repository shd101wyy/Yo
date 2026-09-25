# Yo Roadmap

**Statuses trued 2026-09-23.** One line per item; the linked doc carries the
detail and its own status. History lives in the docs, not here.

## Positioning

**Memory-safe without lifetimes, verifies gradually, compiles to readable
C11, designed for the LLM era.** Yo takes Swift's memory model (RC + cycle
collection + `inout` parameter modes: borrows are modes, not types), adds
algebraic effects and comptime, and aims at two niches the incumbents leave
open: humane verified systems programming, and a language designed for LLM
authorship from day one.

## Done

- **Self-hosting.** The compiler is written in Yo, builds itself from the
  previous release, and ships installers, release bundles and a Yo-native LSP
  ([`archive/BOOTSTRAPPING.md`](archive/BOOTSTRAPPING.md),
  [`archive/SELF_HOSTING_COMPLETION.md`](archive/SELF_HOSTING_COMPLETION.md)).
- **Formal verification, V1–V7.** `requires`/`ensures`, loop invariants,
  `decreases`, ghost code and laws, lowered to SMT-LIB and discharged by Z3;
  `yo verify`
  ([`backlog/FORMAL_VERIFICATION.md`](backlog/FORMAL_VERIFICATION.md)).
- **Iteration speed.** Incremental compilation: an artifact cache, a
  resident `--watch` checker, and chunked C emission with a `.o` cache
  ([`reference/INCREMENTAL_COMPILATION.md`](reference/INCREMENTAL_COMPILATION.md),
  [`reference/CHUNKED_C_EMISSION.md`](reference/CHUNKED_C_EMISSION.md)).
- **Diagnostics.** Structured, coded errors; `yo explain`; `--error-format
  human|short|json|sarif`; `yo fix` applying structured repairs
  ([`reference/ERROR_DIAGNOSTICS_OVERHAUL.md`](reference/ERROR_DIAGNOSTICS_OVERHAUL.md)).
- **Build and dependencies.** `yo.toml`, `yo.lock`, a content-addressed
  store, and `yo build` over a parallel DAG
  ([`archive/BUILD_AND_DEPENDENCY_SYSTEM_REDESIGN.md`](archive/BUILD_AND_DEPENDENCY_SYSTEM_REDESIGN.md)).
- **std maturation.** HTTP, TLS, time, process, async (waker scheduling,
  `Mutex`, `Channel`, `Stream`), stabilized conventions
  ([`archive/STD_API_STABILIZATION.md`](archive/STD_API_STABILIZATION.md)).
- **Targets.** macOS, Linux and Windows on x86_64 and arm64, plus
  `wasm32-wasi` and emscripten, all in CI; a portable single-file `yo.c`
  ([`reference/WASM_SUPPORT.md`](reference/WASM_SUPPORT.md),
  [`reference/PORTABLE_C_DISTRIBUTION.md`](reference/PORTABLE_C_DISTRIBUTION.md)).
- **LLM-first toolchain.** Agent-oriented CLI and diagnostics, `yo init`
  agent scaffolding, and `yo context`: the language pack plus a queryable API
  index
  ([`archive/LLM_FRIENDLY_TOOLCHAIN_AND_SYNTAX.md`](archive/LLM_FRIENDLY_TOOLCHAIN_AND_SYNTAX.md),
  [`reference/YO_CONTEXT.md`](reference/YO_CONTEXT.md)).

## Now

- **`match` redesign.** P1–P3 landed; tuple and struct scrutinees, the async
  lowering and the adoption sweep remain
  ([`MATCH_PATTERN_MATCHING.md`](MATCH_PATTERN_MATCHING.md)).
- **Evaluator memory.** `check src/main.yo` went from 19.9 to 2.6 GB (two
  codegen leaks were most of it: `f(match(...))` arguments, 3 GB, and every
  `HashMap` rehash leaking its RC entries, 2.9 GB); a CI memory ratchet, the
  LSP per-round growth, the header diet and `Option(ref)` remain
  ([`EVALUATOR_MEMORY_REDUCTION.md`](EVALUATOR_MEMORY_REDUCTION.md)). Next
  after it: building the compiler on an 8 GB machine, i.e. the codegen phase
  and cc no longer running while `yo compile` holds its heap
  ([`BUILD_ON_8GB_MACHINES.md`](BUILD_ON_8GB_MACHINES.md)).
- **Yo verifies Yo.** The compiler as the verifier's flagship user, rung by
  rung ([`SELF_VERIFICATION.md`](SELF_VERIFICATION.md)).
- **Type-system soundness.** Make `yo check` a gate, not a filter: the
  audit's holes (unchecked closure results, trait impl completeness,
  coherence, swallowed closure-body errors) and one authoritative identity for
  resolved type variables
  ([`TYPE_SYSTEM_SOUNDNESS.md`](TYPE_SYSTEM_SOUNDNESS.md)).
- **Parallelism soundness.** Data-race freedom for safe code, for real: close
  the audit's holes (writes through `Arc` via `inout`, the unchecked `Iso`
  constructor, module globals, closure types, `RawMutex`/`Cond` UB, the
  spawned-loop waker race), then a TSan-clean gate over the whole thread
  corpus ([`PARALLELISM_SOUNDNESS.md`](PARALLELISM_SOUNDNESS.md)).
- **Safe mode.** No undefined behavior in safe code. Phases 0a–4 landed:
  loud escaped unwinds, bounds-checked indexing, guarded `/` and `%`,
  overflow traps with `wrapping_*` as the escape hatch, saturating casts, the
  panic-vocabulary ban, and an allocation-failure audit. Remaining (its §14): the
  comptime-panic diagnostic, the docs debt, the trap oracles, the UBSan
  acceptance run, verifier-driven check elision (its FV gate is lifted), and
  strict mode
  ([`SAFE_MODE.md`](SAFE_MODE.md)).

## Next

- **Agent loop.** Laws, a `yo verify --strict` gate and an evals corpus that
  measures agents writing Yo
  ([`backlog/BEND_LAWS_AND_AGENT_LOOP_LESSONS.md`](backlog/BEND_LAWS_AND_AGENT_LOOP_LESSONS.md),
  [`backlog/LLM_AUTHORING_AUDIT_2026-09-19.md`](backlog/LLM_AUTHORING_AUDIT_2026-09-19.md)).
- **Debug info.** `#line` directives mapping the emitted C back to `.yo`
  sources, so a C debugger steps through Yo.
- **Package registry.** A registry and `yo publish` on top of the git and
  path dependencies that exist today; deferred when the build campaign
  closed.
- **Seed automation.** Release the seed on a schedule, so compiler fixes reach
  `src/` and `std/` without a manual release
  ([`backlog/SEED_VERSION_AUTOMATION.md`](backlog/SEED_VERSION_AUTOMATION.md)).
- **Publish for pretraining.** Docs, an idiomatic example corpus and
  permissively licensed repositories, so the next model generation knows Yo.

## Non-goals

- Competing with Rust on zero-overhead abstractions or with C on manual
  control. RC + cycle collection is the identity.
- Lifetimes or borrow types. Borrows stay parameter modes (`inout`), backed by
  the runtime exclusivity check and the flowability rules.
- Runtime dependent types. Runtime properties go through the verifier
  ([`backlog/DEPENDENT_TYPES_POSITION.md`](backlog/DEPENDENT_TYPES_POSITION.md)).
- A native or LLVM backend. Yo compiles to C, and compile-speed work stays
  inside the C backend.
- A self-hosted prover. SMT solvers are the backend; Yo owns obligation
  generation and the gradual `VerifyOrAssert` experience.
