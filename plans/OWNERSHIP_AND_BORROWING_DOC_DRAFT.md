# Ownership and Borrowing

**Status: DRAFT (2026-10-13).** The replacement for
`docs/en-US/COMPILE_TIME_RC_WITH_OWNERSHIP_ANALYSIS.md`, promoted to
`docs/en-US/OWNERSHIP_AND_BORROWING.md` and `docs/zh-CN/` at
VALUES_BY_DEFAULT's V5, when the old page is deleted. The plans stay
authoritative; where this draft and a plan disagree, the plan wins and this
draft is fixed. Sections marked (planned: <phase>) describe design that has
not landed.

Tag legend: `V2b`, `V2c`, `V5` are phases of
[`plans/VALUES_BY_DEFAULT.md`](VALUES_BY_DEFAULT.md); `N1`–`N3` are phases
of [`plans/backlog/NON_ESCAPABLE_TYPES.md`](backlog/NON_ESCAPABLE_TYPES.md);
"Generation B" means the compiler accepts the feature in user code today and
`std/` adopts it once a released seed carries it.

---

## 1. The model in one screen

- **Every value has one owner.** A local, a field, an element or a parameter
  owns what it holds. When the owner goes away, the value is dropped.
- **The last use of a value moves it.** `y := x`, passing `x` by value,
  storing it, capturing it and returning it all move `x` when nothing uses
  `x` afterwards. A later use is error E0901.
- **Copies are explicit**, written `x.clone()`, except for `Copy` types
  (integers, floats, `bool`, and the types you `derive(T, Copy, Clone)`),
  which copy bit for bit with no ceremony.
- **Sharing is visible in the type.** Two names reach one object only
  through `Rc(T)` (one thread) or `Arc(T)` (several threads). These are the
  only reference-counted things in the language.
- **Borrows are spelled.** `x : &T` lends a value read-only, `x : &mut T`
  lends it exclusively, and the call site says the same thing: `f(&x)`,
  `f(&mut x)`.
- **Borrows are references carrying an origin** (planned: N1–N2). A
  borrow can be used, passed and (as a projection) returned from a
  function that received it today; once the origin phase lands it is a
  first-class type `&(T, p)` parameterized by a named set of places,
  storable anywhere those places are in scope. No Rust-style region
  lifetime appears in the language.

```yo
Point :: struct(x : i32, y : i32);
derive(Point, Copy, Clone);
Token :: struct(id : i32); // neither Copy nor Clone: move-only

show :: (fn(p : &Point) -> unit)(()); // borrows
redeem :: (fn(t : Token) -> i32)(t.id); // takes ownership

main :: (fn() -> unit)({
  p := Point(x : i32(1), y : i32(2));
  q := p; // Copy: a bitwise copy, p stays usable
  show(&p); // lent read-only, p stays usable
  t := Token(id : i32(7));
  n := redeem(t); // t's last use: moved into redeem
});
export(main);
```

**Where the language is today.** `Copy`, moves, by-value parameters, the
borrow sigils, call-site markers, local borrows, consuming `match`, capture
lists and `FnOnce` have landed. `String`, the collections and `Dyn` still
copy implicitly by sharing their buffer under a count, and `Rc`/`Arc`
handles still copy implicitly; both become explicit `.clone()` copies
(planned: V2b for `String`, collections and `Dyn`; V2c for `Rc`/`Arc`).
Until then a by-value parameter of those kinds receives a shared copy, and
the transitional `sink(x) : T` parameter forces a move; `sink` is removed
at the same phases (planned: V2b, V2c, V5).

## 2. Ownership and moves

### Three kinds of type

| Kind | Which types | `y := x` while `x` is used later |
| --- | --- | --- |
| **`Copy`** | integers, floats, `bool`, `char`, `unit`, raw pointers, `str` views, `fn` pointers; a struct, enum or newtype with `derive(T, Copy, Clone)`; tuples, arrays, anonymous records and closures whose parts are all `Copy` | a bitwise copy |
| **explicit-copy** | implements `Clone` but not `Copy`: `String`, the collections, `Box(T)`, `Dyn(Trait)`, `Rc(T)`/`Arc(T)` handles, and types containing them | E0901; write `x.clone()` |
| **move-only** | implements neither `Copy` nor `Clone`, or implements `Drop`; and any type holding such a value | E0901; there is no copy |

A type that is not `Copy` moves at its last use, whichever of the other two
kinds it is. The difference is only whether `x.clone()` exists.

(planned: V2b, V2c) Of the explicit-copy kind, only `Box(T)` and a plain
`Clone`-without-`Copy` type are checked today; `String`, the collections
and `Dyn` still copy implicitly until V2b and the `Rc`/`Arc` handles until
V2c (section 1).

### Moves happen at the last use

```yo
Token :: struct(id : i32);
keep :: (fn(t : Token) -> unit)(());

main :: (fn() -> unit)({
  a := Token(id : i32(1));
  b := a; // a is not used again: moved into b
  keep(b); // b's last use: moved into keep's parameter
});
export(main);
```

There is no move operator. The checker finds the move points (a binding, a
by-value argument, a store into a field, element or capture, a return) and
reports any use after one:

```yo ignore
t := Token(id : i32(7));
r := redeem(t); // moved here
s := t.id; // error[E0901]: use of moved value: `t`
// help: `t` has type `Token`, which is neither `Copy` nor `Clone`, so it is
//       move-only: give the type `derive(Token, Copy, Clone)` to copy it implicitly
```

The note names the repair that fits the type: `derive(T, Copy, Clone)` for
plain data, `x.clone()` for an explicit-copy type, and `x : &T` in the
callee when the callee only needed to read.

### `Copy`

A named type copies implicitly only if it implements `Copy`, and `Copy`
requires `Clone`:

