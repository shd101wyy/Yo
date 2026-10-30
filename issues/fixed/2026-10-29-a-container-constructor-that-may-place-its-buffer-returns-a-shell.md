# A container constructor that may place its buffer returns a shell, not fresh storage

**Severity:** S3 (analysis precision: no wrong code and no wrong verdict was
seen, but every object holding a new container lost its "fresh" root, so a
write reached through it is no longer proved local)

**Status:** fixed 2026-10-29 (branch `vbd/alloc-v2-gen-b-r2`, allocator
interface v2 Generation B with placement B2a).
**Found:** 2026-10-29 by the cli-case `audit-rc-write-census` on the B2a
branch: `g := Node(n : i32(0), items : ArrayList(i32).new()); g.n = i32(9);`
was reported `root=shell` instead of `root=fresh`.

## The bug

The mutation summary (`src/evaluator/effects/mutation_summary.yo`) roots every
value: storage a function allocates is FRESH, and a fresh object that may hold
a handle rooted elsewhere is a SHELL, whose contents read back as rooted. A
placed block's owner record holds the allocator's `ctx` and vtable, both raw
pointers, so `std/allocator.yo`'s `_stamp`, which writes that record, made the
block a SHELL: a raw pointer may point into parameter storage. Before B2a only
`new_in`/`with_capacity_in` placed a buffer, so only a placed container was a
shell. B2a folds placement into `new(alloc : …)` and `with_capacity`, so every
`ArrayList(T).new()` joined the fresh `.None` arm with the shell `.Some(a)` arm
and returned a shell.

```yo ignore
{ ArrayList } :: import("std/collections/array_list");
Node :: ref(struct(n : i32, items : ArrayList(i32)));
main :: (fn() -> unit)({
  g := Node(n : i32(0), items : ArrayList(i32).new());
  g.n = i32(9); // YO_AUDIT_RC_WRITE=1: root=shell (fresh before B2a)
});
export(main);
```

## Fix

An `Allocator`'s two words are the allocator's private state and its
immortal vtable, never Yo storage a caller reaches. The vtable-slot rule
(`_msp_allocator_slot`) already relies on that for `ctx`, and step A2 makes
`Allocator` an opaque handle in safe code. `_msp_type_contains_pointer_inner`
now says the prelude's `Allocator` (`is_prelude_allocator_struct`) contains
no pointer, so a value of that type roots nothing. `_stamp` takes the owner as
an `Allocator` instead of its two raw words, so the record it writes is built
from an inert value.

## Test

`tests/cli-cases/audit-rc-write-census`: the object built with
`ArrayList(i32).new()` is `root=fresh` again, and a new line, an object built
with a list placed by `alloc : .Some(Allocator.global())`, is `root=fresh` too.
Both are `root=shell` without the fix.
