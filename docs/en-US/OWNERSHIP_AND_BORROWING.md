# Ownership and Borrowing

Yo manages memory without a garbage collector and without hidden sharing.
Every value has one owner, the last use of a value moves it, a copy is either
a bitwise copy of a `Copy` type or an explicit `.clone()`, and the compiler
destroys a value when its owner goes away. References (`&T`, `&mut T`) let
code use a value without owning it; their types carry an **origin**, the set
of places they point into, and the compiler checks every use against it, as
Rust's borrow checker does. Two names reach one object only through `Rc(T)`
or `Arc(T)`, and the type says so.

This page is the user guide to those rules. Every complete example on it
compiles and runs; every rejected example is marked with the error code the
compiler reports. `yo explain <code>` prints the full text of a diagnostic.

## The model in one screen

- **Every value has one owner.** A local, a field, an element or a parameter
  owns what it holds. When the owner goes away, the value is dropped.
- **A binding is immutable unless it says `mut`.** `x := v` can be read,
  lent with `&` and moved. Reassigning it, lending it `&mut`, calling a
  `self : &mut Self` method on it or writing one of its fields needs
  `mut(x) := v` (E0917).
- **The last use of a value moves it.** `y := x`, passing `x` by value,
  storing it, capturing it and returning it move `x`. A later use is E0901.
- **Copies are explicit**, written `x.clone()`, except for `Copy` types
  (integers, floats, `bool`, references `&T`, and the types you
  `derive(T, Copy, Clone)`), which copy bit for bit.
- **References are spelled.** `x : &T` lends a value read-only, `x : &mut T`
  lends it exclusively, and the call site says the same thing: `f(&x)`,
  `f(&mut x)`. A reference is a value: it can be bound, returned, stored in a
  struct field, a tuple or an `Option`, and captured by a closure. Its type
  carries its origin, so the compiler knows what it points into.
- **Sharing is visible in the type.** `Rc(T)` (one thread) and `Arc(T)`
  (several threads) are the only reference-counted values. Their payload is
  read-only through the handle; shared mutation goes through `RefCell(T)`,
  `Mutex(T)` or an atomic inside it.

```yo
{ assert } :: import("std/assert");

Point :: struct(x : i32, y : i32);
derive(Point, Copy, Clone);
Token :: struct(id : i32); // neither Copy nor Clone: move-only

show :: (fn(p : &Point) -> i32)(p.x + p.y); // borrows
redeem :: (fn(t : Token) -> i32)(t.id); // takes ownership

main :: (fn() -> unit)({
  p := Point(x : i32(1), y : i32(2));
  q := p; // Copy: a bitwise copy, p stays usable
  s := show(&p); // lent read-only, p stays usable
  t := Token(id : i32(7));
  n := redeem(t); // t's last use: moved into redeem
  assert((q.x + s + n) == i32(11), "p was copied and lent, t was moved");
});
export(main);
```

## Ownership and moves

### Three kinds of type

| Kind | Which types | `y := x` while `x` is used later |
| --- | --- | --- |
| **`Copy`** | integers, floats, `bool`, `char`, `unit`, `str`, `&T`, function pointers; a struct, enum or newtype with `derive(T, Copy, Clone)`; tuples, arrays and records whose parts are all `Copy` | a bitwise copy |
| **explicit-copy** | implements `Clone` but not `Copy`: `String`, the collections, `Box(T)`, `Rc(T)` and `Arc(T)` handles, and types containing them | E0901; write `x.clone()` |
| **move-only** | implements neither `Copy` nor `Clone`, or implements `Drop`: `Token` above, a file, a lock, a thread handle, and any type holding one | E0901; there is no copy |

A type that is not `Copy` moves at its last use, whichever of the other two
kinds it is. The only difference is whether `x.clone()` exists.

### Moves happen at the last use

There is no move operator. A binding, a by-value argument, a store into a
field or element, a capture and a return each move a value that is not
`Copy`, and the compiler reports any use after the move:

```yo ignore
t := Token(id : i32(7));
r := redeem(t); // moved here
s := t.id; // error[E0901]: use of moved value: `t`
```

The help names the repair that fits the type: `derive(T, Copy, Clone)` for
plain data, `x.clone()` for an explicit-copy type, and `x : &T` in the callee
when the callee only reads.

### `Copy`

A named type copies implicitly only if it implements `Copy`, and `Copy`
requires `Clone`:

```yo
Point :: struct(x : i32, y : i32);
derive(Point, Copy, Clone);
```

- `derive(T, Copy)` without `Clone` is E0602: the compiler never writes the
  `Clone` impl for you.
- Every field must be `Copy`, and the type must not implement `Drop`.
- Tuples, arrays and records are `Copy` exactly when all their parts are.
- `String`, the collections, `Box`, `Rc`, `Arc` and every `Drop` type are
  never `Copy`.
- In generic code, `where(T <: Copy)` also gives `T <: Clone`.

Leaving `Copy` off plain data is a choice: a token that must stay unique, an
index into a table, or a large array can stay move-only.

### Explicit copies

`x.clone()` makes an independent copy. For `String` and the collections it
copies the buffer:

```yo
{ assert } :: import("std/assert");
{ String } :: import("std/string");

main :: (fn() -> unit)({
  mut(s) := String.from("hi");
  t := s.clone(); // an independent copy of the buffer
  s.push_str(" there");
  u := s; // s's last use: a move
  assert(t.len() == usize(2), "t did not see the push");
  assert(u.len() == usize(8), "u owns the written buffer");
});
export(main);
```

