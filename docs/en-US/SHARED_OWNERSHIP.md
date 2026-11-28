# Shared Ownership

Values shared by more than one owner: the reference-counted cells `Rc(T)` and
`Arc(T)`, the uniquely owned `Box(T)`, `Weak` handles, interior mutability with
`RefCell`, and the value rules (`Copy`, move-only values, `Drop`) the cells build
on. Single ownership and references are in
[OWNERSHIP_AND_BORROWING.md](./OWNERSHIP_AND_BORROWING.md); `Arc` and `Weak` in
depth are in [ARC.md](./ARC.md) and [WEAK.md](./WEAK.md).

## Shared Cells and Memory Management

Yo uses **reference-counted cells** (`Rc`, `Arc`) for shared ownership. `Rc(T)` counts its handles non-atomically, and `Arc(T)` counts them atomically. The non-atomic count is sound because an `Rc` is not `Send`: it never leaves its thread, so one thread touches its count ([PARALLELISM.md](./PARALLELISM.md)). Share across threads with `Arc` ([ARC.md](./ARC.md)).

### Reference-Counted Cells

`Rc(T)` and `Arc(T)` are heap cells with automatic reference counting. A handle is a new owner, so a second handle is spelled `Rc.clone(h)`:

```yo
// A shared cell: `Rc(T)` counts the handles to one heap cell.
Resource :: struct(id : i32);
impl(
  Resource,
  Drop(
    drop : (fn(self : &mut Self) -> unit)({
      // `drop` runs when the reference count reaches zero
    })
  )
);

// Usage
s1 := Rc.new(Resource(id : i32(1))); // RC = 1
s2 := Rc.clone(s1); // RC = 2 (both handles point to the same cell)
s3 := Rc.clone(s2); // RC = 3
// When s1, s2, s3 go out of scope, RC decrements
// When RC reaches 0, the payload's `drop` runs and the cell is freed
```

### Choosing a value, a borrow or a shared cell

Two questions pick the shape of a type that holds state:

1. Is it written after construction?
2. Is it needed by two owners that outlive each other's calls?

No and no: a plain `struct`, passed by `&` and returned by value. Yes and no: an
owned value, lent `&mut` where it is written and `&` where it is read. Yes and
yes: `Rc(RefCell(S))`.

std's types show the method shapes. Each method has exactly one:

- A builder consumes and returns: `Command.new(p).arg(a).arg(b)` as a chain, or
  `cmd = cmd.arg(a);` on a `mut(cmd)` binding. `HttpRequest`/`HttpResponse`
  `.header`/`.with_body` and `FetchOptions.with_*` work the same way.
- A mutator lends: `mut(u) := Url.parse(&s).unwrap(); u.set_path(&p);`. So do
  `ArgParser.add_*`, the `Rng` draws and `Interval.tick`.
- A finaliser consumes: a hasher's `update(&mut self)` feeds it, and
  `finish(self)` ends it, so a second `finish` is a use after move (E0901).
- `HttpServer` is the shared one. Its `serve` future owns a `server.clone()`,
  and the kept clone calls `stop` from the handler or another task.

### Reading the count

The builtin `ref_count(x)` returns the number of handles to the cell `x` holds, as a `usize`; an `Arc(T)` is read with an atomic load. For a value type (a plain `struct`, an integer) it is always `1`, known at compile time. A `Box` has no count, so `ref_count(b)` is a compile error. The count is meant for uniqueness checks (copy-on-write) and tests, not for program logic.

```yo
a := Rc.new(i32(42));
b := Rc.clone(a);
assert(ref_count(b) == usize(2), "two handles, one cell");
```

### Explicit Allocators

RC decides when an object dies; an explicit allocator decides where it lives. A creation with no allocator argument goes to the global allocator; a placement is one argument at the creation site: `alloc : .Some(a)`, for `Box.new`, `Rc.new` and `Arc.new` and for the containers' `new` / `with_capacity`:

