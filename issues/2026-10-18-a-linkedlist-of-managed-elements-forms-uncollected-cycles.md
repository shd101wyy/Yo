# A `LinkedList` of managed elements forms cycles the collector never frees

**Severity:** S3 — a memory leak, not unsoundness: `LinkedList(Self)` cycles are
registered by neither side of the collection analysis, so `Gc.collect()` leaves
every member tracked and alive. Develop behaves the same; found 2026-10-18
while adding a cycle canary for the move-only element fix
(`issues/fixed/2026-10-16-a-linkedlist-of-a-move-only-element-cannot-pop-or-clear.md`).

## Symptom

```text
2                       # tracked_count() inside, after building a 2-node cycle
2                       # tracked_count() after Gc.collect()
Assertion failed ... "cycle collected"
```

## Reproducer

```yo
{ assert } :: import("std/assert");
{ collect, tracked_count } :: import("std/gc");
{ LinkedList } :: import("std/collections/linked_list");
LNode :: ref(
  struct(
    value : i32,
    children : LinkedList(Self)
  )
);
test("LinkedList(Self) two-node cycle collected", {
  do_test :: (fn() -> unit)({
    a := LNode(1, LinkedList(LNode).new());
    b := LNode(2, LinkedList(LNode).new());
    consume(a.children.push_back(b));
    consume(b.children.push_back(a));
  });
  do_test();
  collect();
  assert(tracked_count() == u64(0), "LinkedList(Self) cycle collected");
});
```

The `ArrayList(Self)` twin (`tests/cycle_collector.test.yo`, "ArrayList(Self)
two-node cycle collected") passes on the same binary, so the gap is specific to
the indirection: `ArrayList` holds its `?(*(E))` element buffer as a DIRECT
field, which `can_type_form_rc_cycle`'s container buffer-walk
(`src/types/utils.yo`) sees, while `LinkedList` reaches its elements through a
`Node(T)` ref cell whose own registration the analysis decides separately.

## Root cause (first findings)

With the values inline (develop's layout) and with the value buffers (the fix's
layout) the result is the same, and the emitted C shows why:

- the `Node(<T>)` constructor emits `__yo_gc_register` and a `traverse_fn`;
- the `LinkedList(<T>)` constructor emits neither — its header is the small
  (16 B, cycle-incapable) one, so `can_type_form_rc_cycle` answered false for
  the instantiation at the constructor's emission, although a hand walk of
  `can_type_form_rc_cycle`'s arms over `LinkedList(LNode)` — `head : Option(Node)`
  re-rooted at the node, whose `next : Option(Self)` is a direct self-reference —
  says true. The `LNode` and `Node` cells are what `tracked_count()` reports;
  the list cells are never tracked, and the collector never walks
  `LNode -> list -> node -> element -> LNode`.

Which TypeValue copy the constructor emission asks (the instantiated
`LinkedList(LNode)` vs a merged-key or unresolved-generic twin) has not been
pinned down. The instantiation-identity family
(`issues/fixed/yo-self-specialization-signature-type-identity.md`,
`src/codegen/exprs/gc.yo`'s DIVERGENCE note) is the likely place to look.

## Fix direction

Make the constructor's `can_type_form_rc_cycle` ask and the runtime agree with
the structural walk: the list cell is a cycle root exactly when its element
type can reach a managed type. Then the `Node` `Trace` impl the move-only fix
adds (it visits `next`, `prev` and the element buffer) is already the correct
traversal.

## Test

The reproducer above, in `tests/cycle_collector.test.yo` beside the
`ArrayList(Self)` case: it fails on develop today and must pass once fixed.
