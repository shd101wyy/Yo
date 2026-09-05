# `unit` as a value type — the shapes still not covered

**Status:** OPEN (deliberate scope boundary, not regressions)

> ⚠️ **DIRECTION CONFLICT — read
> `issues/unit-should-be-a-true-zero-sized-type-like-rust.md` before acting on
> this file.** Every row below is prescribed here as "route the site through
> `get_storage_type_string`", i.e. GIVE it the one-byte placeholder. The owner
> has since asked for TRUE zero-sized types with `sizeof(unit) == 0`, Rust's
> model — the opposite direction. Each row fixed the placeholder way becomes
> one more site to un-do. Reconcile the two issues before starting; if ZST
> parity is confirmed, these seven rows should be re-prescribed as ERASURE
> sites and the two files merged.
**Context:** follow-up to issues/fixed/unit-typed-params-and-fields-emit-c-void.md,
which made `unit` work in parameter, field, tuple and generic-container positions
by spelling storage positions with a one-byte placeholder
(`get_storage_type_string`).

Every shape in the "Not covered" table below fails **today exactly as it failed
before** that change. Each is the same one-line recipe — route the site through
`get_storage_type_string` instead of `get_type_string`, and fill the matching
empty argument slot — but each needs its own reproducer and test, so they were
left out rather than changed blind. (Of the two extra defects at the bottom,
item 2 is **FIXED 2026-09-05**; item 1 is still open.)

## Not covered

| shape | site |
| --- | --- |
| `[unit; N]` array element | `src/codegen/types/generation.yo` (array struct declaration) |
| a `unit` member of a `union` | `src/codegen/types/generation.yo` (union declaration) |
| `dyn` interface vtable fn-pointer parameters and non-function members | `src/codegen/types/generation.yo`, `src/codegen/functions/dyn.yo` |
| a module-level `unit` global | module-variable emission |
| a `unit` local that crosses an `io.await` (async state-machine slot) | `src/codegen/async/` |
| a `unit` parameter of `main` | `src/codegen/functions/generation.yo` (`_main_call_args` emits `(void){0}`) |
| parallelism spawn zero-initialization | `src/codegen/parallelism/` |

The layout model already ASSUMES the placeholder at every one of these sites
(`get_size_of_type(.Unit)` is one byte since the fix in item 2 below), so routing
any of them through `get_storage_type_string` needs no matching change in
`src/types/utils.yo` — the size it reports is already the size that lands.

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

   The unit-store guards in `src/codegen/exprs/assignment.yo:109,124,240` are
   still in place and are now merely redundant rather than load-bearing (the
   block they protect is no longer zero-sized). Removing them is a **separate**
   change, deliberately not bundled with the size raise.

## Also worth doing

`is_unit_type` does not walk the SomeT resolution chain while `get_type_string`
does, so a generic whose type argument RESOLVES to unit is invisible to every
`is_unit_type` guard in codegen. Four sites in `src/codegen/exprs/return.yo` and
`src/codegen/exprs/await.yo` compensate with a literal `cty == "void"` string
test; those are load-bearing and undocumented. Either document them or give
`is_unit_type` a resolving variant and use it consistently.
