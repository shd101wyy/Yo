# A generic impl rejected under `comptime_expect_error` stays registered

**Severity:** S3 — only `comptime_expect_error` (a test construct) can observe it in one compile: after the expected rejection, the rejected impl still answers `Type.impls` and dispatch, so later checks in the same file (or in another file of the same `yo check <dir>` / `yo fix` session) see a trait the program does not have.

> Found 2026-10-16 while fixing
> `issues/fixed/2026-10-15-yo-fix-over-several-files-applies-one-files-generic-impls-to-anothers-same-named-type.md`:
> the `GenBox` failure there was this leak read through a prefilter that
> compared unrelated receivers.

## Reproducer

```yo
_CtTag :: (fn(comptime(T) : Type) -> comptime(Type))(
  struct(id : i32)
);
impl(
  generic(T : Type),
  _CtTag(T),
  Clone(
    clone : (fn(self : &Self) -> Self)(Self(id : self.id))
  )
);
comptime_expect_error(impl(generic(T : Type), _CtTag(T), Copy()), "a hand-written Clone impl can only repeat it or contradict it");
comptime_assert(!Type.impls(_CtTag(i32), Copy), "the rejected Copy impl is not registered");
main :: (fn() -> unit)(());
export(main);
```

```console
$ yo check leak.yo        # v0.2.63
error: the rejected Copy impl is not registered
```

## Root cause

`src/evaluator/values/impl.yo`, the generic trait-impl path: the entry is
registered (`register_generic_impl`, `note_generic_move_only_impl`, and the
coherence site `note_trait_impl_site("generic", …)`) BEFORE
`_check_generic_copy_clone_exclusion` runs. The check must run after
registration (at a `Copy` impl it re-asks whether each hand-written generic
`Clone` receiver is now `Copy`, which needs the new impl visible), and its
throw does not undo the three registrations. `comptime_expect_error` catches
the throw and evaluation continues with the impl in place.

## Fix direction

On the throw path, remove the entry from its generic-impl bucket (and its
owner slot), its coherence site and its move-only declaration, and bump the
trait-impl epoch; or run the `Copy`-side recheck against a candidate list that
includes the new entry without registering it first.
