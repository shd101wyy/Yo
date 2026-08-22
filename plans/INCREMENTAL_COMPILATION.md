# Incremental compilation

**Status: ACTIVE (promoted from backlog 2026-08-22).** Phase A (build-runner
artifact cache) LANDED (#213). Phase B — LSP-correct invalidation — is the
current work: the LSP MVP shipped with two documented invalidation gaps
(`src/lsp/diagnostics.yo`), and they are this design's requirements list.
Phase C (cross-process evaluated-export reuse) stays deferred behind the
env-graph snapshot problem. Original deferral rationale below, kept for the
record.

## Phase A — build-runner artifact cache (LANDED, #213)

`compile_artifact` stamps each artifact with
sha256(argv + CURRENT_YO_VERSION + project/std `.yo` closure + yo.lock) in
`<output><libsuffix>.inputs-sha256`; an unchanged stamp with an existing
output skips the child compile entirely. `YO_BUILD_NO_CACHE=1` disables.
Gated by `tests/cli-cases/build-cache`. The second `yo build` of an
unchanged project does no compilation.

## Phase B — LSP-correct invalidation (CURRENT)

Two gaps, two sub-phases. Both are correctness-first: the speed story is
that the module cache can then be TRUSTED across edits instead of the
server needing a restart (today's "fast" path is silently stale).

### B1 — imported-file edits must invalidate the module cache

Today `evaluator/module_loader.yo` caches evaluated modules for the process
lifetime and offers only `clear_module_cache()` (full wipe). An edit to an
imported file is invisible until the server restarts.

Design:

1. `module_loader` grows `remove_module(abs_path)` and an import-graph side
   table: `register_module` (or the `evaluate_import` call path) records
   `importer_abs → imported_abs` edges as they happen. The graph is
   append-only per (importer, evaluation); an importer's edge set is
   REPLACED when that importer is re-evaluated.
2. `invalidate_module(abs_path)` = remove `abs_path` and every transitive
   DEPENDENT (reverse-edge closure) from the cache. Dependencies of the
   removed set stay cached — they are unchanged.
3. LSP wiring: on `didOpen`/`didChange` of ANY document, invalidate that
   file's path before analysis. The next analysis of any open document
   re-evaluates exactly the stale part of its closure on demand.
4. `check`/`build` are unaffected (single-shot processes), but the same API
   is what a future watch mode uses.

Risk note: removing a module whose exports other CACHED modules hold
references to does not corrupt them — cached envs keep their own refs; the
removal only forces the next `import` to re-evaluate. Divergence between a
stale importer (cached) and a fresh import is exactly what step 2's
dependent-closure removal prevents.

### B2 — re-analysis must not leak registry entries

Today every re-analysis of an edited document re-evaluates its definitions
under FRESH type ids and re-registers impls into the module-level
registries (`type_trait_methods`, the generic-impl registry, GADT registry,
trait defaults, enum cfids). The stale generation's entries stay forever —
memory grows with edit count, and stale generic-impl entries make every
`try_match_generic_impl` scan longer (a per-keystroke cost).

Design — ownership tagging, purge-on-re-analysis:

1. Each registry entry gains an `owner : String` — the absolute module path
   being evaluated at registration time (the module_loader `loading` stack
   already knows it; expose `current_loading_module()` and default to `""`
   for non-module contexts, which are never purged).
2. Each registry grows `purge_owned_by(owner_abs)`, dropping that owner's
   entries from its tables.
3. The LSP calls `purge_owned_by(doc_abs)` (and B1's
   `invalidate_module(doc_abs)`) before each re-analysis; a B1 invalidation
   of a module also purges that module's registrations before its
   re-evaluation.
4. Compile/check paths never purge — zero behavior change outside the LSP.

Gate for both: extend the LSP cli-case battery — (a) a two-file fixture
where editing the IMPORTED file (didChange) changes the diagnostic in the
IMPORTING document's next analysis; (b) a repeated-didChange case whose
registry sizes are asserted stable via a debug counter (or, minimally, a
dot-completion answer that stays correct and duplicate-free after N edits).

### Measurement baseline

Measured 2026-08-22 on the Mac Mini M4 (both binaries -O2, interleaved
A/B, 3 rounds each):

- **A 12-message LSP session (initialize + didOpen + 10 didChange) on a
  small ArrayList-importing document: ~0.34-0.35 s wall for the WHOLE
  session** (~30 ms per analysis including the first one's prelude cost),
  identical pre- and post-Phase-B — the invalidation + purge add no
  measurable per-edit cost. All 11 publishDiagnostics verified present
  (hollow-measurement check).
- Registry growth per edit before B2 (the leak the red-first probe
  demonstrated): each round grew both registries by the document's impl
  surface; after B2 the counts are flat across rounds
  (tests/internal/module_invalidation.test.yo).
- Still to collect when it matters: `yo check ./src` wall time (whole-tree
  check is the build-side number, not an LSP-latency one), and re-analysis
  latency on a compiler-SIZED module (a src/ file with a deep import
  closure) — the small-doc number above says nothing about evaluator-heavy
  documents.

## Phase C — cross-process evaluated-export reuse (DEFERRED)

Serializing evaluated exports remains blocked on the shared env graph
(7.4 M live `Variable`s at peak, `plans/backlog/YO_SELF_ENV_SHARING.md`)
and on codegen's process-lifetime shared `ExprInfoTable`
(`src/module_manager.yo`). Do not attempt until B has burned in and the
env-sharing work gives the graph a snapshot boundary.

---

## Original deferral record (2026-08-20)

Asked during the P3 campaign:
should the compiler cache per-module work to speed up `yo build` / `yo check`?
Decision: not now — design it once, driven by the LSP's requirements, as the
opening work of P4.

## Why deferred

1. **P4 needs it regardless.** An LSP that re-evaluates the full import
   closure per keystroke is unusable, so incremental evaluation must be
   designed for P4 anyway. Doing a build-oriented cache first means designing
   invalidation twice.
2. **It is a deep cut, not a lever.** A compilation cache needs module-level
   dependency hashing, serializable evaluated exports, and invalidation. The
   evaluated-export state is exactly the structure the memory campaign
   measured: a heavily shared env graph (7.4 M live `Variable`s at peak,
   `plans/backlog/YO_SELF_ENV_SHARING.md`) — snapshotting it is a project, not
   a patch. Codegen additionally assumes a process-lifetime shared
   `ExprInfoTable` (`src/module_manager.yo`).
3. **Risk timing.** The bootstrap fixpoint gates BYTE-IDENTITY of the emit; a
   cache introduces staleness/nondeterminism bug classes into exactly that
   story while the release machinery (musl-only migration, per-target yo.c
   split, Windows legs) is mid-flight.
4. **The pain is partially mitigated.** `_inject_forall_captures` memoization
   already cut the self-emit 227→148.5 s wall / 19.07→14.94 GB live (#145),
   and `yo check <file>` remains the fast iteration loop.

## The cheap win available WITHOUT touching the evaluator

Build-runner-level artifact caching: `src/build_runner.yo` already schedules a
build DAG; skipping recompilation of an artifact whose input closure hash is
unchanged needs no evaluator state to be serialized at all — hash source files
(+ compiler version + flags), keep the emitted C/object keyed by hash. Worth
scoping as its own small plan if build times become the bottleneck before P4.

## When this reopens

At P4 kickoff (`plans/P4_LSP.md`): the LSP's incremental evaluation design
should subsume the build-cache question — a module whose evaluated exports can
be reused across LSP edits can be reused across builds.

**REOPENED 2026-08-22** — P4 kicked off; the LSP MVP (slices 1-2) documents
its two invalidation gaps in `src/lsp/diagnostics.yo` (imported-file edits
invisible until server restart; per-edit re-registration leaks registry
entries under fresh type ids). Those two gaps are this design's concrete
requirements list. First measured perf win of the campaign landed
separately: `issues/desugar-token-clones-evaluator-regression.md`.
