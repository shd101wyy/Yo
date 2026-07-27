# Yo Roadmap — after bootstrap

_Drafted 2026-07-27 from the bootstrap-campaign retrospective. Ordering
reflects dependency and leverage, not just desirability: tooling speed
multiplies everything after it, and verification is the flagship feature the
language's existing machinery (CTFE + effects + contracts pragmas) is already
shaped for._

## Positioning (what Yo is, in one line)

**Memory-safe without lifetimes, verifies gradually, compiles to readable
C11, designed for the LLM era.** Yo does not out-Rust Rust; it takes Swift's
memory model (RC + cycle GC + `inout` parameter modes, borrows as modes not
types), adds algebraic effects and comptime, and targets the two niches the
incumbents leave open: humane verified systems programming, and a language
whose ergonomics are designed for LLM authorship from day one.

## Phase 0 — finish bootstrap (in flight)

Exit criteria: #69 all-GREEN under the honest hollow-scoring, #70 stays
61/61, STRICT_FIXPOINT holds, and the two-compiler lockstep is retired to a
maintenance cadence. Known remaining fronts (tracked in
`plans/YO_SELF_STAGE2_HANDOFF.md` and `issues/`): cluster-B
`dyn(box(closure))` spec emission, cee validations, contracts Phase-0 port,
the REDs, the `||`-LHS trait-call miscompile, `await_analysis` check triage.

## Phase 1 — Formal verification (the flagship)

Dafny-inspired, but built on assets Dafny lacks:

- **Contracts first**: `requires(...)` / `ensures(...)` clauses (pragmas
  `Verify` / `VerifyOrAssert` / `NoContracts` already exist in the prelude),
  plus loop invariants and `decreases` for termination.
- **`VerifyOrAssert` is the flagship mode** — gradual verification: every
  obligation the prover discharges is erased; every one it can't becomes a
  runtime assert. Teams adopt verification incrementally instead of
  all-or-nothing. This is the pragmatic wedge Dafny never had.
- **Leverage the effect system as the frame rule**: a function whose type
  carries no `Io`/effect row is checked-pure — the hardest part of verifying
  imperative code (framing) falls out of machinery that already exists.
- **Leverage CTFE as the semantic core**: the compile-time evaluator is an
  executable semantics for the pure fragment; use it for
  counterexample-checking and constant obligations before reaching for SMT.
- **Lower to SMT-LIB/Z3 directly** (or Why3 as an intermediary) — do not
  build a prover. Start with the pure fragment + RC-value-semantics heap
  model; `inout` params verify as pre/post value pairs (no separation logic
  needed for the mode-based borrows).
- Design doc: extend `plans/FORMAL_VERIFICATION.md`.

## Phase 2 — Iteration speed (multiplies everything)

1. **Incremental compilation** — module-level caching keyed on content
   hashes. Clean builds are ~7 min for the compiler and the stage2
   self-compile is ~38 min; this is the single biggest tax on both human and
   LLM development loops.
2. **LSP maturity** — the VS Code extension exists but serves stale
   diagnostics; a real language server (check-only pipeline is already fast
   at ~30 s for all of std) with go-to-definition, hover types, and inline
   errors.
3. **Error-message overhaul** — errors are the language's actual UI, and
   (see Phase 4) the LLM repair loop. Every error should carry the corrected
   form the way the `unsafe(...)` gate hint does. Kill the 15-deep
   import-chain error cascades: report the leaf once, with the chain
   collapsed.
4. **Debug info** — `#line` directives mapping emitted C back to `.yo`
   sources; cheap and transforms the debugger story.

## Phase 3 — Compiler architecture debt

- **Interned/immutable type identity.** The mutable-registry design
  ("resolves at eval, misses at codegen", per-call identity, value-copies
  with stale cells) generated the largest bug class of the entire bootstrap
  campaign. Hash-consing exists for TypeValues (`types/intern.yo`); extend
  it to a single authoritative identity for SomeT resolution so a resolved
  type is resolved EVERYWHERE. This is the investment that makes every
  future feature cheaper.
- **String interning as identity** — the perf work (2026-07-27) interned
  token strings; finish the job for fids/type keys so hot compares are id
  compares (String== is ~38% of a stage2 emit by call volume).
- **s2 perf**: stage2 emit 38.4 min today; target < 15 min via the
  remaining levers in `issues/yo-self-compile-performance-rc-string-eq.md`
  (interning, the sound `_attach_early_return_only_drop_to_returns` hoist).

## Phase 4 — LLM-first ergonomics (the differentiator)

Nothing has Yo in pretraining; everything rides on context. Make that a
design constraint, not an accident:

1. **Canonical context pack** — a single versioned file (grammar + idioms +
   the sharp edges) shipped with the toolchain (`yo context`), maintained
   like `.github/skills/` but as a product artifact. Small enough to sit in
   any model's context.
2. **Errors as few-shot repairs** — see Phase 2.3; the error corpus doubles
   as training/eval data.
3. **Syntax stability + sugar pass** — do the breaking cleanups NOW (the
   pointer-operator retirement was the right kind); then freeze. Consider a
   thin sugar layer for the noisiest forms (`(fn(x : i32) -> i32)({...})`)
   only if it can be purely syntactic.
4. **Publish for pretraining** — docs, a large idiomatic-example corpus,
   and permissively-licensed repos, so the next model generation knows Yo.
5. **`yo explain <error-id>` / `yo fix`** — machine-consumable diagnostics.

## Phase 5 — Targets & ecosystem

- **WASM target completion** (wasm32-wasi first; the IOCP/kqueue/epoll
  runtimes are done, WASM was deferred). Verified + sandboxed WASM modules
  is a coherent product story with Phase 1.
- **Package registry** — `yo install` (git deps + lock file) exists; add a
  minimal registry + docs hosting (`yo doc` already renders HTML).
- **Std maturation** — HTTP client/server hardening, TLS, time/date,
  process/signal ergonomics; keep `public-safe-report` at zero findings.
- **Debugging/observability** — after Phase 2.4, a `yo test --debug` story
  and sanitizer presets (ASan path exists).

## Non-goals (explicit)

- Competing with Rust on zero-overhead abstractions or with C on manual
  control — RC + cycle GC is the identity, own it.
- Lifetimes/borrow types. Borrows stay parameter modes (`inout`), enforced
  by the runtime exclusivity backstop and the flowability rules.
- A self-hosted prover. SMT solvers are the backend; Yo owns the obligation
  generation and the gradual `VerifyOrAssert` UX.

## Sequencing summary

```
bootstrap done ──> Phase 1 verification (design + pure fragment)
      │                   │
      ├── Phase 2 tooling (incremental, LSP, errors)   [parallel track]
      │                   │
      ├── Phase 3 identity/perf debt (unblocks 1 & 2 at scale)
      │                   │
      └── Phase 4 LLM pack + publish  ──> Phase 5 targets/ecosystem
```
