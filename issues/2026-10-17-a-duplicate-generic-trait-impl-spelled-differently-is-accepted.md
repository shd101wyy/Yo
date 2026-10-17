# A duplicate generic trait impl spelled differently is accepted

**Severity:** S3 — coherence rule 1 ("a type implements a trait at most once", `plans/reference/TRAIT_COHERENCE.md`) misses a second generic impl when its receiver is spelled differently: through an alias of the type constructor, or with another binder name. The program is accepted with two impls of one trait for one type, and which one a call reaches depends on registration order. Nothing is miscompiled beyond the choice of impl.

> Found 2026-10-17 while resolving the review of #1430
> (`issues/fixed/2026-10-15-yo-fix-over-several-files-applies-one-files-generic-impls-to-anothers-same-named-type.md`).
> The same printed-name problem made the generic `Copy` recheck skip an
> alias, which #1430 fixed. The coherence key has had it since before #1430.

## Reproducer

```yo
Wrap :: (fn(comptime(T) : Type) -> comptime(Type))(struct(v : i32));
WA :: Wrap;
Show :: trait(show : (fn(self : &Self) -> i32));
impl(generic(T : Type), Wrap(T), Show(show : (fn(self : &Self) -> i32)(i32(1))));
impl(generic(T : Type), WA(T), Show(show : (fn(self : &Self) -> i32)(i32(2))));
main :: (fn() -> unit)({
  w := Wrap(i32)(v : i32(1));
  _x := w.show();
});
export(main);
```

```console
$ yo check x.yo        # v0.2.64
check: x.yo — evaluator OK
```

Expected: `error[E0612]: Trait "Show" is already implemented for type "WA(T)"`
at the second impl, as when both impls spell `Wrap(T)`.

The binder's name has the same effect. This is accepted, and E0612 is
reported only once both impls name their binder `T`:

```yo
Meters :: struct(v : i32);
impl(generic(T : Type), Option(T), From(Meters)(from : (fn(value : Meters) -> Self)(Option(T).None)));
impl(generic(U : Type), Option(U), From(Meters)(from : (fn(value : Meters) -> Self)(Option(U).None)));
main :: (fn() -> unit)(());
export(main);
```

## Root cause

`_check_generic_impl_coherence` (`src/evaluator/values/impl.yo`) keys a
generic impl by `type_to_string` of its canonicalized receiver pattern. A
generic struct or enum instance prints through the display name registered
from the callee and the arguments as written (`evaluator/calls/comptime_fn.yo`),
so `WA(T)` and `Wrap(T)` print differently and get two keys, and so do
`Option(T)` and `Option(U)`: the `canon` substitution that renames binders to
`$0`, `$1`, … does not reach a display name. #1430 appended the declaring
modules to the key (`_decl_modules_of`), which tells two files' `Wrap` apart.
It does not merge two spellings of one declaration.

## Fix direction

Key the receiver (and each nominal type inside it and inside the trait) by
declaration identity instead of by its printed name: the generic constructor's
func id for an instantiation, else the declaration-stable type id. This is
what `_nominal_root_identity` does for the root since #1430's review. The key
still has to rename binders by position, as the `canon` substitution does now.
A regression test is the reproducer above under `comptime_expect_error` in
`tests/impl.test.yo`, plus the same case with the alias nested inside the
receiver (`Option(WA(T))` against `Option(Wrap(T))`) and the `Option(U)`
reproducer.
