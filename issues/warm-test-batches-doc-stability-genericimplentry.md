# Warm test batches: doc_stability's compile dies unifying GenericImplEntry with DocParam

**Status:** OPEN. Found 2026-09-18 — the first cross-file warm-state breaker
for §7 step 3 (`yo test` batches compiling in-process under one evaluator,
plans/INCREMENTAL_COMPILATION_ZIG_LESSONS.md). The in-process path is gated
behind `YO_TEST_IN_PROCESS=1` (default = the proven child-process spawn)
until this lands.

## Symptom

With `YO_TEST_IN_PROCESS=1`, a `yo test ./tests/internal` run reaches
`tests/internal/doc_stability.test.yo` (file ~20 of 92, after ~10
exec-restarts of the RSS valve) and its batch compile dies:

```
error: Cannot unify incompatible struct types: "GenericImplEntry" and "DocParam"
    --> src/evaluator/values/impl.yo:1376:51
1376 |       entry_list_opt = g_impl_registry_entry_lists.get(ki);

note: while importing this module (import chain collapsed — the error above is from the imported file)
    --> src/doc/builder.yo:47:65
  47 | { GenericImplDocEntry, get_generic_impl_doc_entries } :: import("../evaluator/values/impl.yo);

note: while importing this module (import chain collapsed — the error above is from the imported file)
    --> tests/internal/.yo_selftest_batch_3_0.yo:6:50
   6 | _(module_stability : module_stability) :: import("../../src/doc/builder.yo");
```

`doc_stability.test.yo` ALONE (fresh image) compiles and runs its 9 tests
fine — the failure requires earlier files' evaluator state in the same
process. It is the test-runner twin of the build-side FTT cascade fixed in
#756: eval/collect against the ACCUMULATED universe (shared spec/function
registries, shared ExprInfoTable) instead of this batch's own reachability.

## Reading of the site

