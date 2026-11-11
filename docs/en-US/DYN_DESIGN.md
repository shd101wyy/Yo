# Dyn/dyn Dynamic Dispatch Implementation

## Overview

`Dyn(Trait, ...)` is a trait object, Rust's `dyn Trait`: the concrete type is erased, and every
method call goes through a vtable. A `Dyn` is **unsized** (decision 49 in
[`plans/VALUES_BY_DEFAULT.md`](../../plans/VALUES_BY_DEFAULT.md)). Payloads of different
concrete types have different sizes, so a `Dyn` has no size of its own and lives behind a pointer.
The pointer decides who owns the object:

| Form | Owns the object | Built by |
| --- | --- | --- |
| `Box(Dyn(T))` | uniquely: dropping the box drops the payload | `dyn(Box.new(v))`, `dyn(Box.new(v, alloc : a))` |
| `Rc(Dyn(T))` | shared, read-only through the handle | `dyn(Rc.new(v))` |
| `Arc(Dyn(T, Send, Sync))` | shared across threads, read-only | `dyn(Arc.new(v))` |
| `&Dyn(T)` / `&mut Dyn(T)` | nothing: a borrow of a place that stays where it is | `dyn(&v)` / `dyn(&mut v)`; `&b.*` / `&mut b.*` |

`dyn(...)` is the only way in. It erases the pointee of the pointer it is given and returns the
same kind of pointer over a `Dyn`, with the trait list taken from the type its position expects.

```yo
{ println } :: import("std/fmt");
Speak :: trait(speak : (fn(self : &Self) -> i32));
Cat :: struct(n : i32);
impl(Cat, Speak(speak : ((self : &Self) -> self.n)));
speak_via :: (fn(d : &Dyn(Speak)) -> i32)(d.speak());
main :: (fn() -> unit)({
  c := Cat(n : i32(3));
  a := speak_via(dyn(&c)); // borrowed: nothing is allocated, and `c` stays usable
  (b : Box(Dyn(Speak))) = dyn(Box.new(Cat(n : i32(4)))); // owned
  m := speak_via(&b.*); // lend the boxed object
  (s : Rc(Dyn(Speak))) = dyn(Rc.new(Cat(n : i32(5)))); // shared
  total := (a + m + s.speak() + c.n);
  println(&total);
});
export(main);
```

### Release status (v0.2.77)

The compiler half of decision 49 (S1) ships in v0.2.77, while the prelude's `Box`, `Rc` and
`Arc` become generic over unsized types only in v0.2.78 (S2). Until then:

- **`Box(Dyn(T))` is the older owning `Dyn` value.** In v0.2.77, the bare spelling `Dyn(T)` used as
  a value type means `Box(Dyn(T))`, a plain `dyn(v)` means `dyn(Box.new(v))`, and `&d` of such a
  value into a `&Dyn` slot lends it as `&d.*` does. `yo fix <path> --migrate unsized` writes the
  bare spellings the new way; in v0.2.78 they become errors (E0619, E0620).
- **Until v0.2.78, `Rc(Dyn(T))` is two allocations**: `dyn(Rc.new(v))` puts a boxed `Dyn` in a
  counted cell. Its type and its sharing rules are already final.
- **Until v0.2.78, `downcast` of an owned object is spelled on `&d.*`.** `downcast(&d.*, V)`
  gives `Option(&V)`, as on any reference. The owning form, which hands the box back on failure,
  comes with the prelude; `downcast(d, V)` on an owned `d` keeps the copying form described below.
- **Until v0.2.78, a `dyn(&v)` reference can be used only as a call argument.** It cannot be
  named, stored or returned: binding it to a local or storing it is E0911, and returning it, also
  through a projection or inside an `Option`, is E0912. Pass it directly, or own the object with
  `dyn(Box.new(v))`.

A raw pointer `*Dyn(T)`/`?*Dyn(T)` is also a pointer to an owned `Box(Dyn(T))` until v0.2.78; the
migration writes it `*Box(Dyn(T))`.

