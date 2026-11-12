# A generic by-value result at a reference type drops its second argument's origin

**Severity:** S1 — a write to a place that a live reference points at is accepted: `picked := pick(rx, ry, false)` over `T := &i32` borrows only the first argument's referent, so `y = 9` while `picked` (which is `ry`) is still read passes `check`.

- Filed: 2026-11-12 (fixdev lane, found while fixing the G-E totality hole in `tests/origins/reference_read_rule.test.yo`'s `_sm_pick`).
- Related: R3 (#1904, `plans/backlog/REFERENCES_AND_ORIGINS.md`'s "a generic `T := &U` is a reference value"); O2's elided-result row (the union of the reference-holding arguments).

## Reproducer

```yo ignore
{ assert } :: import("std/assert");
_sm_pick :: (fn(generic(T : Type), a : T, b : T, first : bool) -> T)(if(first, a, b));
main :: (fn() -> unit)({
  x := i32(1);
  mut(y) := i32(2);
  rx := &x;
  ry := &y;
  picked := _sm_pick(rx, ry, false);
  y = i32(9);
  assert(picked.* == i32(2), "picked is ry");
});
export(main);
```

`yo check` accepts it (expected: E0911, `y` is written while `picked` borrows it). `YO_DEBUG_ORIGIN=1` prints
`_sm_pick(rx, ry, false) -> [x(imm), rx(imm)]`: the call's result is rooted at the first argument (its referent `x`, and
the binding `rx` itself) and never at the second. The same program with `x = i32(9)` instead is E0911, as it should be.

## Expected

The result of a call whose declared result is a by-value binder (`-> T`) specialized at a reference type holds what every
argument of type `T` holds: `[x, y]` here (O-3: a type parameter's instantiation carries one origin into all its
occurrences, so `a` and `b` share it and the result is their union).

## Status

Open. Not fixed by the fixdev PR, which fixes only the callee-side totality hole of the same function (the value tail's
origin). The caller-side root computation is `projection_call_root_args` / `_origin_carrying_roots_shallow`
(`src/evaluator/utils.yo`).
