# Incremental compilation — deferred to the P4 (LSP) era

**Status: BACKLOG (decision 2026-08-20).** Asked during the P3 campaign:
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