```yo
Point :: struct(x : i32, y : i32);
derive(Point, Copy, Clone); // derive(Point, Copy) alone is an error naming this form
```

- The impl is checked: every field must be `Copy`, and the type must not
  implement `Drop`. A `String` field makes `derive(T, Copy, Clone)` an
  error naming that field.
- Tuples, arrays, anonymous records and closures are `Copy` exactly when all
  their parts are. A closure holding a `&mut` capture is never `Copy`.
- `Rc`, `Arc`, `Box`, `String`, the collections, `Dyn` and every `Drop`
  type are never `Copy`.
- In generic code, `where(T <: Copy)` also gives `T <: Clone`.
- A type that is `Copy` only for some arguments derives each trait under its
  own bound:

```yo
Pair :: (fn(comptime(T) : Type) -> comptime(Type))(struct(a : T, b : T));
derive(generic(T : Type), where(T <: Clone), Pair(T), Clone);
derive(generic(T : Type), where(T <: Copy), Pair(T), Copy); // Pair(i32) copies; Pair(String) clones
```

Leaving `Copy` off plain data is a choice, not an oversight: a type-state
token, an index that must stay unique or a large array can stay move-only.

### Explicit copies

`x.clone()` makes an independent copy. For `String` and the collections it
copies the buffer. A shared handle is copied with `Rc.clone(r)` or
`Arc.clone(a)`, which makes a new handle to the same object; a bare
`r.clone()` is ambiguous between the handle and the payload (section 10).

```yo ignore
t := s.clone(); // s and t are independent
```

(planned: V2b) Today a `String` or collection copied with `t := s` still
shares its buffer under a count, so the copy is not yet an error. From V2b
it moves at the last use and needs `.clone()` otherwise; a `yo fix` sweep
inserts the clones, and a redundant-clone lint removes those a move would
serve.

### Move-only values and resources

A lock, a file, a socket or a thread handle is a value that cannot be
copied. A type is move-only when it implements `Drop`, or implements
neither `Copy` nor `Clone`, or holds such a value in a field, payload,
tuple, array or capture.

- Lending is free: `f : &File` and `m : &mut Mutex(T)` move nothing.
- A move-only type may still implement `Clone`; then `x.clone()` is its copy
  (a channel `Sender` works this way).
- To share a resource, say so in the type: `Arc(Mutex(T))`,
  `Rc(Receiver(T))`.

### No partial moves

A field of a non-`Copy` type cannot be moved out of a value that stays
alive. The alternatives:

- copy the field: `x.field.clone()`;
- move the whole value and destructure it: `{ a, b } := x`;
- borrow it: `match(&x.field, …)`, `f(&x.field)`;
- (planned: V2b) `take(&mut x.field)`, which leaves the type's `Default`
  behind, or `replace(&mut x.field, v)`.

## 3. Drops

A value is dropped when its owner stops holding it. Nothing is counted
unless the value is an `Rc` or `Arc`: a drop frees a buffer, disposes a
resource, or decrements a shared handle.

- **Scope end.** Owned locals that were not moved are dropped when their
  scope ends.
- **Early exit.** `return`, `break` and `unwind` drop what the exited scopes
  still own.
- **Reassignment.** `x = v` drops the old value of `x`. For an
  explicit-copy or move-only value this happens right after the store, as
  in Rust; `old := (x = v)` keeps the old value instead.
- **Moved in some arms.** A value moved in some arms of a `cond` or `match`
  is dropped at the end of the others, so it is gone on every path. No
  run-time drop flag exists.
- **Loops.** The ways out of a loop (each `break`, and the condition
  turning false) must agree: a value moved on some of them and not on
  others is E0907. Record what the loop found and move the value once,
  after the loop.

### `Drop`

`Drop` runs exactly once, when the single owner's drop runs: first `drop`,
then the fields are dropped. (`Drop` is the renamed `Dispose`, decision 45;
an explicit call is E0915 in both spellings while the old one exists.)

```yo
Fd :: struct(n : i32);
impl(
  Fd,
  Drop(
    drop : (fn(self : &mut Self) -> unit)({
      // close self.n here
    })
  )
);
Holder :: struct(fd : Fd, tag : i32); // move-only: it holds a move-only field
```

- A `Drop` type is never `Copy`.
- `drop` takes `self : &mut Self`: it may take a field out or reset it
  (`self.inner = .None`), and the fields that drop after it read what it
  left. Calling the destructor by hand (`x.drop()`) is E0915: it would run
  a second time, on a value that is still live.
- To end a value before its scope does, call `drop(x)`: the prelude
  function moves `x` in and the value drops when the call returns; a later
  use of `x` is E0901.
- A resource that must keep a stable address (an OS mutex) keeps its state
  in a `Box` of a move-only struct: moving the owner moves the pointer, not
  the state.

## 4. Functions and parameters

### Three parameter modes

| Parameter | Meaning | C |
| --- | --- | --- |
| `x : T` | by value: a copy for a `Copy` type, a move otherwise | `T x` |
| `x : &T` | read-only borrow | `const T*` (a small `Copy` `T` may be passed as `T`) |
| `x : &mut T` | exclusive read-write borrow | `T*` |

- A by-value parameter is the callee's own value. Writing it is legal and
  changes nothing in the caller.
- The mode is part of the function type for every `T`: `fn(x : &i32)` and
  `fn(x : i32)` are different types.
- Receivers use the same spellings: `self : &Self` reads,
  `self : &mut Self` mutates, a plain `self` consumes the receiver.

```yo
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
  c := Counter(n : i32(0));
  c.bump(); // receiver lent &mut, with no marker
  v := c.get(); // receiver lent &
  last := c.finish(); // receiver moved: c is not usable afterwards
});
export(main);
```

### The call site marks the borrow

