# An element borrow rejects a sibling argument that cannot reach the container

**Severity:** S2 — a valid call is rejected: `replace(&mut xs(i), v)` with
`xs : ArrayList(String)` and `v : String` is refused because "argument 2 ...
could hold a handle to `xs`", though no `String` can reach an
`ArrayList(String)`. The workaround is `take(&mut xs(i))` followed by a store
(`xs(i) = v`).

**Found:** 2026-10-24, reviewing V2b B6-0 (`std/mem`). The tree binary at
`f271ed005` fails as below. `replace(&mut xs(i), v)` with `xs : ArrayList(i32)`
is accepted, and so is `take(&mut xs(i))` on an `ArrayList(String)`.

## Reproducer

`issues/repros/2026-10-24-an-element-borrow-rejects-a-sibling-argument-that-cannot-reach-the-container.yo`:

```yo
{ replace, take } :: import("std/mem");
{ ArrayList } :: import("std/collections/array_list");
{ String } :: import("std/string");
{ assert } :: import("std/assert");
main :: (fn() -> unit)({
  mut(s) := ArrayList(String).new();
  s.push(`a`);
  v := `c`;
  y := replace(&mut s(usize(0)), v);
  assert(y == `a`, "old");
});
export(main);
```

```text
Error: A 'ref' argument ("s(usize(0))") borrows into the container "s", but argument 2 of the same call could hold a handle to "s" and grow it, reallocating the buffer the reference points into. Copy the element out with ".get(i)" first, or split the calls.
  --> tmp/f2.yo:9:21
```

## Root cause

The element-borrow rule in `src/types/flowability.yo` (rule (b), "any OTHER
argument that could hold a handle to the container") rejects a sibling
argument whose type satisfies `type_contains_rc_type`. Since decision 36 that
predicate is true for every value that is not `Copy`, so an explicit-copy
`String` counts as "could hold a handle", whatever the container's type. The
question the rule asks is narrower: can a value of the sibling's type reach the
container's storage (a closure, a raw pointer, a `Dyn`, an open generic, a `&`
or handle to the container's own type, or an aggregate holding one)?

The help text is also wrong for a move-only element: `.get(i)` copies, which is
E0901 there; `std/mem`'s `take(&mut xs(i))` is the move-out.

## Plan

V2b B6-a (element access through `std/mem`) is where this bites: narrow rule
(b) to a reachability walk over the sibling's type against the container's
type, and name `take(&mut xs(i))` in the help. Until then B6-a spells an
element replace as `take` followed by a store.

## Fix

V2b B6-a. Rule (b) in `_reject_if_container_reachable`
(`src/types/flowability.yo`) now asks the narrower question. The types the
borrowed element hangs from are the root variable's type and the type of every
value on the place's field path down to the container
(`_ref_place_holder_types`; `xs` for `xs(i)`, `h` and `h.lists` for
`h.lists(i)`). A sibling argument is rejected when it is a closure, or when a
value of its type can hold one of those types (`_type_may_reach_any_of`): a DFS
over the sibling's type through struct and enum fields, tuples, unions, arrays,
`Box` payloads and pointees. A `Dyn`, an open type variable, a `void` pointer
and a function value inside an aggregate (a closure that may have captured the
container) answer yes. When a type on the path is unknown, the old
conservative predicate applies. The help text names `std/mem`'s
`take(&mut xs(i))` beside `.get(i)`.

`replace(&mut xs(i), v)` with `xs : ArrayList(String)` and `v : String` is
accepted, and so is a move-only element value. An alias of the list, a value
holding one, and the object a listed field lives in are still rejected.

Tests: `tests/ref_field_borrow.test.yo` ("an element borrow beside a value that
cannot reach the container" and its rejected counterpart) and
`tests/move_only.test.yo` ("B6-a: take, with, swap and an element replace on
move-only elements"), which fail to compile before the fix and pass after.
