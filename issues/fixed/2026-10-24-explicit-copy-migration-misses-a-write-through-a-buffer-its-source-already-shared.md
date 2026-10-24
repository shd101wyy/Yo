# `yo fix --migrate explicit-copy` misses a write through a buffer its source already shared

**Severity:** S1. The rewrite changes what the program computes: a copy of a variable that already shared its buffer with another one stops seeing a write through that other variable.

> Found 2026-10-24 while fixing the review findings of B4-0a
> (`issues/fixed/2026-10-24-explicit-copy-migration-misses-a-write-through-a-pattern-binding.md`).
> The guard followed a copy's source only forward, into variables it flowed
> into after the copy.

## Symptom

```yo
{ ArrayList } :: import("std/collections/array_list");
{ println } :: import("std/fmt");
alias_before :: (fn() -> usize)({
  x := ArrayList(i32).new();
  t := x;
  y := t;
  x.push(i32(1));
  y.len() + t.len()
});
main :: (fn() -> unit)({
  println(alias_before());
});
export(main);
```

The program prints `2`: `x`, `t` and `y` share one buffer. With the v0.2.69
tree (`f271ed005`) `yo fix main.yo --migrate explicit-copy` listed `t := x` (its
source is written afterwards) but wrote `y := t.clone();`, after which the
program prints `1`.

## Root cause

`_decl_written_after` (`src/main.yo`) followed the flows out of a copy's
source recorded after the copy. `t` received `x`'s buffer before `y := t`,
and the push goes through `x`, so neither the source `t` nor anything it
flowed into afterwards was written.

## Fix

For a copy's source, the guard first collects the variables the source
shares its buffer with when the copy is made: those joined to it by a flow
before the site, in either direction, transitively (`flows_by_dst` beside
`flows_by_src`, `_decl_written_after`'s `shared_before`). A write through
any of them, or through a variable they flow into afterwards, is a write of
the source. Flows are per variable, not per field, so a copy of one field
can now be listed for a write through a variable that took another field of
the same root; that is the same granularity the guard already had after the
copy.

Test: `tests/cli-cases/fix-migrate-explicit-copy-shared-before`. `alias_before`'s `y := t` is
listed. When `t` holds its own buffer (`t := x.clone()`), `y := t` is still
cloned.