## Core Design

### 1. The fat pointer

Every pointer to a `Dyn` is two words, the payload's address and the vtable of the payload's
concrete type:

```c
typedef struct {
  void* data;                 // the payload
  const TraitVtable* vtable;  // one static vtable per (concrete type, trait list)
} __yo_dyn_trait_Speak;
```

A `&Dyn(T)` is passed by value as this pair, so `dyn(&v)` allocates nothing: `data` is `&v`.

### 2. The vtable

A vtable describes the concrete type, not the pointer, so every pointer kind over one concrete type
shares it. It starts with a fixed prefix, then one slot per callable method:

| Slot | Meaning |
| --- | --- |
| `__yo_type_id` | the concrete type's id, which `downcast` compares |
| `size`, `align` | the payload's size and alignment, read by `size_of_val(d)` and `align_of_val(d)` |
| `drop_in_place` | drops the payload where it lies |
| `clone_into` | clones the payload into storage the caller provides; `NULL` unless the trait list has `Clone` |
| `payload_of`, `retain`, `release`, `clone` | the v0.2.77 owning value's slots; removed once `Box(Dyn)` is the prelude's `Box` |

```c
typedef struct {
  uintptr_t __yo_type_id;
  size_t size, align;
  void (*drop_in_place)(void*);
  void (*clone_into)(const void*, void*);
  /* legacy suffix: payload_of, retain, release, clone */
  int32_t (*speak)(const void*);  // the method slots
} __yo_dyn_trait_Speak_vtable;
```

Each method slot is a wrapper that casts `data` back to the concrete type and calls the impl. A
method call is one load and one indirect call:

```c
int32_t r = d.vtable->speak(d.data);
```

## Object-Safety Constraint (Following Rust)

A method can be called through a `Dyn(Trait)` receiver when:

1. its receiver is a reference, `self : &Self` or `self : &mut Self`;
2. `Self` appears nowhere else in its signature: not as another parameter, not as the result, and
   not inside one (`Option(Self)`, `Result(Self, E)`);
3. it takes no `generic(...)` parameters.

The reasons:

- A `Dyn` erases the concrete type, so a `Self` parameter or result has no single C type at the
  call: two concrete types behind the same `Dyn` have different sizes and representations.
- A generic method is a family of functions, one per instantiation, and a vtable slot holds one.
- A by-value `self` would move the payload out of the pointer that owns it, and an unsized payload
  has no value form to move.

Only these methods get a vtable slot. Calling one of the others through a `Dyn` is error E0614
(`yo explain E0614`), at the call. A trait with a by-value `self` method cannot be put behind a
`Dyn` at all, for any payload: the operator traits that take their operand by value
(`LogicalNot`, `Negate`, `Add`, ...) are among them.

```yo ignore
Sp :: trait(speak : (fn(self : &Self) -> i32), me : (fn(self : &Self) -> Self));
(d : Box(Dyn(Sp))) = dyn(Box.new(Cat(n : i32(3))));
d.speak(); // OK: `Self` only as the receiver
d.me(); // error[E0614]: Method "me" of trait Sp cannot be called through a Dyn receiver (dyn(Sp)): it returns Self, which the Dyn erases.
```

A blanket inherent method over a trait bound (`impl(generic(E), where(E <: Named), E, shout : ...)`)
also accepts a `Dyn(Named)` receiver. It is not a trait member and has no vtable slot: the call is
an ordinary call to the method, specialized for the `Dyn`, and inside it `self.name()` dispatches
through the vtable.

An inherent impl on a `Dyn` type adds methods to that `Dyn`, like Rust's `impl dyn Error`:
`std/error.yo`'s `impl(AnyError, is : ...)` is why `err.is(NotFound)` works on an `AnyError`.

