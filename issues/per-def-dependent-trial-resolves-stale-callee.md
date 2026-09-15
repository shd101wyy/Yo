# A re-forced dependent's body trial resolves module-member calls against the STALE callee

OPEN (2026-09-14). Surfaced by Phase 3b's per-definition invalidation
(plans/INCREMENTAL_COMPILATION_ZIG_LESSONS.md §6 step 4): the dependent's
re-validation is not a faithful re-check, which is why the per-def path ships
gated to signature-stable fn edits.

## Reproducer

lib.yo:

```rust
helper :: (fn() -> i32)(i32(1));
answer :: (fn() -> i32)((helper() + i32(41)));
export(answer, helper);
```

app.yo:

```rust
lib_mod :: import("./lib.yo");
main :: (fn() -> unit)({
  _x := lib_mod.answer();
});
export(main);
```

Edit lib.yo's `answer` to `(fn(n : i32) -> i32)((helper() + n))` and run one
`check --watch-once` round. Cold `yo check` of the same tree fails with
`error[E0603]: Argument count mismatch: expected 1, got 0` at app.yo's call.

## What the trace proved (all under YO_DEBUG_* probes, 2026-09-14)

The per-def round does everything it is supposed to, and the dependent's
trial still succeeds against the old signature:

- `answer` re-forced with the re-parsed statement (fresh expr ids from the
  differ's parse); its own errors surface correctly through the per-def
  failure channel (verified with a `-> str` body break).
- The cached module value's `answer` slot IS patched in place
  (`update_module_cache_slot` hit, verified by print).
- `main` (the def-edge dependent) re-forced with a `clone_expr_fresh_ids`
  copy of its statement — fresh ids, so stale ExprInfo-by-id cannot explain
  it — `[trial] app… main` runs, `[flow-post] out=1 pending=false`:
  the body trial COMPLETES, no swallow, no arity error, and the
  module-member-read hook (`record_module_member_read` → `[p3edge]`) does
  NOT fire during the re-forced trial (it fired during the initial pass's
  trial of the same body).

So the trial's evaluation of `lib_mod.answer()` resolves a 0-parameter
callee from somewhere other than the patched slot — value AND arity both
stale — despite the variable's StructVal sharing the patched
`field_values` ArrayList and the property/call nodes having fresh ids.

## Consequences (why the mitigation is a gate)

A dependent's re-forced trial cannot be trusted to re-derive:

- ARITY/type errors against a changed signature (the exact class of
  issues/fixed/wrong-arity-call-silently-accepted-version-install-broken.md
  when swallowed);
- comptime-folded VALUES of a changed comptime callee.

Phase 3b therefore gates its per-def path on `_def_is_per_def_able`
(src/module_manager.yo): only a SIGNATURE-STABLE fn-literal edit is
per-def-able; signature changes, constants, and type-producing defs take the
file-level reload where diagnostics are the cold path's by construction.

## Second finding — FIXED 2026-09-15: ordered-read TARGET attribution was wrong in directory checks

**Fixed** by `stable_sns_module_id` (src/utils.yo): the sns struct id now
embeds the module-path hash, so ids are unique per module instead of every
module's first mint colliding on `source_namespace_0` (the occurrence
counter was per module). Red-first test:
`tests/internal/check_watch.test.yo` "a DIRECTORY check attributes
destructured reads to the right module" (an importer whose destructure
follows another module's mint). Measured after the fix: the hub body-edit
round's reader lookup finds `src/lexer.yo` (`[p3read] readers=1`) and the
round drops + re-checks lexer's 143-file closure — ~355 s on the WSL2 box,
a full re-check. That is the SOUND posture (the destructured copy cannot be
patched in place); the perf unlock for hub edits is fixing the FIRST
finding below — once a dependent's trial re-derives calls against the
patched slot, signature-stable fn edits no longer need to drop their
readers.

Original finding, kept for the record:

Instrumenting `record_module_ordered_read` (`[p3ord]`, YO_DEBUG_P3DIFF) over
`check ./src --watch` shows the reader table's TARGET attribution is broken in
the directory-check topology:

```
[p3ord] file:///…/src/lexer.yo reads is_identifier_continue of file:///…/src/expr_info.yo
[p3ord] file:///…/src/lexer.yo reads rune of file:///…/src/expr_info.yo   ← std/string!
```

lexer.yo destructures `is_identifier_continue` from `./token.yo` (and `rune`
from `std/string`), yet EVERY field it reads is attributed to expr_info.yo —
the last-registered module — while a SINGLE-entry check attributes correctly
(the per-def tests' destructured-import fallback fires exactly as designed).
Suspect: `sns_module_of` / `register_sns_module` — in a directory check every
file is walked twice (entry walk under the typed key, demand walk under the
`file://` key), and the source-namespace id → module map evidently ends up
pointing many modules' sns ids at one module. Consequences:

- Phase 3b's ordered-reader fallback (`ordered_readers_of`) silently finds
  nothing for directory checks, so destructured importers of a revalidated
  def are NOT dropped — the hub-edit round (`src/token.yo` body edit)
  revalidates 1 def and drops 0 modules in ~50-90 ms instead of falling back
  over the ~200-file closure. Under the signature-stable gate this is sound
  for the common case (a dependent's check verdict is insensitive to a
  fn BODY), but the destructured-comptime-fold hole above stays open there.
- The 3a def-level edges that flow through `record_module_member_read` use
  the same `sns_module_of` attribution, so cross-module member-read edges may
  be mis-keyed in directory checks too (over/under-invalidation, never a
  stale verdict in the single-entry topology the tests cover).

Fix direction: make the sns id → module registration survive double walks
(mint per WALK, or key the map by the value's identity, not a mutable
global), then re-measure the hub round — the fallback should fire and the
round should still be fast (the drop set is the destructured readers of the
one changed name, not the whole closure).

## Suspects not yet eliminated

- A FuncVal identity/side-table (e.g. keyed by `func_id` or the callee's
  rendering) consulted before the arity check in `evaluate_function_call`
  (src/evaluator/calls/function.yo:4584).
- The property-access module-member path synthesizing from the TYPE tables
  (`mod_labels_rt`/`mod_types_rt`, src/evaluator/exprs/property_access.yo)
  rather than the slot value under def-time-trial conditions.
- An `ExprInfo` value on a node the clone does NOT replace (the import node's
  `out_info.value`, or the `lib_mod` variable's cell being replaced — not
  shared — at some point between the import and the trial).

Next step for whoever picks this up: print the resolved callee's `func_id`
at the top of the module-member call check and diff it against the grafted
def's fresh id.
