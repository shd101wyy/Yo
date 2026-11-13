# Yo Roadmap

**Statuses trued 2026-11-08** (after the 2026-11-07 audit of every plan). One
line per item; the linked doc carries the detail and its own status. History
lives in the docs, not here.

## Positioning

**Memory-safe without a collector or region lifetimes, verifies gradually,
compiles to readable C11, designed for the LLM era.**

Yo takes Rust's memory model:
- values with unique ownership;
- `Rc`/`Arc` for sharing, and `Weak`/`ArcWeak` for back edges;
- no collector (VALUES_BY_DEFAULT decision 48);
- first-class, exclusivity-checked references.

Its references `&(T, p)` are parameterized by origins, which name *what* is
borrowed (a set of places) rather than *how long* (decision 43). The target is
a borrow checker with Rust-parity expressiveness and no soundness holes
(decision 50). "Rust-parity" stays a target, not a v0.2.79 fact: v0.2.79
claims the language migration and a checker that is sound on what it accepts,
and the parity claim is made when `DIVERGENCES.tsv` has no row "rejected
pending a parity item"
([`handover/VBD_RELEASE_SCHEDULE.md`](handover/VBD_RELEASE_SCHEDULE.md) §5g).

On top of that Yo adds algebraic effects, comptime and a built-in verifier. It
aims at two niches the incumbents leave open: humane verified systems
programming, and a language designed for LLM authorship from day one.

## Done

- **Self-hosting.** The compiler is written in Yo, builds itself from the
  previous release, and ships installers, release bundles and a Yo-native
  LSP ([`archive/BOOTSTRAPPING.md`](archive/BOOTSTRAPPING.md)).
