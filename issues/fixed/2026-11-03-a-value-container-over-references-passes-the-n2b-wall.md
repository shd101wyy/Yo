# A value container over references passes the N2b wall

**Severity:** S1 — once collections are value structs, `ArrayList(&i32).new()`
type-checks. The origin checker cannot follow a reference stored in a
container's element buffer, so a program can keep a reference past its
referent and nothing rejects it.

**Status:** fixed 2026-11-03 on `vbd/b9-helps-b8-tests` (for the B8
ArrayList/String value flip). **Found:** 2026-11-03 by B9 in B8's tree sweep
`check ./tests --test-bodies` (tree binary `yo-tree-3a7ca187e`).
`tests/borrow_spelling.test.yo:280` failed: its `comptime_expect_error`
expects the N2b wall, and no error was raised. Develop (`ce827ae52`) passes.
The bug is caused by the flip.

## Reproducer

```yo
{ ArrayList } :: import("std/collections/array_list");
bs_type_argument :: (fn() -> unit)({
  _xs := ArrayList(&i32).new();
});
export(bs_type_argument);
```

Expected: `A value of ArrayList(&i32) carries an origin inside a container
or a cell, …` (decision 43 step 3: containers over reference-holding elements
arrive with N2c). On the flipped tree the file checks clean.

## Root cause

`origin_beyond_n2b` (`src/types/utils.yo`) tells inline composites, which N2b
opens, apart from containers and cells, which it does not.

- It recognises a container by its shape. `_origin_shape_is_handle_or_cell`
  takes a `ref`-semantics struct, `Rc`, `Arc`, or the unique `Box`.
- On develop, `ArrayList` is a `ref(struct(...))`, so that shape test catches
  it.
- After the flip, `ArrayList` is a value struct whose elements sit behind
  `_ptr : ?*T`. The walk then reads it as an inline composite and recurses
  through its fields.
- The `.Pointer(inner)` arm recursed into `&i32`, and a bare reference is an
  inline position (`false`). The element buffer was never seen.

The flipped `HashMap`/`HashSet` (B9) hold their entries the same way and had
the same gap.

## Fix

In `_origin_beyond_n2b_inner`, a pointer whose pointee carries an origin
(`type_carries_origin`) is now beyond N2b. A pointee is storage outside the
composite, either a container's element buffer or a cell, so it belongs to N2c
or N2d, never to an inline position. Inline composites that hold no pointer
are unaffected: a value struct, an enum, a tuple or an array of references
still builds.

## Regression test

`tests/borrow_spelling.test.yo`, the `comptime_expect_error` at line 280
(`ArrayList(&i32).new()`). It fails on the flipped tree before the fix, with
no error raised, and passes after.