A named place passed to a borrow parameter carries the same sigil as the
parameter: `&x` for `x : &T`, `&mut x` for `x : &mut T`. A bare `x` passes
by value.

```yo
bump :: (fn(n : &mut i32) -> unit)({
  n = (n + i32(1));
});
peek :: (fn(n : &i32) -> i32)(n);

main :: (fn() -> unit)({
  x := i32(1);
  bump(&mut x); // x is 2
  y := peek(&x); // x stays usable
});
export(main);
```

(planned: NON_ESCAPABLE_TYPES N1) `n = (n + i32(1))` writes through the
`&mut` parameter today; once references are types, a whole-value read or
write through one is spelled `n.*` (section 5).

- A mismatch is an error, never a conversion: E0914. A bare `x` to a `&T`
  parameter names `&x`; `&x` to a by-value parameter names `x` or
  `x.clone()`. The rule holds for `Copy` types too, so the marker always
  tells the truth.
- Exempt, because nothing is kept: method receivers (`s.len()`),
  temporaries, literals and closure literals (`show(make_name())`), operator
  operands, and a `&` or `&mut` binding passed whole (it already holds a
  borrow).
- `&x` is only ever a borrow. A raw pointer is `addr_of(x)`, in unsafe code.
- `yo fix <path> --migrate markers` inserts missing markers.

```yo ignore
show(x); // error[E0914]: Parameter "n" is a `&` borrow (`n : &T`): lend `x` with `&x`.
```

### Operators

An operator's trait fixes its operands' modes, so operands carry no marker.
`==` and the comparisons (`Eq`, `Ord`) borrow both operands, so `a == b`
keeps them. Arithmetic, bitwise and unary operators take their operands by
value, as in Rust: a `Copy` operand is copied and a move-only one moves.
(planned: V2b) Once `String` is explicit-copy, `a + b` consumes `a`; keep it
with `a.clone() + b`. An impl writes exactly the trait's modes.

### Returning values

A function returns an owned value, which moves out to the caller. A local
borrow cannot be returned (E0912): read the value out first.

```yo ignore
f :: (fn() -> i32)({
  x := i32(1);
  y := &x;
  return(y); // error[E0912]: Cannot return the local borrow `y`
});
```

The one way to return a borrow today is a projection (section 6). Returning
values that hold references is planned (section 11).

## 5. Local borrows

### Binding a borrow

`y := &place` borrows a place read-only, `y := &mut place` borrows it
exclusively. The annotated form is `(y : &T) = &place`.

```yo
Point :: struct(x : i32, y : i32);
derive(Point, Copy, Clone);

main :: (fn() -> unit)({
  p := Point(x : i32(3), y : i32(4));
  a := &mut p.x;
  b := &mut p.y; // sibling fields borrow independently
  a = i32(10); // writes p.x
  b = i32(20); // writes p.y
});
export(main);
```

Today a bare assignment to a `&mut` binding writes through it (`a = v`).
(planned: NON_ESCAPABLE_TYPES N1) When references become types, a
whole-value read or write through a reference is spelled `a.* = v` and
`tmp := a.*`; `.field` and `.method()` keep auto-dereferencing.

### A borrow lives until its last use

A borrow's live range ends at its last use, not at the end of its scope.
While it is live, its place is frozen:

- under `&`: the place, any place inside it and any place containing it
  are neither written nor moved;
- under `&mut`: none of those places is accessed at all, except through the
  borrow.

```yo ignore
x := i32(1);
y := &x;
x = i32(2); // error[E0911]: Cannot write `x` here: `y` borrows `x` with `&` and is still live
z := y; // ... because y is used here
```

Moving the write after `z := y` makes the program legal: `y` is dead by
then. A loop that mentions a borrow keeps it live for the whole loop.

### Exclusivity is by place

Two borrows conflict only if one place is a prefix of the other. Sibling
fields are free (`&mut s.left` beside `&mut s.right`). Below an `Rc` or
`Arc` dereference the cell is the unit, because another handle may reach
it.

### A `&` borrow is read-only

Assigning through a `&` local borrow, passing it to a `&mut` parameter,
calling a writing method on it, or taking `&mut` of a place under it is
E0908.

The compiler enforces the rule for local `&` borrows and for every write
into a `&T` parameter's value: a field (plain data included), a nested
field, a fixed-array element or a `Box`'s payload, assigned, borrowed with
`&mut`, or passed to a `&mut` parameter the callee writes. A handle
reached or lent through a `&T` parameter (a `ref` object, an `Rc`, a std
collection: `h.xs.push(v)`) still writes the storage it shares with the
caller, until the V2b flip makes the collections values. Until
2026-10-17 a plain-data field write compiled and changed only the callee's
copy
(`issues/fixed/a-field-write-through-a-shared-borrow-parameter-is-accepted-and-lost.md`).

### Re-pointing: the cursor walk

A local borrow can be moved to a place reached from its own target, with
`cur = &place` or `cur = &mut place`. This walks a linked structure without
cloning a node:

```yo
Node :: struct(value : i32, next : Option(Box(Node)));
List :: struct(head : Option(Box(Node)));

append :: (fn(list : &mut List, v : i32) -> unit)({
  cur := &mut list.head;
  while(cur.is_some(), {
    match(
      cur,
      .Some(n) => {
        cur = &mut n.next; // re-point: the sigil on the right
      },
      .None => ()
    );
  });
  cur = .Some(box(Node(value : v, next : .None))); // no sigil: writes the tail slot (cur.* = … once references are types)
});
```

- "Reached from `cur`" means through field steps, a `Box` or `Rc`
  dereference, or a binding of a `match` over `cur`. A sibling root, a
  module-level place or a call result is rejected. (planned: V2b) A
  projection step joins the list.
- The declared place stays frozen for the whole walk: `list.head = .None`
  mid-walk is an error. A re-point while a borrow derived from the old
  target is live is E0911.
