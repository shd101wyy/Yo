# FFI: `c_include` and `extern`

Yo reaches C through two declaration forms. Both are privileged — the file
needs `pragma(Pragma.AllowUnsafe);` — and every call of an `extern "c"`
function is wrapped in `unsafe(...)` at the call site (see
[MEMORY_SAFETY.md](MEMORY_SAFETY.md)).

- `c_include("<header.h>", name : Type, ...)` declares symbols that a C header
  provides. Codegen `#include`s the header wherever one of them is used.
- `extern("c", name : Type, ...)` declares C symbols with no header (you link
  them yourself). `extern("Yo", ...)` declares symbols of Yo's own C runtime.

## Both forms evaluate to a module value

A `c_include(...)` or `extern(...)` call is an expression whose value is a
**module** — the same kind of value `import("...")` produces. Its members do
not enter scope by themselves; you bind the module, or destructure it, exactly
as you would an import:

```yo
pragma(Pragma.AllowUnsafe);

// Bind the module and qualify each use.
c :: c_include(
  "<stdio.h>",
  FILE : Type,
  stdout : *FILE,
  fputs : (fn(s : *char, stream : *FILE) -> int)
);
unsafe(c.fputs((*char)("hello\n"), c.stdout));

// Select the members you want — and rename any of them.
{ strlen : c_strlen } :: c_include("<string.h>", strlen : (fn(s : *char) -> usize));
n := unsafe(c_strlen((*char)("hello")));

// Take everything under its own name (the glob).
{ ... } :: c_include("<stdlib.h>", abs : (fn(x : int) -> int));
```

Renaming is the ordinary destructuring rename `{ c_name : yo_name }`. It works
for functions, for globals (`{ M_PI : pi }`) and for opaque types
(`{ FILE : CFile }`): the emitted C always uses the C symbol.

A field's type may name an earlier field of the same declaration
(`FILE : Type, stdout : *FILE`).

## A bare statement is the glob

Written as a statement — at the top level of a file, or as a line of a block —
a `c_include(...)` or `extern(...)` is sugar for its glob destructure:

```yo
c_include("<stdlib.h>", abs : (fn(x : int) -> int));
// means exactly
{ ... } :: c_include("<stdlib.h>", abs : (fn(x : int) -> int));
```

So the familiar form still declares every listed name into the current scope,
and a declaration inside a function body is scoped to that body.

## No shadowing

Because the names arrive through a binding, the no-shadowing rule applies to
them like to any other binding: a declared name that is already visible in
scope is an error, whichever came first.

```yo
abs :: (fn(x : i32) -> i32)(x);
c_include("<stdlib.h>", abs : (fn(x : int) -> int));
// error: Variable "abs" is already defined here (variable shadowing is not allowed)
```

Resolve it by qualifying (`libc :: c_include(...)`, then `libc.abs`) or by
renaming (`{ abs : c_abs } :: c_include(...)`).

## Definition order