- **Formal verification, V1–V7.** `requires`/`ensures`, loop invariants,
  `decreases`, ghost code and laws, lowered to SMT-LIB and discharged by Z3.
  `yo verify --strict` is a CI gate
  ([`backlog/FORMAL_VERIFICATION.md`](backlog/FORMAL_VERIFICATION.md), the
  verifier's design of record).
- **Iteration speed.** An artifact cache, a resident `--watch` checker, and
  chunked C emission with a `.o` cache
  ([`reference/INCREMENTAL_COMPILATION.md`](reference/INCREMENTAL_COMPILATION.md),
  [`reference/CHUNKED_C_EMISSION.md`](reference/CHUNKED_C_EMISSION.md)).
- **Diagnostics.** Structured, coded errors; `yo explain`; `--error-format`;
  `yo fix` applying structured repairs
  ([`reference/ERROR_DIAGNOSTICS_OVERHAUL.md`](reference/ERROR_DIAGNOSTICS_OVERHAUL.md)).
- **Build and dependencies.** `yo.toml`, `yo.lock`, a content-addressed
  store, and `yo build` over a parallel DAG
  ([`reference/BUILD_SYSTEM.md`](reference/BUILD_SYSTEM.md)).
- **Targets.** macOS, Linux and Windows on x86_64 and arm64, plus
  `wasm32-wasi` and emscripten, all in CI, and a portable single-file `yo.c`
  ([`reference/WASM_SUPPORT.md`](reference/WASM_SUPPORT.md),
  [`reference/PORTABLE_C_DISTRIBUTION.md`](reference/PORTABLE_C_DISTRIBUTION.md)).
- **LLM-first toolchain.** Agent-oriented CLI and diagnostics, `yo init`
  agent scaffolding, and `yo context`
  ([`reference/YO_CONTEXT.md`](reference/YO_CONTEXT.md)).
- **Parallelism soundness.** Data-race freedom for safe code (rules D1–D10,
  with `Send`/`Sync` split as in Rust), enforced at `check`, with a TSan run as
  the standing proof
  ([`reference/PARALLELISM_RULES.md`](reference/PARALLELISM_RULES.md)).
  **Known gap, 2026-11-13 (VERDICTS-58 decision 6):** two S1 holes in rule
  D1's thread reach walk are open, so "data-race freedom for safe code" is
  not yet a claim that holds: the walk does not see `Drop`, so a value
  dropped on another thread races on a global
  (`issues/2026-11-11-the-d1-thread-reach-walk-does-not-see-drop-so-a-value-dropped-on-another-thread-races-on-a-global.md`,
  audit A41), and it trusts every std body, including the user impls a std
  generic calls
  (`issues/2026-11-11-the-d1-thread-reach-walk-trusts-every-std-body-including-the-user-impls-a-std-generic-calls.md`,
  audit A42). They belong to `PARALLELISM_RULES.md`, which VBD did not
  change, so they are post-VBD lane A items ahead of scoped threads
  ([`backlog/POST_VBD_PLAN.md`](backlog/POST_VBD_PLAN.md)).
- **Real pattern matching**
  ([`reference/MATCH_PATTERN_MATCHING.md`](reference/MATCH_PATTERN_MATCHING.md)),
  and **`#line` debug info**
  ([`reference/LINE_DIRECTIVES.md`](reference/LINE_DIRECTIVES.md)).
- **Async.** The single-pass resumable state-machine lowering, await-site
  fusion, a value `JoinHandle` and future-taking `timeout`/`select`
  ([`reference/ASYNC_AWAIT_SITE_FUSION.md`](reference/ASYNC_AWAIT_SITE_FUSION.md),
  [`archive/ASYNC_STATE_MACHINE_GENERATION.md`](archive/ASYNC_STATE_MACHINE_GENERATION.md)).
- **Safe mode, phases 0a–5b.2.** Loud unwinds, bounds-checked indexing,
  guarded division, overflow traps, saturating casts, and verifier-driven
  guard elision ([`backlog/SAFE_MODE.md`](backlog/SAFE_MODE.md)).
- **Inside VBD, landed:**
  - `String` and the collections as values
    ([`archive/STRING_VALUE_SEMANTICS.md`](archive/STRING_VALUE_SEMANTICS.md));
  - `Rc`/`Arc` without a collector, with `Weak`
    ([`archive/WEAK_AND_UNCOLLECTED_RC.md`](archive/WEAK_AND_UNCOLLECTED_RC.md));
  - allocator placement by argument
    ([`backlog/ALLOCATOR_PLACEMENT.md`](backlog/ALLOCATOR_PLACEMENT.md));
  - static argument inference
    ([`archive/STATIC_ARGUMENT_INFERENCE.md`](archive/STATIC_ARGUMENT_INFERENCE.md));
  - the isolated-transfer type deleted;
  - kebab-case package names;
  - decision 43's reference checker N0–N3
    ([`backlog/REFERENCES_AND_ORIGINS.md`](backlog/REFERENCES_AND_ORIGINS.md)).

## Now — only VALUES_BY_DEFAULT (v0.2.78 → v0.2.79)

Every declared type is a value, `ref(...)`/`atomic(...)` leave the language,
references carry origins, and the checker is sound on what it accepts
([`VALUES_BY_DEFAULT.md`](VALUES_BY_DEFAULT.md); release by release in
[`handover/VBD_RELEASE_SCHEDULE.md`](handover/VBD_RELEASE_SCHEDULE.md), whose
§5g defines the two claims "VBD complete" makes). What remains:

| Release | Content |
| --- | --- |
| **v0.2.77** | **Published 2026-11-13.** The `yo fix` migrations retire (every mode except `deref`); G2's borrowing collections (`impl(&C, IntoIterator)`); decision 49 S1 (`?Sized`, `str`, `[T]`, `Dyn`, compiler half) with `Box` layout L1; brace groups Generation A; the borrow-checker stack O-1…O-6, P3, P8, P9 and the audit's cut-gate fixes. The parser's `ref`/`atomic` drop moved to v0.2.79 |
| **v0.2.78** (cut target 2026-11-25, latest 11-27) | The sweeps: `deref` and brace groups Generation B (one window); decision 49 S2 (std over `?Sized`) with `Box` layout L2, then S3a (the `Dyn` deletions) and G3; kebab-case module files (Part C), last. The audit's clusters 1–8 close by rule or wall (wall date 2026-11-20); G-D now, then G-C; P1 behind cluster 4, P2 and P12 |
| **v0.2.79** (cut target 2026-12-11, latest 12-19) | The three-tree retype (`Token`, `AstExpr`, `EvalValue`) and the parser drop of `ref`/`atomic`; S3b (`str`/`slice_copy`); the mode retirements; `Box` layout L3. **The language migration is complete; the soundness claim is asserted by the release-candidate tests, or listed as pending** |

## Next — after VBD (from v0.2.80)

The concrete, release-mapped plan is
[`backlog/POST_VBD_PLAN.md`](backlog/POST_VBD_PLAN.md). It runs six lanes,
with at most four running at once:

- **A. Soundness and language completion.**
  - The type-system soundness remainder
    ([`backlog/TYPE_SYSTEM_SOUNDNESS.md`](backlog/TYPE_SYSTEM_SOUNDNESS.md)).
  - The `Comptime` storage rule
    ([`backlog/COMPTIME_METAPROGRAMMING_AUDIT.md`](backlog/COMPTIME_METAPROGRAMMING_AUDIT.md)).
  - The walls VBD dropped, in order: N2c–N2f with P4 and P5, then the
    thread reach walk's holes (A41/A42), then scoped threads (P6), then
    lending iterators through a trait (P7).
  - The borrow checker's standing gates.
- **B. Runtime and platform.** In order:
  1. `Io` becomes an interface value
     ([`backlog/IO_INTERFACE_AND_STD_RUNTIME.md`](backlog/IO_INTERFACE_AND_STD_RUNTIME.md)).
  2. `ThreadPool` owns its workers and shares one queue
     ([`backlog/THREAD_POOL_OWNED_WORKERS_AND_SHARED_QUEUE.md`](backlog/THREAD_POOL_OWNED_WORKERS_AND_SHARED_QUEUE.md)).
  3. The root `global_allocator`.
  4. No libc by default, Zig's default
     ([`backlog/NO_LIBC_BY_DEFAULT.md`](backlog/NO_LIBC_BY_DEFAULT.md)), with
     the `std/heap` catalogue
     ([`backlog/ZIG_STYLE_ALLOCATORS.md`](backlog/ZIG_STYLE_ALLOCATORS.md)).
- **C. Performance.** VBD deferred all performance work, and memory grew 1.7×
  during it. The lane re-baselines first, then:
  - compiler memory and time
    ([`backlog/EVALUATOR_MEMORY_REDUCTION.md`](backlog/EVALUATOR_MEMORY_REDUCTION.md),
    [`backlog/CODEGEN_MEMORY_REDUCTION.md`](backlog/CODEGEN_MEMORY_REDUCTION.md),
    [`backlog/PARALLEL_COMPILATION.md`](backlog/PARALLEL_COMPILATION.md));
  - the generated code's gap to Rust
    ([`backlog/CODEGEN_PERFORMANCE.md`](backlog/CODEGEN_PERFORMANCE.md)).
- **D. Docs and the agent loop.**
  - The docs teach only the finished language, with a type-check gate on
    every block, and the skills are deleted
    ([`backlog/AGENT_KNOWLEDGE_CONSOLIDATION.md`](backlog/AGENT_KNOWLEDGE_CONSOLIDATION.md)).
  - The ownership and borrowing guide
    ([`backlog/OWNERSHIP_AND_BORROWING_DOC_DRAFT.md`](backlog/OWNERSHIP_AND_BORROWING_DOC_DRAFT.md)).
  - The evals corpus that measures agents writing Yo
    ([`backlog/BEND_LAWS_AND_AGENT_LOOP_LESSONS.md`](backlog/BEND_LAWS_AND_AGENT_LOOP_LESSONS.md)
    B4).
- **E. Verification as the flagship.** It starts by verifying std bodies
  instead of assuming them, which unblocks:
  - imported-module guard elision and strict mode
    ([`backlog/SAFE_MODE.md`](backlog/SAFE_MODE.md));
  - the std lemma library
    ([`backlog/THEOREM_PROVING_DIRECTION.md`](backlog/THEOREM_PROVING_DIRECTION.md));
  - the compiler as the verifier's flagship user
    ([`backlog/SELF_VERIFICATION.md`](backlog/SELF_VERIFICATION.md)).
- **F. std and reach.**
  - HTTP keep-alive and `lines()`.
  - Raw string literals.
  - A package registry and `yo publish`
    ([`backlog/PACKAGE_MANAGER_DISTRIBUTION.md`](backlog/PACKAGE_MANAGER_DISTRIBUTION.md)).
  - Seed follow-ups
    ([`backlog/SEED_VERSION_AUTOMATION.md`](backlog/SEED_VERSION_AUTOMATION.md)).
  - An idiomatic example corpus for pretraining.

## Non-goals

- **Competing with Rust on zero-overhead abstractions, or with C on manual
  control.** Unique ownership with counted sharing (`Rc`/`Arc`/`Weak`) is the
  identity. Arenas come as values and as origins
  ([`backlog/ZIG_STYLE_ALLOCATORS.md`](backlog/ZIG_STYLE_ALLOCATORS.md)), for
  phase-structured data.
- **Rust-style region lifetimes in the surface language.**
  - An origin is a declared set of places. There are no abstract `'a`
    regions or outlives bounds in signatures, conflict is set intersection,
    and coercion is subset.
  - Inside a body, the checker is NLL-shaped: flow-inferred origins plus
    liveness ([`backlog/REFERENCES_AND_ORIGINS.md`](backlog/REFERENCES_AND_ORIGINS.md)).
  - The expressiveness target is Rust parity, and the Polonius-only cases are
    a recorded divergence (decision 50).
- **Runtime dependent types.** Runtime properties go through the verifier
  ([`reference/DEPENDENT_TYPES_POSITION.md`](reference/DEPENDENT_TYPES_POSITION.md)).
- **A native or LLVM backend.** Yo compiles to C, and compile-speed work stays
  inside the C backend.
- **A self-hosted prover.** SMT solvers are the backend. Yo owns obligation
  generation and the gradual `VerifyOrAssert` experience.
- **Migrating a started async task between threads.** Async is
  single-threaded per thread. A `Send`-gated work-stealing executor is
  deferred, not rejected
  ([`backlog/IO_INTERFACE_AND_STD_RUNTIME.md`](backlog/IO_INTERFACE_AND_STD_RUNTIME.md)
  §7).