- A walk through `Box` cells costs nothing; a walk through `Rc` cells pins
  each cell it is in (one increment and one decrement per step).

### Argument overlap (planned: V2b)

A `&mut` argument, or a by-value argument that moves, may not overlap any
other argument of the same call; two `&` arguments may. So
`swap(&mut p.a, &mut p.b)` is accepted and `swap(&mut p.a, &mut p.a)` is
rejected. A closure argument overlaps every place it captures, and a method
receiver counts as an argument. Today the call-level rule covers a later
argument moving a place an earlier argument lends to the call
(`f(&mut a, eat(a))`, E0910); the overlap check is not yet on for value
roots.

### Module-level places

A module-level binding has no owner frame. A local borrow of one may not be
live across a call or an `await`, and a `&mut` argument into a module-level
container is rejected whatever the callee.

## 6. Element access and projections

### `xs(i)` is a place

`xs(i)` reads an element in read position and writes it on the left of `=`
or as a `&mut` receiver, with no copy of the container:

```yo
{ ArrayList } :: import("std/collections/array_list");

main :: (fn() -> unit)({
  xs := ArrayList(i32).new();
  xs.push(i32(10));
  xs(usize(0)) = i32(99); // writes in place
  v := xs(usize(0)); // a Copy element: copied out
});
export(main);
```

(planned: V2b) For a non-`Copy` element, `xs(i)` borrows and does not copy:
`get(i) -> Option(T)` exists only for `Copy` elements, `get_cloned(i)` is
the explicit copy, and `take(i)`, `swap(i, j)`, `pop`, `drain` and
`with(i, body)` give non-copying access. A local borrow of an element,
`e := &mut xs(i)`, is accepted from the same phase.

### Projections: functions that return a borrow

A function whose result is `&T` or `&mut T` is a projection. Its body
yields a place with the result's sigil, rooted at one of its own borrow
parameters; a `&mut` result needs a `&mut` parameter.

```yo
Grid :: struct(a : i32, b : i32);
derive(Grid, Copy, Clone);

first :: (fn(g : &Grid) -> &i32)(&g.a);
first_mut :: (fn(g : &mut Grid) -> &mut i32)(&mut g.a);
```

- The place must outlive the call: a local, a temporary, a by-value
  parameter or a module-level binding is rejected as the root.
- While a `&mut` projection is live, its base is exclusively borrowed.
- Indexing is a projection: `Index.index(self : &Self, idx) -> &Output`
  serves reads and `IndexMut.index_mut(self : &mut Self, idx) -> &mut Output`
  serves writes, both reached through the subscript `x(i)`. (std adoption
  planned: Generation B)
- (planned: V2b) Today a projection is reached only through the subscript;
  a direct call such as `first(&g)` is an error. Once the rest of the
  projection design lands, the result is a reference value: a receiver,
  an argument, an operand, the left of `=`, or a local binding — and,
  once N2 lets cells carry origin parameters, storable there too.

Two live `&mut` projections into one container are rejected even for
different indices: the checker reasons about places, not index arithmetic.
(planned: NON_ESCAPABLE_TYPES) The disjoint case is a single call returning
both, with the disjointness as a precondition:

```yo
get2_mut :: (fn(generic(T : Type), self : &mut ArrayList(T), i : usize, j : usize, requires(i != j, i < self.len(), j < self.len())) -> (&mut T, &mut T))(...);
```

The check stays at run time in every build, like a bounds check (the
verifier can remove it where it proves the caller's side), and the two
results may be live and written together.

## 7. Pattern matching

A `match` takes its scrutinee the way a parameter takes its argument.

| Scrutinee | Bindings |
| --- | --- |
| an owned value or a temporary of a non-`Copy` type | consumed; the selected arm's bindings own their parts |
| `match(&x, …)` | `&` borrows; `x` stays usable |
| `match(&mut x, …)`, or a `&mut` binding | `&mut` places: writing a binding writes `x` |
| a `&` binding (a `&T` parameter, `y := &place`) | `&` borrows |
| a `Copy` value | a copy |

```yo
Token :: struct(id : i32);

main :: (fn() -> unit)({
  o := Option(Token).Some(Token(id : i32(1)));
  a := match(&o, .Some(t) => t.id, .None => i32(0)); // borrows: o stays usable
  b := match(o, .Some(t) => t.id, .None => i32(0)); // consumes o
});
export(main);
```

- A later use of a consumed scrutinee is E0901 naming `match(&x, …)`.
- Guards see the bindings as borrows; the move happens when an arm is
  selected.
- Parts an arm does not bind (`_`, unlisted fields) are dropped when the arm
  is entered.
- A field, an element, a dereference or a module-level binding of a
  non-`Copy` type cannot be matched by value (no partial moves): write
  `match(&x.f, …)`.
- `yo fix <path> --migrate match-scrutinee` adds the `&` an older program
  needs.

### Patterns name the wrapper they look through

A pattern that reaches through an `Rc` or `Arc` names it:
`.Node(Rc(.Leaf(a)), _)`. Bindings inside `Rc(p)` and `Arc(p)` borrow,
because other handles may share the cell, and `(c := Rc(p))` binds the
cell itself. An `Arc` position accepts only the wrapper spelling.

- (planned: Generation B) An `Rc` position still matches its payload
  implicitly today; the implicit look-through is removed once `std/` and
  the compiler spell `Rc(p)`.
- (planned) A `Box` position gets the same `Box(p)` spelling, with bindings
  that follow the scrutinee's mode; today a pattern looks through a `Box`
  implicitly.

## 8. Closures

### Non-escaping and escaping

- A closure passed to an `f : &Impl(Fn(…))` parameter cannot outlive the
  call. This is how `for_each`, `with_lock` and loop bodies take their
  closures.
- A closure passed to a by-value parameter, bound to a local that outlives
  the call, stored, returned or spawned escapes, and owns its captures.
- A closure body does not write the captures it holds by value, and moves
  one out only as an `FnOnce` (below). State that changes goes through a
  `&mut` capture, an `Rc` capture or a `&mut` parameter.
- (planned) Without a capture list, a literal passed to an
  `f : &Impl(Fn(…))` parameter borrows its captures implicitly; today it
  copies or shares them.

### Capture lists

A record before the parameters lists the captures and their modes:

```yo
main :: (fn() -> unit)({
  total := i32(0);
  k := i32(10);
  (i32(1) .. i32(3)).for_each({ &mut total }(x : i32) => {
    total = (total + x); // writes the caller's total
  });
  (add : Impl(Fn(x : i32) -> i32)) = ({ k }(x : i32) => (x + k)); // k copied in
});
export(main);
```

| Entry | Meaning |
| --- | --- |
| `x` or `x : e` | a by-value field: a copy, or a move of an owning value at its last use |
| `&y`, `name : &place` | a read-only borrow of a place |
| `&mut z`, `name : &mut place` | an exclusive borrow of a place |
| `s2 : s.clone()`, `n : s.len()` | an ordinary by-value field |

- The list is exhaustive: the body may name only the listed captures and
  module-level items. `{}()` captures nothing.
- A borrow names a place rooted at a local binding: no temporary, no
  module-level binding, nothing through an `Rc`/`Arc` dereference. To use
  a place inside an `Rc`, capture the handle (`{ &r }`) and derive
  `r.*.items` in the body.
- A closure holding a borrow is second-class today: it can be bound,
  called and lent, but returning it, storing it, putting it in a `Dyn`,
  passing it to a by-value parameter or spawning it is E0909 (from N1 the
  restriction restates as the no-origin positions of section 11; a lent
  `Impl(Fn(...))` slot stays the non-escaping form). A `&mut` capture
  also makes it move-only.
- The places a closure borrows are frozen while it lives (E0910). Today the
  freeze lasts to the end of the binding's scope; ending it at the
  closure's last use is planned (Generation B). (std adoption planned:
  Generation B)