A trait implemented through a generic impl (`ArrayList(T)`'s `ToString` for `T <: ToString`) can be
put behind a `Dyn`: `dyn(&xs)` specializes the generic impl's methods for the concrete type.

**No implicit upcasting.** A `Dyn(Sp, Ot)` does not flow into a `Dyn(Sp)` slot: the two have
different vtable layouts, so the conversion is written out with `upcast` (below). The trait list
is a set: `Dyn(Sp, Ot)` and `Dyn(Ot, Sp)` are one type.

**Two traits in one `Dyn` may not share a method name** (E0616). A `Dyn` calls its methods by
name, so `Dyn(A, B)` where `A` and `B` both declare a callable `get` is rejected where the type is
written: `d.get()` could not say which trait's method it means.

## Construction: `dyn(...)`

`dyn(p)` takes a pointer to a concrete value and returns the same kind of pointer to a `Dyn`:

| Written | Type | Notes |
| --- | --- | --- |
| `dyn(Box.new(v))` | `Box(Dyn(T))` | `v` moves into a fresh box; `alloc : a` places it in `a` |
| `dyn(Rc.new(v))` | `Rc(Dyn(T))` | a fresh shared cell |
| `dyn(Arc.new(v))` | `Arc(Dyn(T, Send, Sync))` | a fresh atomic cell; the payload must be `Send` and `Sync` |
| `dyn(&v)` | `&Dyn(T)` | `v` is lent, read-only, and stays usable after the call |
| `dyn(&mut v)` | `&mut Dyn(T)` | `v` is lent exclusively: another lend of `v` in the same call is E0910 |

The trait list comes from the expected type: a parameter, an annotated binding, a field. The
concrete type must implement every listed trait. `dyn(d)` over a value that is already a `Dyn` is
an error that points at `upcast`: the payload's type is erased, so there is nothing to build a new
vtable from.

`dyn(h)` over a named `Rc`/`Arc` handle is rejected: the handle's cell may be shared, and a `Dyn`
built over it in place would not know about the other handles. Write `dyn(Rc.new(v))` to build the
shared object where it is created, or `dyn(Box.new(v))` to own it.

A closure literal inside `Box.new`, `Rc.new` or `Arc.new` under `dyn` is typed from the expected
`Dyn(Fn(...))`, so its parameters need no annotation:

```yo
run :: (fn(d : &Dyn(Fn(x : i32) -> i32)) -> i32)(d(i32(2)));
main :: (fn() -> unit)({
  k := i32(3);
  (f : Box(Dyn(Fn(x : i32) -> i32))) = dyn(Box.new(x => (x * k)));
  _n := run(&f.*);
});
export(main);
```

### `dyn(...)` is the only way in

A value becomes a `Dyn` only where the program writes `dyn(...)` (decision 44). There is no
implicit conversion at a typed slot, for a nominal value or for a callable. A named closure, a
named `fn`, an `Impl(Fn(...))` parameter or a closure literal in an owning `Dyn(Fn(...))` binding,
field, argument or result is error E0618, whose note names `dyn(f)`, the v0.2.77 spelling of
`dyn(Box.new(f))`. A `&Dyn(Fn(...))` parameter borrows the closure with `dyn(&f)`, which
allocates nothing.

```yo
run :: (fn(d : &Dyn(Fn() -> i32)) -> i32)(d());
main :: (fn() -> unit)({
  n := i32(3);
  (f : Impl(Fn() -> i32)) = (() => n);
  _x := run(dyn(&f)); // a borrowed closure: no allocation
  (g : Box(Dyn(Fn() -> i32))) = dyn(Box.new(f)); // `= f` is E0618
  _y := run(&g.*);
});
export(main);
```

An `Impl(Fn(...))` slot is the closure's own static type, not an erasure, so a closure flows into
it bare.

## Places: `b.*` and `size_of_val`

`b.*` on a `b : Box(Dyn(T))`, and `h.*` on an `Rc`/`Arc` handle, is a place of type `Dyn(T)`. It
can be borrowed (`&b.*`, and `&mut b.*` through a `Box`), and methods are called through it, but it
is never bound, moved, assigned or matched by value: `x := b.*` is E0619, since the place has no
size of its own. Through an `Rc` or `Arc` the payload is read-only, so `&mut h.*` and a
`&mut Self` method are E0919.

`size_of_val(d)` and `align_of_val(d)` read the payload's size and alignment from the vtable;
`size_of(Box(Dyn(T)))` is two pointers.

## Runtime Type Checks: `downcast(d, V)`

`downcast` recovers the concrete type. Through a reference it borrows the payload, with no copy:

```yo ignore
downcast(r : &Dyn(T), V) -> Option(&V)
downcast(r : &mut Dyn(T), V) -> Option(&mut V)
```

```yo ignore
(animal : Box(Dyn(Animal))) = dyn(Box.new(Cat.new()));
match(
  downcast(&animal.*, Cat),
  .Some(cat) => cat.purr(), // `cat : &Cat`, borrowed from the box
  .None => println(`not a cat`)
);
```

The second argument is a TYPE, evaluated at compile time. `std/error.yo`'s `err.is(T)` on an
`AnyError` is built out of `downcast`.

`downcast(d, V)` on an owned `d` keeps the v0.2.77 form: it returns `Option(V)`, a copy of the
payload, so a move-only `V` needs a `Dyn` that lists `Clone`. In v0.2.78 the owning form becomes
`Result(Box(V), Box(Dyn(T)))`, which hands the box back on failure; until then write
`downcast(&d.*, V)` where you only read the payload.

**How the check works.** Each concrete type gets one static whose ADDRESS is its type id, and every
vtable carries it in `__yo_type_id`. The check is one pointer comparison,
`d.vtable->__yo_type_id == (uintptr_t)&__yo_typeid_Cat`, with no string comparison and no RTTI
table.

**A downcast that can never succeed is a compile-time `.None`.** The compiler sees every
`dyn(...)` site in the program. If nothing ever erases `V` into this `Dyn`, no vtable carries `V`'s
type id, and the expression is lowered to a constant `.None`.

**There is no unchecked cast.** A panic on mismatch is spelled `downcast(&d.*, V).unwrap()`.
`type_id` takes a TYPE, not a value; it cannot test a `Dyn` at runtime.

## Upcasting: `upcast(p, Dyn(...))`

`upcast` gives the same payload behind a `Dyn` with fewer traits, keeping the pointer kind:

```yo ignore
c := Cat(n : i32(1));
speak_via(upcast(dyn(&c), Dyn(Speak))); // &Dyn(Speak, Run) -> &Dyn(Speak)
(b : Box(Dyn(Speak, Run))) = dyn(Box.new(Dog()));
(s : Box(Dyn(Speak))) = upcast(b, Dyn(Speak)); // the box moves into the result
```

The target names the `Dyn`, never the pointer. It is checked at compile time, so it returns the
pointer, not an `Option`: every trait the target requires must be one the source carries (after
supertrait expansion), and every trait the target excludes (`!Send`) must be one the source
excludes. `upcast(one, Dyn(Speak, Run))` from a `Dyn(Speak)` is E0602.

**How it works.** The concrete type is erased at the upcast, but not at the `dyn(...)` sites that
built the source, and the compiler sees the whole program. For every `upcast(_, Dyn(Tgt))` of a
source `Dyn(Src)`, each `Dyn(Src)` vtable carries one extra pointer, `__yo_up_<Tgt>`, to the same
concrete type's `Dyn(Tgt)` vtable. The upcast replaces the vtable word:

```c
(Tgt){ .data = d.data, .vtable = d.vtable->__yo_up_Tgt }
```

This is how Rust implements `dyn Sub -> dyn Super`, and `downcast` on the result still finds the
original concrete type. A program with no `upcast` emits no extra pointers.

## Ownership

A `Dyn` has no ownership of its own; its pointer's applies (decision 7, amended by decision 49):

- **`Box(Dyn(T))`** owns its payload alone. It is move-only unless the trait list has `Clone`, in
  which case `b.clone()` makes an independent payload in the allocator that placed the source
  (decision 12).
- **`Rc(Dyn(T))` and `Arc(Dyn(T, Send, Sync))`** share one payload; `Rc.clone(h)` bumps the count,
  and the payload is read-only through the handle (decision 46).
- **`&Dyn(T)` and `&mut Dyn(T)`** borrow, under the reference rules of decision 43.

```yo
{ println } :: import("std/fmt");
Speak :: trait(speak : (fn(self : &Self) -> i32));
Cat :: struct(n : i32);
derive(Cat, Clone);
impl(Cat, Speak(speak : ((self : &Self) -> self.n)));
main :: (fn() -> unit)({
  (d : Box(Dyn(Speak, Clone))) = dyn(Box.new(Cat(n : i32(3))));
  e := d.clone(); // an independent payload: d and e share nothing
  both := (d.speak() + e.speak());
  println(&both);
  f := d; // the last use of d: a move
  one := f.speak();
  println(&one);
});
export(main);
```

`Clone` in the trait list gives the `Dyn` no method slot of its own, because its `clone` returns
the erased `Self`; it fills the `clone_into` slot. So a `Dyn` with `Clone` and another trait that
declares a callable `clone` method is E0616, like any other method-name clash.

**A copy whose source is used again is E0901.** Copying a `Box(Dyn(T))` moves it, so using the
source afterwards is the use of a moved value:

```yo ignore
(d : Box(Dyn(Speak))) = dyn(Box.new(Cat(n : i32(3))));
e := d; // value moved here
d.speak(); // error[E0901]: use of moved value: `d`
```

A copy out of storage that cannot give the value away (a field or element, a dereference, a
module-level binding, a `&mut` borrow, a `&T` parameter, a closure's capture) is rejected where it
is made. The note says which fix applies: `d.clone()` when the `Dyn` lists `Clone`; otherwise
moving the value, lending it, adding `Clone` to the trait list, or sharing it through
`Rc(Dyn(...))`. A copying accessor on a collection of a non-`Clone` owned `Dyn` (`xs.get(i)`,
`xs.last()`) is E0901 at the call: read the element through the subscript (`xs(i).m()`) or move
it out (`xs.pop()`).

**`Send` and `Sync` come from the trait list.** `Box(Dyn(T, Send))` may move to another thread.
`Arc(Dyn(...))` needs a list that says `Send, Sync`. `Rc(Dyn(...))` is neither.

**Errors are thrown by value.** `Exception.throw` and `ResumableException(T).throw` take
`error : AnyError` by value, so a handler owns the error it catches and keeps it (stores it,
returns it, wraps it in a `Context`) by moving it, and lends it to a function that only reads it.
`AnyError` is the owning `Dyn(Error, Clone)` in v0.2.77; v0.2.78 spells it `Box(Dyn(Error))`.

## Summary of Design

1. **`Dyn` is unsized.** It lives behind a pointer, and the pointer owns it: `Box` uniquely, `Rc`
   and `Arc` shared and read-only, `&`/`&mut` borrowed.
2. **Every pointer to a `Dyn` is fat**: `{ data, vtable }`, so a borrow costs no allocation.
3. **One vtable per concrete type and trait list**, shared by every pointer kind: a prefix
   `{ type_id, size, align, drop_in_place, clone_into }`, then the method slots.
4. **`dyn(...)` is the one spelled unsizing**: `dyn(Box.new(v))`, `dyn(Rc.new(v))`,
   `dyn(Arc.new(v))`, `dyn(&v)`, `dyn(&mut v)`.
5. **`downcast` and `upcast` keep the pointer kind**: through a reference, `downcast` borrows the
   payload as `Option(&V)`; `upcast` replaces the vtable word.
6. **In v0.2.77** `Box(Dyn(T))` is the older owning value, `Rc(Dyn(T))` takes two allocations, the
   owning `downcast` is spelled on `&d.*`, and a `dyn(&v)` reference is a call argument only;
   `yo fix --migrate unsized` writes the older spellings the new way.
