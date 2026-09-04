# `ArrayList` has no public buffer pointer, so six sites in `std/` read its `_`-private `_ptr` from other modules

**Status:** OPEN
**Severity:** papercut — nothing is wrong at runtime today; `ArrayList`'s buffer
representation is nevertheless part of three other modules' ABI, and no tool
would report a break.
**Found:** 2026-09-04, during the std-API audit re-measurement of the
`collections/*` row, while checking the premise of its "hide the pub
`ctrl`/`data`/… fields" item — that the `_` prefix provides hiding.

`ArrayList`'s heap buffer is `_ptr : ?(*(T))`
(`std/collections/array_list.yo:21`), underscore-prefixed as internal. It has no
public accessor: `extend_from_ptr(src : *(T), count : usize)`
(`std/collections/array_list.yo:515`) takes a raw pointer **in**, but nothing
hands one **out**. Every module that needs one therefore reaches across the
module boundary and reads `_ptr` directly.

## The sites

```
$ grep -rn '\._ptr' std --include='*.yo' \
    | grep -v 'std/collections/array_list.yo\|std/imm/'
std/collections/btree_map.yo:184:            self._entries._ptr,
std/collections/priority_queue.yo:172:            self._data._ptr,
std/string/string.yo:211:        al._ptr,
std/string/string.yo:1170:                    self_al._ptr,
std/string/string.yo:1173:                        other_al._ptr,
std/string/string.yo:2853:                al._ptr,
```

(`std/imm/vec.yo` and `std/imm/string.yo` declare their own `_ptr` and are not
part of this.)

`std/collections/priority_queue.yo:167-180` — `PriorityQueueIterPtr`'s `next`:

```rust
next : (fn(inout(self) : Self) -> Option(*T))(
  cond(
    (self._index >= self._data.len()) => .None,
    true =>
      match(
        self._data._ptr,              // ← ArrayList's private buffer
        .Some(ptr) => {
          element_ptr := ptr.add(self._index);
          self._index = (self._index + usize(1));
          .Some(element_ptr)
        },
        .None => .None
      )
  )
)
```

`std/collections/btree_map.yo:179-193` — `BTreeMapIterPtr`'s `next` is the same
expression against `self._entries._ptr`.

`std/string/string.yo` does it four times, and `:2851-2855` shows the asymmetry in
a single statement — it calls the public `extend_from_ptr` with a pointer it had
to steal:

```rust
buf := ArrayList(u8).with_capacity(n);
match(
  al._ptr,                              // ← no public way to ask for this
  .Some(ptr) => buf.extend_from_ptr(ptr, n),
  .None => ()
);
```

Three of those sites read `_length` too (`string.yo:212`, `:1157`, `:1158`) even
though the public `len()` returns exactly that.

## Why it is a defect

`ArrayList` cannot change how it stores its buffer without silently breaking
`BTreeMap`, `PriorityQueue` and `String`. A small-vector optimisation, an
offset-plus-base layout, or moving the length into the allocation would all
compile and then produce wrong pointers or dangling ones — the reach-ins are
plain field reads, so `yo check` reports nothing and there is no test that would
notice a stride change.

It also contradicts the premise the audit row is built on. The `_` prefix is a
convention; `.github/instructions/yo-design.instructions.md:534` states only the
enforceable half ("an underscore-private name must never appear in an
`export(...)` list"), and Yo's actual visibility mechanism is `export(...)`,
which operates on module-level names, not on struct fields. A field of an
exported type is readable from anywhere the type is. So the planned "hide the pub
`ctrl`/`data`/… fields" sweep on `HashMap`/`HashSet`/`LinkedList` will make those
modules *consistent*, but it must not be recorded as making them *encapsulated* —
these six lines are the proof that it cannot.

## Fix

Give `ArrayList` the accessor its `extend_from_ptr` already implies, and route
the six sites through it:

```rust
/// Raw pointer to the first element, or `.None` when the list has never
/// allocated. The pointer is invalidated by any operation that can grow or
/// move the buffer (`push`, `insert`, `reserve`, `extend*`, `drain`, `clear`).
as_ptr : (fn(self : Self) -> Option(*(T)))(self._ptr),
```

`as_ptr` matches Rust's `Vec::as_ptr` and keeps the same `Option` shape the call
sites already match on, so each reach-in becomes a one-token change
(`self._data._ptr` → `self._data.as_ptr()`) and the `_length` reads become
`len()`. The name is not underscore-prefixed because it is a real, documented
part of the API — an escape hatch with a stated invalidation contract, which is
exactly what the six callers need and what an `_`-prefixed name cannot honestly
be.

Two things NOT to do:

- Do not rebuild `PriorityQueueIterPtr` / `BTreeMapIterPtr` on `ArrayList.iter()`.
  That iterator yields elements **by value** (`Item : T`,
  `std/collections/array_list.yo:719`, `ArrayListIter` at `:653`), while these two
  yield `*T` so callers can mutate in place — `tests/collections/priority_queue.test.yo:224`
  ("PriorityQueue iter - mutate through pointer") and
  `tests/collections/btree_map.test.yo:201` ("BTreeMap iter - mutate values
  through pointer") both depend on it. Redirecting would silently change the
  public `Item` type of two exported iterators.
- Do not add an `_`-prefixed accessor (`_as_ptr`). It would move the violation
  rather than remove it: a cross-module call to an `_` name is the same
  convention break as a cross-module read of an `_` field.

## Regression test

There is no behavioural change to assert — the six call sites keep doing exactly
what they do now, and `tests/collections/priority_queue.test.yo:214-237`,
`tests/collections/btree_map.test.yo:191-210` and the `std/string` suite already
cover the paths. The check that the refactor is complete is the grep above
returning nothing outside `std/collections/array_list.yo` and `std/imm/`.

`tests/collections/array_list.test.yo` should gain a small direct test of the new
accessor so it is not dead-on-arrival public API: assert `.None` on a fresh list,
`.Some(p)` after a push with `p.*` equal to the pushed value, and that
`as_ptr().add(i).*` matches `get(i)` across a few elements.

## Breaking change

None. `as_ptr` is additive; the six edited call sites are all inside `std/`.
