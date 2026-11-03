# The element-borrow sibling rule still rejects a value collection that cannot alias

**Severity:** S2 — a valid program is rejected, and std pays a clone to avoid it. A call that
lends one element of a collection `&mut` (`&mut xs(0)`) beside a BY-VALUE argument of a type that
can reach the collection's type (`other : ArrayList(String)`) is rejected with `could hold a
handle` even when the argument is a value collection that, after B8, cannot alias the lent
container.

**Status:** open — created by B8 (`ArrayList` and `String` became values), verdict
2026-10-31 (Fable consultation #12, B8-Q2): the loosening lands as its own small PR right after
the B8 flip merges, inside the v0.2.74 window (fallback slot: B9's flip PR). It keys on
`is_reference_semantics`, so it needs nothing from V5. This PR pins the first `grow_beside` case
below as an INTERIM over-rejection; the follow-up PR flips that pin to an accepted call.

## Reproducer

```yo
{ ArrayList } :: import("std/collections/array_list");
{ String } :: import("std/string");
grow_beside :: (fn(dst : &mut String, other : ArrayList(String)) -> unit)({
  mut(o) := other;
  o.push(String.from("grown"));
  dst = String.from("w");
});
main :: (fn() -> unit)({
  mut(xs) := ArrayList(String).new();
  xs.push(String.from("a"));
  grow_beside(&mut xs(usize(0)), ArrayList(String).new()); // rejected: "could hold a handle"
});
export(main);
```

`tests/ref_field_borrow.test.yo` pins this today as
`comptime_expect_error(grow_beside(&mut xs(usize(0)), ArrayList(String).new()), "could hold a
handle")`. After B8 the program is sound: the callee owns `other` (a fresh value list), so
growing it cannot reallocate `xs`'s buffer, and the `&mut` element stays valid. The two other
pins in that test stay rejected under the fix below: `&_ListBox` (a `&` to a struct that holds
the container's type) and the `_StrLists` owner lent through a second handle, plus a closure
capturing the container.

## The std cost

`std/encoding/json.yo`'s `insert` cannot spell `old := replace(&mut values(i), value);` (the
`value : JsonValue` argument's type reaches `ArrayList`, so the sibling rule rejects the
element borrow beside it). It clones instead — `old := values(i).clone(); values(i) = value;` —
one deep copy of the old entry per key overwrite.

## Cause

`_reject_if_container_reachable` (`src/types/flowability.yo`, the element-borrow sibling rule)
walks TYPE reachability from the sibling argument to the container's type: "it may be an alias"
(`tests/ref_field_borrow.test.yo`'s three genuine pins). That reasoning only holds for
handle/reference semantics. A flipped value collection has a unique owner, so a by-VALUE
argument of that type cannot reach the lent container; only edges through reference semantics
(a `&`/`&mut` of a `ref`-rooted place, a second handle to a `ref` root, a closure capture) can
alias it.

## Fix direction

Reach may pass only through reference-semantic edges: the walk from the sibling argument to the
container must cross an `is_reference_semantics` edge to reject. With that predicate the rule
tracks the flips themselves (B9–B11 each flip one more type), so no follow-up re-read is needed
per flip; V5 Generation B re-reads the 527 `is_reference_semantics` sites as planned. The
follow-up PR: flip the first `grow_beside` pin to an accepted call with an assertion that `xs`
is unchanged, switch json's `insert` to `replace(&mut values(i), value)`, and keep the
`&_ListBox`, `_StrLists`-owner and closure pins rejected. Its gate is its own emit-diff plus the
re-pinned test, not the flip probe.
