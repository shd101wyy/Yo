# E0901's help on a raw cell suggests a `.clone()` the cell does not have

**Severity:** S3 — a wrong hint in a diagnostic. The program is correctly rejected. Raw cells (`__yo_cell(V)`, `__yo_atomic_cell(V)`) are unsafe-only, std-internal primitives, so few users see it.

- Filed: 2026-11-26 (lane `v81-dupdrop`, VERDICTS-70 row 9, `wip/v0281-dupdrop-r9`).
- Introduced by row 9. Before row 9, a raw cell was implicitly copyable: `d := c` minted a `___dup`. Row 9 makes every value that needs drop glue explicit-copy, so a second read of a moved cell is E0901. E0901's help is written for an explicit-copy type and suggests `.clone()`.

## Reproducer

```yo
pragma(Pragma.AllowUnsafe);
main :: (fn() -> unit)({
  c := __yo_cell(i32)(i32(5), .None);
  d := c;
  e := c;
});
export(main);
```

`yo check tmp/fixme.yo` (the stage-1 of `wip/v0281-dupdrop-r9` at `2e6c8401c`):

```text
error[E0901]: use of moved value: `c`
  --> tmp/fixme.yo:5:8
  |
5 |   e := c;
  |        ^
help: `c` is copied explicitly: write `c.clone()` for a copy, move it (`sink(c)`), or lend it to a `&mut T` parameter. A `&T` parameter borrows it without a copy (the call lends it with `&c`).
help: run `yo explain E0901` for more information
```

Following the hint fails:

```text
error[E0610]: No method "clone" on __yo_cell(i32): the type has no field or method with that name.
```

The working spelling today is `___dup(c)` (`tests/yo-cell.test.yo`, `tests/cell-handles.test.yo`).

## Root cause

`move_only_help` (`src/evaluator/utils.yo`) picks its text from the copy kind (`_explicit_copy_kind`). It does not check whether the type has a `Clone` impl. Every explicit-copy type had one until row 9 added the drop-glue clause to `type_requires_explicit_copy`. A raw cell, and a plain struct over one, is now explicit-copy without having `clone`.

## Fix direction

VERDICTS-70 row 12 settles how a raw cell is copied (it rewrites the `___dup(c)` spellings in `tests/yo-cell.test.yo` and `tests/fixtures/cell-handles.yo`). The help must then name that spelling. Either the cell gets the method the help names, or the help names the cell's own copy when the type has no `Clone`. The test for the fix is a `comptime_expect_error` row in `tests/yo-cell.test.yo` that matches the corrected help text.

## Fix

Fixed in VERDICTS-70 row 12 (`wip/v0281-dupdrop-r12`). Row 12 deletes `___dup`, so a raw cell's second handle is spelled the way the prelude's `Rc.clone` makes one: `consume(__yo_incr_rc((*void)(cell)))` retains the cell, and `__yo_rc_own(...)` makes the new handle own that count (`_cell_share` in `tests/yo-cell.test.yo`, the `TRc`/`TArc` `Clone` impls in `tests/fixtures/cell-handles.yo`).

`move_only_help` now picks its text from the copy the type has:

- a raw cell (`is_cell_primitive_type`) gets a note that names the retain and `__yo_rc_own`, and no `.clone()`;
- any other explicit-copy type that is not `Clone` (`type_lacks_clone`), such as a struct over a raw cell, is told to give the type a `Clone` impl.

The test is `E0901 on a moved cell names the copy it has, not a .clone()` in `tests/yo-cell.test.yo`.
