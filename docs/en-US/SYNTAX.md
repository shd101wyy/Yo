# Syntax

Yo's surface syntax: a program's entry point, calls and operators, bindings,
literals, control flow, naming and formatting. Data types are in
[DATA_TYPES.md](./DATA_TYPES.md), functions in
[FUNCTIONS.md](./FUNCTIONS.md), and the formal grammar in
[GRAMMAR.md](./GRAMMAR.md).

## Hello World

```yo
{ println } :: import("std/fmt");

main :: (fn() -> unit)({
  println("Hello, world!");
});

export(main);
```

`main` must return `unit`, and the compiler rejects any other result type. A
program body runs on a worker thread for its large stack, so a value returned
from `main` would have nowhere to go. Set a process exit status with `exit(code)` from `std/process`:

```yo
{ exit } :: import("std/process");

main :: (fn() -> unit)({
  if(!ok(), {
    exit(usize(1));
  });
});
export(main);
```

`main` may take an `io : Io` effect parameter (`main :: (fn(io : Io) -> unit)`);
the result type must be `unit`, and `Io` is the ONLY parameter the runtime
provides — the C wrapper zero-initializes parameters, so any other effect
record would carry NULL handler pointers and crash on first use. Bind other
handlers inside `main` instead (for example:
`exn := Exception(throw : ((err) -> { unwind(()); }));`).

## Calls, operators and blocks

```yo
// Comment is using `//` or `/* */`
/*
  Nested comments are supported
  /*
    Like this
  */
*/
// Yo syntax is inspired by Lisp, so there are no keywords
// It uses atoms and function calls only
x; // an atom (identifier)
func(x, y); // a function call with two arguments x and y.
// Please note there is no space between function name and parentheses
// Paren-less calls such as func x, y are invalid.
// Calls must use immediate parentheses. These are invalid:
// func x, y
// func (x, y)
// Yo is case sensitive, so `X` and `x` are different identifiers
// In Yo, everything is a function: `x := true;` and `y :: 14;` are the
// reserved operators `:=` / `::` applied to two arguments, callable in
// prefix form too (here binding fresh names — shadowing is not allowed):
(:=)(x2, true);
(::)(y2, 14);
// although normally we won't write like this ^
// There is no arithmetic precedence in Yo
// Except for the "." which is not treated as an operator, but it has the highest precedence.
// "." has its own parsing rules, for example a.b + c.d is parsed as .(a, b) + .(c, d)
// Every infix operator takes two arguments on its left and right.
//
// Yo has NO operator precedence. A chain of the SAME operator is
// left-associative, so no parentheses are needed:
3 + 4 + 5; // parsed as (3 + 4) + 5
// But adjacent DIFFERENT operators are ambiguous and must be
// disambiguated with explicit parentheses:
//
//   3 + 4 - 5; // error: "+" and "-" are different operators
//
// must be written as
3 + (4 - 5);
// or
(3 + 4) - 5;

// Yo has a CLOSED operator set (plans/reference/OPERATOR_SET_AND_PRECEDENCE.md).
// A run of operator characters is split greedily against two fixed tables;
// anything not in them is a LEX ERROR, not a user-defined operator.
//   two-char: != && -> :: := <: << <= == => >= >> ?= ||
//   one-char: ! % & * + - / : < = > ? ^ | ~
//   dot family: . .. ..= ...
// Infix operators are translated to a dot method call:
// But they will be translated as dot method call:
(3 + 4) * 5; // is the same as
3.(+)(4).(*)(5);

{
  // Content within {...} with separator `;` is a begin block
  // which is used to group expressions together
  (); // () is a unit value
  12
};
// is the same as
begin(
  (),
  12
);
```

## Variable Declaration

Variables in Yo are declared with `:=` (runtime) or `::` (compile-time).

```yo
// "comptime" here means compile-time known
x := 5; // x: i32, runtime variable
y :: 5; // y: comptime_int, compile-time variable
// with explicit type declaration
(x : i32) = 5; // x: i32, runtime variable
(comptime(y) : comptime_int) = 5; // y: comptime_int, compile-time variable
// or
comptime(y) := 5;

// (:) function is used to denote a type
// (=) function is used to update a variable with a new value, or initialize a variable with a value
// (:=) function is used to denote a runtime variable with type inferred
// (::) function is used to denote a comptime variable with type inferred
x : i32; // Define a runtime variable
comptime(x) : i32; // Define a compile-time variable
// Initialize variables
(comptime(x) : comptime_int) = 12;
(y : i32) = 14;
(z : i32) = 16;

