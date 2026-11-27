# Modules

Modules: `import` and `export`, anonymous modules, module-level mutable
bindings, and the order-independence of a module's definitions. Packages and
`yo.toml` dependencies are in [BUILD_SYSTEM.md](./BUILD_SYSTEM.md); module file
names are in [SYNTAX.md](./SYNTAX.md#naming-convention).

## Module importing and exporting

```yo
// module1.yo
{ println } :: import("std/fmt");

demo :: (fn() -> unit)({
  println("Hello, world!");
});
export(demo);

// module2.yo
// Export the type
Maybe :: (fn(comptime(T) : Type) -> comptime(Type))(
  enum(
    Some(value : T),
    None
  )
);
export(Maybe);
```

```yo
{ ... } :: import("./module1.yo"); // Import everything from module1.yo
test_module :: import("./module1.yo"); // Import everything from module1.yo and put it in the test_module namespace
{ demo } :: import("./module1.yo"); // Import the demo function from module1.yo
{ demo : demo2 } :: import("./module1.yo"); // Import the demo function from module1.yo and rename it to demo2
{ Maybe } :: import("./module2.yo"); // Import Maybe type from module2.yo
```

### Importing a name twice

Every imported name is a binding, so the no-shadowing rule applies to imports: binding the same name twice is an error (`Failed to define variable "ArrayList"` … `variable shadowing is not allowed`), whether both lines name it or a `{ ... }` glob already brought it in. Several import lines from one path are fine as long as each binds different names, and a name may be imported again under a new one:

```yo
{ ArrayList } :: import("std/collections/array-list");
{ ArrayListIter } :: import("std/collections/array-list"); // fine: a different name
{ ArrayList : List } :: import("std/collections/array-list"); // fine: bound under a new name
xs := List(i32).new();
```

### Trait impls are visible through your imports

A method call resolves against the `impl(...)` blocks of the modules your
file can REACH through its imports (transitively) plus the prelude. An impl
that lives in a module nobody on your import path imports is not a
candidate, even if some other file in the same `yo check` or the same
program happens to have loaded it. Integer and `str` `to_string`, for
example, are `std/fmt`'s `ToString` impls, so a module that calls them
imports `std/fmt` (any binding will do: `{ ToString } :: import("std/fmt")`).
This is what makes a file's verdict the same whether it is checked alone or
beside its siblings. `YO_VISIBILITY_REPORT=1` lists, instead of rejecting,
every call that resolves only through an impl outside the caller's imports —
the tool for adding the missing import lines.

### Anonymous module

The anonymous module is defined using `impl` keyword followed by a `begin` block:

```yo
{ println } :: import("std/fmt");

my_module :: impl({
  my_function :: (fn() -> unit)({
    println("Hello from my_module!");
  });
  export(my_function);
});
```

### Module-level mutable variables

Yo supports mutable runtime variables at the top level of a module (file scope). These become C `static` file-scope variables, initialized before `main` runs.

Two syntaxes are supported:

```yo
// := initialization
counter := i32(0);

// Binding pattern initialization
(flag : bool) = false;
```

Functions defined in the same module can read and write these variables:

```yo
inc :: (fn() -> unit)({
  counter = (counter + i32(1));
});
```

**Restrictions:**

- Standalone type annotations without initialization are not allowed at module scope:
  ```yo
  a : i32; // ❌ Error: use `a := i32(0);` or `(a : i32) = i32(0);` instead
  ```
- Mutable runtime variables (`:=` or `(x : T) = val`) are **not allowed inside `impl` blocks**. Use `::` for compile-time definitions:
  ```yo ignore
  m :: impl {
    b := i32(13);  // ❌ Error: not allowed inside impl
    b :: 13;       // ✅ OK: compile-time constant
    export(b);
  };
  ```
- Module-level mutable variables **cannot be exported**. Only compile-time known values can be exported from modules.

## Definition Order

Within one module, **`name :: <definition>` bindings, `impl(...)` registrations
and `derive(T, ...)` statements are order-independent**. A definition may reference any other definition of the
same module regardless of where it appears in the file — a caller above its
callee, a function above the type it returns, mutual recursion between free
functions, a free function that calls a method or trait default whose `impl`
sits at the end of the file.

```yo
{ String } :: import("std/string");

// caller above callee
call_later :: (fn(n : i32) -> i32)(later_helper(n) * i32(2));
later_helper :: (fn(n : i32) -> i32)(n + i32(1));

// self-recursion through the function's own name (`recur` still works too)
fact :: (fn(n : i32) -> i32)(
  cond((n <= i32(1)) => i32(1), true => (n * fact(n - i32(1))))
);

// mutual recursion between free functions
is_even :: (fn(n : i32) -> bool)(cond((n == i32(0)) => true, true => is_odd(n - i32(1))));
is_odd :: (fn(n : i32) -> bool)(cond((n == i32(0)) => false, true => is_even(n - i32(1))));

// a type and a constant used above their definitions
make_point :: (fn(x : i32) -> Point)(Point(x : x, y : (x * SCALE)));
Point :: struct(x : i32, y : i32);
SCALE :: i32(7);

// an impl below the free function that uses it — the trait default included
say_hi :: (fn(d : &Dog) -> String)(d.greet());
Dog :: struct(n : String);
Greeter :: trait(
  name : (fn(self : &Self) -> String),
  (greet : (fn(self : &Self) -> String)) ?= (self -> (`hi ` + self.name()))
);
impl(Dog, Greeter(name : (fn(self : &Self) -> String)(self.n.clone())));

// a derive below the function that calls the method it derives
copy_bag :: (fn(b : &Bag) -> Bag)(b.clone());
Bag :: struct(n : i32);
derive(Bag, Clone);

// `export` may name a definition that appears after it
export(exported_later);
exported_later :: (fn() -> i32)(i32(99));
```

### What stays ordered

Statements whose **effects** are the module's observable evaluation keep strict
source order — they are not definitions:

| statement | why it is ordered |
| --- | --- |
| `{ a, b } :: import("...")`, `x :: import("...")`, `{ ... } :: import("...")` | loading a module registers its impls and brings names into scope |
| `pragma(...)` | applies to what follows |
| module-level runtime globals — `x := v`, `(g : T) = v` | runtime values initialized in order |
| `comptime(x) : T;` … `x = v;` (declare, then assign) | the declaration is a statement; the assignment fills it |
| `(comptime(x) : T) = v` | an assignment, not a `::` definition |
| `comptime_assert(...)`, bare expression statements | evaluated where written |
| `impl({ ... })` blocks and the bindings inside them | a module *value*; its fields are block-scoped and ordered |

A definition forced early sees only the statements that precede the **reference
that forced it**. If `helper` (line 60) uses a name brought in by an import at
line 50, and `caller` at line 30 forces `helper`, the import has not happened
yet and the check fails. Keep imports at the top of the file, as every module
in the standard library does.

The diagnostic for referencing an ordered statement that appears later names
it:

```
forward reference to "counter" (bound at line 3) — imports, pragmas and
runtime bindings are evaluated in order (only `::` definitions and `impl`
registrations are order-independent); move that statement above this use
```

### How it works

The module walker still evaluates statements top to bottom. Before it starts,
it pre-scans the module and records every `::` definition, every
`impl(<receiver>, ...)` and every `derive(T, ...)` as a **pending** entry (a
derive is a pending impl of `T`). Evaluation is then:

1. A statement whose entry is still pending is evaluated at its own position,
   exactly as before.
2. A lookup that **misses** — an identifier the environment does not know, an
   `export` of an unbound name, a method/trait lookup on a named type that
   finds nothing — checks the pending table of the identifier's module. A
   pending definition is **forced**: its statement is evaluated right there (as
   a module-level statement, in the module's environment) and the resulting
   binding is handed back. Pending `impl`s and `derive`s whose receiver head is
   the type in question are forced the same way, then the lookup retries.
3. When the walker later reaches a statement that was already forced, it skips
   it. Everything is bound by module end: laziness changes *when*, never
   *whether*.

Because forcing only happens on a lookup that would otherwise have been an
error, programs that are order-correct today evaluate in exactly the same
order and emit exactly the same C.

#### Function definitions are two-phase

Forcing `f :: (fn(...) -> R)(body)` binds `f` in two steps: the signature
head is evaluated and a function value with a stable id is **published** before
the body is evaluated. A reference to `f` from inside its own body
(self-recursion), or from a sibling definition the body forced (mutual
recursion), binds that published value. Only the `(fn(...) -> R)(body)` form
has a separately evaluated head; an anonymous `->`/`=>` literal infers from its
body, so a recursive function is written with `fn`.

#### Cycles

A definition whose *value* depends on itself is an error with the chain:

```
cyclic definition: A (line 2) → B (line 3) → A — a definition's value depends
on itself. Function definitions may reference each other (their signatures bind
before their bodies evaluate); a constant or type definition may not name itself.
```

#### Errors inside a forced definition

A definition that fails while being forced reports **its own** error, at its
own location, followed by a note saying why it ran early:

```
note: `second` (line 4) was evaluated here because it is referenced before its
definition in the source
```

### Inside an `impl` block

Sibling methods of one `impl(...)` block may call each other in any order
through `self.method(...)` or `Self.method(...)`:

```yo
N :: struct(value : i32);
impl(
  N,
  is_even : (fn(n : i32) -> bool)(cond((n == i32(0)) => true, true => Self.is_odd(n - i32(1)))),
  is_odd : (fn(n : i32) -> bool)(cond((n == i32(0)) => false, true => Self.is_even(n - i32(1))))
);
```

Bare-name references to a sibling method (`callee()` instead of
`self.callee()`) are **not** forward-bound inside an impl block: binding the
sibling as a local name would shadow same-named locals in other method bodies.
Module-level bare names are a different scope and *are* order-independent.

This works the same way as module-level definitions: the members of a block are
pending until the block reaches them, and a `self.callee()` / `Self.callee()`
lookup that misses forces `callee`'s real definition on the spot (its body is
type-checked and evaluated once, with the block's scope). Mutual recursion
between siblings resolves through the callee's signature, exactly as for two
`::` functions. If a forced sibling has a genuine error, the error is reported
at the sibling's own position with a note saying it was evaluated early because
a sibling referenced it.

A free function, a generic body or a method of *another* type may use methods
from any later `impl` block or `derive` of a type — a miss on the type forces
every pending impl of that type. From **inside** an `impl` block of `T`, a miss
on a method forces only the later `impl(T, ...)` blocks that declare that
method by name, and failing those, the later `derive(T, ...)` statements (a
derive declares its methods only once it runs). A trait-bound check from inside
the block forces nothing: while an impl of `T` is being evaluated, those misses
belong to the in-block sibling machinery.
