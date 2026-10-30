# `--migrate cloned-accessors` renames an accessor whose element has no `Clone`

**Severity:** S3. `yo fix <path> --migrate cloned-accessors` rewrote `xs.get(i)` to `xs.get_cloned(i)` even when the element type had no `Clone`. `get_cloned` is declared `where(T <: Clone)`, so the rewritten file no longer evaluated (E0610, `No method "clone"`). The migration's output had to be reverted by hand.

**Found:** 2026-10-30, while dropping V2c's std-generic-body exemption (`vbd/v2c-drop-std-exemption`). The migration, extended there to counted-handle results, renamed `w.path.get(pi)` in `src/types/utils.yo`, whose element `_TypeWalkFrame` holds a `TypeValue` and derived no `Clone`, and `check ./src` then failed in 204 files at that call. The unique-buffer half had the same gap: a dry run on the base tree offered `q.assumptions.get(ai)` in `src/verifier/encode.yo`, whose `VcAssumption` had no `Clone` either.

**Fixed:** `vbd/v2c-drop-std-exemption`.

## Root cause

`_run_migrate_cloned_accessors` (`src/main.yo`) renamed every recorded site that passed its generic-body, receiver, written-after, raw-pointer and hot-path guards. Nothing asked whether the result type had `Clone`, the bound the `_cloned` sibling declares. `--migrate explicit-copy` already asks that question, once every impl is registered (`type_lacks_clone(&st.ty_value)`).

## Fix

The accessor driver asks the same question after its generic-body guards. A site whose result has no `Clone` is listed with the two repairs: read it in place, or give the element `Clone`. In `src/`, `_TypeWalkFrame` and `VcAssumption` now derive `Clone`, so their two `get_cloned` calls resolve.

The test is `tests/cli-cases/fix-migrate-cloned-accessors-lists-non-clone`. Its `ArrayList(Holder).get` call has an element with no `Clone`, and the golden records the listing and an unchanged file.