`g_impl_registry_entry_lists : HashMap(String, ArrayList(GenericImplEntry))`
— the `.get(ki)` call's instantiation is being unified against a
`DocParam`-typed context. `doc/builder.yo` (imported fresh by the batch)
imports `impl.yo` (a cache HIT — evaluated by an earlier batch in this
image) and calls `get_generic_impl_doc_entries`, which builds
`GenericImplDocEntry`/`DocParam` lists from the registry. Suspect: the
HashMap's value-type instantiation (or the ArrayList element identity)
recorded in the shared state under the FIRST importer's GenericImplEntry
generation vs the fresh reader's — same shape as the struct-shell unify of
issues/warm-compile-selfcheck.md item 1, but with the modules all cached
(the split is between a registry's recorded instantiation and a fresh
import's, not between two module evaluations).

## Repro

```
YO_TEST_IN_PROCESS=1 yo test ./tests/internal --parallel 1
# ~25 min in, at doc_stability.test.yo
```
Passes standalone: `yo test ./tests/internal/doc_stability.test.yo`.

## What un-gating needs

The §7 item-1 residue: per-batch reachability for eval/collect — owner-tagged
registry purges or per-compile emission scoping — so a warm batch never
unifies against entries minted for a different batch's import graph.

## NARROWED 2026-09-18 (evening): minimal pair + the decoded unify

Minimal repro: **{doc_render_markdown, doc_stability}** alone in a directory
inside the repo (so `../../src` imports resolve — e.g. a scratch
`tests/internal-bisect/`), run with YO_TEST_IN_PROCESS=1. Two light files,
~1 min. Neither file alone fails; doc_builder/extractor/reexport_docs +
check_watch + module_invalidation are all NOT poisoners.

New probes (both YO_DEBUG_WARM-gated, kept in the tree):
- `[unify-struct]` at the struct-unify throw (types/synthesizer.yo) —
  prints both sides' struct ids, ctor fids and FULL type_keys.
- `[fmg-get]` at find_methods_from_generic_impls' candidate push for
  method_name == "get" — receiver/pattern/spec keys.

The fatal unify decoded (bisect logs):
- expected = `GenericImplEntry` (`struct_decl_values__impl_r202c20`,
  instantiated), given = `DocParam` (`struct_decl_doc__model_r66c12`) —
  and **BOTH ctor fids EMPTY** (the structural fallback that would save
  this pair is scoped to in_def_time_trial(), which is false here).
- The last `.get` dispatch before the throw IS on the impl registry's own
  receiver: `HashMap(String, ArrayList(GenericImplEntry))` — the
  type_key RENDER of that receiver is CORRECT (the arg resolves to
  GenericImplEntry), yet the match binds the pattern's V slot to
  DocParam, so the spec's `-> ?(V)` lands as `Option(ArrayList(DocParam))`
  and the annotated assignment at impl.yo:1376 throws.

**Working hypothesis (next dig):** the receiver's ArrayList T-arg is a
SomeT with a RESOLUTION-CELL CHAIN; type_key resolves the chain through
`_tk_resolve_arg_slot` (→ GenericImplEntry) while `try_match_generic_impl`'s
slot unify follows a different resolution (→ DocParam, minted during
doc/model's own HashMap usage in doc_render_markdown's pass). Shared
mutable cell state diverging by reader — the same disease class as the
closure-F slot repairs in type_key.yo's `_tk_resolve_arg_slot` comment.
Start: impl.yo's try_match_generic_impl slot walk (~lines 910–1350) vs
type_key.yo's `_tk_resolve_arg_slot`.

## ROOT CAUSE FOUND 2026-09-19: shared signature-SomeT slots + the global resolution table

One level deeper than the SomeT-cell hypothesis, and it is the disease
`expr_info.yo`'s `unregister_some_resolved_concrete` comment already names:
"yo-self reuses the ONE signature instance, so one call's `B := i32` can
never be seen by the next" — except here it CAN, because the value was
STORED. The chain, measured with the [fmg-get]/[rfb-bound]/[unify-struct]
probes on the minimal pair:

1. The warm registry's stored `GenericImplEntry` instances carry
   UNRESOLVED type-arg slots (the receiver render shows
   `forall_types:R#struct_r37c4_n4` etc. — SomeT-slot placeholders, not
   the concrete types a cold process stores).
2. Those slots' SomeT ids belong to SHARED signature instances; the global
   `g_some_resolved_concrete` table is LAST-WRITE-WINS keyed by id.
3. doc/model's earlier pass (doc_render_markdown's batch) registered ITS
   resolutions over those same ids (`T := ArrayList(DocParam)`,
   `T := DocVariant`, …).
4. doc_stability's warm dispatch of `.get` on the registry's
   `ArrayList(GenericImplEntry)` synthesizes pattern-vs-receiver over
   those poisoned slots → binds `T := DocVariant` (measured:
   `[fmg-get] … spec_key=fn(self : ArrayList(DocVariant), index : usize)
   -> Option(T)` for a receiver that renders as
   `ArrayList(GenericImplEntry)`) → the spec result unifies against the
   `GenericImplEntry` annotation → the fatal throw.

Two hardening layers already landed with this diagnosis (both
behavior-preserving cold, verified): the env-lookup fast path's concrete
branch now requires the def frame to hold the LIVE (last) binding of the
name (types/env_lookup.yo), and `try_match_generic_impl`'s binding
extraction is frame-scoped to the match's own synthesis frames
(`_resolve_one_forall_binding_from`) — TS's impl.ts:2243 scratch-frame
scoping. They close the INHERITED-env channels but cannot fix slots the
SYNTHESIS ITSELF reads through the poisoned table.

**The remaining fix** is slot identity for stored values: either
(a) the registry stores only FULLY-RESOLVED instances (deep-resolve at
registration — but the warm pass is what leaves them unresolved, so this
is really "resolve before store, after any call"), or (b) per-call SomeT
minting for signature binders (TS parity — the big one), or (c)
generation-keying `g_some_resolved_concrete` so a stale registration can't
satisfy a later read. (c) is the smallest sound step: stamp registrations
with the match/eval generation and ignore reads from a later generation
unless re-registered.