// can be written as:
(=)((:)(comptime(x), comptime_int), 12);
(=)((:)(y, i32), 14);
(=)((:)(z, i32), 16);

// They are equivalent to the following:
x :: 12;
y := 14;
z := 16;
```

### Bindings are immutable unless declared `mut(name)`

A binding cannot be written after its definition unless its name is wrapped
in `mut(...)`, as Rust's `let mut`.
The marker wraps the name in every binding position:

```yo
x := 0; // immutable
mut(n) := 0; // mutable
n = (n + 1); // OK
(mut(t) : i32) = 0;
mut(c) :: 12; // mutable at compile time
comptime(mut(d)) := 12; // a mutable compile-time variable
r := match(
  opt,
  .Some(mut(v)) => {
    v = (v + 1);
    v
  },
  .None => 0
);
{ a, mut(b) } := pair; // per name in a destructuring
```

`mut` gates four writes of the binding and of every place under it:

- reassignment (`x = v`);
- a field or element write (`p.x = v`, `a(i) = v`);
- a `&mut` lend (`f(&mut x)`, `y := &mut x.f`, `match(&mut x, …)`, a `&mut x` capture);
- a `&mut self` method call (`s.push_str("!")` on a `String`).

Each is error E0917 on a binding declared without the marker. A door behind a
shared handle writes through its own method: `RefCell.with_mut` takes `&self`
and writes the payload, so a `RefCell` binding changes what it holds with no
marker; reassigning the binding still needs one. A borrow
(`x : &mut T`, `y := &mut place`) is written through, not written. The first
assignment of a binding declared without a value (`(x : T);`) initializes it.

Parameters take no `mut`: they stay immutable. A body that changes a
by-value argument rebinds it, `mut(y) := x;`, which moves an owning value; one
that should change the caller's value takes `x : &mut T`. A module-level
binding follows the same rule: an unmarked one is Rust's `static`,
`mut(G) := v` is `static mut` (and is never lent to a call, E0916). A
compile-time binding reassigned while compiling is declared `mut(x) :: v` (or
`comptime(mut(x)) := v`), in a block or at module level. A `for` element and a
closure's capture-list entry take no `mut` either; a body that changes one
rebinds it.

`yo fix <path>` inserts the marker a write needs, one write per pass.

> `mut` is a reserved word: it wraps a binding's name (`mut(x) := v`) and follows `&` (`&mut T` in a slot, `&mut x` at a call site); a binding or parameter named `mut` is an error.

### No variable shadowing

Yo disallows variable shadowing to avoid confusion

```yo
x := 1;
x := 2; // Error: x is already declared
```

```yo
x := 1;
{
  x := 2; // Error: x is already declared
};
```

Variables can be shadowed in different block scopes:

```yo
{
  x := 1;
};
{
  x := 2; // Allowed: different scope
};
```

### Discarding a call result

When you call a function only for its side effect and do not need its result, write the call as a bare expression statement — do not bind it to a discard name:

```yo
// Preferred:
unsafe(unistd.close(fd));