### `Fn`, `FnMut`, `FnOnce`

| Trait | The call takes | A closure gets it when its body |
| --- | --- | --- |
| `Fn` | `self : &Self` | only reads its captures |
| `FnMut` (planned: NON_ESCAPABLE_TYPES N1) | `self : &mut Self` | writes a `&mut` capture or its own state |
| `FnOnce` | `self` | moves a capture out |

- `Fn` implies `FnMut`, which implies `FnOnce`.
- Calling a closure is a receiver call and is never marked: an `Fn` call
  borrows it, an `FnOnce` call consumes it, so a second call is E0901.
- Passing a closure is an ordinary argument: `apply(&f, x)` lends it to an
  `f : &Impl(Fn(…))` parameter; a bare `keep(f)` moves it into a by-value
  one.
- An `FnOnce` body owns its capture list's by-value entries; moving an
  implicit capture out, or moving out of a capture in an `Fn` closure, is
  E0913.

```yo
Token :: struct(id : i32);
run_once :: (fn(f : Impl(FnOnce() -> i32)) -> i32)(f());

main :: (fn() -> unit)({
  t := Token(id : i32(4));
  (once : Impl(FnOnce() -> i32)) = ({ t }() => {
    u := t; // moves the capture out: only FnOnce allows it
    u.id
  });
  n := run_once(once); // once is moved into run_once
});
export(main);
```

- Only APIs a closure escapes into take `FnOnce` by value (`Thread.spawn`,
  the `io.async` body). Non-escaping call-once APIs (`Option.map`,
  `unwrap_or_else`) keep `&Impl(Fn(…))`, so their bodies cannot move a
  capture out.
- (planned: NON_ESCAPABLE_TYPES N1) Until `FnMut` lands, a `&mut` capture
  writes through its pointer under an `Fn` call, as in the capture-list
  example above. Afterwards that closure is an `FnMut`, the write is spelled
  `total.* = (total.* + x)`, and repeated-call slots (`for_each`,
  `sort_by`, `retain`, the `with_lock` bodies) take `Impl(FnMut(…))`.

## 9. Iteration

- `for(&xs, x => …)` borrows `xs` and binds each element read-only.
- `for(&mut xs, x => …)` borrows `xs` exclusively; `x` is a `&mut` place
  into the element, so a write through it lands in the collection (the
  write-through spelling becomes `x.* = …` once references are types,
  planned: NON_ESCAPABLE_TYPES N1).
- A plain `for(xs, x => …)` takes `xs` by value.

```yo
{ ArrayList } :: import("std/collections/array_list");

main :: (fn() -> unit)({
  xs := ArrayList(i32).new();
  xs.push(i32(1));
  xs.push(i32(2));
  for(&mut xs, x => {
    x = (x * i32(2)); // doubles each element in place
  });
  (total : i32) = i32(0);
  for(&xs, x => {
    total = (total + x);
  });
});
export(main);
```

Growing or shrinking a collection while a borrowed `for` walks it panics
at run time today; collect the changes and apply them after the loop.
(planned: NON_ESCAPABLE_TYPES N2) For a container held by value, the same
mistake becomes a compile error (E0911).

(planned: V2b) Post-V2b iteration over a uniquely owned container is the
borrowed `for`, or an index cursor: `xs.indices()` returns a `Copy` range
and `xs(i)` is re-derived each step, so growth mid-walk is a bounds error,
not undefined behaviour. `xs.into_iter()` consumes; a chain that must own
its source writes `xs.clone().into_iter()`. (planned: NON_ESCAPABLE_TYPES
N3) Borrowing iterators (`iter(self : &Self)` returning a cursor that holds
`&xs`) and lazy adapter chains over a borrowed container follow.

