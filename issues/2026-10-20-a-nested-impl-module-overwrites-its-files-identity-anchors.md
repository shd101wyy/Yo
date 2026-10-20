# A nested `impl({...})` module overwrites its file's identity anchors

**Severity:** S3 — ids minted after an inner anonymous module in a file are anchored on the INNER module's statements, so one declaration is minted under two anchor spellings in one process and the "an edit above it leaves the id byte-identical" promise of `_anchored_position` does not hold below the first `impl({...})` module of a file; no wrong code observed.

**Status:** open. Found 2026-10-20 while fixing
`issues/fixed/2026-10-17-two-recursive-enums-of-one-shape-share-their-arraylist-self-instantiation.md`
(an anchored declaration key split the prelude's `Option` in two).

## Evidence

One node — the `enum(` of `Option :: (fn(comptime(T) : Type) -> comptime(Type))(enum(...))`
at `std/prelude.yo:8269`, column 2 — was minted by `stable_type_id` under two
anchors in one `yo check`:

- `enum_std__prelude_cast_s2_r8019c2_n0` — anchor `cast_s2`, row offset 8019:
  the anchor list of `unsafe :: impl({ drop :: ...; cast :: __yo_as; ... })`
  (`cast` at row 249).
- `enum_std__prelude_has_other_aliases_s2_r16c2_n63` — anchor
  `has_other_aliases_s2`, row offset 16: the anchor list of
  `Var :: impl({ ... has_other_aliases ... })` (its last statement at row 8253).

Neither is the prelude's own top-level anchor (`Option`, which would give
`Option_r1c2`).

## Root cause

`register_module_anchors` (`src/evaluator/context.yo`) runs at the start of
EVERY `evaluate_anonymous_module_begin_exprs` walk
(`src/evaluator/values/anonymous_module.yo`, "Identity anchors (Phase 3.3)"),
including the walk of a nested `impl({...})` module, which carries the
enclosing FILE's `module_path`. `register_top_level_anchors` (`src/utils.yo`)
then REPLACES the file's anchor list with the inner module's statements and
nothing restores it, so every id minted after the inner walk — in the rest of
the file, or later through CTFE — is anchored on the inner module's last
statement, with a row offset that grows with everything between.

## Fix direction

Register anchors only for a file's top-level walk, or save and restore the
previous list around a nested walk the way `set_module_walk` already saves
`_prev_mod_exprs`. Either changes the spelling of every id minted below the
first nested module of a file (C names change once; the emitted-C goldens and
the fixpoint absorb it). A regression test: mint an id below a nested
`impl({...})` module, insert a line above the declaration, and compare the
ids (`tests/internal/stable_ids.test.yo` has the harness).