// Works, but the binding is pure noise:
_ := unsafe(unistd.close(fd));
```

`_ := expr` declares a throwaway binding that is dropped at scope end (`_` may repeat within a scope; `___` may not). Reserve it for the rare cases where the binding itself matters — e.g. a test that counts drops via `ref_count(...)`, or forcing the value-evaluation path that a compile-error fixture depends on.

## Type inference

```yo
// A String is a value that owns its bytes on the heap
(my_string : String) = String.from("Hello, world"); // Heap-allocated bytes
my_string_2 := my_string.clone(); // An independent copy; `my_string_2 := my_string` would move it
// Primitive types are copied
my_int := 1; // Stack-allocated
my_int_2 := my_int; // my_int_2 is a copy
// Fixed-size arrays are value types
(my_int_array : Array(i32, 3)) = [1, 2, 3]; // Stack-allocated
my_int_array := [1, 2, 3]; // Array(i32, 3)
// ArrayList is a value too: it owns its heap buffer
(my_array_list : ArrayList(i32)) = ArrayList(i32).new(); // Heap-allocated buffer, one owner
Person :: struct(name : String, age : i32); // Value type (its String field is a value too)
p := Person(name : String.from("Alice"), age : 30);
_(name, age) := p; // name : String, age : i32
```

### Uninitialized variable

```yo
x : i32; // x : i32, uninitialized
// Compiler prevents using uninitialized variable.
println(x); // Compiler Error: x is uninitialized.
x = 1; // x : i32, initialized
```

### Integer literals and compile-time integers

An integer literal, a `::` constant and a folded constant expression have type `comptime_int`,
which is unbounded. It takes a fixed-width type only when it enters a slot of that type — a
typed binding, an assignment, an argument, a struct or enum field, a return value, a joined
`cond`/`match` arm, or a `T(x)` conversion — and it must fit that type:

```yo
(a : u8) = 255; // OK
(b : u8) = 300; // error[E1102]: the literal 300 does not fit in u8 (0..=255)
(c : i8) = -128; // OK
(d : u8) = (200 + 100); // error[E1102]: the compile-time value 300 does not fit in u8
k :: 3;
(e : u8) = k; // OK: a comptime_int constant takes the slot's type
f := u8(300); // error[E1102]
g := u8(i32(300)); // OK: a conversion between TYPED integers truncates (g == 44)
```

With no slot, a `comptime_int` defaults to `i32` (and a `comptime_float` to `f64`) when it becomes
a runtime value. In a `cond` or `match`, a comptime arm joins at its concrete sibling's type in
either order: `cond(c => 1, true => i64(2))` is an `i64`.

## Arithmetic and Failure Semantics

A safe Yo program never executes undefined behavior. Every way a runtime
operation can fail falls into one of three tiers:

| Tier | Mechanism | Examples |
| --- | --- | --- |
| Proven | a contract the verifier discharges | `requires(i < self.len())` at a call site |
| Typed | the failure is in the return type, and the caller must handle it | `list.get(i) -> Option(T)`, `checked_add`, `Result` |
| Trapped | a deterministic abort with `file:line:col` | the rows of the table below |

| Operation | Behavior |
| --- | --- |
| `+`, `-`, `*` overflow; `-MIN` | abort: `integer addition overflow (at …)`. Applies to every integer width, signed and unsigned |
| `/` or `%` by zero; `MIN / -1` | abort: `integer division or remainder by zero (at …)` |
| shift count ≥ width | abort: `shift count out of range: 64 not in [0, 64) (at …)` |
| `Array(T, N)` / `str.bytes(i)` index out of range | abort: `index out of bounds: i not in [0, n) (at …)` |
| float → integer cast | saturates at the target's MIN/MAX; `NaN` becomes `0` |
| integer → narrower integer cast | truncates |
| float `/` and `%` | IEEE results (`inf`, `nan`); never aborts |

The behavior is identical at every `--optimize` level. It is also the runtime
match of compile time: the same expressions on constants are compile errors,
and a comptime function that reaches a panic is a compile error that carries
its message. Arithmetic that wraps by design calls `wrapping_add`,
`wrapping_sub` or `wrapping_mul`. See [MEMORY_SAFETY.md](MEMORY_SAFETY.md) for
the full rules, including the `unwrap` ban.

## Control Flow

### cond

```yo
use_cond :: (fn(x : i32) -> unit)(
  cond(
    (x == 1) => println("x is 1"),
    (x == 2) => println("x is 2"),
    true => println("x is not 1 or 2")
  )
);
```

> Note: The last condition must be compile-time known value `true` to act as the default case.

### if/else

`if(condition, then, else)`

`if` is sugar for `cond`: the compiler desugars every `if(...)` call to
`cond(condition => then, true => else)` at parse time, so downstream
passes (including the async state machine) see a real `cond` node. The
prelude still carries the equivalent macro definition as the
specification and as a fallback for dynamically constructed ASTs (see
`std/prelude.yo` and `plans/reference/MACRO_POLICY.md`):

```yo
// Definition in prelude.yo (spec/fallback — normally desugared at parse time)
if :: (
  fn(
    quote(condition) : Expr,
    quote(then) : Expr,
    (quote(else) : Expr) ?= quote(())
  ) -> unquote(Expr)
)(
  quote(
    cond(
      unquote(condition) => unquote(then),
      true => unquote(else)
    )
  )
);

// Usage
main :: (fn() -> unit)({
  // If no return type, it is unit
  number := 3;

  if(
    number < 5,
    then : {
      println("condition was true");
    },
    else : {
      println("condition was false");
    }
  );

  if(number < 5, println("condition was true"), println("condition was false"));
});
```

### while

`while(condition, body)` or
`while(condition, step, body)`

```yo
factorial :: (fn(n : i32) -> i32)({
  result := 1;
  i := 1;
  while(i <= n, {
    result = (result * i);
    i = (i + 1);
  });
  result
});