## 10. Heap and sharing

| Wrapper | Meaning | A copy | Threads |
| --- | --- | --- | --- |
| `Box(T)` | a uniquely owned heap cell, no count; for recursion and stable addresses | `b.clone()`, deep | as `T` |
| `Rc(T)` | shared, one thread, counted | `Rc.clone(r)`: a new handle to the same object | not `Send` |
| `Arc(T)` | shared across threads, atomically counted; mutation through `Mutex`/atomics | `Arc.clone(a)` | `Send` and `Sync` when `T` is both |

The constructors are `box(v)`, `rc(v)` and `arc(v)`; each moves `v` into a
new cell. `box(v, alloc : .Some(a))` places the cell in allocator `a`.
`ref_count(x)` reads the count of an `Rc` or `Arc` (a debugging read) and is
an error on anything else.

### `Box`

```yo
Tree :: enum(Leaf(v : i32), Node(l : Box(Self), r : Box(Self)));

sum :: (fn(t : &Tree) -> i32)(
  match(
    t,
    .Leaf(v) => v,
    .Node(l, r) => (sum(&l.*) + sum(&r.*)) // l.* is the payload place
  )
);

main :: (fn() -> unit)({
  t := Tree.Node(box(Tree.Leaf(i32(1))), box(Tree.Leaf(i32(2))));
  n := sum(&t); // 3
});
export(main);
```

(planned: NON_ESCAPABLE_TYPES N1) The `.Leaf(v) => v` arm reads through the
`&` binding today; once references are types, nothing coerces and the
whole-value read is spelled `v.*`.

`Box(T)` is move-only exactly when `T` is; otherwise `Box.clone(b)` is a
deep copy. Writes through a `Box` are plain writes, because its owner is
unique. (std adoption planned: Generation B)

### `Rc` and `Arc`

- Members forward through the handle: `r.n` reads the payload's field and
  `r.push(x)` calls the payload's method. `r.*` names the payload.
- A member both the wrapper and its payload have is an error (E0616) that
  names both spellings. The common case is `clone`: `Rc.clone(r)` copies the
  handle, `r.*.clone()` copies the payload.
- An `Arc` payload is never written in safe code; mutation goes through a
  `Mutex`, `RwLock` or atomics inside it.
- (planned: V2c) Copying a handle needs `Rc.clone(r)`; today `r2 := r`
  still shares the cell implicitly.

### Writing through `Rc`, and `RefCell` (planned: V1 write-site work)

A plain write through an `Rc` compiles only where the compiler proves no
conflicting borrow can be live, and is then an ordinary write with no
run-time check. A write the compiler proves conflicting is an error; one it
cannot decide (through a `Dyn`, a function value, an unrelated second
handle) is an error naming the two repairs: restructure so the proof goes
through, or put the payload in a `RefCell(T)`.

`RefCell(T)` is the one spelling of a dynamic exclusivity check. It panics
on a conflicting borrow, as Rust's does, and exposes closures and
expression-scoped projections, never a guard value:

```yo ignore
counter := rc(RefCell(i32)(0));
counter.with_mut(v => {
  v.* = (v.* + 1);
});
n := counter.with(v => v.*);
counter.get_mut().* = 5; // expression-scoped: the mark ends with the statement
```

Binding `r := cell.get_mut()` is an error naming `with_mut`. `RefCell(T)` is
`Send` when `T` is and never `Sync`; `Arc(RefCell(T))` is rejected, and the
cross-thread forms stay `Arc(Mutex(T))` and `Arc(RwLock(T))`.

### `Dyn(Trait)`

`Dyn(Trait)` is an owned, type-erased value in a heap cell. `dyn(v)` moves
`v` in; the erasure is always spelled, never implicit.

- It is explicit-copy when the trait provides `Clone` (`Dyn(Trait, Clone)`)
  and move-only otherwise. Sharing a trait object is `Rc(Dyn(Trait))` or
  `Arc(Dyn(Trait, Send))`. (planned: V2b) Today a `Dyn` copy still shares
  its cell under a count.
- (planned) A closure flowing into a `Dyn(Fn(…))` slot is spelled `dyn(f)`
  at every site; a bare `f` there becomes a type error.
- (planned: NON_ESCAPABLE_TYPES N1) A borrowed trait object, with no
  allocation, is `&Dyn(Trait)`, made by `dyn(&v)` or by lending an owned
  `Dyn` (`&d`). It follows the reference rules (until N2, the
  second-class ones). Narrowing
  `&Dyn(A, B)` to `&Dyn(A)` is `upcast(r, Dyn(A))`.

### Cycles

Only `Rc` cells whose payload can reach another `Rc` are tracked by the
cycle collector, which is thread-local and non-atomic. `Box` trees, `String`
and collection buffers are part of their owner's value and are never
tracked. An `Arc` payload must be `Acyclic`, so an `Arc` cannot close a
cycle. See [`CYCLE_COLLECTION.md`](../docs/en-US/CYCLE_COLLECTION.md).

## 11. References as values (planned: NON_ESCAPABLE_TYPES N1–N3)

Today a borrow lives in a parameter, a local binding, a capture or a
projection result. The origin phase makes `&T` and `&mut T` **types** —
first-class, parameterized by an origin: a named set of places, declared
in the signature's `generic(p : Origin)` clause and written as a trailing
argument of the reference types, `&(T, p)` / `&mut(T, p)`. Elision is
allowed and is a default the checker still verifies, never inference it
trusts.

- `&T` is `Copy`; `&mut T` is not. Passed to a `&mut T` parameter it is
  reborrowed; passed to a generic `T` it moves.
- `.*` reads or writes the whole value (`x.* = y.*`); operators and bare
  assignment never dereference; `.field` and `.method()` do.