A declaration statement is a lazy top-level definition like any `::` binding
(see [MODULES.md](./MODULES.md#definition-order)): a function defined above it
may call one of the names it binds, including a renamed one.

## The `std/libc` modules

`std/libc/*` wraps the common headers, one module per header, so most programs
never write `c_include` themselves:

```yo
{ strlen, memcpy } :: import("std/libc/string");
fcntl :: import("std/libc/fcntl"); // fcntl.open, fcntl.O_RDONLY
```

## C types whose name is not a Yo identifier

An opaque `Name : Type` field lowers to the C type spelled `Name`. When the
C spelling is not a Yo identifier (`struct stat`, `struct timespec`), give
it explicitly with `c_type`:

```yo
{ stat_buf, stat } :: c_include(
  "<sys/stat.h>",
  stat_buf : c_type("struct stat"),
  stat : (fn(pathname : *char, statbuf : *stat_buf) -> int)
);
```

`stat_buf` is an opaque type in Yo and `struct stat` in the emitted C, so a
`*stat_buf` parameter is `struct stat*`. Adopting a Yo struct under a
`c_type` spelling (`Point : c_type("struct point")` where `Point` is a Yo
`struct`) lowers the Yo type to that spelling.

When you only need to hand the C function a buffer you allocated yourself
(an `ArrayList(u64)` sized to the struct, say), spell the parameter `*void`
and cast the buffer pointer with `(*void)(ptr)`: C converts `void *` to any
object pointer implicitly. Do not spell it as a pointer to the buffer's
element type. Yo emits no prototype for a `c_include` function — the header's
is the only one — so a parameter type that disagrees with the header is an
incompatible pointer type at the call, and the C compile step rejects it
with `-Werror=incompatible-pointer-types` on every platform.

## Limits

- Adopting a Yo struct as a C struct (`Point : Type` where `Point` is already a
  Yo `struct`) lowers the Yo type to the C name and emits no definition of its
  own; the header's definition is the layout. Such a field is the existing
  type itself, so the glob leaves the existing `Point` binding in place rather
  than re-binding it (which the no-shadowing rule would reject).

## Pointers

Yo uses pointers (`*(T)`) for direct memory access, similar to C. Operations that dereference or do arithmetic on raw pointers require an explicit `unsafe(...)` wrap — see [Memory Safety](#memory-safety) below.

```yo
// Pointer type: *(T)
x := 1;
y := 2;

swap :: (fn(a : *i32, b : *i32) -> unit)(
  unsafe({
    tmp := a.*; // Dereference pointer
    a.* = b.*;
    b.* = tmp;
  })
);

swap(addr_of(x), addr_of(y)); // Pass pointers to x and y
// Now x == 2, y == 1
```

For day-to-day in-place mutation, prefer the `name : &mut T` parameter form (see [Type Methods](./FUNCTIONS.md#type-methods)) — it lowers to the same `T*` ABI but stays safe and the caller lends the places with `&mut` (`swap(&mut x, &mut y)`) instead of taking raw addresses. Raw `*(T)` is reserved for FFI and the low-level cases this section covers.

`addr_of(x)` where `x` is a `&T` parameter, or a place inside one (`addr_of(x.field)`), is error E0921: a `&T` parameter is passed as a copy of the caller's value, so its address is the callee's copy and dangles when the call returns. Code that needs the caller's address takes `x : *T` and the caller passes `addr_of(place)`, or takes `x : &mut T`, which is passed as a pointer. A projection's `&T` parameter (a function returning `&T` or `&mut T`) is passed as a pointer and keeps `addr_of`; that is how the prelude's `Array` `Index` impl reaches the element.

### Pointer Operations

```yo
// Create a pointer with addr_of
x := 42;
ptr := addr_of(x); // ptr: *(i32)
// Dereference with .* (requires unsafe — may read invalid memory)
value := unsafe(ptr.*); // value == 42
// Modify through pointer (requires unsafe — could write to invalid memory)
unsafe(ptr.* = 100); // x is now 100
// Pointer arithmetic (requires unsafe — could produce OOB address)
arr := [1, 2, 3, 4, 5];
ptr := addr_of(arr(0)); // Pointer to first element
ptr2 := unsafe(ptr.add(2)); // Point to third element
value := unsafe(ptr2.*); // value == 3
// Pointer casting (safe — just changes type label on the address)
float_ptr := (*f32)(ptr); // Cast pointer to *(f32)
```

### Pointer Arithmetic and Comparison

Pointer arithmetic uses methods — `p.add(n)`, `p.sub(n)`, `p.offset_from(q)` — which require `unsafe(...)`. Pointer comparison uses the ordinary operators (`==`, `!=`, `<`, `<=`, `>`, `>=`) via the `Eq`/`Ord` impls on `*(T)` and stays safe — comparing addresses can't violate memory safety. Note that `*(T) ==` compares ADDRESSES (identity), while a handle such as `Rc(T)` compares VALUES via its own `Eq` impl.

```yo
pragma(Pragma.AllowUnsafe); // raw pointers need the unsafe-capable pragma
{ assert } :: import("std/assert");

test("Pointer arithmetic", {
  x := 12;
  p := addr_of(x);

  // Addition and subtraction (require unsafe — could produce
  // out-of-bounds addresses):
  q := unsafe(p.add(2)); // Advance pointer by 2 elements
  z := unsafe(q.sub(2)); // Go back 2 elements
  // Comparison operators (safe — addresses are just data):
  assert(q > p); // q is after p
  assert(p < q); // p is before q
  assert(q >= p); // Greater or equal
  assert(p <= q); // Less or equal
  assert(z == p); // Equal (same address)
  assert(p != q); // Not equal
  // Pointer difference also requires unsafe (assumes both point
  // into the same object):
  diff := unsafe(q.offset_from(p)); // Distance: 2 elements
  assert(diff == 2);
});
```

### Pointer Operations Reference

Arithmetic (methods, require `unsafe(...)`):

- `p.add(n)` : Advance by `n` elements
- `p.sub(n)` : Go back by `n` elements
- `p.offset_from(q)` : Signed element distance (`isize`)

Comparison (ordinary operators via `Eq`/`Ord` on `*(T)`, safe):

- `==` / `!=` : Address equality / inequality
- `<` / `<=` / `>` / `>=` : Address ordering

### The consume Function

`consume` tells the compiler that you're initializing memory, not overwriting an existing value. This prevents attempting to drop uninitialized memory:

```yo
// Without consume - Error: tries to drop uninitialized value
ptr.* = some_value; // Danger!
// With consume - OK: initialization, no drop
consume(ptr.* = some_value);
```

On any other argument, `consume(x)` moves `x` (a later use is "use of moved value") and, since it returns `unit`, it is the value's last owner: an owned value is released at the consume, exactly as `drop(x)` releases it. A binding that does not own its value (a `&T` borrow) is only marked moved.

For more pointer examples, see `tests/ptr.test.yo`.

### Nullable Pointers

Yo uses `Option(*(T))` for nullable pointers:

```yo
// malloc returns Option(*(void)) — it is NOT generic, so cast before use.
some_ptr := malloc(size_of(i32));
match(
  some_ptr,
  .Some(vp) => {
    ptr := (*i32)(vp);
    ptr.* = i32(42);
    printf("value: %d\n", ptr.*);
    free(some_ptr);
  },
  .None => printf("Allocation failed\n")
);
```

**Note**: Raw pointers are unsafe. Use `Rc`, `Arc`, `Box` and the owned collections for safe memory management whenever possible.

### `Option` of a handle is one pointer

`Option(T)` where `T` is a raw pointer OR a counted or boxed handle (`Rc`, `Arc`, `Box`) lowers to the bare pointer, with `NULL` as `.None`. The same niche applies to any two-variant enum with one fieldless variant and one single-field handle payload. There is no tag word and no extra padding: `size_of` is the pointer's own, and a `match` on such a value compiles to a NULL test.

```yo
pragma(Pragma.AllowUnsafe); // only so size_of may name a pointer type

sz_opt :: size_of(Option(*i32)); // == size_of(*i32) — the pointer itself
sz_str :: size_of(String); // == size_of(*u8)   — the handle itself
Tree :: enum(Empty, Node(child : Rc(Self)));
sz_tree :: size_of(Tree); // == size_of(*u8)   — NULL is Empty
```

### Memory Safety

For the user-facing guide, see [MEMORY_SAFETY.md](MEMORY_SAFETY.md) — covers the safe-by-default contract, `&mut T` parameters, the `pragma(Pragma.AllowUnsafe);` opt-in, `unsafe(...)` per-op wraps, `// SAFETY:` comment convention, `yo unsafe-report`, the `unwrap` ban, and the integer arithmetic rules (overflow, division by zero and out-of-range shifts abort).

Ownership, moves and copies, `&T`/`&mut T` references and their origins, and the borrow rules the compiler checks are explained in [OWNERSHIP_AND_BORROWING.md](OWNERSHIP_AND_BORROWING.md).

Yo's safety model is layered (the design plan is `plans/reference/MEMORY_SAFETY.md`):

- **`Rc(T)`** is a reference-counted cell, automatically freed at its last handle (a cycle leaks unless a `Weak` breaks it). Memory-safe by construction.
- **`Arc(T)`** provides atomic-RC ownership for thread-shared cases; a `Send` value is transferred to another thread by moving it.
- **`*(T)` raw pointers** are available only in a file that declares `pragma(Pragma.AllowUnsafe);`. Inside such a file the `unsafe(...)` wrap is the per-operation AUDIT MARKER that `yo unsafe-report` keys on — and the convention `std/`, `src/` and `tests/` follow — not a second compiler gate: a bare `p.*` in a pragma'd file compiles. In a file WITHOUT the pragma the whole raw-pointer surface is rejected, including the `*(T)` type itself.

`unsafe(...)` is a regular builtin call that takes exactly one expression. It is purely a compile-time marker — at codegen time it lowers to its inner expression, no runtime cost.

```yo
// Pointer deref requires unsafe:
read :: (fn(p : *i32) -> i32)(unsafe(p.*));

// Pointer arithmetic likewise:
advance :: (fn(p : *i32, n : usize) -> *i32)(unsafe(p.add(n)));

// Multi-statement unsafe with a block:
write_and_read :: (fn(p : *i32, v : i32) -> i32)(
  unsafe({
    p.* = v;
    p.*
  })
);

// Pointer comparison (==, <, etc.) and *(T) casts (e.g., (*u8)(p))
// stay safe — they don't dereference, so they're not gated.
```

**What requires `unsafe(...)`**: pointer dereference (`.*`), pointer arithmetic (`.add(n)`, `.sub(n)`, `.offset_from(q)`), and `consume(p.* = v)`.

**What needs no additional `unsafe(...)` wrap** (inside a file that already declares `pragma(Pragma.AllowUnsafe);`): taking an address (`addr_of(x)`), passing/storing/returning pointers, pointer comparison (`<`, `==`, etc.), pointer-type casts (`(*u8)(p)`), and `asm(...)` (already implicitly unsafe). None of these are available in SAFE code — without the pragma, `&(x)` is rejected at the construction site and a `*(T)` type in any signature is rejected outright.

The unsafe surface is greppable: every `unsafe(` token marks a place where raw memory ops happen. A file must declare `pragma(Pragma.AllowUnsafe);` at the top before it can use `unsafe(...)` or perform raw pointer operations. `std/`, `src/`, and `tests/` files declare this pragma explicitly; user code (`main.yo`, the rest of your project) defaults to safe mode and gets a compile error if it tries to use `unsafe(...)`.

For an at-a-glance audit, run `yo unsafe-report` (or `yo unsafe-report ./std` for stdlib alone). It lists every `unsafe(...)` site, `asm(...)` block, `extern(...)` declaration, and pragma-declaring file, with `file:line:col` jumps for editors. The `--json` flag emits machine-readable output for CI integrations.

```yo ignore
// File without pragma — `unsafe(...)` is rejected:
main :: (fn() -> unit)({
  x := i32(42);
  v := unsafe(x); // error: 'unsafe(...)' is not available in safe code.
  //        To use raw pointer operations, declare at the top:
  //            pragma(Pragma.AllowUnsafe);
});
```

```yo
// Opt in by adding the pragma at the top of the file:
pragma(Pragma.AllowUnsafe);

main :: (fn() -> unit)({
  x := i32(42);
  p := addr_of(x);
  v := unsafe(p.*); // OK
});
```

### `&mut` Parameters

For in-place mutation without raw pointers, use a `name : &mut T` parameter. The `&mut` prefixes the parameter's type, and the parameter behaves like a binding to the caller's variable — reads access the current value, writes update the caller's storage. At codegen time `name : &mut T` lowers to `T*` in C; the caller lends the place with `&mut x` and the compiler passes its address.

```yo
{ assert } :: import("std/assert");

swap :: (fn(a : &mut i32, b : &mut i32) -> unit)({
  tmp := a.*;
  a.* = b.*;
  b.* = tmp;
});

increment :: (fn(n : &mut i32) -> unit)({
  n.* = (n.* + i32(1));
});

main :: (fn() -> unit)({
  mut(x) := i32(1);
  mut(y) := i32(2);
  swap(&mut x, &mut y); // the call site lends each place with `&mut`
  assert(x == i32(2), "swapped");
  assert(y == i32(1), "swapped");

  mut(counter) := i32(0);
  increment(&mut counter);
  increment(&mut counter);
  assert(counter == i32(2), "incremented");
});
```

A `&mut T` parameter cannot be combined with `sink(...)` (opposite calling conventions) or with `generic(...)`; a compile-time parameter carries the mode on its type (`comptime(x) : &mut T`). For chained calls, passing a `&mut T` parameter through to another function's `&mut T` parameter works as expected (the parameter already holds a borrow, so it is passed bare):

```yo
double :: (fn(n : &mut i32) -> unit)({
  n.* = (n.* + n.*);
});

double_both :: (fn(x : &mut i32, y : &mut i32) -> unit)({
  double(x); // passes the borrow through to double's `&mut` parameter
  double(y);
});
```

### RAII (Resource Acquisition Is Initialization)

Yo manages memory automatically: an owned value is dropped at its owner's scope end, and a counted cell (`Rc`, `Arc`) is freed when its reference count reaches zero.

```yo
demo :: (fn() -> unit)({
  x := String.from("World!"); // RC = 1
  // ... use x ...
  // At end of scope, RC is decremented
  // If RC reaches 0, memory is automatically freed
});
```