factorial2 :: (fn(n : i32) -> i32)({
  result := 1;
  i := 1;
  while(i <= n, i = (i + 1), {
    result = (result * i);
  });
  result
});
```

### Iterator and for loop

The `Iterator` trait defines a sequence of values. It has an associated type `Item` and a `next` method that returns `Option(Self.Item)`:

```yo
Iterator :: trait(
  Item : Type,
  next : (fn(self : &mut Self) -> Option(Self.Item))
);
```

To implement `Iterator` for a type, provide the `Item` type and a `next` function:

```yo
Counter :: struct(_current : i32, _max : i32);

impl(
  Counter,
  Iterator(
    Item : i32,
    next : (
      self -> cond(
        (self._current >= self._max) => .None,
        true => {
          val := self._current;
          self._current = (self._current + i32(1));
          .Some(val)
        }
      )
    )
  )
);
```

The `IntoIterator` trait converts a collection into an iterator. It has a `where` clause that constrains the `IntoIter` associated type to implement `Iterator` with the matching `Item` type:

```yo
IntoIterator :: trait(
  Item : Type,
  IntoIter : Type,
  into_iter : (fn(self : Self) -> Self.IntoIter),
  where(Self.IntoIter <: Iterator(Item := Self.Item))
);
```

The `for` macro provides syntactic sugar for iterating. It calls `.next()` in a loop and pattern-matches on `Option`:

```yo
// for loop syntax
for(iter_expr, variable => .{
  // body
});
```

The `for` macro iterates **by value** — `for(coll, (x) => body)` lowers to `coll.into_iter()` followed by a standard `next()`-loop. `into_iter` takes the collection by value, so the value form **consumes** `coll`: the iterator owns it. A collection that is read again after the loop is walked in place with `for(&coll, x => body)` (below), or iterated as a copy, `for(coll.clone(), x => body)`. The same holds for the other iterators that hold their source: `chars()`, `bytes()`, `char_indices()` and `lines()` on a `String`, `keys()` and `values()` on a map, `chunks(n)` and `windows(n)` on a list. The collections and `String` are values, so a later use of one the loop consumed is E0901. A collection's `iter()` yields raw pointers into its storage and holds the storage, not the collection: it is for `pragma(Pragma.AllowUnsafe)` code, and the collection must outlive the walk. A value element is borrowed: writing its data through `x` (a `String` element, a struct element's `String` field) is E0908. In-place mutation of value elements uses the borrow form `for(&mut coll, x => body)` below, or an index loop with index writes:

```yo
// Value form — each `x` is yielded by value.
mut(list) := ArrayList(i32).new();
list.push(i32(10));
list.push(i32(20));
for(list, value => {
  println(&value);
});

// A borrowed `for` lends each element `&mut` — mutation lands in the collection.
Counter :: struct(n : i32);
mut(counters) := ArrayList(Counter).new();
counters.push(Counter(n : i32(1)));
for(&mut counters, c => {
  c.n = (c.n + i32(1));
});

