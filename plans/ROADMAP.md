# Yo Roadmap — after bootstrap

_Drafted 2026-07-27 from the bootstrap-campaign retrospective. Ordering
reflects dependency and leverage, not just desirability: tooling speed
multiplies everything after it, and verification is the flagship feature the
language's existing machinery (CTFE + effects + contracts pragmas) is already
shaped for. Statuses last trued 2026-09-03 (Phase 0.5 complete; Phase 2.1/2.2
landed; 2.3/4.5 in design; Phase 5 std maturation largely landed)._

## Positioning (what Yo is, in one line)

**Memory-safe without lifetimes, verifies gradually, compiles to readable
C11, designed for the LLM era.** Yo does not out-Rust Rust; it takes Swift's
memory model (RC + cycle GC + `inout` parameter modes, borrows as modes not
types), adds algebraic effects and comptime, and targets the two niches the
incumbents leave open: humane verified systems programming, and a language
whose ergonomics are designed for LLM authorship from day one.

## Phase 0 — finish bootstrap — **COMPLETE**

All exit criteria met: the corpus is green under honest hollow-scoring, the
fixpoint holds (stage-2 ≡ stage-3, byte-identical, CI-gated), and every listed
front — cluster-B `dyn(box(closure))` spec emission, cee validations, the
contracts port, the REDs, the `||`-LHS trait-call miscompile,
`await_analysis` triage — closed. Record: [`BOOTSTRAPPING.md`](BOOTSTRAPPING.md).

The two-compiler lockstep **was retired** by Phase 0.5 below — the TypeScript
compiler is deleted and the self-hosted compiler lives as `src/`.

## Phase 0.5 — self-hosting completion — **COMPLETE 2026-08-22**

Retire `src/` and the bun/node toolchain, ship installers, rewrite the LSP in
Yo. This was not a phase in the original draft: at the time, "bootstrap done"
was assumed to mean the TypeScript compiler could simply be dropped. It cannot
— CI, the release chain, the version cache, the LSP and the VS Code extension
all reach into `src/`, and the trust chain has to move to
"previous release builds current compiler" first.

Outcome, per phase: P1 CLI parity complete 2026-08-10; P2/P2.5 retired the
TypeScript compiler (frozen at the `src-attic-final` tag) and moved
`yo-self/` into the freed `src/` name (2026-08-20); P3's installers and
releases channel are proven by shipped releases (`scripts/install.sh`, the
GitHub-Releases version cache — the seed is now v0.2.23); P4's Yo-native LSP
is feature-complete 2026-08-22 (`yo lsp` plus the extension's bundled
client). Remaining P4 quality items (typed diagnostics channel, doc-comment
plumbing) are listed in the P4_LSP.md header — the typed-diagnostics one is
P3 of [`ERROR_DIAGNOSTICS_OVERHAUL.md`](ERROR_DIAGNOSTICS_OVERHAUL.md).

Working docs: [`SELF_HOSTING_COMPLETION.md`](SELF_HOSTING_COMPLETION.md)
(umbrella) → `P1_CLI_PARITY.md` (COMPLETE) → `P2_RETIRE_SRC.md` +
`P2_5_RETIRE_EXECUTION.md` (LANDED) → `P3_DISTRIBUTION.md` (shipped) →
`P4_LSP.md` (feature-complete).

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
- Design doc: extend `plans/backlog/FORMAL_VERIFICATION.md`.

## Phase 2 — Iteration speed (multiplies everything)

1. **Incremental compilation** — module-level caching keyed on content
   hashes. Clean builds are ~7 min for the compiler and the stage2
   self-compile is ~38 min; this is the single biggest tax on both human and
   LLM development loops. — **LANDED** (Phases A–C, revised scope:
   build-runner artifact cache, LSP-correct invalidation at ~65 ms per edit,
   in-process `--watch`; the original cross-process evaluated-export cache
   was descoped — see [`INCREMENTAL_COMPILATION.md`](INCREMENTAL_COMPILATION.md)).
