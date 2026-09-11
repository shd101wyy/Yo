# A definition that type-checks in source order fails when a FORWARD reference forces it early

**Status:** OPEN — observed once, not yet minimized
**Found:** 2026-09-11, wiring the `--imports` loader into `src/module_manager.yo`
(branch `p1/imports-plumbing`).

## Symptom

`_load_imports_file` (new) called `_read_file_sync`, which was defined ~100
lines LATER in the same module. `yo check ./src` then failed on every importer
of `module_manager.yo` with:

```
error: Type fn(T : Type) -> Type does not implement the trait Error required by dyn(Error + ToString).
    --> file:///…/src/module_manager.yo:222:74
    |
222 | _read_file_sync :: (fn(path : String, exn : Exception) -> ArrayList(u8))({
    |                                                                          ^^^^^
  note: `_read_file_sync` (line 222) was evaluated here because it is referenced before its definition in the source
```

`_read_file_sync` itself was untouched and type-checks in source order: moving
the new caller BELOW it (no other change) made `check` pass 270/270. So the
lazy-binding forcing path (`plans/reference/LAZY_TOPLEVEL_BINDINGS.md`) evaluated
the body under an environment where some name it uses — the message points at a
type constructor (`fn(T : Type) -> Type`) reaching a `dyn(Error + ToString)`
position, i.e. an `exn.throw(dyn(...))` or an `IoExn`/error-type name resolving
to a generic type function rather than its instantiation — resolved differently
than in source order.

## To do

Minimize: a two-definition module where `a` (first) calls `b` (second) and `b`'s
body throws `dyn(<some std error type>)`. Compare the forced evaluation's env
with the in-order one; the forcing env (`module_walk_force_env`) is the suspect.
Until then: keep new helpers BELOW what they call in `module_manager.yo`.
