# `yo doc` drops re-exported docs, trait implementors and inherited method docs

**Severity:** S2 — `yo doc` output silently loses three kinds of documentation: a re-exported type's docs filled in from its declaring module, a trait's sorted implementor list, and method docs inherited from a trait.

**Found:** 2026-10-29, develop battery 40796298553 on `01e94c77c`: `tests/internal/doc_reexport_docs.test.yo` failed 2 of 3 cases (internal shard 3). The cases were "a re-exported type takes the declaring module's documentation" and "a module that documents its own re-export keeps what it wrote".

**Fixed:** `fix/develop-cli-goldens-v0273`.

## Root cause

B6-c's `src/` half (#1651) renamed copying accessor reads to `get_cloned`. In `src/doc/builder.yo` it renamed four reads in the three cross-reference passes:
- `modules.get(mj)` in `build_cross_references`, `_fill_re_exported_docs` and `_inherit_trait_method_docs`;
- `m2.types.get(tj)` in `_inherit_trait_method_docs`.

Each pass then writes through the binding it read, for example `m.traits(tj) = DocTrait(...)`, `m2.types(tj) = DocType(...)` and `ty.methods(fj) = DocFunction(...)`.

Before B8, `ArrayList` is a shared handle, so `.get`'s struct copy shares the model's `ArrayList`s and the indexed writes reach the model. `get_cloned` deep-copies those lists, so every write landed in a temporary and was dropped.

B6-c's gates could not see this:
- Its corpus emit-diff was byte-identical by construction for these cold files.
- Its internal selection (doc_builder, context_index, …) did not include `doc_reexport_docs`.
- No test covered the implementor or inherited-method passes.

A scan of `src/` for a `get_cloned` binding written through afterwards finds only these four sites.

## Fix

The four reads go back to `.get`. Each carries a comment saying why it must share: until B8, the passes write through the copy's shared `ArrayList` handles. B8 has to rewrite these passes to index-assign through `&mut` anyway.

## Test

`tests/internal/doc_reexport_docs.test.yo` is the regression test. It fails 2 of 3 cases on develop `01e94c77c` (battery 40796298553) and passes after the fix.