```yo
{ ArrayList } :: import("std/collections/array-list");
Point :: struct(x : i32, y : i32);

// `a` is any `Allocator` value, e.g. `Allocator.global()`.
p := Rc.new(Point(x : i32(3), y : i32(4)), alloc : .Some(a)); // placed in `a`
p2 := Rc.new(Point(x : i32(1), y : i32(2))); // no argument: the global allocator
xs := ArrayList(i32).new(alloc : .Some(a)); // the buffer lives in `a`
```

No new keyword is involved, and there is no allocation scope: what a call does never depends on its caller. Every block carries its owner in a 16-byte prefix, so its release always returns to the allocator that made it, on any thread. The safety rules are in [MEMORY_SAFETY.md](./MEMORY_SAFETY.md#explicit-allocators); the full guide is [EXPLICIT_ALLOCATORS.md](./EXPLICIT_ALLOCATORS.md).

### Copy

`Copy` is the prelude marker for a value whose copy is a bitwise copy. It requires `Clone`, as Rust's `Copy: Clone` does: the trait is declared `Copy :: trait(where(Self <: Clone))`, so every `Copy` impl needs a `Clone` impl beside it, and `where(T <: Copy)` lets a generic body call `x.clone()`. The integers, floats, `bool`, `char`, `unit`, `str` views and raw pointers implement both, and so do `Option(T)` and `Result(T, E)` when their payloads do. A named type opts in with `derive(T, Copy, Clone)`, and a generic one with a `where` bound:

```yo
Point :: struct(x : i32, y : i32);
derive(Point, Copy, Clone);

Pair :: (fn(comptime(T) : Type) -> comptime(Type))(struct(a : T, b : T));
derive(generic(T : Type), where(T <: Clone), Pair(T), Clone);
derive(generic(T : Type), where(T <: Copy), Pair(T), Copy);

main :: (fn() -> unit)({
  p := Point(x : i32(1), y : i32(2));
  q := p; // a copy: `p` stays usable
  r := p.clone(); // the derived clone, which for a Copy type is the copy
});
export(main);
```

The impl is checked. A `Clone` impl must cover the same instantiations, and the compiler never writes one: `derive(T, Copy)` alone is an error naming `derive(T, Copy, Clone)`. Every field and variant payload must be `Copy`, and the error names the first one that is not (a `String` field: `holds a move-only value in its field \`name\``). A type that implements `Drop` cannot be `Copy`, in either order, and neither can a reference type. `derive(T, Clone)` is always allowed (a field-wise clone of `Copy` fields is the bitwise copy), and it is how a type that is `Copy` only under a bound gets `clone()` at every instantiation: `derive(generic(T : Type), where(T <: Clone), Pair(T), Clone)` — the derive's clone calls `.clone()` on its fields, so it needs the bound. Together with `derive(generic(T : Type), where(T <: Copy), Pair(T), Copy)`, it makes `Pair(i32)` copy implicitly and `Pair(String)` clone explicitly. A hand-written `Clone` impl is an error only on a type that is `Copy` for every instantiation the impl serves, such as a concrete `Copy` type; a generic one that also serves types that are not `Copy`, like the prelude `Option(T)`'s, is allowed. A tuple, an `Array(T, N)`, an anonymous record, a closure and a `fn` pointer have no declaration to annotate, so each is `Copy`, and `Clone`, exactly when all its parts are. When it is `Copy`, `x.clone()` is the copy, so `f.clone()` on a `fn` pointer works; a record or closure that is `Clone` but not `Copy` clones field-wise, copying each `Copy` part and cloning the rest. A closure's parts are its capture record, as in Rust: a by-value capture counts with its own type (a listed `{ s }`, and an implicit capture too, since a closure bound to a name owns what it captures), a `&` capture is a pointer and so `Copy`, and a `&mut` capture makes the closure neither `Copy` nor `Clone`. So a closure that owns a `String` is `Clone` but not `Copy`: `d := c` moves it, and `c.clone()` gives a second closure with its own `String`. `Rc`, `Arc`, `String`, the collections and `Dyn` never are. A raw pointer's `p.clone()` copies the pointer, never the pointee: `p.m(...)` is always the pointer's own member, and a pointee member is written `p.*.m(...)`.

`Copy` is the rule. A plain-data type that is not `Copy` is copied only explicitly: `q := p` moves a `Point` without `Copy`, and a later use of `p` is E0901, whose note names `derive(Point, Copy, Clone)` and `p.clone()`. A `&T` parameter or a `match` binding of one borrows it, so storing or returning it there is E0901 too; take the parameter by value (`p : Point`, without `&`) to own it. Compile-time-only types, control-bound records such as `Exception`, unions, C opaque types and refinements of a `Copy` type keep copying implicitly.

### Move-only values

A resource (a file descriptor, a lock, a socket) is a value that must not be copied: two copies would release it twice. A value type (`struct`, `enum`, `newtype`) that implements `Drop` is **move-only**, and so is a plain value type that is neither `Copy` nor `Clone` (a token that must stay unique needs no `Drop`: declare neither), and every value that holds one: a struct field, an enum payload, a tuple or array element, a closure capture. `Option(Fd)` and `Tuple(Fd, i32)` are move-only. A counted handle (`Rc`, `Arc`) never is, whatever it holds, because its copies share one cell; its payload's `Drop` runs once, when the count reaches zero.

```yo
{ println } :: import("std/fmt");
Fd :: struct(n : i32);
impl(
  Fd,
  Drop(
    drop : (fn(self : &mut Self) -> unit)(println(`closing ${self.n}`)) // a real one would close the descriptor
  )
);

peek :: (fn(f : &Fd) -> i32)(f.n); // a `&T` parameter borrows: no copy
keep :: (fn(f : Fd) -> unit)(()); // a by-value parameter moves the value in

main :: (fn() -> unit)({
  a := Fd(n : i32(3));
  n := peek(&a); // borrowed; `a` is still usable
  b := a; // moves `a` into `b`
  // a.n           // E0901: use of moved value: `a`
  keep(b); // moves `b`; `keep` drops it when it returns
});
export(main);
```

Every copy point moves a move-only value: `:=`, `=`, a `sink` argument, a field or element store, a constructor argument, a return and a closure capture. A use after the move is E0901, and its note says why the type is move-only. A move-only value cannot be copied out of storage it does not own either: a `&T` parameter and a `match`/`for` binding borrow it, a field belongs to its holder (there are no partial moves), and a module-level binding is never moved. A value moved in some arms of a `cond`/`match` is dropped at the end of each arm that keeps it, so where the arms meet it is gone on every path and a later use is E0901 (the static form of Rust's drop flag: the arms are structured, so no runtime flag is needed). Where the ways out of a loop meet, a value is still moved on all of them or on none (E0907). An assignment statement (`x = y;`, `h.f = y;`, `xs(i) = y;`) drops the old value right after the store, as Rust does; `old := (x = y)` keeps it in `old` instead. Its single owner runs `drop` exactly once, when it drops the value, and then drops its fields. A type that implements `Clone` is copied explicitly with `x.clone()`; to share one value, put it behind a reference type.

To move a field out of a holder that stays alive, use `std/mem` (Rust's `std::mem`): `replace(&mut h.f, v)` stores `v` and returns the old value, `take(&mut h.f)` stores `T`'s default (`where(T <: Default)`) and returns the old value, and `swap(&mut a, &mut b)` exchanges two places. Each moves bitwise, so a move-only value is neither copied nor dropped twice. They live in their own module rather than the prelude, so the names stay free for your own definitions: `{ replace, take, swap } :: import("std/mem");`.

A generic function is checked at each instantiation: `ArrayList(Fd).get(i)` copies an element out, so that instantiation is E0901, reported at the call. A collection element is reached by place instead: `xs(i)` reads it in place, `xs.with(i, (v) => …)` runs a body on it borrowed `&mut` and returns the body's result, `xs.take(i)` moves it out and leaves `T`'s default, `xs.swap(i, j)` exchanges two elements, and `replace(&mut xs(i), v)` from `std/mem` moves a new value in and the old one out. Each copying accessor has a cloning sibling for an element that implements `Clone`: `get_cloned`, `first_cloned` and `last_cloned` on `ArrayList`; `get_cloned`, `front_cloned` and `back_cloned` on `Deque`; `get_cloned` on the maps, with `get_key_value_cloned` (`HashMap`), `get_index_cloned` (`OrderedMap`) and `first_entry_cloned`/`last_entry_cloned` (`BTreeMap`); and `peek_cloned` on `PriorityQueue`. `xs.extend(ys)` consumes `ys`; `xs.extend_cloned(&ys)` appends clones and keeps it. `Option` and `Result`'s `unwrap`, `expect`, `unwrap_or`, `unwrap_or_else`, `unwrap_or_default`, `unwrap_err` and `expect_err` consume their receiver, so `make().unwrap()` moves a move-only payload out.

### std's resources are move-only

The resources in `std/` are move-only values: `File`, `TempDir`, `TempFile`, `Watcher`, `TcpStream`, `TcpListener`, `UdpSocket`, `UnixStream`, `UnixListener`, `TlsStream`, `HttpClient`, `Child` and its pipe handles (`ChildStdin`, `ChildStdout`, `ChildStderr`), `Thread`, and a `BufReader`/`BufWriter` that owns one of them. Each is a struct whose state lives in a `Box`, so the handle can move while a future or the runtime holds the state's address. Dropping the handle releases the resource: the descriptor is closed, the temporary removed, the watch stopped, the thread detached. The `std/sync` primitives (`Mutex`, `RawMutex`, `RwLock`, `Cond`, `Barrier`, `Semaphore`, `WaitGroup`, `Once`, `OnceCell` and the `Atomic*` types) are move-only values the same way, shared across threads as `Arc(Mutex(T))`; `Channel(T)` is a value holding an `Arc` of its queue, and `ch.clone()` is another handle on it.

- **A copy is E0901.** `g := f` moves the file, and a use of `f` afterwards is E0901 (use of moved value). Storing one handle twice, or capturing it in two closures, is E0901 as well. Before this change a `File` was a reference handle, and a copy shared its descriptor and position.
- **Lend it.** Every method takes `self : &Self`, so `f.read_to_string(io)` borrows `f`. A function that only uses a resource takes `&File`.
- **Share it through a reference type.** On one thread, `Rc.new(f)` gives an `Rc(File)` whose handles all reach the one file (`h.*.read_to_string(io)`). Across threads, use `Arc(Mutex(TcpStream))`; that needs a `Send` resource: the sockets, `File`, the temporaries, `Child` and its pipes, and `Thread` (`File`, the temporaries and `UnixListener` hold a `String` path, a value since B8). `Watcher`, `TlsStream` and `HttpClient` stay on their thread. A `ref` struct that holds a resource holds it as an `Rc` field for the same reason, as `HttpServer` holds its listener.
- **Moving it out.** `Option(T).unwrap` reads through a borrow and cannot move a move-only payload out. Use a consuming match instead: `f := match(opt, .Some(x) => x, .None => …)`.
- **Hand it over.** `BufReader(File).new(f)` and `TcpListener.incoming()` take ownership (`sink`); `get_ref()` and `Incoming.listener()` lend it back, and `BufReader.into_inner()` / `BufWriter.into_parts()` give it back by value. To serve a socket from a spawned task, move it into the task.
- **Dropping it releases it.** A `Child` dropped without `wait()` closes the pipe ends it still holds (it does not wait for the process).

Every I/O method's future borrows the resource until it completes, because the descriptor it uses is closed when the resource drops. That covers every read, write, `close`, `flush`, `set_len`, `metadata`, `accept`, `connect` (UDP), `send`/`recv`, `shutdown` and socket option on the resources above, `BufReader.read_line`, `Child.wait` and its pipe reads and writes, `HttpClient.fetch`, `Watcher.next`, the `Reader`/`Writer` defaults (`read_to_end`, `read_to_string`, `write_all`), and the free functions built on them (`io.copy`, `read_http_message`). A borrowing future follows the rules of §3.13 A2:

- Await it where it is made. It cannot be bound to a name, spawned or returned (E0909).
- Its effect bundle must be a place. Write `b := IoExn(io : io, exn : exn); io.await(f.read_to_string(io), b)`; an inline `IoExn(...)` in the `io.await` is E0910.
- The borrowed resource cannot live inside an `Rc` payload or behind a pointer dereference (E0909): lend the handle instead.

For the same reason there is no `Dyn(Reader)` or `Dyn(Writer)`. The traits' defaults (`read_to_end`, `read_to_string`, `write_all`) return futures that borrow the reader or writer, and a vtable's future type carries no borrow, so `dyn(r)` as either trait object is E0909 for every implementor. Take one through a generic `Impl(Reader)` / `Impl(Writer)` parameter instead.

### The destructor: `Drop`

`Drop` is the destructor trait, and its method `drop` has Rust's semantics: it runs automatically, exactly once, when the owner drops the value or the last `Rc`/`Arc` reference goes away, and a value type that implements it is move-only. Its receiver follows Rust's `drop(&mut self)`: `drop : (fn(self : &mut Self) -> unit)`, so a destructor may take a field out or reset it (`self.f = .None`) before the fields are dropped, and an impl that declares `self : &Self` does not conform.

Calling the destructor by hand is error E0915, as in Rust: `x.drop()`, `Fd.drop(&x)` and `(Fd <: Drop).drop(&x)` would run it a second time on a live value. Reading it as a value, `f := Fd.drop`, is E0915 too, since a call through `f` would do the same. A method of another trait that happens to be named `drop` is an ordinary method, called directly or through `Dyn`. A destructor does not call its fields' destructors either: they drop after it returns. To end a value early, pass it to the prelude's `drop(x)`, which moves it in and drops it when the call returns; a later use of `x` is E0901.

```yo
{ println } :: import("std/fmt");
Fd :: struct(n : i32);
impl(Fd, Drop(drop : (fn(self : &mut Self) -> unit)(println(`closing ${self.n}`))));

main :: (fn() -> unit)({
  a := Fd(n : i32(3));
  drop(a); // prints "closing 3" now
  // a.drop()      // E0915: explicit call of the destructor
  // a.n           // E0901: use of moved value: `a`
});
export(main);
```

A resource that must be released while other references to it may still be live gets an ordinary method its destructor delegates to, such as `TcpStream.close_sync()`.

## Box: the Uniquely Owned Cell

`Box(T)` is a heap cell with exactly one owner and no reference count, like
Rust's `Box<T>`. Use it for a recursive type and for a value that needs a
stable address; use `Rc` when the value is shared.

```yo
Tree :: enum(
  Leaf(v : i32),
  Node(l : Box(Self), r : Box(Self))
);
sum :: (fn(t : &Tree) -> i32)(
  match(
    t,
    .Leaf(v) => v.*,
    .Node(l, r) => (sum(&l.*.*) + sum(&r.*.*))
  )
);
t := Tree.Node(Box.new(Tree.Leaf(1)), Box.new(Tree.Leaf(2)));
assert(sum(&t) == 3);
```

- **`Box.new(v)`** moves `v` into a new cell. `b.*` is the payload place, in safe
  code too: `b.* = v` replaces it, and `b.*.field` / `b.*.method()` reach
  its members. A pattern looks through a `Box` payload with `Box(p)`,
  as through an `Rc`'s with `Rc(p)`; for now a `Box` is also looked through
  without it.
- **Explicit copies.** A `Box` is never `Copy`. `c := b` moves `b` when it is
  `b`'s last use; any other copy is E0901. `Box.clone(b)` is a deep copy: a
  new cell holding a clone of the payload, and `b.clone()` is the same call
  (`b.*.clone()` is the payload's own `clone`). `Box(T)` implements `Clone` when `T`
  does, so a `Box` of a move-only value is move-only.
- **One drop.** Dropping a `Box` drops its payload and frees the cell.
  `ref_count(b)` is a compile error: there is no count.
- **Moving the payload out.** `b.into_inner()` consumes the `Box`, frees the
  cell and returns the payload, so a move-only payload leaves the cell without
  a copy (`RefCell.into_inner` and `BufWriter.into_parts` use it).
- **`Eq`, `Hash` and `Default`** compare, hash and build the payload.
  `Box(T)` is `Send`/`Sync` exactly when `T` is.
- **Layout.** The `Box` value is one pointer, and `Option(Box(T))` is one
  pointer too (`NULL` is `.None`). A global cell is the payload alone,
  `size_of(T)` bytes as in Rust, and a zero-sized payload allocates nothing.
  A cell an `alloc` argument placed has a 16-byte owner prefix recording the
  allocator in front of the payload, and the handle says so in bit 0 of its
  pointer (every cell is at least 16-byte aligned, so the bit is free).
  `Box`'s payload may be unsized (`comptime(V) : ?Sized`): the
  handle of a `Box([T])` or `Box(Dyn(T))` is two words.
- **Allocators.** `Box.new(v, alloc : .Some(a))` places the cell in `a`;
  without `alloc`, the cell is on the global allocator. The cell is freed through its owner, and `Box.clone(b)`
  lands where `b` lives (a box placed by an explicit allocator clones into that allocator).
  `Box.allocator(b)` reads the owner back (`.None` for the global allocator).
- **Cycles.** A `Box` is part of its owner's value, so an `Rc` cycle closed
  through a `Box` is a cycle of the `Rc` cells: it leaks like any other
  unless a `Weak` breaks it.

## Rc and Reference-Counted Cells

Yo provides `Rc` (built with `Rc.new`) for heap-allocating value types with automatic reference counting.

### Rc Type

> **⚠️ `Rc` is Rust's `Rc`, not Rust's `Box`.** Rust's `Box<T>` is a unique
> owner — passing it moves, cloning it deep-copies. Yo's `Rc(T)` is a counted
> handle: `Rc.clone(a)` makes **a second handle to one heap value and bumps a
> reference count**, exactly like Rust's `Rc::clone`.
>
> ```yo
> a := Rc.new(i32(42));
> b := Rc.clone(a);          // a second handle, NOT a copy of the value
> assert(ref_count(a) == usize(2), "a and b name the SAME value");
> ```
>
> **A second handle is spelled**:
> a handle is a new owner, so sharing is visible where it is created. A
> handle's last use moves it (`b := a` with no later `a`); an implicit copy
> whose source is used again is E0901, whose note names `Rc.clone(a)`. A
> `&Rc(T)` parameter borrows the handle without a copy. A value holding a
> handle (a struct field, an `Option(Rc(T))`) is copied with `.clone()`,
> which clones each handle; a closure takes a second handle in its capture
> list, `{ a : Rc.clone(a) }() => a.*`. `a.clone()` is the handle's own
> `clone`, the same call as `Rc.clone(a)`; the payload's is `a.*.clone()`.
> `Rc(T)` and `Arc(T)` are `Clone` for every `T`, and the
> clone is always a second handle; a deep copy is `Rc.new(h.*.clone())`. A generic body is judged at each instantiation, so a copy
> of a `T` that is a handle needs `.clone()` there too (`where(T <: Clone)`).
> std's generic readers are judged the same way: `ArrayList(Rc(T)).get(i)`
> and `HashMap.get` copy their element through `T`, so at a handle element
> the call is E0901, reported at your call with the std location as a note.
> Read handle elements through the accessors that do not copy: `xs(i)` in
> place, `xs.get_cloned(i)` for a second handle, or `xs.with(i, ...)`.
>
> What this means in practice: sharing is silent, an `Rc` cycle leaks unless
> broken (Rust's `Box` cannot form one; a `Weak` back edge breaks it, see
> [Weak: a Handle That Does Not Own](#weak-a-handle-that-does-not-own)), and
> `ref_count(b)` / `Rc.try_unwrap` are how you ask about uniqueness.
>
> `Box` is a different type: the uniquely owned, uncounted cell, like Rust's
> `Box<T>` ([Box: the Uniquely Owned Cell](#box-the-uniquely-owned-cell)).

`Rc(T)` is a generic cell type that wraps any value type:

```yo
// Rc is defined in std/prelude.yo
Rc :: (fn(comptime(V) : ?Sized) -> comptime(Type))(
  newtype(_cell : __yo_cell(V))
);
```

The constructor is `Rc(T).new(value, (alloc : Option(Allocator)) ?= .None)`. It
allocates a fresh cell whose count is 1; the count is read with `ref_count(x)`.
`Rc.new(v)` infers `T` from the argument, as `Box.new(v)` and `Arc.new(v)` do;
write the type, `Rc(T).new(...)`, when the argument does not carry it (an enum
shorthand such as `.None`, a closure literal). `alloc : .Some(a)` places the cell
in the allocator `a`; the default, `.None`, places it on the global allocator
([EXPLICIT_ALLOCATORS.md](./EXPLICIT_ALLOCATORS.md)). `dyn(Rc.new(v))` builds an `Rc(Dyn(Trait))`
over a fresh cell ([TRAIT_OBJECTS.md](./TRAIT_OBJECTS.md)).

### Usage Examples

```yo
// Wrap a primitive value
i := Rc.new(42); // i: Rc(i32)
assert(i.* == 42); // Dereference with .*
// Wrap a struct
Point :: struct(x : i32, y : i32);
p := Rc.new(Point(x : 3, y : 4)); // p: Rc(Point)
assert(p.*.x == 3);

// Rc with explicit type
b := Rc(i32)(100); // Same as Rc.new(100)
// The payload is read-only through the handle (E0919); a door writes it
m := Rc.new(i32(10));
Rc.make_mut(&mut m) = i32(20); // in place: m is the only handle
assert(m.* == 20);
```

### Rc with Assignments

A reassignment needs a `mut` binding, and the assignment
expression is the OLD value of the handle:

```yo
{ assert } :: import("std/assert");

test("Rc assignment behavior", {
  mut(x) := Rc.new(1);
  y := (x = Rc.new(2)); // y gets the old value
  assert(x.* == 2); // x now points to the new Rc
  assert(y.* == 1); // y has the old Rc
});
```

### Rc and Reference Counting

`Rc(T)` uses automatic reference counting; a second handle is `Rc.clone`:

```yo
{ assert } :: import("std/assert");

test("Rc reference counting", {
  original := Rc.new(42);
  copy := Rc.clone(original); // RC increment
  another := Rc.clone(copy); // RC increment
  // All three point to the same Rc
  assert(original.* == 42);
  assert(copy.* == 42); // Shared!
  assert(ref_count(another) == usize(3));

  // RC decrements when variables go out of scope
});
```

### Mutating a Shared Payload: `RefCell`, `Rc.get_mut`, `Rc.make_mut`, `Rc.try_unwrap`

An `Rc`'s payload is shared, so it is **read-only through the handle**, as
in Rust.
A write through an `Rc` (`h.*.n = v`, `h.* = v`, `bump(&mut h.*.n)`,
`h.*.items.push(v)`) is error E0919, which names the doors below
(`yo explain E0919`):

- **`RefCell(T)`** (`std/sync/refcell`) is the payload for shared mutation:
  `Rc(RefCell(T))`. Access is scoped to a closure, as `Mutex(T)`'s is:
  `with(v => ...)` lends `v : &T`, `with_mut(v => ...)` lends `v : &mut T`,
  and each returns the closure's result. Rust's value-moving methods lend
  nothing to the caller: `replace(v)` and `take()` (`T <: Default`) store a
  new value and return the old one, `replace_with(v => ...)` stores what
  the closure computes from `v : &T` and returns the old value, and
  `into_inner()` consumes the cell. Unlike Rust's `replace_with`, whose
  closure is an `FnOnce(&mut T) -> T`, the closure is an `Fn` lent `&T`, as
  a `with` body is. Several `with` bodies may run at once;
  a `with_mut` (or `replace_with`'s closure) runs alone, and a conflicting
  access while one runs panics, as Rust's `RefCell::borrow_mut` does. The
  mark is released when the body returns or unwinds. A `RefCell` is `Send` when `T` is and never
  `Sync`, so `Arc(RefCell(T))` is rejected (share an `Arc(Mutex(T))` across
  threads). It may also sit in a plain value, where it makes a write through
  a `&` borrow possible.

  ```yo
  { RefCell } :: import("std/sync/refcell");
  log := Rc.new(RefCell(i32).new(i32(0)));
  other := Rc.clone(log); // a second handle to the same cell
  other.*.replace_with(n => (n + i32(1)));
  assert(log.*.with(n => n) == i32(1), "seen through the first handle");
  ```

- **`Rc.make_mut(&mut h)`** (`T <: Clone`) is the payload, written: when
  another handle shares the cell, `h` first moves to a fresh cell holding a
  clone of the payload, so the other handles never see the write. On the
  only handle it writes in place. Rust's `Rc::make_mut`; the clone is in
  the name.

  ```yo
  a := Rc.new(Point(x : 1, y : 2));
  b := Rc.clone(a);
  Rc.make_mut(&mut b).x = 10; // b gets a cell of its own
  assert((a.*.x == 1) && (b.*.x == 10), "a is unchanged");
  ```

- **`Rc.try_unwrap(h)`** consumes the handle and returns `.Ok(payload)`
  when it was the only one (the cell is freed), else `.Err(h)`, the handle
  back. It needs no `Clone`.
- **`Rc.get_mut(&mut h)`** is `.Some(&mut T)`, a reference into the cell,
  when no other `Rc` or `Weak` shares it, and `.None` otherwise; it never
  clones, so it needs no `Clone`. Rust's `Rc::get_mut`.

  ```yo
  h := Rc.new(i32(1));
  match(
    Rc.get_mut(&mut h),
    .Some(v) => {
      v.* = i32(2);
    },
    .None => ()
  );
  assert(h.* == i32(2), "the only handle writes in place");
  ```

The doors are called through the type, as in Rust, so a payload method of
the same name stays reachable as `h.name()`. `Arc` has the same
`Arc.get_mut`, `Arc.make_mut` and `Arc.try_unwrap` ([ARC.md](./ARC.md)).

### Weak: a Handle That Does Not Own

`Weak(T)` is Rust's `rc::Weak<T>`: `Rc.downgrade(&h)` makes a handle to the
cell that does not keep the payload alive, and `w.upgrade()` is
`.Some(handle)` while an `Rc` to it exists, `.None` after the last one. The
last `Rc` drops the payload; the last handle of either kind frees the cell.
A `Weak` has no `Deref`, is explicit-copy (`Weak.clone(&w)`), and is not an
edge of the ownership graph, so a parent pointer `Weak(RefCell(Node))`
closes no cycle. See [WEAK.md](./WEAK.md).

```yo
a := Rc.new(i32(7));
w := Rc.downgrade(&a);
assert(w.upgrade().is_some(), "alive while a is");
consume(a);
assert(w.upgrade().is_none(), "the last Rc dropped the payload");
```

### When to Use Rc

- **Heap allocation**: When you need a value type on the heap
- **Shared ownership**: Several handles to one value; shared mutation goes through `Rc(RefCell(T))`
- **Shared dynamic dispatch**: `dyn(Rc.new(v))` builds an `Rc(Dyn(Trait))`, one trait object several handles share; a uniquely owned one is `dyn(Box.new(v))`
- **Recursive types**: only when the nodes are shared; a tree of uniquely owned nodes uses `Box`

```yo
impl(i32, SomeTrait(...));
use_dyn :: (fn(value : &Dyn(SomeTrait)) -> unit)({ ... });

// One i32 behind a shared trait object
(shared : Rc(Dyn(SomeTrait))) = dyn(Rc.new(i32(42)));
use_dyn(&shared.*);
```