A shared handle is copied with `Rc.clone(&r)` or `Arc.clone(&a)`, which makes
a second handle to the same object ([Heap and sharing](#heap-and-sharing)).

### Move-only values and resources

A lock, a file, a socket or a thread handle cannot be copied. A type is
move-only when it implements `Drop`, implements neither `Copy` nor `Clone`,
or holds such a value in a field, payload, tuple, array or capture.

- Lending is free: `f : &File` and `m : &mut Mutex(T)` move nothing.
- A move-only type may still implement `Clone`; then `x.clone()` is its copy.
- To share a resource, say so in the type: `Arc(Mutex(T))`, `Rc(RefCell(T))`.

### No partial moves

A field that is not `Copy` cannot be moved out of a value (E0901): the field
is part of its holder. Instead:

- copy the field: `p.name.clone()`;
- move the whole value apart with `match`: `match(p, { name, age } => …)`;
- borrow it: `&p.name`, `match(&p.name, …)`.

### Mutable bindings

Where a binding is declared decides its lifetime; `mut(...)` around the name
decides whether it can be written:

| Spelling | Meaning |
| --- | --- |
| `x := v`, `(x : T) = v` | an immutable local or module-level binding |
| `mut(x) := v`, `(mut(x) : T) = v` | a mutable one |
| `x :: v` | a compile-time constant; a write at run time is E0918 |
| `thread_local(mut(st)) := v` | a thread-local mutable global |
| `.Some(mut(v))`, `{ a, mut(b) } := pair` | per name in a pattern or destructuring |

`mut` gates four writes: reassignment, a `&mut` lend (`&mut x`, `&mut x.f`, a
`&mut x` capture), a `self : &mut Self` call and a field or element write.
Writing through a reference is not writing the binding, so `a := &mut p.x;
a.* = i32(10)` needs `mut(p)`, not `mut(a)`. Parameters take no `mut`: a
body that writes one rebinds it, `mut(y) := x`.

A destructuring borrows its elements from the value it destructures, which
still drops them. A `mut(b)` binding there is a copy of its element, so an
element that holds an `Rc`, a `Box` or an owned buffer (a `String`, a
collection) cannot be bound `mut` (E0901): bind it without `mut` and copy it
explicitly (`mut(c) := b.clone()`), or `match` a value you own, which moves
its parts into the arm's bindings.

## Drops

A value is dropped when its owner stops holding it. A drop frees a buffer,
runs a `Drop` impl, or decrements an `Rc`/`Arc` count.

- **Scope end.** Owned locals that were not moved are dropped when their
  scope ends.
- **Early exit.** `return`, `break` and `unwind` drop what the exited scopes
  still own.
- **Reassignment.** `x = v` drops the old value of `x` right after the store.
  `old := (x = v)` keeps it instead.
- **Moved in some arms.** A value moved in some arms of a `cond` or `match`
  is dropped at the end of the others, so it is gone on every path. There is
  no run-time drop flag.
- **Loops.** The ways out of a loop (each `break`, and the condition turning
  false) must agree: a value moved on some of them and not on others is
  E0907. Record what the loop found and move the value once, after the loop.

### `Drop`

`Drop` runs exactly once, when the single owner drops the value: first
`drop`, then the fields.

```yo
{ println } :: import("std/fmt");

Fd :: struct(n : i32);
impl(
  Fd,
  Drop(
    drop : (fn(self : &mut Self) -> unit)({
      println(`close ${self.n}`);
    })
  )
);

main :: (fn() -> unit)({
  a := Fd(n : i32(1));
  b := Fd(n : i32(2));
  drop(a); // prints "close 1": a ends here
  println("end of main");
}); // prints "close 2": b is dropped at the end of its scope
export(main);
```

- A `Drop` type is move-only and never `Copy`.
- `drop` takes `self : &mut Self`: it may take a field out or reset it, and
  the fields that drop after it see what it left.
- `drop(x)` ends a value before its scope does: the prelude function moves
  `x` in, and the value is dropped when the call returns.
- Calling the destructor by hand (`x.drop()`) is E0915: it would run a second
  time, on a value that is still live.
- Unsafe code that owns a value through a raw pointer destroys it in place
  with `drop_in_place(p)`
  ([MEMORY_SAFETY.md](./MEMORY_SAFETY.md#destroying-a-value-in-place-drop_in_place)).

## Functions and parameters

### Three parameter modes

| Parameter | Meaning | The call |
| --- | --- | --- |
| `x : T` | by value: a copy for a `Copy` type, a move otherwise | `f(x)` |
| `x : &T` | a read-only reference | `f(&x)` |
| `x : &mut T` | an exclusive read-write reference | `f(&mut x)` |

- A by-value parameter is the callee's own value. The callee may write it
  (after rebinding it `mut`), store it or return it, and drops it otherwise.
- The mode is part of the function type: `fn(x : &i32)` and `fn(x : i32)` are
  different types.
- Receivers use the same spellings: `self : &Self` reads, `self : &mut Self`
  mutates, `self : Self` consumes the receiver. A method call lends or moves
  its receiver without a marker.

```yo
{ assert } :: import("std/assert");

Counter :: struct(n : i32);
impl(
  Counter,
  get : (fn(self : &Self) -> i32)(self.n),
  bump : (fn(self : &mut Self) -> unit)({
    self.n = (self.n + i32(1));
  }),
  finish : (fn(self : Self) -> i32)(self.n)
);

main :: (fn() -> unit)({
  mut(c) := Counter(n : i32(0));
  c.bump(); // the receiver is lent &mut
  v := c.get(); // the receiver is lent &
  last := c.finish(); // the receiver is moved: c is not usable afterwards
  assert((v == i32(1)) && (last == i32(1)), "bumped once");
});
export(main);
```

### The call site marks the borrow

A named place passed to a reference parameter carries the parameter's sigil:
`&x` for `x : &T`, `&mut x` for `x : &mut T`. A bare `x` passes by value.

```yo
{ assert } :: import("std/assert");

bump :: (fn(n : &mut i32) -> unit)({
  n.* = (n.* + i32(1));
});
peek :: (fn(n : &i32) -> i32)(n.*);

main :: (fn() -> unit)({
  mut(x) := i32(1);
  bump(&mut x); // x is 2
  y := peek(&x); // x stays usable
  assert((x == i32(2)) && (y == i32(2)), "written through the &mut");
});
export(main);
```

- A mismatch is an error, never a conversion (E0914): a bare `x` to a `&T`
  parameter, `&x` to a by-value one, `&x` to a `&mut T` one. The rule holds
  for `Copy` types too, so the marker always tells the truth.
- No marker is written for a method receiver, a temporary, a literal, a
  closure literal, an operator operand, or a reference passed whole (`f(r)`
  with `r : &T`).
- `&x` is only ever a reference. A raw pointer is `addr_of(x)`, in unsafe
  code.

```yo ignore
y := peek(x); // error[E0914]: Parameter "n" is a `&` borrow (`n : &T`): lend `x` with `&x`.
```

### `.*` reads and writes through a reference

A reference is a value of its own type, `&T`, not the `T` it points to.
`r.*` names the referent: `r.*` reads it, `r.* = v` writes it through a
`&mut T`. Operators never look through a reference, so `n + i32(1)` with
`n : &i32` is E0926; write `n.* + i32(1)`.

Field access, method calls and indexing look through references by
themselves: `r.x`, `r.len()` and `r(i)` need no `.*`. `&r` lends the
reference itself (a `&&T`); nothing converts it back to a `&T`.

### Operators

An operator's trait fixes how it takes its operands, so operands carry no
marker. `==` and the comparisons (`Eq`, `Ord`) borrow both operands, so
`a == b` keeps them. Arithmetic, bitwise and unary operators take their
operands by value: a `Copy` operand is copied and any other operand moves.

### Returning values

A function returns an owned value, which moves out to the caller. A
reference into a local of the function cannot be returned: the local's
storage ends with the call (E0912). Return the value, or a reference rooted
at one of the function's own reference parameters
([origins](#returning-and-storing-references-origins)).

```yo ignore
get :: (fn() -> i32)({
  x := i32(1);
  y := &x;
  return(y); // error[E0912]: Cannot return the local borrow `y`
});
```

## References

### Local borrows

`y := &place` borrows a place read-only, `y := &mut place` borrows it
exclusively. A place is a local, a parameter, or a field path rooted at one.

```yo
{ assert } :: import("std/assert");

Point :: struct(x : i32, y : i32);

main :: (fn() -> unit)({
  mut(p) := Point(x : i32(3), y : i32(4));
  a := &mut p.x;
  b := &mut p.y; // sibling fields borrow independently
  a.* = i32(10); // writes p.x
  b.* = i32(20); // writes p.y
  assert((p.x == i32(10)) && (p.y == i32(20)), "both writes landed in p");
});
export(main);
```

`&T` is `Copy`: `a := r; b := r;` gives two references to the same place.
`&mut T` is not `Copy`, so there is never more than one usable `&mut` to a
place. Binding a `&mut T` to a new name moves it: after `a := m` (or
`(a : &mut T) = m`), `a` holds `m`'s borrow until `a`'s last use, and a later
use of `m` is E0901. A tuple element, a generic `T` argument and a return
move it too. To keep `m`, reborrow it: `a := &mut m.*` borrows the place for
`a`'s life, and `m` is usable again after `a`'s last use. Passing a `&mut T`
binding to a `&mut T` parameter reborrows it for the call and leaves the
binding usable afterwards.

```yo
main :: (fn() -> unit)({
  mut(x) := i32(1);
  m := &mut x;
  a := &mut m.*; // a reborrow: m is usable after a's last use
  a.* = i32(2);
  m.* = i32(3);
  b := m; // a move: m is not usable after this
  b.* = i32(4);
});
export(main);
```

### A borrow lives until its last use

A reference is live from where it is made to its last use, not to the end
of its scope. While it is live, its place is **frozen**:

- under `&`: the place, every place inside it and every place containing it
  are neither written nor moved;
- under `&mut`: none of those places is accessed at all, except through the
  reference.

```yo ignore
mut(x) := i32(1);
y := &x;
x = i32(2); // error[E0911]: Cannot write `x` here: `y` borrows `x` with `&` and is still live
z := y.*; // ... because y is used here
```

Moving the write after `z := y.*` makes the program legal: `y` is dead by
then. A few more rules decide liveness:

- A loop that uses a reference keeps it live for the whole loop, because the
  next iteration uses it again.
- A reference made from another reference keeps its source live as long as
  itself.
- A value that holds a reference (a struct, a tuple, an `Option`, a closure)
  is live, and freezes what it borrows, until the value's own last use.
- Two references conflict only if one place is a prefix of the other.
  Sibling fields are independent: `&mut s.left` beside `&mut s.right`.
- A `&` reference through an `Rc` or `Arc` (`r := &h.x`) borrows the handle:
  `h` cannot be moved, reassigned or dropped while `r` lives.

### A `&` reference is read-only

Assigning through a `&T`, passing it to a `&mut T` parameter, calling a
`self : &mut Self` method on it, or taking `&mut` of a place under it is
E0908.

```yo ignore
reset :: (fn(p : &Point) -> unit)({
  p.x = i32(0); // error[E0908]: Cannot write `p.x`: `p` is a `&T` parameter, a read-only borrow of the caller's value.
});
```

### Two-phase borrows and argument overlap

A call's arguments are evaluated in order. A place an argument lends (`&x`,
`&mut x`, a borrowed receiver, an operand its operator borrows) is borrowed
from the moment that argument is evaluated until the call returns. So:

- A later argument may **read** the place: `xs.push(xs.len())` and
  `f(&mut a, a.len())` are accepted. This is Rust's two-phase borrow.
- A later argument may not **move** the place, assign to it or lend it
  `&mut` (E0910): in `sync(&mut a, eat(a))` the callee would see `a` after
  `eat` consumed it. Compute such an argument before the call:
  `n := eat(a.clone()); sync(&mut a, n)`.
- Two places one call lends may not overlap when one of them is lent `&mut`
  (E0910): `s.push_string(&s)`, `f(&mut p, &p.name)` and `swap(&mut x, &mut x)`
  are rejected, because the callee would write one while reading the other.
  Two `&` lends may overlap, and disjoint fields are independent
  (`f(&mut p.a, &p.b)`). Copy one side first:
  `t := s.clone(); s.push_string(&t)`.

### Re-pointing: the cursor walk

A local reference can be moved to another place with `cur = &place` or
`cur = &mut place`, so code can walk a linked structure without copying a
node. The sigil on the right decides: `cur = &mut n.next` re-points `cur`,
while `cur.* = v` writes through it.

```yo
{ assert } :: import("std/assert");

Node :: struct(value : i32, next : Option(Box(Self)));
List :: struct(head : Option(Box(Node)));

append :: (fn(list : &mut List, v : i32) -> unit)({
  cur := &mut list.head;
  while(cur.is_some(), {
    match(
      cur,
      .Some(n) => {
        cur = &mut n.next; // re-point to the next slot
      },
      .None => ()
    );
  });
  cur.* = .Some(Box.new(Node(value : v, next : .None))); // writes the tail slot
});

sum :: (fn(list : &List) -> i32)({
  (mut(total) : i32) = i32(0);
  cur := &list.head;
  while(cur.is_some(), {
    match(
      cur,
      .Some(n) => {
        total = (total + n.value);
        cur = &n.next;
      },
      .None => ()
    );
  });
  total
});

main :: (fn() -> unit)({
  mut(list) := List(head : .None);
  append(&mut list, i32(1));
  append(&mut list, i32(2));
  append(&mut list, i32(3));
  assert(sum(&list) == i32(6), "three nodes");
});
export(main);
```

- `match(cur, …)` matches through the reference: `n` is a reference into
  `cur`'s referent. While a binding of a `&mut` match is live, the matched
  reference is reached only through that binding; `cur = &mut n.next` is the
  one statement that may name `cur`, because it re-points the binding and
  does not touch what it points at. A write, read or call through `cur` (or
  a write to the place it borrows, `list.head`) while `n` is still used
  later is E0911.
- After the re-point, `cur` holds a place inside `n`, so a later use of `n`
  is E0911.
- The declared place stays frozen for the whole walk: `list.head = .None`
  mid-walk is E0911.
- A re-point to an unrelated place (`cur = &mut other.head`) is a new loan,
  checked as a declaration is: `other` needs `mut` for `&mut`, and `cur` may
  not be used after `other`'s scope ends.
- A re-point while a borrow derived from `cur`'s current target is still
  live is E0911.
- An `Rc` payload is read-only, so a `&mut` walk needs `Box` cells; a `&`
  walk works over `Option(Rc(Node))` as well.

### Module-level places

A module-level binding has no owner frame, and any function can name it.
A module-level binding declared without `mut` is immutable, so it may be lent
to any call. A `mut(G)` binding is reachable by every function a callee
calls, so lending it, or a place under it, to a call is E0916; copy it into a
local, lend the local and write it back. A local reference to a module-level
place may not be live across a call, and a reference through a module-level
place or a reference cell may not be live across an `await`.

## Returning and storing references: origins

An **origin** is the set of places a reference may point into. Every
reference type carries one: `&(T, p)` and `&mut(T, p)` spell it, and most
signatures leave it out (elide it) and let the compiler fill it in. Origins
are what let a reference leave the expression that made it: be returned,
stored in a struct, kept in a tuple or an `Option`, and still be checked.

### A function that returns a reference

A function may return a reference rooted at one of its own reference
parameters. The caller's argument stays frozen until the result's last use.

```yo
{ assert } :: import("std/assert");

Grid :: struct(a : i32, b : i32);

first :: (fn(g : &Grid) -> &i32)(&g.a);
first_mut :: (fn(g : &mut Grid) -> &mut i32)(&mut g.a);

main :: (fn() -> unit)({
  mut(g) := Grid(a : i32(1), b : i32(2));
  r := first_mut(&mut g); // g is frozen while r lives
  r.* = i32(10); // writes g.a
  v := first(&g).*;
  assert(v == i32(10), "written through the projection");
});
export(main);
```

When the result's origin is elided, it is every reference parameter, so the
caller freezes all of them. A signature names a narrower origin by writing a
parameter's name: `-> &(i32, s)` borrows from `s` only, and the call leaves the
other arguments free.

```yo
{ assert } :: import("std/assert");

Pair :: struct(a : i32, b : i32);

// The result borrows from `s` only.
pick :: (fn(s : &Pair, t : &Pair) -> &(i32, s))(cond((t.a > i32(0)) => &s.a, true => &s.b));

main :: (fn() -> unit)({
  p := Pair(a : i32(1), b : i32(2));
  mut(q) := Pair(a : i32(3), b : i32(4));
  r := pick(&p, &q);
  q.a = i32(0); // accepted: the result's origin is p, not q
  assert(r.* == i32(1), "r points at p.a");
});
export(main);
```

- The body is checked against the declared origin: yielding `&t.a` from
  `pick` is E0923.
- A call is checked from the signature alone, never from the callee's body.
- With the elided origin (`-> &i32`) the same `q.a = i32(0)` is E0911, because
  the result might point into `q`.
- A function that takes and returns references of unrelated parameters
  declares an origin parameter, `generic(p : Origin)`, and uses it in both
  positions: `fn(generic(p : Origin), a : &(T, p), b : &T) -> &(T, p)`.

Indexing is the same mechanism: `xs(i)` calls `Index.index(self : &Self, i)
-> &Output` for a read and `IndexMut.index_mut` for a write
([TRAITS.md](./TRAITS.md#projections)). `r := xs.index(i)` binds the
element reference; `xs` is frozen until `r`'s last use.

### Types that hold references

A struct or enum that holds a reference declares an origin parameter and
names it in the field's type. A value of it borrows that origin until the
value's last use.

```yo
{ assert } :: import("std/assert");
{ ArrayList } :: import("std/collections/array-list");

// A window into a list: the type carries the origin of the list it borrows.
View :: (fn(comptime(p) : Origin) -> comptime(Type))(
  struct(xs : &(ArrayList(i32), p), lo : usize, hi : usize)
);

total :: (fn(generic(p : Origin), v : View(p)) -> i32)({
  (mut(sum) : i32) = i32(0);
  (mut(i) : usize) = v.lo;
  while(i < v.hi, {
    sum = (sum + v.xs(i));
    i = (i + usize(1));
  });
  sum
});

main :: (fn() -> unit)({
  mut(xs) := ArrayList(i32).new();
  xs.push(i32(1));
  xs.push(i32(2));
  xs.push(i32(3));
  v := View(xs)(xs : &xs, lo : usize(1), hi : usize(3)); // lends xs until v's last use
  assert(total(v) == i32(5), "the window sums 2 + 3");
  xs.push(i32(4)); // v is dead: xs is free again
});
export(main);
```

- `View(xs)` fills the origin parameter with the place `xs`.
- A `xs.push(...)` while `v` is still used later is E0911.
- A value holding a `&mut` component is move-only.
- Tuples and `Option` hold references without a declaration:
  `t := (&x, &y)` and `Option(&i32).Some(&x)` borrow `x` (and `y`) for as long
  as they live.
- A type may never name its own fields as an origin (E0924): a value cannot
  contain a reference into itself, so moving a value never leaves a reference
  dangling and no pinning is needed. Store an index or an offset instead.

### Where a reference may not go

Some positions accept no reference, and a value that holds one there is
rejected:

- an element of a collection or the payload of a cell: `ArrayList(&T)`,
  `RefCell(&T)`, `Box(&T)` and an `Rc`/`Arc` payload are E0909;
- a module-level binding and an `extern` signature (E0909);
- a value moved to another thread: a reference is never `Send`, so a
  `Thread.spawn` closure that captures one is E0909.

## Element access and iteration

`xs(i)` is a place: it reads an element in read position and writes it on the
left of `=`, with no copy of the container.

```yo
{ assert } :: import("std/assert");
{ ArrayList } :: import("std/collections/array-list");

main :: (fn() -> unit)({
  mut(xs) := ArrayList(usize).new();
  xs.push(usize(10));
  xs(usize(0)) = usize(99); // writes the element in place
  v := xs(usize(0)); // a Copy element: copied out
  xs.push(xs.len()); // the argument reads xs before push lends it
  assert((v == usize(99)) && (xs(usize(1)) == usize(1)), "in place");
});
export(main);
```

- A `Copy` element is copied out by `xs(i)` and by `xs.get(i)`, which returns
  `.None` out of bounds. An element that is not `Copy` is copied with
  `xs.get_cloned(i)`, borrowed with `r := xs.index(i)`, or written in place
  with `xs.with(i, e => …)`.
- `&xs(i)` is not a place you can bind (E0927); borrow an element with
  `xs.index(i)` or through the borrowed `for` below.

### Iteration

- `for(&xs, x => …)` borrows `xs` and binds each element as a `&` reference.
  The body may read `xs` but not write it.
- `for(&mut xs, x => …)` borrows `xs` exclusively; `x` is a `&mut` reference
  into the element, so `x.* = …` writes it in place. The body cannot name `xs`
  at all (E0911): `xs.push(v)`, `xs.len()` and a nested loop over `xs` are
  rejected while the loop holds it.
- A plain `for(xs, x => …)` takes `xs` by value and consumes it.

```yo
{ assert } :: import("std/assert");
{ ArrayList } :: import("std/collections/array-list");

main :: (fn() -> unit)({
  mut(xs) := ArrayList(i32).new();
  xs.push(i32(1));
  xs.push(i32(2));
  for(&mut xs, x => {
    x.* = (x.* * i32(2)); // doubles each element in place
  });
  (mut(total) : i32) = i32(0);
  for(&xs, x => {
    total = (total + x.*);
  });
  assert(total == i32(6), "2 + 4");
});
export(main);
```

To grow or read a collection while walking it, walk its positions instead:
`for(xs.indices(), i => …)` with `xs(i)`. Maps take `for(&m, (k, v) => …)`
and `for(&mut m, (k, v) => …)`; the key is read-only in both. `HashSet` and
`PriorityQueue` have only the read walk, because writing an element in place
would break their order. A collection held in an `Rc` is walked through the
handle's payload, `for(&h.*, x => …)`.

## Pattern matching

A `match` takes its scrutinee the way a parameter takes its argument:

| Scrutinee | Bindings |
| --- | --- |
| an owned value or a temporary that is not `Copy` | consumed; the selected arm's bindings own their parts |
| `match(&x, …)` | `&` references; `x` stays usable |
| `match(&mut x, …)` | `&mut` references: `v.* = …` writes `x` |
| a reference `r` (`match(r, …)`) | references in `r`'s mode, into `r`'s referent |
| a `Copy` value | copies |

```yo
{ assert } :: import("std/assert");

Token :: struct(id : i32);

main :: (fn() -> unit)({
  o := Option(Token).Some(Token(id : i32(1)));
  a := match(&o, .Some(t) => t.id, .None => i32(0)); // borrows: o stays usable
  b := match(o, .Some(t) => t.id, .None => i32(0)); // consumes o
  mut(n) := Option(i32).Some(i32(2));
  match(
    &mut n,
    .Some(v) => {
      v.* = (v.* * i32(3)); // writes the payload in place
    },
    .None => ()
  );
  assert((a == b) && (n.unwrap_or(i32(0)) == i32(6)), "borrowed, consumed, written");
});
export(main);
```

- A later use of a consumed scrutinee is E0901, whose help names
  `match(&x, …)`.
- Guards see the bindings as references; the move happens when an arm is
  selected.
- A field, an element or a module-level binding that is not `Copy` cannot be
  matched by value (no partial moves): write `match(&x.f, …)`.
- `match(&r, …)` on a reference `r` is E0926: the marker is redundant, write
  `match(r, …)`.

## Closures

### Capture lists

A closure names what it captures, and how, in a list before its parameters:

| Entry | Meaning |
| --- | --- |
| `x` or `x : e` | a by-value field: a copy, or a move of an owning value |
| `&y`, `name : &place` | a read-only reference to a place |
| `&mut z`, `name : &mut place` | an exclusive reference to a place |
| `s2 : s.clone()`, `n : s.len()` | an ordinary by-value field computed at the literal |

```yo
{ assert } :: import("std/assert");

main :: (fn() -> unit)({
  mut(total) := i32(0);
  k := i32(10);
  (i32(1) .. i32(4)).for_each({ &mut total }(x) => {
    total.* = (total.* + x.*); // writes the caller's total
  });
  (add : Impl(Fn(x : i32) -> i32)) = ({ k }(x : i32) => (x + k)); // k is copied in
  assert((total == i32(6)) && (add(i32(1)) == i32(11)), "1 + 2 + 3, and 1 + 10");
});
export(main);
```

- The list is exhaustive: the body may name only the listed captures and
  module-level items. `{}()` captures nothing.
- A capture-list reference is judged as the same `&y` / `&mut z` argument
  would be: a `&mut` capture needs a `mut` place, and the places a closure
  borrows are frozen while the closure lives (E0910 for an access that
  conflicts with a capture).
- Without a list, a closure captures the locals its body names. Spell the
  list when the closure should borrow (`{ &y }`, `{ &mut z }`) or when a
  copy should be explicit (`{ s2 : s.clone() }`).
- A closure that holds a reference is checked like any value that holds one:
  it may be bound, called and lent, and returned only when what it borrows
  outlives the function. Returning it over a local, storing it in a `Dyn`,
  moving it into a by-value parameter that keeps it, or spawning it is E0909.
- A `&mut` capture makes the closure move-only.

### `Fn`, `FnMut`, `FnOnce`

| Trait | A call takes | A closure has it when its body |
| --- | --- | --- |
| `Fn` | `self : &Self` | only reads its captures |
| `FnMut` | `self : &mut Self` | writes a `&mut` capture or its own by-value state |
| `FnOnce` | `self` | moves a capture out |

- `Fn` implies `FnMut`, which implies `FnOnce`.
- An `FnMut` closure is called through a `mut` binding or an
  `f : &mut Impl(FnMut(…))` parameter. Its by-value captures are state kept
  across calls:

```yo
{ assert } :: import("std/assert");

main :: (fn() -> unit)({
  (mut(tick) : Impl(FnMut() -> i32)) = ({ n : i32(0) }() => {
    n = (n + i32(1)); // the closure's own state, kept across calls
    n
  });
  a := tick();
  b := tick();
  assert((a == i32(1)) && (b == i32(2)), "the state persists");
});
export(main);
```

- An `FnOnce` call consumes the closure, so a second call is E0901. Its body
  owns its capture list's by-value entries and may move one out; moving a
  capture out of an `Fn` or `FnMut` closure is E0913.

```yo
{ assert } :: import("std/assert");

Token :: struct(id : i32);
redeem :: (fn(t : Token) -> i32)(t.id);
run_once :: (fn(f : Impl(FnOnce() -> i32)) -> i32)(f());

main :: (fn() -> unit)({
  t := Token(id : i32(4));
  (once : Impl(FnOnce() -> i32)) = ({ t }() => redeem(t)); // moves the capture out
  n := run_once(once); // once is moved into run_once
  assert(n == i32(4), "called once");
});
export(main);
```

- std's non-escaping callbacks (`for_each`, `retain`, `RefCell.with`,
  `Mutex.with_lock`, the `Option` and `Result` combinators) take
  `&mut Impl(FnMut(…))`. APIs a closure escapes into (`Thread.spawn`, the
  `io.async` body) take an `FnOnce` by value.

## Heap and sharing

| Type | Meaning | A copy | Threads |
| --- | --- | --- | --- |
| `Box(T)` | a uniquely owned heap cell; for recursion and stable addresses | `Box.clone(&b)`, a deep copy | as `T` |
| `Rc(T)` | shared on one thread, counted | `Rc.clone(&r)`: a second handle to the same cell | never `Send` |
| `Arc(T)` | shared across threads, atomically counted | `Arc.clone(&a)` | `Send` and `Sync` when `T` is both |
| `Weak(T)`, `ArcWeak(T)` | a handle that does not keep the payload alive | `Weak.clone(&w)` | as its strong handle |

`Box.new(v)`, `Rc.new(v)` and `Arc.new(v)` move `v` into a new cell; an
`alloc : .Some(a)` argument places the cell in allocator `a`
([EXPLICIT_ALLOCATORS.md](./EXPLICIT_ALLOCATORS.md)).

### `Box`

```yo
{ assert } :: import("std/assert");

Tree :: enum(Leaf(v : i32), Node(l : Box(Self), r : Box(Self)));

sum :: (fn(t : &Tree) -> i32)(
  match(
    t,
    .Leaf(v) => v.*,
    .Node(l, r) => (sum(&l.*.*) + sum(&r.*.*)) // l.* is the Box, l.*.* its payload
  )
);

main :: (fn() -> unit)({
  t := Tree.Node(Box.new(Tree.Leaf(i32(1))), Box.new(Tree.Leaf(i32(2))));
  assert(sum(&t) == i32(3), "1 + 2");
});
export(main);
```

A `Box` is part of its owner's value: writing through it is a plain write,
and dropping the owner frees it.

### `Rc` and `Arc`

- Members forward through the handle: `r.n` reads the payload's field and
  `r.len()` calls the payload's method. `r.*` names the payload.
- A member both the handle and its payload have is E0616, which names both
  spellings: `Rc.clone(&r)` copies the handle, `r.*.clone()` the payload.
  `Box` works the same way: `Box.clone(&b)`.
- A cycle of `Rc` handles leaks, as in Rust: put a `Weak` on the back edge
  ([WEAK.md](./WEAK.md)). `--allocator debug` reports the leak.

### Writing through `Rc`: `RefCell`, `Rc.get_mut`, `Rc.make_mut`

The payload of an `Rc` or `Arc` is read-only through the handle, because
other handles may share it. A write through a plain handle is E0919, which
names the doors:

- `RefCell(T)` in the payload, for shared mutation on one thread: `with`
  lends the value `&T`, `with_mut` lends it `&mut T`, and a conflicting access
  while one runs panics;
- `Rc.get_mut(&mut h)`: `.Some(&mut T)` when `h` is the only handle, `.None`
  otherwise;
- `Rc.make_mut(&mut h)`: `&mut T` after moving `h` to a fresh cell (a clone of
  the payload) when the cell is shared;
- `Rc.try_unwrap(h)`: the payload by value when `h` is the only handle.

```yo
{ assert } :: import("std/assert");
{ RefCell } :: import("std/sync/refcell");

main :: (fn() -> unit)({
  count := Rc.new(RefCell(i32).new(i32(0)));
  other := Rc.clone(&count); // a second handle to the same cell
  other.with_mut(v => {
    v.* = (v.* + i32(1)); // checked at run time: no other access is running
  });
  assert(count.with(v => v.*) == i32(1), "both handles see the write");

  mut(h) := Rc.new(i32(1));
  a := Rc.clone(&h);
  Rc.make_mut(&mut h).* = i32(3); // shared: h moves to a fresh cell first
  assert((a.* == i32(1)) && (h.* == i32(3)), "a keeps the old value");
});
export(main);
```

`RefCell(T)` is `Send` when `T` is and never `Sync`; across threads the doors
are `Arc(Mutex(T))`, `Arc(RwLock(T))` and the atomics.

### `std/sync` values

`Mutex(T)`, `RwLock(T)`, `Cond`, `Barrier`, `Semaphore`, `WaitGroup`, `Once`,
`OnceCell(T)` and the `Atomic*` types are move-only values, as in Rust: a
copy is E0901, and every method takes `self : &Self`. Threads share one
through an `Arc`: create it with `Arc.new(...)`, give each thread its own
`Arc.clone(&...)`, and capture that clone by value.

```yo
{ assert } :: import("std/assert");
{ Mutex } :: import("std/sync/mutex");
{ Thread } :: import("std/thread");

main :: (fn() -> unit)({
  total := Arc.new(Mutex(i32).new(i32(0)));
  mine := Arc.clone(&total); // the spawned thread's handle
  t := Thread(unit).spawn({ mine }(io : Io) => {
    mine.with_lock(v => {
      v.* = (v.* + i32(1));
    });
  });
  t.join();
  assert(total.with_lock(v => v.*) == i32(1), "the thread's write is visible");
});
export(main);
```

`Channel(T)` holds an `Arc` of its queue: `ch.clone()` is another handle on
the same queue. See [THREAD_SAFETY.md](./THREAD_SAFETY.md).

### `Dyn(Trait)`

`Dyn(Trait)` is an unsized, type-erased value. It lives behind a pointer that
says who owns it: `Box(Dyn(Trait))` owns it, `Rc(Dyn(Trait))` shares it, and
`&Dyn(Trait)` borrows it. See [TRAIT_OBJECTS.md](./TRAIT_OBJECTS.md).

## Async and threads

### Futures

- A future is move-only. `io.await(f, io)` and `io.spawn(f, io)` consume it;
  a future cannot be awaited twice.
- The `io.async` body is a by-value `FnOnce`: it owns its captures.
- A future may borrow. A function whose future captures its `&`/`&mut`
  parameters returns a borrowing future; binding it freezes the lent places
  until the future's last use, as a local reference does:

```yo
{ assert } :: import("std/assert");

Counter :: struct(n : i32);
bump :: (fn(c : &mut Counter, io : Io) -> Impl(Future(unit, Io)))(
  io.async({ c : &mut c.* }(io : Io) => {
    c.n = (c.n + i32(1));
  })
);

main :: (fn(io : Io) -> unit)({
  mut(c) := Counter(n : i32(0));
  f := bump(&mut c, io); // f borrows c until its last use
  io.await(f, io); // a write of c before this line is E0911
  assert(c.n == i32(1), "the future wrote c");
});
export(main);
```

A borrowing future cannot be spawned or stored (E0909). The full rules are in
[ASYNC_AWAIT.md](./ASYNC_AWAIT.md).

### Threads: `Send` and `Sync`

- **`Send`: the value may be moved to another thread.** A value is `Send`
  when it reaches no `Rc`, no raw pointer and no type marked `!(Send())`.
- **`Sync`: the value may be read from several threads at once.** `Arc(T)`
  requires `T <: (Send, Sync)`; `Mutex(T)` requires `T <: Send` and is itself
  `Sync`.
- A reference to a place some frame owns, and any value holding one, is never
  `Send`.
- `Thread.spawn` takes an `FnOnce` by value, so a spawned closure moves its
  captures in.

See [THREAD_SAFETY.md](./THREAD_SAFETY.md) and
[PARALLELISM.md](./PARALLELISM.md).

## Known limits

The checker is conservative in a few places: it rejects some programs that
are safe. Each is an open issue:

- A borrow a closure captures lasts to the end of the closure binding's
  scope, not to the closure's last use: wrap the closure and its calls in a
  `{ …; }` block when the place is needed afterwards
  (`issues/2026-11-13-a-closures-capture-borrow-lasts-to-the-bindings-scope-end-not-its-last-use.md`).
- A re-point through a `match` binding keeps the binding and the cursor
  exclusive longer than needed: use the binding before the re-point, or put
  the arm that writes it before the arm that re-points
  (`issues/2026-11-21-a-re-point-through-a-match-binding-keeps-the-binding-and-the-cursor-exclusive-longer-than-needed.md`).
- A local reference to an immutable module-level binding is rejected across a
  call (`issues/2026-11-11-decision-18-rule-3-rejects-a-call-while-a-local-borrows-an-unmarked-module-level-binding.md`).

The checker also has known holes: safe programs it accepts that misuse
memory. They are compiler bugs, tracked as open issues with the highest
severity ([MEMORY_SAFETY.md](./MEMORY_SAFETY.md#what-this-doesnt-guarantee)).
Run tests under `--sanitize address` when a change leans on the borrow rules.

## Diagnostics

| Code | Meaning |
| --- | --- |
| E0901 | use of a moved value, or a copy of a move-only value |
| E0907 | a value moved on some ways out of a loop and not on others |
| E0908 | a write through a `&` reference |
| E0909 | a value holding a reference reaches a position that accepts no origin, or outlives what it borrows |
| E0910 | an access conflicts with a borrow a closure or future holds, or with a place an earlier argument of the same call lends; overlapping `&mut` arguments |
| E0911 | an access conflicts with a live reference |
| E0912 | a reference into a local of the function crosses the function boundary |
| E0913 | a closure's call trait is weaker than its slot's: it moves a capture out under `Fn`/`FnMut`, or writes its state under `Fn` |
| E0914 | a call-site marker does not match the parameter's mode |
| E0915 | an explicit destructor call (`x.drop()`); write `drop(x)` |
| E0916 | a `mut(G)` module-level binding, or a place under it, lent to a call |
| E0917 | a write to a binding declared without `mut` |
| E0918 | a run-time write to a `::` constant |
| E0919 | a write through an `Rc` handle |
| E0922 | an origin that no `generic(p : Origin)` declares |
| E0923 | a reference outside its declared origin |
| E0924 | a type or binding that names itself as an origin |
| E0926 | a reference read or written as a whole value without `.*` |
| E0927 | a local borrow of something that is not a place, such as `&xs(i)` |

## Coming from Rust

| Concept | Yo | Rust |
| --- | --- | --- |
| default parameter | by value: copy if `Copy`, else move | by value (move) |
| read-only borrow | `x : &T`, call `f(&x)` | `x: &T`, `f(&x)` |
| exclusive borrow | `x : &mut T`, call `f(&mut x)` | `x: &mut T`, `f(&mut x)` |
| dereference | `r.*`; fields, methods and indexing auto-dereference | `*r`; auto-deref on `.` |
| lifetimes | origins: `&(T, p)`, `generic(p : Origin)`, `-> &(T, xs)`; elided by default | `&'a T`, `<'a>` |
| a struct holding a reference | `View :: (fn(comptime(p) : Origin) -> comptime(Type))(struct(xs : &(T, p)))` | `struct View<'a> { xs: &'a T }` |
| implicit copy | `derive(T, Copy, Clone)` | `#[derive(Copy, Clone)]` |
| deep copy | `x.clone()` | `x.clone()` |
| move | implicit at the last use; E0901 after | implicit; error after |
| mutable binding | `mut(x) := v` | `let mut x = v` |
| shared ownership | `Rc(T)`, `Arc(T)`; `Rc.clone(&r)` | `Rc<T>`, `Arc<T>`; `Rc::clone(&r)` |
| dynamic borrow check | `RefCell(T)` with `with` / `with_mut` | `RefCell<T>` with `borrow` / `borrow_mut` |
| match on an owned value | consumes; `match(&x, …)` borrows | default binding modes |
| closure capture | capture list `{ x, &y, &mut z }` | `move` or inferred |
| trait object | `Box(Dyn(Trait))`, `Rc(Dyn(Trait))`, `&Dyn(Trait)` | `Box<dyn T>`, `Rc<dyn T>`, `&dyn T` |
| pinning | none needed: a value never holds a reference into itself | `Pin` |

## Further reading

- [MEMORY_SAFETY.md](./MEMORY_SAFETY.md): the safe-by-default contract, the
  unsafe opt-in and the audit tools.
- [THREAD_SAFETY.md](./THREAD_SAFETY.md): `Send`, `Sync` and the `std/sync`
  types.
- [ASYNC_AWAIT.md](./ASYNC_AWAIT.md): futures, borrowing futures and tasks.
- [TRAITS.md](./TRAITS.md#index-trait): projections and `xs(i)`.
- [WEAK.md](./WEAK.md), [ARC.md](./ARC.md), [TRAIT_OBJECTS.md](./TRAIT_OBJECTS.md).
- [ERROR_DIAGNOSTICS.md](./ERROR_DIAGNOSTICS.md): every diagnostic code.
- The design records: `plans/VALUES_BY_DEFAULT.md` (the model and its
  decisions) and `plans/backlog/REFERENCES_AND_ORIGINS.md` (origins).
