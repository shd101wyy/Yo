# A `LinkedList` of a move-only element cannot pop or clear

**Severity:** S2 — valid programs are rejected: a `LinkedList(T)` of a `Drop` type or a plain type with neither `Copy` nor `Clone` can be pushed to but not popped, removed from, cleared, or dropped through `clear`.

**Status:** open. Found 2026-10-16 while checking the std collections for the
cause of `issues/fixed/a-hashmap-of-a-move-only-key-or-value-does-not-compile.md`.
It has a different cause, so that fix does not cover it.

## Symptom

```text
error[E0901]: use of moved value: cannot copy `old_head.value`, whose type `Fd` is move-only, and it cannot be moved either: it is a field of another value, and moving it out would leave that value partly moved (Yo has no partial moves). Move the whole value instead.
note: raised here, inside the standard library
    --> std/collections/linked_list.yo:120:26
    |
120 |         value := old_head.value;
```

## Reproducer

```yo
{ LinkedList } :: import("std/collections/linked_list");
Fd :: struct(n : i32);
impl(Fd, Drop(drop : (fn(self : &mut Self) -> unit)(())));
main :: (fn() -> unit)({
  d := LinkedList(Fd).new();
  d.push_back(Fd(n : i32(1)));
  d.clear();
});
export(main);
```

## Root cause

Each element lives in a `Node(T)`, a `ref(struct(value : T, next, prev))`.
`pop_front`, `pop_back` and `remove` read `node.value` out of a node that other
handles (the neighbours, an iterator) may still share, and `clear` is a loop of
`pop_front`. A move out of a field of a shared cell is a partial move, which
Yo does not have, and the node's own drop would release the value again. The
array-backed collections fixed with the `HashMap` issue move a slot bitwise
and then stop owning it; a node has no such "the slot is empty now" state.

## Fix direction

Give the node an empty state the pop can leave behind, for example
`value : Option(T)` taken with `Option.take` (decision 19), with the readers
(`front`, `back`, `get`, `contains`, both iterators) reading through the
`Option`; or make the node uniquely owned (`Box` links, V2b), so the popped
node is consumed whole. `clear` can then unlink without popping each element.