// Struct/scalar elements: index writes mutate in place.
mut(arr) := Array(i32, 3)(1, 2, 3);
i := usize(0);
while(i < usize(3), {
  arr(i) = (arr(i) * i32(10));
  i = (i + usize(1));
});
// arr is now [10, 20, 30].
```

Combinator chains (`coll.into_iter().map(f)`, `.filter(p)`, `.fold(init, f)`, etc.) keep the value-yielding `Iterator` shape; a blanket `into_iter` impl `generic(I), where(I <: Iterator), I, into_iter : (fn(self) -> Self)` (identity) lets `for(combinator_chain, (x) => body)` work uniformly.

The borrow form `for(&mut coll, x => body)` hands the body each element in place: writing `x.* = …` writes the element. The sigil goes on the source and the element mode follows it. For a map, `for(&mut m, (k, v) => body)` lends each value (the key read-only). The loop is the value form over `(&mut coll).into_iter()`: the cursor `impl(&mut C, IntoIterator)` returns holds the lend of the collection for the whole loop, so the body reaches the collection only through `x`: naming it in the body is E0911. The read walk `for(&coll, x => body)` (`for(&m, (k, v) => body)` for a map) is the same over `(&coll).into_iter()` and binds each element as a read-only `&` reference: nothing is copied, a write through `x` is E0908, and the body may read the collection but not write it (E0911). Every std collection has the read walk; `HashSet` and `PriorityQueue` have no in-place walk, and `String` has neither (walk `s.chars()`). To read or grow a list while walking it, walk its positions, `for(xs.indices(), i => …)` with `xs(i)`. A source reached through an `Rc` is walked as `for(&xs.*, …)` (see [OWNERSHIP_AND_BORROWING.md](./OWNERSHIP_AND_BORROWING.md#iteration)).

```yo
mut(xs) := ArrayList(i32).new();
xs.push(i32(1));
for(&mut xs, x => {
  x = (x + i32(10));
});
// xs(usize(0)) is now 11.
```

Strings have explicit `chars()` (rune iteration), `char_indices()` (rune
iteration carrying each rune's byte offset) and `bytes()` (byte iteration).
String indexing itself is BYTE-based, like Rust and Go: `len()` is the byte
count at O(1), and every index a string method takes or returns is a byte
offset on a UTF-8 character boundary. The rune count is `s.chars().count()`.
See [STRINGS.md](./STRINGS.md) for the full contract.

## Naming Convention

2 spaces for indentation.

- `snake_case`
  - `function`
  - `variable`
  - a binding that holds a whole module (`array_list :: import("std/collections/array-list");`)
- `PascalCase`
  - `trait`
  - `type` and its variants
- `UPPER_SNAKE_CASE`
  - `constant`
- `kebab-case`: every name that is only ever a string, never an identifier
  - `package name` (`yo.toml`'s `[package] name` and dependency keys, e.g. `markdown-yo`)
  - `.yo` file name (`array-list.yo`, `hash-map.test.yo`)
  - `directory name`
  - `[modules]` key

A module path is only an `import(...)` string: nothing derives an identifier
from it, so one separator serves the whole path
(`import("markdown-yo/block-parser")`). `-` and `_` are different names, and
nothing normalizes one into the other; a name may contain `[A-Za-z0-9_-]` and
must not start or end with `-` (`yo check -foo.yo` would read a flag).
`check` and `compile` warn on a project-local module file or directory whose
name holds `_` or an upper-case letter, and `yo fix <path> --module-names`
renames them and rewrites every import, `[modules]` entry and `build.yo` root
that reaches them (`ERROR_DIAGNOSTICS.md`).

## Formatting with `yo fmt`

`yo fmt` is intentionally not configurable, following the same philosophy as `go fmt`: all Yo projects share one compact, consistent style with 2-space indentation.

When `yo fmt` would change a file, it first parses the original: a parse failure is reported like a lexer error (the bare diagnostic, exit code 1) and the file is left untouched, so a formatting pass can never rewrite — or mask — a tree the parser rejects. Files whose formatting is already canonical are not parsed; `yo check` remains the parseability gate.

`yo fmt` elides provably-redundant parentheses (a re-parse must reproduce the original tree, so a group is only removed when grouping cannot change) and keeps every load-bearing one. That includes the redundant LEFT groups of a same-operator chain at any operand count — `(((20 - 5) - 4) - 3)` formats to `20 - 5 - 4 - 3` — while a parenthesized right operand is always kept: `20 - (5 - 4) - 3` is left untouched.

The same rule removes two more kinds of group: parentheses around a whole call argument (`f((a + b))` becomes `f(a + b)`, because the call's own parentheses already group it) and around a bare prefix operand (`-(x)` becomes `-x`, `!(done)` becomes `!done`). It keeps a parenthesized right operand (`a + (b + c)`), a prefix operator's compound operand (`-(x + x)`, `!(a > b)`), the parentheses between two different operators (`(a * b) + c`), and the group around a binary right-hand side of `:=` or `=`, which E0003 requires. `yo fmt` never adds parentheses, so write the E0003 ones yourself. Before and after:

```yo ignore
// before
s1 := (((a - b) - c) - x);
s2 := (a + (b + c));
s3 := f((a + b));
s4 := -(x);
s5 := -(x + x);
s6 := ((a * b) + c);
ok := !(done);

// after `yo fmt`
s1 := (a - b - c - x);
s2 := (a + (b + c));
s3 := f(a + b);
s4 := -x;
s5 := -(x + x);
s6 := ((a * b) + c);
ok := !done;
```
