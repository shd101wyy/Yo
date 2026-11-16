# The deref migration rewrites the raw-pointer `Clone` impl's result type to the pointee

**Severity:** S2 (wrong accepted text that breaks `derive(..., Copy, Clone)` instantiation and the `--migrate deref` prelude load; a loud failure at derive/fix time, never a wrong binary)

## What happened

Running `yo fix std src scripts build.yo --migrate deref` (the v0.2.78 deref text sweep, VERDICTS-60)
rewrote `std/prelude.yo`'s `*T` `Clone` impl:

```yo
// develop
impl(generic(T : Type), *T, Clone(clone : (self -> self)));
// swept (wrong)
impl(generic(T : Type), *T, Clone(clone : (self -> self.*)));
```

`self` of this impl is the RAW POINTER itself (by value), not a reference binding, so the result-type
spelling `self` must stay: a raw pointer "clones as itself: the address is copied, never the pointee"
(the impl's own doc comment). The migration applied the `&Self` rule — where the Gen B result type is
`self.*`, the referent — to a raw pointer. `yo check ./std` accepts the swept line (the signature still
type-checks), so the error surfaced only when a derive instantiates `Clone` for a pointer type.

The 24 sibling rewrites in the same file — `impl(i8, Clone(clone : (self -> self.*)))` and the other
primitive `&Self` clone/hash impls — are the correct Gen B spelling (`self : &Self` per the trait
signature, result `self.*` = `Self`) and are NOT affected.

## Verbatim error

With the swept line in `std/prelude.yo`, every directory-form migration fails to load the prelude
(the five `tests/cli-cases/fix-migrate-deref-*` goldens went red; single-file `check`/`fix` defer the
prelude's own derive and pass):

```text
$ yo fix . --migrate deref --std-path ./std
error[E0604]: derive on "Allocator" failed: Function body has type `void`, but the declared result type is `*(void)`.
     --> std/prelude.yo:6985:56
     |
6985 | impl(generic(T : Type), *T, Clone(clone : (self -> self.*)));
     |                                                        ^
help: run `yo explain E0604` for more information
     --> std/prelude.yo:9564:25
     |
9564 | derive(Allocator, Copy, Clone);
     |                         ^
yo: error: fix: could not load the prelude from ./std
```

## Reproducer

1. Take develop's `std/prelude.yo`, change only line 6985's result type `self` to `self.*`.
2. `yo fix <dir> --migrate deref --std-path ./std` on any directory → the E0604 above, rc 1.
3. Put the line back → rc 0 and the five `tests/cli-cases/fix-migrate-deref-*` cases pass.

Found by the full `scripts/cli-diff-test.sh` run of the text-sweep stage 1 (`bin/yo-dt1`): the five
`fix-migrate-deref-*` cases failed while the same cases pass on the v0.2.78 brace tree (same develop
base, no deref sweep), so the swept line is the cause, not the base.

## Root cause

`--migrate deref` rewrites a trait-impl member signature's result-type `self` to `self.*` without
checking whether the impl's self parameter is a reference (`&Self`, where `self.*` = `Self`) or a
by-value raw pointer (`*T`, where `self` already names `*T` and `self.*` is the pointee type `T`).

## Root cause (corrected 2026-11-15)

The swept text is RIGHT; the recorder misread it. The short-form lambda `self -> self` takes its
parameter type from `Clone`'s signature, `fn(self : &Self) -> Self`, so at `Self = *T` the binding is
a `&*T` reference and its body `self.*` is the pointer, `Self`. Normal mode reads it that way (a tree
binary's `check ./std` and the v0.2.77 seed's both accept the swept line), and a binary with the
exemption deleted rejects the held-back `self -> self` with E0926
(`issues/fixed/2026-11-15-the-deletion-binary-rejects-the-swept-lend-of-an-rc-handle-binding-in-src.md`),
so `self.*` is the spelling the deref flip needs.

What broke is `yo fix --migrate deref` loading that prelude. While recording, a written `.*` on a
reference binding whose referent `.*` reads through (a pointer, a `Box`, a cell handle) is taken as
OLD source (edit 3, `r.*.*`) and evaluated the old way (the pointee) unless the file was already
seen to be migrated (`deref_file_migrated`, the second-run evidence rule). That rule depends on
evaluation order. `derive(Allocator, Copy, Clone)` instantiates the `*T` `Clone` at `T = void`
before any evidence site in the prelude is evaluated, the old reading gives the body type `void`
for the declared `*(void)`, and the derive fails.

## Fix

`deref_text_is_new_spelling` (`src/evaluator/utils.yo`): the recorder reads a written `.*` as the new
spelling in a file the evidence rule saw OR in one of the repository's own swept trees, std, src,
scripts and `build.yo` (`is_deref_swept_tree`, `src/evaluator/memory_safety.yo`, which
`is_deref_rule_exempt` now builds on and which outlives the exemption the deref flip deletes). Those
trees hold no old source: N3 deref Generation A' has read their written `.*` as the reference's own
deref since v0.2.77, so the recorder now agrees with normal mode there. The prelude line is swept to
`self -> self.*` in the same change.

Test: the five `tests/cli-cases/fix-migrate-deref-*` cases run the directory-form migration, which
loads the prelude and instantiates the derive. With the swept line they fail before the fix
(E0604 above, rc 1) and pass after.

The sibling
`issues/fixed/2026-11-15-migrate-deref-doubles-a-swept-star-when-the-recorders-old-reading-aborts-the-files-evaluation.md`
is the same order dependence. Its src sites (`impl.yo:217`, `declarations.yo:134`) lie in a swept tree and
fall under this fix too (not re-run here); its user-file repro does not, and stays open.
