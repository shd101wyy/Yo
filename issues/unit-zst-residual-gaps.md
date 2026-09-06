# `unit` as a value type — the shapes still not covered

**Status:** OPEN (deliberate scope boundary, not regressions)
**Context:** follow-up to issues/fixed/unit-typed-params-and-fields-emit-c-void.md
(which made `unit` work in parameter, field, tuple and generic-container
positions) and — **re-prescribed 2026-09-06** — to
issues/fixed/unit-should-be-a-true-zero-sized-type-like-rust.md, which made
`unit` a TRUE zero-sized type: `sizeof(unit) == 0`, and every STORAGE position
erases it (no struct/tuple member, no `Array` data, no ArrayList bytes).

That changes the recipe below. The old prescription for every row was "route
the site through `get_storage_type_string`" — i.e. give it the one-byte
placeholder. **That is now only right for a PARAMETER position** (C cannot
declare a `void` parameter, and a parameter is calling convention, not layout).
A STORAGE position must be ERASED instead — emit no member / no slot / no
global — the way struct fields, tuple elements and enum variant fields already
are. The layout model (`get_size_of_type(.Unit)` is 0) already assumes erasure
at every one of these sites, so an erasure needs no matching change in
`src/types/utils.yo`; a placeholder at a storage site would now be the
model/emitter mismatch that
issues/fixed/sizeof-of-aggregate-with-unit-field-disagrees-with-emitted-c-struct.md
was, in the other direction.

Every shape in the table fails **today exactly as it failed before** either
change. Each needs its own reproducer and test, so they were left out rather
than changed blind.

## Not covered

| shape | site | fix direction |
| --- | --- | --- |
| `[unit; N]` array element | `src/codegen/types/generation.yo` (array wrapper) | **DONE 2026-09-06** — the wrapper emits no `data` member, only the one-byte `_zst_dummy` (`sizeof(Array(unit, N)) == 1`); the comptime and runtime array literals emit the empty struct and an index read emits nothing (`fill`/`len`/index pinned in tests/unit_as_value_type.test.yo) |
| a `unit` member of a `union` | `src/codegen/types/generation.yo` (union declaration) | storage → **erase** the member |
| `dyn` interface vtable fn-pointer parameters | `src/codegen/types/generation.yo`, `src/codegen/functions/dyn.yo` | parameter → placeholder (`get_storage_type_string`) |
| `dyn` interface non-function members | same | storage → **erase** |
| a module-level `unit` global | module-variable emission | storage → **erase** (no global) |
| a `unit` local that crosses an `io.await` (async state-machine slot) | `src/codegen/async/` | storage → **erase** (no slot) |
| a `unit` parameter of `main` | `src/codegen/functions/generation.yo` (`_main_call_args` emits `(void){0}`) | parameter → placeholder, fed `0` |
| parallelism spawn zero-initialization | `src/codegen/parallelism/` | storage → **erase** |

## Two pre-existing defects surfaced while mapping this

1. **`is_void_type` never matches `.Unit`.** `src/types/guards.yo` defines
   `is_void_type` (guards.yo:411) to match only `.Void`, while `is_unit_type`
   (guards.yo:120) matches only `.Unit`. `src/codegen/functions/dyn.yo:483` passes
   `is_void_type(result)` to the
   dyn wrapper emitter, so a **unit-returning `dyn` impl method** emits
   `return impl(...);` inside a C `void` wrapper.

2. ~~**`unit` is zero bits, so `ArrayList(unit)` allocates zero bytes.**~~
   **FIXED 2026-09-05** — `get_size_of_type(.Unit)` is now **8 bits**, the width
   of the one-byte placeholder `get_storage_type_string` already spells in every
   storage position, so `ArrayList(unit)` mallocs `1 * capacity` and `sizeof`
   agrees with the C struct codegen emits. The prescription below ("raise the
   size to 8 bits first") is what was done; it was forced by a worse instance of
   the same mismatch — an aggregate with a `unit` FIELD, where the store is not
   suppressed and the short allocation is a real out-of-bounds heap write. See
   `issues/fixed/sizeof-of-aggregate-with-unit-field-disagrees-with-emitted-c-struct.md`.

   > `get_size_of_type(.Unit)` is 0 (`src/types/utils.yo:1537`; alignment is 1, :1434), so an
   > `ArrayList(unit)` mallocs `0 * capacity`. It works on macOS/Linux because
   > `malloc(0)` returns a unique non-NULL pointer, but on a platform where
   > `malloc(0)` is NULL, `push` would return `.Err(AllocError.OutOfMemory)`.
   > The unit-store guards in `src/codegen/exprs/assignment.yo` are what keep a
   > one-byte write out of that zero-byte block — **do not remove them**. If a real
   > unit store is ever needed, raise the size to 8 bits first, and note that this
   > is a user-visible change to the `size_of` builtin's comptime value.

   **Re-reversed 2026-09-06:** `unit` is zero-sized again — RIGHTLY this time,
   because the storage is erased rather than merely unmeasured. `ArrayList` of a
   zero-sized type takes a one-byte anchor block with `SIZE_MAX` capacity
   (`_zst_anchor`) instead of `malloc(0)`. The unit-store guards in
   `src/codegen/exprs/assignment.yo:109,124,240` are load-bearing once more: a
   unit field has no C member to store into.

## Also worth doing

`is_unit_type` does not walk the SomeT resolution chain while `get_type_string`
does, so a generic whose type argument RESOLVES to unit is invisible to every
`is_unit_type` guard in codegen. Four sites in `src/codegen/exprs/return.yo` and
`src/codegen/exprs/await.yo` compensate with a literal `cty == "void"` string
test; those are load-bearing and undocumented. Either document them or give
`is_unit_type` a resolving variant and use it consistently.
