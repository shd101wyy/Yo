# E0908 prints an element place with unbalanced parentheses

**Severity:** S3 — a misleading diagnostic: an E0908 for an element place names `q.ss)(usize(0)` instead of the place.

**Status:** fixed 2026-10-17. Found while writing `tests/shared_borrow_write.test.yo`
for `issues/fixed/a-field-write-through-a-shared-borrow-parameter-is-accepted-and-lost.md`.

## Reproducer

```yo
{ String } :: import("std/string");
Q :: struct(ss : [String ; 2]);
w :: (fn(q : &Q) -> unit)({
  q.ss(usize(0)) = String.from("x");
});
export(w);
```

On develop at `1a4cf8df6`, `yo check` reports
``Cannot write `q.ss)(usize(0)`: `q` is a `&T` parameter, …``; a `&` local
borrow's element write reads ``Cannot write `y.arr)(usize(0)` `` the same way.

## Root cause

`_place_source_text` (`src/evaluator/exprs/assignment.yo`) stripped the first
and last character whenever the printed place started with `(` and ended with
`)`. The printer renders an element place `(q.ss)(usize(0))`, whose first `(`
does not enclose the whole text.

## Fix

`_place_source_text` uses `local_borrow_place_text` (`src/evaluator/utils.yo`),
which prints a field path as written and strips only a pair of parentheses that
encloses the whole text: the message now names `(q.ss)(usize(0))`.

Test: `tests/shared_borrow_write.test.yo`, "E0908 names an element place with
balanced parentheses". It fails on develop at `1a4cf8df6`: the message does not
contain ``Cannot write `(q.ss)(usize(0))` ``.
