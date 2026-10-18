# `yo fix` over several files applies one file's generic impls to another file's same-named type

**Status:** FIXED 2026-10-16 (`fix/yo-fix-multi-file-generic-impls`).

**Severity:** S3 — an evaluating migration (`--migrate mutable-globals`, `match-scrutinee`, `markers`, ...) run over a directory reports correct files as "does not evaluate" and silently leaves their sites unmigrated; running the migration on each file alone works around it.

> Found 2026-10-15 running `yo fix ./tests --migrate mutable-globals` for
> decision 47 (`feat/global-lend-to-call-is-an-error`). Reproduces on the
> v0.2.62 seed with `--migrate match-scrutinee`, so it predates that branch.

## Symptom

`yo fix ./tests --exclude tests/internal --exclude tests/cli-cases --exclude tests/spec --migrate mutable-globals --dry-run`
reports 18 files that do not evaluate. Each one evaluates when it is the only
path (`yo fix tests/type_soundness.test.yo --migrate mutable-globals` marks 2
globals the directory run missed). With `YO_DEBUG_FIX=1` the load errors name
a definition in a DIFFERENT entry file:

```text
[fix] tests/impl.test.yo: error: derive on "GenBox(T)" failed: Type "GenBox(T)" implements Copy, so its Clone may not be hand-written (the hand-written Clone impl is at tests/copy_trait.test.yo:96:1) ...
[fix] tests/codegen-bootstrap/generic_impl_method_returns_self.yo: error[E0612]: Method "add" is already defined for type "Wrap(T)" under the same bounds (first definition: tests/codegen-bootstrap/generic_impl_method_arg.yo:6:1) ...
[fix] tests/circular_deps/circular_error_a.yo: error[E0403]: No member "EarlyField" in the module. ...
```

Four of the 18 (`circular_error_a.yo`, `circular_error_b.yo` and the two
`member_visibility/` helpers) are not standalone programs either way; the
other 14 `.test.yo` / `codegen-bootstrap` files are correct programs.

## Reproducer

Two identical files, each defining its own generic `Wrap(T)` with an inherent
method:

```yo
Wrap :: (fn(comptime(T) : Type) -> comptime(Type))(
  ref(struct(v : T))
);
impl(
  generic(T : Type),
  Wrap(T),
  add : (fn(self : &Self, delta : i32) -> i32)(self.v + delta)
);
main :: (fn() -> unit)({
  w := Wrap(i32)(v : i32(60));
  _a := w.add(i32(5));
});
export(main);
```

```console
$ cp a.yo b.yo
$ yo check a.yo; yo check b.yo        # both: evaluator OK
$ YO_DEBUG_FIX=1 yo fix a.yo b.yo --migrate match-scrutinee --dry-run
[fix] b.yo: error[E0612]: Method "add" is already defined for type "Wrap(T)" under the same bounds (first definition: a.yo:4:1). ...
fix: b.yo does not evaluate; its match scrutinees are migrated only as far as evaluation reached
```

## Root cause (suspected at filing; see "Root cause (measured)" below)

The evaluating migrations load every path into one session (`mm_load_file`
per file, `src/main.yo`, so generic `std` bodies instantiated by one file are
migrated too). The inherent-method and trait-impl registries for a generic
type template are keyed by the template's printed name (`Wrap(T)`), not by
its defining module, so the second file's `Wrap` collides with the first
one's impls: a duplicate inherent method is E0612, and a hand-written `Clone`
on one file's `Copy` type is found for another's. The same key would collide
in any other one-session multi-entry evaluation (`yo lsp` with two open
projects).

The verify-pragma fixtures that fail the same way under `tests/spec` are a
separate cause, filed as `issues/yo-fix-migrate-markers-skips-verify-pragma-files.md`.

## Workaround

Run the migration on each reported file alone. For decision 47's test sweep
that recovered 2 globals (`tests/type_soundness.test.yo`).

## Root cause (measured)

