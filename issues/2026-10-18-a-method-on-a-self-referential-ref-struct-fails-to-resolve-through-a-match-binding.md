# A method on a self-referential `ref(struct)` fails to resolve through a match binding

**Severity:** S2 — valid programs are rejected: calling a method on a
`ref(struct)` type whose fields mention `Self` reports
`E0610: No method "m" on T(...)` when the receiver is a `match` payload binding
reached inside another generic type's method; the same call on a directly
constructed value resolves.

**Status:** open. Found 2026-10-18 while fixing
`issues/fixed/2026-10-16-a-linkedlist-of-a-move-only-element-cannot-pop-or-clear.md`:
`std/collections/linked_list.yo` wanted a `_take_value` method on `Node(T)` and
had to stay with free functions instead. The OLD std already worked around the
same hole (`_node_value_ptr` was a free function), so this predates the
move-only work.

## Reproducer (v0.2.65 seed and the develop tree)

```yo
Plain :: (fn(comptime(T) : Type) -> comptime(Type))(
  ref(
    struct(
      value : T,
      next : Option(Self),
      prev : Option(Self)
    )
  )
);
impl(
  generic(T : Type),
  Plain(T),
  probe : (fn(self : &Self) -> usize)(usize(7))
);
LL :: (fn(comptime(T) : Type) -> comptime(Type))(ref(struct(head : Option(Plain(T)))));
impl(
  generic(T : Type),
  LL(T),
  pop : (fn(self : &mut Self) -> usize)(
    match(
      self.head,
      .None => usize(0),
      .Some(old_head) => old_head.probe()
    )
  )
);
main :: (fn() -> unit)({
  h := LL(i32)(head : .None);
  consume(h.pop());
});
export(main);
```

```text
error[E0610]: No method "probe" on Plain(i32): the type has no field or method with that name.
    --> ...  .Some(old_head) => old_head.probe()
```

Facts pinned by bisection:

- `next : Option(Self)` (or any field mentioning `Self`) is required: the same
  program with `next : i32` resolves.
- The indirection through the second generic type's method is required: calling
  `probe` on a directly constructed `Plain(i32)` value resolves even with the
  `Self` fields.
- Free functions work in the same position:
  `_probe(&old_head)` with `_probe :: (fn(generic(T : Type), node : &Plain(T)) -> usize)(...)`
  resolves and runs, which is the workaround std uses.
- A `Trace` impl on the same type is unaffected (trait impls resolve; plain
  methods do not).
- The failure is evaluator-side: `yo check` reports it, so nothing is silently
  swallowed here (a swallowed variant of the same shape DOES exist: when the
  call sits in a generic `Index`/`IndexMut` body, the specialization trial
  hides the E0610 and the C compiler then fails with
  `implicit declaration of function` — seen with the seed while iterating on
  the linked-list fix).

## Fix direction

The method-table lookup for the receiver's instantiated type inside the
specialization of the enclosing generic method apparently keys the impl on a
different TypeValue copy when the struct's fields mention `Self` (the
`Self`-bearing field makes the instantiation id differ from the declaration
id?). The instantiation-identity family
(`issues/fixed/yo-self-specialization-signature-type-identity.md`) is where to
look.

## Test

The reproducer above, reduced into `tests/method_resolution.test.yo` (or the
parser test's method-call table): fails before the fix, resolves after.