- `impl(&T, Trait(…))` is distinct from `impl(T, Trait(…))`.
- There is no `&String` to `str` coercion, and no other deref coercion.

### Where a reference may live (N2)

A reference may be a component of anything laid out inline (a struct field,
an enum payload, a tuple or array element, `Option(&T)`), and — from N2 —
the payload of a `Box` or `RefCell`: the containing type carries the
origin parameters, which must be in scope wherever it goes. The positions
that accept no origin parameters at all are `Send` values and threads,
spawned tasks, `extern` signatures, module-level bindings and a `Dyn`
payload (initially) — E0909. A type may never name its own fields and a
binding's type never its own place, so a value cannot contain a pointer
into itself (section 14's pinning row).

```yo
View :: (fn(comptime(T) : Type) -> comptime(Type))(
  struct(xs : &ArrayList(T), lo : usize, hi : usize)
);
StrArg :: enum(Borrowed(s : &String), Owned(s : String));
```

Building a `View(T)(xs : &xs, lo : lo, hi : hi)` lends `xs` until the
view's last use. A `&mut` component makes the value move-only.

- A value holding a borrow of a module-level binding may not be live
  across a call or an `await`, as a local borrow of one may not.

### Returning references: the origin in the result type (N1)

A function may return a reference-holding value when every origin in its
result type names an origin parameter or one of its reference-typed
parameters' places (a by-value parameter contributes its type's origins,
never its own place — that slot is the callee's frame, E0912's rule); the
caller freezes those places until the result's last use.

```yo ignore
// borrows a only: r is declared, and the result names it (b's elided origin is a fresh, unrelated one)
pick :: (fn(generic(r : Origin), a : &(ArrayList(u8), r), b : &ArrayList(u8)) -> View(u8, r))(...);
// the item shares the origin the cursor carries, not the cursor: two items may be live at once
next :: (fn(generic(T : Type, p : Origin), self : &mut Cursor(T, p)) -> Option(&(T, p)))(...);
```

Elided, a result's origin is the union of the reference-holding parameters
(the conservative reading: an elided `next` lends the cursor, so std's
`Iterator` spells the origin). A call is checked from the signature alone,
never from the callee's body.

### Containers of references (N2)

`ArrayList(&(T, p))` and other buffer containers over a reference are
legal, and their origin union is declared up front:

```yo ignore
out := ArrayList(&(View(u8), self))(...); // may ever hold views rooted at self
out.push(self.text.view(r));              // accepted: the pushed origin is a subset
both := ArrayList(&(T, (x, y)))(...);     // two roots, declared
both.push(&z);                            // error naming {x, y} and {z}; yo fix widens
```

(N3) std's entry API, guards, parser remainders and the `FnMut` slots
follow on the next seed. `Rc(T)` stays read-only, like Rust's, and no
origin crosses an `Rc`/`Arc` dereference: hold the handle and re-derive
the place at each use. Shared mutation keeps decision 46's doors —
`RefCell(T)` (the one spelling of the runtime exclusivity check),
`Rc.get_mut`, `Rc.make_mut` — and a `RefCell` payload may hold a
reference, with the marks governing mutation and the origin governing
the borrow.

## 12. Async and threads

### Futures

- **A future is move-only.** `io.await(f, io)` and `io.spawn(f, io)`
  consume `f`, and `io.state(f)` borrows. A future cannot be awaited twice;
  a result several tasks need is joined once and shared as `Rc(T)` or sent
  through a channel.
- **The `io.async` body is a by-value `FnOnce`**, so it owns its
  captures. An implicit capture that the body moves out is E0913; list it
  (`io.async({ f }(io : Io) => io.await(f, io))`).
- **A future may borrow, and is then second-class today.** A function whose
  returned future captures one of its `&`/`&mut` parameters returns a
  borrowing future. It may be the direct operand of `io.await`, or be
  returned when every borrow is rooted at the returning function's own
  borrow parameters; binding it to a local, storing it or spawning it is
  E0909. This is what lets `Stream.next(self : &mut Self, io)` exist.
  (planned: N3) The future's type carries its origins (`Future(T, p)`),
  forwarding works, and what stays E0909 narrows to the no-origin
  positions — spawn and `Send`.
- A borrowing future may not borrow through an `Rc`/`Arc` dereference: own
  the value in the task, or share `Rc(Mutex(S))`.
- A `JoinHandle` is move-only: `join(self, io)` consumes it, and a dropped
  handle detaches its task. (std adoption planned: Generation B)
- (planned: V3 async A4) `timeout` and a two-way `select` accept borrowing
  futures.

The async runtime stays single-threaded.

### Threads: `Send` and `Sync`

- **`Send`: the value may be moved to another thread.** A value is `Send`
  when it reaches no `Rc`, no raw pointer and no type marked `!(Send())`.
  Moving a uniquely owned buffer hands over its only owner.
- **`Sync`: copies of the value may be read from several threads.**
  `Arc(T)` requires `T <: (Send, Sync)`; `Mutex(T)` requires `T <: Send` and
  is itself `Sync`.
- A borrow, and anything holding one, is never `Send`.
- `Thread.spawn` takes an `FnOnce` by value, so a spawned closure moves its
  captures in.
- (planned: V2b) `Channel(String)` and `Arc(ArrayList(T))` become legal
  once `String` and the collections are uniquely owned.

## 13. Diagnostics

`yo explain <code>` prints the full text and an example for each code.