2. **LSP maturity** — a real language server with go-to-definition, hover
   types, and inline errors. — **LANDED** (P4, feature-complete 2026-08-22:
   `yo lsp` serves diagnostics, hover, definition, symbols, references,
   folding, rename, formatting, signature help and completion, and the VS
   Code extension bundles the client — [`P4_LSP.md`](P4_LSP.md)).
3. **Error-message overhaul** — errors are the language's actual UI, and
   (see Phase 4) the LLM repair loop. Every error should carry the corrected
   form the way the `unsafe(...)` gate hint does. Kill the 15-deep
   import-chain error cascades: report the leaf once, with the chain
   collapsed. — detailed design **PROPOSED 2026-09-03**:
   [`ERROR_DIAGNOSTICS_OVERHAUL.md`](ERROR_DIAGNOSTICS_OVERHAUL.md)
   (structured diagnostics, `E`-codes with an offline `yo explain` registry,
   `--error-format human|short|json`; awaiting review).
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
   as training/eval data. Design proposed in
   [`ERROR_DIAGNOSTICS_OVERHAUL.md`](ERROR_DIAGNOSTICS_OVERHAUL.md) — the
   `yo explain` registry's verified examples are the corpus export.
3. **Syntax stability + sugar pass** — do the breaking cleanups NOW (the
   pointer-operator retirement was the right kind); then freeze. Consider a
   thin sugar layer for the noisiest forms (`(fn(x : i32) -> i32)({...})`)
   only if it can be purely syntactic.
4. **Publish for pretraining** — docs, a large idiomatic-example corpus,
   and permissively-licensed repos, so the next model generation knows Yo.
5. **`yo explain <error-id>` / `yo fix`** — machine-consumable diagnostics.
   `yo explain` is designed in
   [`ERROR_DIAGNOSTICS_OVERHAUL.md`](ERROR_DIAGNOSTICS_OVERHAUL.md);
   `yo fix` remains open.

## Phase 5 — Targets & ecosystem

- **WASM target completion** (wasm32-wasi first; the IOCP/kqueue/epoll
  runtimes are done, WASM was deferred). Verified + sandboxed WASM modules
  is a coherent product story with Phase 1.
- **Package registry** — `yo install` (git deps + lock file) exists; add a
  minimal registry + docs hosting (`yo doc` already renders HTML).
- **Std maturation** — HTTP client/server hardening, TLS, time/date,
   process/signal ergonomics — **largely landed** by the std API audit
   campaign (2026-08-23 → ongoing: the §2 correctness sweep, the conventions
   + breaking sweep, TLS, HTTP client/server, time/date, process —
   [`STD_API_AUDIT.md`](STD_API_AUDIT.md)). Remaining: the §7 S4/P1 addition
   tail and the §9 S5 stability freeze (additive-only std); keep
   `public-safe-report` at zero findings.
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
bootstrap done ──> Phase 0.5 self-hosting completion ──> Phase 1 verification
   (COMPLETE)         (COMPLETE 2026-08-22)                (design + pure fragment)
                                                                    │
                                                                    │
      ├── Phase 2 tooling (incremental + LSP landed;       [parallel track]
      │    errors in design — ERROR_DIAGNOSTICS_OVERHAUL)         │
      ├── Phase 3 identity/perf debt (unblocks 1 & 2 at scale)
      │                   │
      └── Phase 4 LLM pack + publish  ──> Phase 5 targets/ecosystem
```

Note Phase 0.5's LSP work (`P4_LSP.md`) and Phase 2's tooling track overlapped:
the Yo-native language server was the same deliverable seen from two roadmaps.
Both halves have since landed — P4 shipped the correct server (2026-08-22),
and Phase 2.1's Phase B landed the incremental re-check (~65 ms per edit).
