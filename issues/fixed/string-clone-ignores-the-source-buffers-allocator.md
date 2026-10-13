# `String.clone` placed the copy in the current scope, not where the source lives

**Severity:** S3 — an arena string's `clone()` made outside any `with_allocator` scope came back on the global heap, against decision 12 and against `String.to_bytes`, `ArrayList.clone` and `HashMap.clone`, which all keep the source's allocator.

> Found 2026-10-13 by the std allocator hand-off audit. **FIXED** on
> `fix/allocator-tag-handoffs`.

## Symptom

```yo
pragma(Pragma.AllowUnsafe);
{ String } :: import("std/string");
{ Arena } :: import("std/arena");
{ with_allocator } :: import("std/allocator");
{ println } :: import("std/fmt");
main :: (fn() -> unit)({
  arena := Arena.new(usize(1) << usize(16));
  {
    s := with_allocator(arena.allocator(), () => String.from("arena text"));
    before := arena.live_blocks();
    t := s.clone();
    println(`clone added ${arena.live_blocks() - before} arena block(s)`); // 0 on develop, 1 now
  };
  arena.deinit();
});
export(main);
```

## Root cause

`impl(String, Clone(clone : …))` in `std/string/string.yo` built the copy with
`ArrayList(u8).with_capacity(n)`, which follows the *caller's* current scope.
Every sibling copy routine asks the source instead: `ArrayList.clone` and
`HashMap.clone` match on `self.allocator()`, and `String.to_bytes` goes through
`ArrayList.clone`. `plans/VALUES_BY_DEFAULT.md` §3.11 (decision 12): "An
explicit `clone()` lands where its source lives, not in the current scope".

This is a placement defect, not a misroute: the copy's tag matched its block,
so nothing was freed through the wrong allocator.

## Fix

`String.clone` picks the buffer the way `ArrayList.clone` does:
`match(al.allocator(), .Some(a) => ArrayList(u8).with_capacity_in(a, n), .None => ArrayList(u8).with_capacity(n))`.
A global source cloned inside a scope still follows the scope, the same rule
`ArrayList.clone` applies to a `.None` owner.

## Verification

`tests/string/string.test.yo`, "clone of an arena string stays in the arena":
the clone adds exactly one arena block, its buffer reports the arena as its
owner after growing, and every block is released at the end. It fails on
develop (exit 6) and passes with the fix.
