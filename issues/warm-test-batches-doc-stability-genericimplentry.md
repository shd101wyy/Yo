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