| Code | Meaning |
| --- | --- |
| E0009 | a deleted spelling: the old mode words (`imm(x)`, `mut(x)`, `inout(x)`, …); the message names `x : &T` / `x : &mut T`, and `yo fix <path> --migrate borrow-spelling` rewrites them |
| E0616 | a member both a wrapper and its payload have; write `Rc.clone(r)` or `r.*.clone()` |
| E0901 | use of a moved value; the note names `derive(T, Copy, Clone)`, `x.clone()`, `match(&x, …)` or `x : &T` |
| E0907 | a value moved on some ways out of a loop and not on others |
| E0908 | a write through a `&` borrow |
| E0909 | a second-class value escapes: a borrowing closure or future returned, stored, put in a `Dyn` or spawned; from N2 a reference whose origins cannot follow it into the position (a `Send` value, a spawn, an `extern` signature, a module-level binding, a `Dyn` payload) |
| E0910 | an access conflicts with a borrow a closure or future holds; a later argument moves a place an earlier argument lends to the call; (from N1) two `&mut` arguments of one call with intersecting origins |
| E0911 | an access conflicts with a live local borrow, or a re-point while a derived borrow is live; (planned: V2b) overlapping call arguments; (from N1) an access conflicting with a live origin; (from N2) a push outside a container's declared origin union |
| E0912 | a local borrow crosses the function boundary |
| E0913 | a closure moves a capture out where its call cannot consume it |
| E0914 | a call-site marker does not match the parameter's mode |
| E0915 | an explicit destructor call (`x.drop()`); write `drop(x)` to end the value early |

## 14. Coming from Rust or Swift

| Concept | Yo | Rust | Swift |
| --- | --- | --- | --- |
| default parameter | by value: copy if `Copy`, else move | by value (move) | borrowed |
| read-only borrow | `x : &T`, call `f(&x)` | `x: &T`, `f(&x)` | default |
| exclusive borrow | `x : &mut T`, call `f(&mut x)` | `x: &mut T`, `f(&mut x)` | `inout`, `f(&x)` |
| implicit copy | `derive(T, Copy, Clone)` | `#[derive(Copy, Clone)]` | every struct |
| deep copy | `x.clone()` | `x.clone()` | implicit copy-on-write |
| move | implicit at last use; E0901 after | implicit; error after | `consume` |
| shared ownership | `Rc(T)`, `Arc(T)`; `Rc.clone(r)` | `Rc<T>`, `Arc<T>`; `Rc::clone(&r)` | classes |
| dynamic borrow check | `RefCell(T)` (planned) | `RefCell<T>` | exclusivity enforcement at run time |
| lifetimes | none: references carry origins — declared place sets, `&(T, p)` with checked elision (planned N1) | named lifetimes | none (`~Escapable`) |
| match on an owned value | consumes; `match(&x, …)` borrows | default binding modes | copies |
| closure capture | capture list `{ x, &y, &mut z }` | `move` or inferred | capture list `[x]` |
| trait object | `Dyn(Trait)` (owned), `&Dyn(Trait)` (planned) | `Box<dyn T>`, `&dyn T` | existential `any P` |
| pinning | none needed (planned N1): a type may never borrow from itself, so moving a value never dangles what it contains | `Pin` | none |

## 15. What happened to compile-time reference counting

Before this model, every struct value carried hidden shared buffers: an
assignment, a constructor argument, a return or a block tail inserted a
count increment (`___dup`), and an optimizer cancelled pairs of increments
and decrements it could prove redundant. Parameters borrowed by default, and
a `sink` parameter forced a transfer. That machinery is described in
[`COMPILE_TIME_RC_WITH_OWNERSHIP_ANALYSIS.md`](../docs/en-US/COMPILE_TIME_RC_WITH_OWNERSHIP_ANALYSIS.md)
and `plans/VALUES_BY_DEFAULT.md` §3.14.

Under unique ownership the hidden copies are gone, and so are the rules that
inserted them and the pass that cancelled them. What remains is ordinary:
scope-end drops, the reassignment drop, use-after-move (E0901/E0907), and
real counts only on `Rc` and `Arc` cells, plus the cycle collector for
`Rc`. A drop now frees a buffer, disposes a resource, or decrements a
shared handle. Each kind leaves the counted world at its own phase: `Box`
with the unique `Box`, `String`, the collections and `Dyn` at V2b,
`Rc`/`Arc` copies at V2c, and `ref(...)` types at V5. (planned: V5)
`ref(struct(...))` and `atomic(ref(...))` are removed; a type that two places
mutate on purpose becomes a value held in an `Rc`.

## 16. Design records

- [`plans/VALUES_BY_DEFAULT.md`](VALUES_BY_DEFAULT.md): §0 the model; §3.2
  `Box`/`Rc`/`Arc`; §3.4 move-only values; §3.8 `Send`/`Sync`; §3.10
  exclusivity and `RefCell`; §3.13 async; §3.14 the RC machinery; §7
  migration recipes. Decisions: 18 local borrows, 19 no partial moves, 20
  element access, 22/23 closures, 24 projections, 25 re-pointing, 26
  `match` by value, 27 clone elision, 28 argument overlap, 30 by-value
  parameters, 31 wrapper patterns, 32 member clashes, 33 call-site markers,
  34 operators and `Index`, 35 capture lists, 36 `Copy`, 37 `Fn`/`FnMut`/
  `FnOnce`, 38 closure soundness, 39 iteration, 40 no `Pin`, 41 `RefCell`,
  42 borrow spelling, 43 references as types, 44 `Dyn`, 45 `Drop` (the
  `Dispose` rename).
- [`plans/backlog/NON_ESCAPABLE_TYPES.md`](backlog/NON_ESCAPABLE_TYPES.md):
  origins (O1–O10, the `Origin` kind and `&(T, p)`); phases N0–N3.
- Related docs: [`MEMORY_SAFETY.md`](../docs/en-US/MEMORY_SAFETY.md),
  [`DYN_DESIGN.md`](../docs/en-US/DYN_DESIGN.md),
  [`ARC.md`](../docs/en-US/ARC.md),
  [`CYCLE_COLLECTION.md`](../docs/en-US/CYCLE_COLLECTION.md).
