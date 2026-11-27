# Closures

Closures: their syntax, what they capture and how, capture lists, `FnOnce`
and `FnMut`, and the static (`Impl(Fn(...))`) and dynamic (`Dyn(Fn(...))`) forms.
Named functions are in [FUNCTIONS.md](./FUNCTIONS.md).

## Overview

Yo supports closures (anonymous functions that capture their environment).

A closure compiles to a **capture struct** holding the variables it uses. How that struct is stored and called depends on the type it is given:

- **`Impl(Fn(...))` — static dispatch, not reference counted.** The compiler monomorphizes the closure into its own function, passes the capture struct **by value**, and emits a direct call. No heap allocation, no vtable, no reference count. Each closure has its own distinct type (see [Closure Type Restrictions](#closure-type-restrictions)), so this form cannot hold two different closures in one variable.
- **`Box(Dyn(Fn(...)))` and `&Dyn(Fn(...))` — dynamic dispatch.** The value is a fat pointer of `{data, vtable}` ([TRAIT_OBJECTS.md](./TRAIT_OBJECTS.md)): `dyn(Box.new(f))` moves the capture struct into a heap box the `Box` owns, and `dyn(&f)` borrows a closure where it is, with no allocation. Use this when closures of different types must share one type — storing them in a collection, returning them from different branches, or accepting any callable. The erasure is always written, at a binding, a field, an argument and a result alike; a plain `dyn(f)` of a closure, a named `fn` or an `Impl(Fn(...))` value is E0620. A callable passed bare into a `Dyn(Fn(...))` slot (`(d : Dyn(Fn() -> i32)) = f`, `run(f)`, `S(cb : f)`, a body ending in `f`) is error E0618, whose note names `dyn(f)`; `yo fix <path>` wraps a named callable. An `Impl(Fn(...))` slot is not an erasure and takes the closure bare.

In both cases the *captured values* follow the usual rules: a captured `Rc` handle is owned by the capture and released when the capture is dropped.

Please check `tests/closure.test.yo` for closure examples and usage.

## Basic Closure Syntax

There are two ways to create closures:

1. **Using `Impl(Fn(...))`** - Explicit closure type:

```yo
test_closure :: (fn() -> unit)({
  x := 1;

  // Explicit closure type using Impl
  (closure : Impl(Fn(y : i32) -> i32)) = (
    y => {
      x = (x + y);
      return(x);
    }
  );

  closure(1); // x is now 2
  closure(1); // x is now 3
  result := closure(2); // x is now 5
  assert(result == 5);
});
```

2. **Using `ClosureType({...})`** - Closure value from type:

```yo
test_closure :: (fn() -> unit)({
  x := 1;

  ClosureType :: Impl(Fn(y : i32) -> i32);
  closure := ClosureType({
    x = (x + y);
    return(x);
  });

  result := closure(2);
  assert(result == 3);
});
```

## Closure Capture Semantics

Closures capture variables from their environment:

- **Value types** (primitives, structs) are captured by value: a `Copy` value is copied, any other is moved in
- **A shared cell** (`Rc`, `Arc`) is captured as a handle the closure owns; a second handle is spelled in the capture list, `{ data : Rc.clone(data) }`
- A closure may write its own by-value state only when it is typed `FnMut` or `FnOnce` (E0913 otherwise)

```yo
test_capture :: (fn() -> unit)({
  // Value type - the closure's own copy
  mut(counter) := i32(0);

  // Shared cell - the closure owns a second handle
  data := Rc.new(RefCell(i32).new(i32(42))); // `std/sync/refcell`

  (mut(closure) : Impl(FnMut(increment : i32) -> i32)) = ({ counter, data : Rc.clone(data) }(increment) => {
    counter = (counter + increment); // Modifies the closure's own copy
    data.*.replace_with(v => (v.* + increment)); // Modifies the shared cell
    return(counter);
  });

  closure(5);
  // counter is still 0 (the closure has its own copy)
  // data.*.with(v => v.*) is now 47 (the shared cell)
});
```

## Capture lists

A closure may list its captures in a field list before its parameters:

```yo
k := i32(3);
w := i32(10);
z := i32(0);
(h : Impl(Fn(m : i32) -> i32)) = ({ k, &w, &mut z }(m : i32) => {
  z.* = (z.* + m); // writes the caller's `z` through the borrow
  k + w.* + z.*
});
(g : Impl(Fn() -> usize)) = ({ n : s.len(), name : &s }() => (n + name.len()));
count := i32(0);
(i32(1) .. i32(4)).for_each({ &mut count }(x : i32) => {
  count.* = (count.* + x);
});
```

- **Entries.** `x` (or `x : e`) is a by-value field: plain data copies, a
  value that is not implicitly copyable moves. `y : &p` and
  `z : &mut p` borrow the place `p`; `&y` and `&mut z` are the puns of
  `y : &y` and `z : &mut z`. The left of an entry names the field, and the
  sigil on the right carries the mode.
- **A reference binding is captured by copying the reference.** Outside std and
  the compiler's own source, the entry `y` (or `r : y`) of a reference binding
  (a `&T` parameter, `self : &Self`, `y := &x`, a `match` or `for` binding)
  copies the reference, not the value it refers to: a `&T` is `Copy`, so `y`
  stays usable, and the closure's origin is what `y` refers to (`x`), not the
  binding `y`. `{ q : &p.field }` projects and `{ m : &mut m.* }` reborrows a
  `&mut T`; the by-value entry `{ m }` of a `&mut` binding is rejected because
  it would move the reference. A closure that captures any value carrying an
  origin by value (a holder `h`, a reference copy) carries that origin: it
  cannot be returned over the local the origin names, and that local is frozen
  while the closure lives. A copied `&T` parameter (`{ p }`, `{ self }`) carries
  the parameter's origin, so until a closure's type carries its origin the
  closure is second-class: it is called where it is made, and returning it or
  boxing it into a `Dyn(Fn(...))` is E0909.
- **The list is exhaustive.** With a list the body may read only the listed
  captures and module-level items; `{}()` captures nothing. Without a list,
  capture stays implicit.
- **What a borrow may name.** A place rooted at a named local binding: not a
  temporary, not a module-level binding, and not through an `Rc`/`Arc` (or any
  pointer dereference) — capture the handle instead,
  `{ &r }() => r.*.items.len()`. A `&mut` place must be writable. A `&`
  capture is read-only in the body.
- **A borrowing closure is second-class**, and so is anything built from it (a
  copy, a tuple or record holding it, a closure capturing it). It may be bound
  to a local, called, and passed to a parameter, but never returned, stored in
  a field or a `Dyn`, moved into a `sink` parameter, captured by an `io.async`
  body or used as a type argument (`ArrayList(type_of(f))`), and it may not
  outlive what it borrows (E0909). A `&mut` capture also makes the closure
  move-only (E0901 on a copy).
- **`Copy` and `Clone` follow the capture record**, as in Rust: a closure is
  `Copy` (`Clone`) exactly when every by-value capture is. A closure whose
  captures are all `&` is `Copy`; one that owns a `String`, an `Rc` or a
  collection is explicit-copy, so `d := c` moves it (a later `c` is E0901,
  whose note names `c.clone()`), even while `t := s` on the `String` itself
  still shares; `c.clone()` clones each by-value capture and copies the
  rest. A `&mut` capture makes the closure neither, and
  `where(T <: Copy)` rejects a closure that is not `Copy` (E0602).
- **Borrowed places are frozen while the closure lives**: no access to a
  `&mut`-captured place, no write or move of a `&`-captured one (E0910). A
  closure lives until the end of its binding's scope, so put
  the closure and its calls in a block when the place is needed afterwards.
- **Call arguments are exclusive.** A closure that holds a `&mut` capture is
  lent exclusively, so a call may not also pass anything that reaches the
  borrowed place, the receiver and a called closure included (E0910):
  `bump({ &z }() => z, &mut z)` is rejected. A `Copy` value passed by value
  is copied before the call and reaches nothing, so `self.mix(self.tail)`
  with a `u64` field is accepted.
- A capture list on a `->` function literal or an `io.async` body is an
  error, and `{ x }(y) => …` is not a `match` arm pattern (a record pattern is
  `{ x, y } => …`).

## Call-once closures: `FnOnce`

`FnOnce(...) -> R` is the closure trait whose call consumes the closure.
A closure with a capture list,
typed `FnOnce(...)`, owns its by-value captures, so its body may move one out:

```yo
take :: (fn(sink(t) : Token) -> i32)(t.n);
t := Token(n : i32(5));
(send : Impl(FnOnce() -> i32)) = ({ t }() => take(t)); // moves `t` out, no copy
send(); // consumes `send`
// send();                                               // E0901: `send` was moved by the call above

run_once :: (fn(sink(f) : Impl(FnOnce() -> i32)) -> i32)(f());
k := i32(3);
(add : Impl(Fn() -> i32)) = ({ k }() => k);
run_once(add); // an `Fn` serves for one call
```

- **The call consumes the closure.** A second call, or any later use, is
  E0901 pointing at the first call. The body drops the captures it did not
  move when the call ends. A closure that is never called drops its captures
  with its owner.
- **`Fn` implies `FnMut`, which implies `FnOnce`.** An `Fn(...)` or
  `FnMut(...)` closure is accepted wherever `FnOnce(...)` is required. An
  `FnOnce` closure passed where `Fn(...)` or `FnMut(...)` is required is E0913.
- **Only an API the closure escapes into can call it once.** Take it by value,
  `sink(f) : Impl(FnOnce(...))`; calling an `FnOnce` closure through a
  borrowed parameter is E0901. A closure that holds a reference cannot be
  moved into a by-value parameter (E0909), so a non-escaping callback is lent,
  `f : &mut Impl(FnMut(...))`. Like every owned value, a `sink` closure called
  on some arms of a `cond`/`match` is dropped, uncalled, at the end of the
  others.
- **Moving a capture out needs `FnOnce` and a capture list.** Against
  `Fn(...)`, whose call borrows the captures so the closure can run again, a
  move out is E0913 at the moving line. An implicit capture
  cannot be moved out either (E0913 names the capture-list spelling).
- `Box(Dyn(FnOnce(...) -> R))` holds any call-once closure; its call consumes it too.

## Call-repeatedly closures: `FnMut`

`FnMut(...) -> R` is the closure trait whose call borrows the closure
exclusively, `self : &mut Self`.
Its body may write its own state — the by-value entries of its capture list —
and its `&mut` captures, and the write persists from one call to the next:

```yo
(mut(tick) : Impl(FnMut() -> i32)) = ({ n : i32(0) }() => {
  n = (n + i32(1)); // the closure's own state
  n
});
tick(); // 1
tick(); // 2

twice :: (fn(f : &mut Impl(FnMut() -> i32)) -> i32)(f() + f());
twice(&mut tick); // 3 + 4: the callee writes the caller's closure
twice({ n : i32(10) }() => {
  n = (n + i32(1));
  n
}); // a literal is a temporary, lent exclusively
```

- **The call borrows the closure exclusively**, like `xs.push(v)`. So the
  closure is called through a `mut(f)` binding, a `f : &mut Impl(FnMut(...))`
  parameter, a `(mut(d) : Box(Dyn(FnMut(...))))` or a temporary. Calling it
  through an unmarked binding or a by-value parameter is E0917 (rebind a
  parameter: `mut(g) := f;`), through `f : &Impl(FnMut(...))` or a
  `&Dyn(FnMut(...))` E0908, and while a borrow of it is live E0911.
- **`Fn` implies `FnMut`.** An `Fn(...)` closure is accepted wherever
  `FnMut(...)` is required. A closure typed `FnMut(...)` passed where
  `Fn(...)` is required, or erased into a `Dyn(Fn(...))`, is E0913: that slot may
  call it again through a shared borrow. An `FnOnce` closure is not an
  `FnMut` (E0913).
- **A by-value entry is writable only under `FnMut`.** The same body typed
  `Fn(...)` or `FnOnce(...)` writing an entry is E0917: there the write would
  reach a per-call copy. Under `FnOnce`, rebind the entry (`mut(m) := n;`).
  The entry outlives each call, so it may not keep a reference to the call's
  parameter (`last = .Some(v)` with `v : &T`, E0923) or to a local of the body
  or one of the closure's own by-value entries (E0912); store an owned value,
  or a borrow capture (`{ o : &x, last : Option(&T).None }`, `last = .Some(o)`).
- **An implicit capture is written only under an owning `FnMut` or `FnOnce`.**
  An `Fn(...)` closure, or a literal lent to a borrowing parameter
  (`run(&(() => …))`), that writes a capture it names in its body — `s = …`,
  `s.push_str(…)`, `grow(&mut s)` — is E0913: the record holds the closure's
  copy of `s`, a bitwise alias of the caller's in a borrowed literal, so the
  write would release storage the caller still owns. Borrow the place instead,
  `{ &mut s }(...) => …` at an `FnMut` slot. A `&` capture entry is read-only:
  calling an `FnMut` closure through `{ r : &f }` is E0908.
- **An `FnMut` closure is move-only.** It derives neither `Copy` nor `Clone`,
  whatever its captures are: a copy would fork its state. `Box(Dyn(FnMut(...)))` is
  move-only too.
- **A `Sync` slot rejects it.** `Impl(Fn(...), Sync)` may call the closure
  from several threads at once, so a closure that writes a `&mut` capture or
  its own state is rejected there, naming `FnMut`.
- **A `&mut`-capturing literal at an `Fn(...)` slot is E0913.** A literal
  that holds a `&mut` capture is `FnMut(...)` by its captures alone: every std non-escaping
  callback — call-repeatedly (`for_each`, `retain`, `sort_by`, the
  `with_lock` bodies) and call-once alike (the `Option`/`Result`
  combinators, `RefCell.with`, `Once.call`, the `*_lazy` loggers) — takes
  `f : &mut Impl(FnMut(...))`, so the write goes through the capture's
  pointer at an `FnMut` slot instead. `Fn` survives only where the callback
  is shared, stored beyond the call, or called from another thread.

## Closure Type Restrictions

Each closure has a unique type, even if they look identical:

```yo
// This will fail - each closure has a distinct type
test_error :: (fn() -> unit)({
  closure : Impl(Fn(y : i32) -> i32);

  cond(
    some_condition() => {
      a := 1;
      closure = (y => (y + a)); // Type 1
    },
    true => {
      b := 1;
      closure = (y => (y + b)); // Type 2 - different!
    }
  );
  // Error: no two closures, even if identical, have the same type
});
```

A closure is never a bare function pointer. A parameter or field declared `fn(...) -> R` holds a
named function or a capture-free `->` literal; a `=>` closure needs a closure-carrying type:

```yo
takes_ptr :: (fn(f : (fn(a : i32) -> i32), v : i32) -> i32)(f(v));
takes_fn :: (fn(f : Impl(Fn(a : i32) -> i32), v : i32) -> i32)(f(v));
k := i32(10);
takes_ptr(double, 5); // OK: a named fn
takes_ptr(y => (y + k), 5); // error[E0605]: a closure (`=>`) cannot be used where the function-pointer type ... is expected
takes_fn(y => (y + k), 5); // OK
```

The closure's body is checked against the result of the `Fn(...) -> R` it is passed as:
`takes_fn(x => true, 5)` is an E0604.

A closure's type can instantiate a container. `ArrayList(type_of(k))` holds copies of `k`, and
two closures' lists are two types, so a closure cannot go into another closure's list:

```yo
(k1 : Impl(Fn() -> unit)) = (() => println(&a));
(k2 : Impl(Fn() -> unit)) = (() => println(&s));
mut(l1) := ArrayList(type_of(k1)).new();
l1.push(k1); // OK
l1.push(k2); // error: k2 is a different closure type
```

To keep different closures in one collection, store them as `Box(Dyn(Fn(...)))`.

## Closures over Shared Cells

A closure that captures a shared cell owns a handle to it; the cell's payload changes through a `RefCell`:

```yo
{ assert } :: import("std/assert");
{ RefCell } :: import("std/sync/refcell");

make_incrementer :: (fn(start : Rc(RefCell(i32))) -> Impl(Fn() -> i32))({
  return(() => {
    start.*.with_mut((n : &mut i32) => {
      n.* = (n.* + 1);
    });
    start.*.with((n : &i32) => n.*)
  });
});

test :: (fn() -> unit)({
  counter := Rc.new(RefCell(i32).new(0));
  inc := make_incrementer(Rc.clone(counter));

  assert(inc() == 1);
  assert(inc() == 2);
  assert(counter.*.with((n : &i32) => n.*) == 2);
});
```

For more examples, see `tests/closure.test.yo`.
