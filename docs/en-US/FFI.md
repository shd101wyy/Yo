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

```rust
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

```rust
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

```rust
abs :: (fn(x : i32) -> i32)(x);
c_include("<stdlib.h>", abs : (fn(x : int) -> int));
// error: Variable "abs" is already defined here (variable shadowing is not allowed)
```

Resolve it by qualifying (`libc :: c_include(...)`, then `libc.abs`) or by
renaming (`{ abs : c_abs } :: c_include(...)`).

## Definition order

A declaration statement is a lazy top-level definition like any `::` binding
(see [DEFINITION_ORDER.md](DEFINITION_ORDER.md)): a function defined above it
may call one of the names it binds, including a renamed one.

## The `std/libc` modules

`std/libc/*` wraps the common headers, one module per header, so most programs
never write `c_include` themselves:

```rust
{ strlen, memcpy } :: import("std/libc/string");
fcntl :: import("std/libc/fcntl");   // fcntl.open, fcntl.O_RDONLY
```

## Limits

- A C name that is not a Yo identifier (`struct stat`, `struct timespec`)
  cannot be declared as a type; pass such objects as `*(void)`.
- Adopting a Yo struct as a C struct (`Point : Type` where `Point` is already a
  Yo `struct`) lowers the Yo type to the C name and emits no definition of its
  own; the header's definition is the layout. Such a field is the existing
  type itself, so the glob leaves the existing `Point` binding in place rather
  than re-binding it (which the no-shadowing rule would reject).