`yo check <dir>` fails the same way (`yo check .` in a directory holding
the reproducer's two files: `b.yo` E0612, measured with v0.2.63), so the
shared state is the evaluator's, not `yo fix`'s. The method and impl registries themselves are
not the problem: dispatch and generic-impl matching compare struct and enum
identities by declaration (`constructor_func_id` / id, the synthesizer's
struct arm), so `b.yo`'s `Wrap(i32)` never matches `a.yo`'s impl. Two checks
that run at impl REGISTRATION compared printed names instead, in
`src/evaluator/values/impl.yo`:

1. **The generic coherence keys.** `_check_generic_impl_coherence` records
   each generic impl in the site table (`note_trait_impl_site`) under a key
   built from `type_to_string` of the receiver pattern (binders renamed `$0`,
   `$1`, …): `Wrap($0)` + bounds + method name for an inherent impl,
   `Wrap($0)` + `Show` for a trait impl. Both files' `Wrap` print `Wrap($0)`
   and both files' `Show` print `Show`, so the second file's impl found the
   first file's site and was rejected as a duplicate method (E0612) or a
   second impl of the trait (E0612).
2. **The generic `Copy`/`Clone` recheck.** At a generic `Copy` impl,
   `_check_generic_copy_clone_exclusion` re-tests every hand-written generic
   `Clone` impl that `_root_shapes_could_match` the new receiver. That
   prefilter compares the printed base name only when it is non-empty, and a
   generic struct instance's name is empty (it prints through its display
   name), so every generic struct passed it. `impl.test.yo`'s
   `derive(..., GenBox(T), Copy)` re-tested `copy_trait.test.yo`'s `_CtTag(T)`
   `Clone`, which reads as `Copy` because the `Copy` impl that
   `copy_trait.test.yo` rejects under `comptime_expect_error` stays
   registered (filed separately:
   `issues/fixed/2026-10-16-a-generic-impl-rejected-under-comptime-expect-error-stays-registered.md`).
   This half is not multi-file only: one file holding both declarations
   failed the same way.

After the fix, the decision 47 sweep
(`yo fix ./tests --exclude tests/internal --exclude tests/cli-cases --exclude tests/spec --migrate mutable-globals --dry-run`)
reports 3 files that do not evaluate instead of 18. Two are the
`circular_error_*` helpers, which are not standalone programs (the
`member_visibility/` helpers now evaluate beside their importer). The third,
`tests/lazy_toplevel_bindings.test.yo`, is new in the list: it evaluated
before only because `tests/impl.test.yo` failed early. Now `impl.test.yo`
evaluates, and its `MrE` has the same shape as `lazy_toplevel_bindings`'
`Tree` (`enum(Leaf(v : i32), Node(kids : ArrayList(Self)))`), so the two share
one `ArrayList(Self)` instantiation. That is a separate structural-key bug,
not a printed-name one, and it reproduces in one file:
`issues/2026-10-17-two-recursive-enums-of-one-shape-share-their-arraylist-self-instantiation.md`.

## Fix

`src/evaluator/values/impl.yo`:

- `_decl_modules_of` lists where the nominal types a type mentions are
  declared, in print order: a struct's, enum's or union's declaring module
  (`type_decl_module`, the registry the member-visibility check already
  keeps, which every declaration and CTFE instance registers), a trait's
  base key followed by its method signatures' types (a function type
  contributes its parameters and result). A trait instance's arguments live
  only there: `From(Meters)` is `from : fn(value : Meters) -> Self`, and its
  `TraitT` keeps no argument list. Both coherence keys append it for the
  receiver pattern, and the trait key also appends it for the trait and
  `entry.trait_key`. Two declarations that print alike now key apart (two
  files' `Wrap(T)`, and two files' `From(Meters)` over the prelude's
  `Option(T)`); the same declaration still keys alike from any module, so a
  duplicate impl in an importing module is still E0612
  (`tests/cli-cases/check-coherence-cross-module-duplicate`).
- `_receiver_patterns_could_overlap` replaces the root-shape prefilter in the
  generic `Copy` recheck: two nominal roots overlap only when they are the
  same declaration (`_nominal_root_identity`: the generic constructor's func
  id, else the declaration-stable `struct_decl_…`/`enum_decl_…` id). A
  printed name is not an identity: `GB(T)` after `GB :: GenBox` prints
  differently from `GenBox(T)`, and a first version that compared printed
  base names skipped the recheck for an alias. A root whose id is minted per
  instantiation with no recorded constructor, a union, a type-variable root
  or a structural root still defers to `_root_shapes_could_match` and the
  `Copy` hook.

The coherence key itself still prints the receiver, so a duplicate generic
impl whose receiver is spelled differently (through an alias, or with another
binder name: `Option(T)` and `Option(U)`) is accepted. That predates this fix
and is filed as
`issues/2026-10-17-a-duplicate-generic-trait-impl-spelled-differently-is-accepted.md`.

## Regression test

`tests/cli-cases/fix-over-two-files-declaring-one-generic-type-name`: two
files each declaring `Wrap(T)` (inherent `add`, trait `Show`), one with
`_CtTag`'s rejected `Copy` and one deriving `GenBox(T)`'s `Copy`; runs
`yo fix . --migrate mutable-globals` (marks one global in each file) and
`yo check .` (both files pass). Each file also implements `From(Meters)` for
the prelude's `Option(T)` over its own `Meters` (a printed-alike trait
instance). `tests/copy_trait.test.yo` pins the alias half: a `Copy` impl over
`_CtTaggedAlias(T)` is still rejected by `_CtTagged(T)`'s hand-written
`Clone`.
