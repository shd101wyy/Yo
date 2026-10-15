# `yo fix` over several files applies one file's generic impls to another file's same-named type

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

## Root cause (suspected)

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
