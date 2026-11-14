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

## Fix

Not in this PR. The text sweep holds the line back (the 94th held-back line, beside VERDICTS-60
decision 7's 93): the swept tree carries develop's `(self -> self))` until the flip. The migration
mode itself must learn the pointer case before the v0.2.79 flip re-runs it (rider/flip lane,
VERDICTS-60 decisions 11–14). With the line held back the E0604 and the prelude-load failure are
gone; the five `tests/cli-cases/fix-migrate-deref-*` cases stay red for a second, independent
reason recorded beside this one
(`issues/2026-11-14-the-deref-recorder-cannot-evaluate-the-swept-preludes-generic-comparisons.md`).
