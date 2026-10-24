# `yo fix --migrate explicit-copy` misses a write through a `&mut` capture-list borrow

**Severity:** S1. The rewrite changes what the program computes: a list copied out of a variable and then pushed to through a closure's `&mut` capture of that variable stops sharing the push, so a later read of the copy sees a different length.

> Found 2026-10-24 while fixing
> `issues/fixed/2026-10-23-explicit-copy-migration-keys-every-parameter-of-a-module-alike.md`.
> Once a parameter had its own key, a copy out of a parameter that a closure
> writes through a `&mut` capture went from listed (for a wrong reason, the
> shared key) to cloned. A local had always been cloned.

## Symptom

```yo
{ ArrayList } :: import("std/collections/array_list");
VEntry :: struct(yes : ArrayList(i32), no : ArrayList(i32));
local_capture :: (fn() -> usize)({
  mut(entry) := VEntry(yes : ArrayList(i32).new(), no : ArrayList(i32).new());
  x := entry.yes;
  (bump : Impl(Fn() -> unit)) = ({ &mut entry }() => {
    entry.yes.push(i32(1));
  });
  bump();
  x.len()
});
main :: (fn() -> unit)(());
export(main);
```

`yo fix main.yo --migrate explicit-copy` rewrote `x := entry.yes` to
`x := entry.yes.clone()`. Today `x` and `entry.yes` share one buffer, so
`x.len()` is 1 after `bump()`. After the rewrite it is 0. With a parameter
(`entry : &mut VEntry`, a labeled entry `{ e : &mut entry }`, a field place
`{ ys : &mut entry.yes }`) the v0.2.69 tree listed the copy, but only as "a
raw pointer into its source is taken", because every parameter of a module
shared one declaration key. With the key fixed, those copies were cloned
too. A `&mut` capture of the copy itself (`{ &mut x }` pushing to `x`) was
cloned the same way.

## Root cause

A capture-list entry binds a new variable in the closure body, declared at
the entry's label (`evaluate_anonymous_function_implementation`,
`src/evaluator/values/anonymous_function.yo`). A write through it
(`record_copy_write`) is keyed at that label, not at the captured variable.
The written-after guard (`_copy_written_after`, `_decl_written_after` in
`src/main.yo`) compares keys, so it never connected the push with the
variable the copy shares a buffer with. A by-value capture already recorded
its store as a copy into the capture. A borrow recorded nothing.

## Fix

A `&mut` capture-list entry records a flow from its root variable's key
into the capture's key (`record_copy_flow_decl`, `src/evaluator/utils.yo`),
at the entry. `_decl_written_after` follows flows recorded after the copy
site, so a write through the capture in the body counts as a write of the
captured variable. The entry carries the root's key from the capture-list
evaluation (`_CapListEntry.root_decl`). The field stays empty outside the
migration, so nothing is recorded or computed otherwise.

A `&` capture cannot be written through and records nothing.

Test: `tests/cli-cases/fix-migrate-explicit-copy-mut-capture`. It covers a local, a parameter under a
label, a field place and the copy itself. All four are listed. A closure
that only reads through a `&` capture still has its copy cloned.
