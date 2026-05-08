---
applyTo: "**/*.yo"
description: "Use when writing or editing Yo language code. Covers critical syntax rules: curly brace semantics, cond/match parentheses, function definitions, parsing ambiguities, and expression vs block distinctions."
---

# Yo Language Syntax Rules

## Curly braces `{...}` behave differently based on separators

- `{ expr }` without semicolons creates an **anonymous struct value**, NOT a block!
- `{ expr; }` with semicolons creates a **begin block** (sequence of statements)
- Struct literal fields use spaces around `:` and infix field values must stay grouped: `{ x : (1 + 2), y : 3 }`, not `{ x: 1 + 2, y: 3 }`.
- If you want a single expression, write `expr` directly. Don't wrap it in `{...}` unless you need a struct.
- **The parser now detects this mistake and emits a clear error**: if `{ }` contains a single non-struct expression (a function call, `match`, `cond`, `while`, etc.), it fails with: `{ ... } without semicolons is parsed as a struct literal, not a block.`

```rust
// WRONG - creates a struct:
result := { .Ok(()) }

// CORRECT - just the expression:
result := .Ok(())

// CORRECT - begin block with statements:
result := { x := 1; y := 2; .Ok(()) }

// WRONG - invalid anonymous struct value:
print_bool :: (fn(value: bool) -> i32)({
  cond(
    value => i32(1),
    true => i32(0)
  )
});

// CORRECT - just the expression:
print_bool :: (fn(value: bool) -> i32)(
  cond(
    value => i32(1),
    true => i32(0)
  )
);

// WRONG - lambda body wraps single expression in {...}, creating a struct:
io.async((using(io : IO)) => {
  cond(
    done => .Ok(()),
    true => .Err(e)
  )
})

// CORRECT - lambda body is just the expression, no {...}:
io.async((using(io : IO)) =>
  cond(
    done => .Ok(()),
    true => .Err(e)
  )
)
```

## Always write `cond(...)` and `match(...)` with parentheses

- `cond(...)` - NOT `cond ...`
- `match(...)` - NOT `match ...`
- The parentheses are **required** and must not be omitted.
- Always write `cond(condition => result, true => default)`

## `if` is a macro for `cond`

`if` is defined in `prelude.yo` as a macro that expands to `cond`:

```rust
if(condition, then_body)        // → cond(condition => then_body, true => ())
if(condition, then_body, else)  // → cond(condition => then_body, true => else)
```

Use `if` for simple two-branch conditionals — especially for comptime early-return guards:

```rust
if((arch == Arch.Wasm32), {
  printf("  skipped on wasm32\n");
  return();
});
```

Use `cond` when there are more than two branches or when the branches are large.

## Function definitions

- `(fn(param1 : Type1, param2 : Type2) -> ReturnType)({ body; return(expr); })`
- No space between `(fn() -> ReturnType)` and `({ body; })`
- Function type body creation is a normal call: `(fn(...) -> T)({ body })`, not `(fn(...) -> T) { body }`
- Method definitions in `impl` use `name : (fn(self : Self) -> ReturnType)({ body })`
- Use `Self` instead of the type name in method signatures, enum definitions, and struct definitions — the type name is not available inside its own definition
- Use `struct(...)` for record/effect-record types. The old `module(...)`,
  `Module`, and `SelfModule` syntax has been removed; imported source files are
  namespace structs, and recursive type references use normal `Self`.
- Bare `Module` is not a type-hierarchy alias anymore. Use `Type` for
  compile-time type parameters/returns, and reflect source-module namespaces as
  ordinary `TypeInfo.Struct(...)` values.

## Anonymous function (`=>`) parameters cannot have type annotations

The `=>` arrow form is for anonymous functions whose parameter types are inferred from the expected `Fn(...)` signature at the call site. **You cannot annotate `=>` parameters with `: Type`** — parameter types come from the expected `Fn` signature.

```rust
// CORRECT — types inferred from expected Fn signature:
filtered := iter.filter((x) => (x.* > i32(2)));

// CORRECT — single parameter, parens optional:
filtered := iter.filter(x => (x.* > i32(2)));

// WRONG — `=>` parameters cannot have type annotations:
filtered := iter.filter((x : *(i32)) => (x.* > i32(2)));
```

If you need to specify parameter types explicitly, use the full `fn(...)` form or `Impl(Fn(...))(...)`:

```rust
// Use fn(...) form when types must be explicit:
pred :: (fn(x : *(i32)) -> bool)(x.* > i32(2));
filtered := iter.filter(pred);

// Or inline:
filtered := iter.filter((fn(x : *(i32)) -> bool)(x.* > i32(2)));
```

## Return value rules

- The last expression in `{ ... }` without semicolon is the return value of the struct or enum constructor.
- With semicolon, like `{ expr; }`, the return value is `unit`.

## Enum definition syntax

Enum variants are defined **without** the `.` prefix. The `.` prefix is only used when **constructing** or **pattern matching** enum values.

**Use `Self` to refer to the enum type itself** inside the `enum(...)` definition — the type name is not yet available during the definition. This applies to recursive types using `Box(Self)`, `ArrayList(Self)`, etc.:

```rust
// CORRECT — use Self for recursive references:
Expr :: enum(
  Atom(id : ExprId, token : Token),
  FnCall(id : ExprId, func : Box(Self), args : ArrayList(Self), token : Token)
);

// WRONG — type name not available inside its own definition:
Expr :: enum(
  Atom(id : ExprId, token : Token),
  FnCall(id : ExprId, func : Box(Expr), args : ArrayList(Expr), token : Token)
);

// CORRECT — no dots in definition:
Color :: enum(Red, Green, Blue);
Option :: (fn(comptime(T) : Type) -> comptime(Type))(
  enum(None, Some(value : T))
);

// WRONG — dots in definition:
Color :: enum(.Red, .Green, .Blue);

// Dots are used when constructing values:
(c : Color) = .Red;
(x : Option(i32)) = .Some(i32(42));

// Dots are used in match branches:
match(c,
  .Red => println(`red`),
  .Green => println(`green`),
  .Blue => println(`blue`)
);
```

## All function, keyword, and prefix-operator calls require immediate `(...)`

- Write `func(arg1, arg2)`, not `func arg1, arg2`.
- Do not insert whitespace before call parentheses: `func(arg)`, not `func (arg)`.
- Control-flow keywords follow the same rule: `return(value)`, `return()`, `escape(value)`, `escape()`.
- Prefix operators follow the same rule: `&(x)`, `!(ready)`, `-(value)`, `~(bits)`.

This avoids ambiguous parses such as `&x, y`:

```rust
// WRONG:
call(&x, y)

// CORRECT — pass a pointer and another argument:
call(&(x), y)

// CORRECT — take the address of a tuple:
call(&(x, y))
```

Parens are also required for zero-argument control flow:

```rust
if((arch == Arch.Wasm32), {
  return();
});
```

## No operator precedence

Always use parentheses to group operations: `((a + b) * c)` not `a + b * c`

Every binary operation must be explicitly parenthesized. When chaining the same operator 3+ times, nest parentheses left-to-right:

```rust
// WRONG — 3+ operands without nesting:
(A | B | C)
(A | B | C | D)

// CORRECT — nest left-to-right:
((A | B) | C)
(((A | B) | C) | D)
```

This also applies to `fn` type annotations on the same line — always wrap in parentheses to avoid ambiguity with `->`:

```rust
// WRONG — bare fn type on same line as `:`:
next : fn(self : *(Self)) -> Option(Self.Item)

// CORRECT — parenthesized fn type:
next : (fn(self : *(Self)) -> Option(Self.Item))

// ALSO CORRECT — newline after `:` triggers right associativity:
next :
  fn(self : *(Self)) -> Option(Self.Item)
```

Example: `((value <= 0x10FFFF) && ((value < 0xD800) || (value > 0xDFFF)))`

```
// WRONG — ambiguous parsing without parentheses:
err1 : AnyErr = dyn(ErrA(`error A`));

// WRONG — parsed as `err1 : (AnyErr = dyn(...))`:
err1 :
  AnyErr = dyn(ErrA(`error A`));

// CORRECT — parentheses around the declaration:
(err1 : AnyErr) = dyn(ErrA(`error A`));
```

## Unary operators need parentheses around their operand

Unary operators like `!`, `&`, and `-` greedily consume everything that follows, including comma-separated arguments. Always wrap the operand in parentheses.

```rust
// WRONG — `!` captures `d.is_empty(), "msg"` as one expression:
assert(!d.is_empty(), "should not be empty");

// CORRECT — parentheses limit the operand:
assert(!(d.is_empty()), "should not be empty");

// WRONG — `&` captures `s, label, extra` as a TUPLE argument:
func(&s, label, extra);  // parsed as func(&(s, label, extra)) — one tuple arg!

// CORRECT — take address first, then pass separately:
p := &s;
func(p, label, extra);
// OR — wrap the operand only (preferred — matches how the parser thinks about it):
func(&(s), label, extra);
// Equivalent — outer parens around the whole unary expression:
func((&s), label, extra);
```

This applies to **all** unary operators: `!`, `&`, `-`, `~`. Any of them placed before a comma-separated list will greedily absorb the entire list as a tuple.

**Critical: `!x && y` is parsed as `!(x && y)`**, not `(!x) && y`.

Because prefix `!` is treated as a function call that consumes the entire following expression (parsed by `parseExpression`, which includes all infix operators), `!x && match(...)` is equivalent to `!(x && match(...))`. Always parenthesize the negated operand separately when it must be the left operand of `&&`:

```rust
// WRONG — `!x && match(...)` parses as `!(x && match(...))`:
(!is_infix && match(opt, .None => false, .Some(x) => pred(x))) => handle()

// CORRECT — parentheses around `!is_infix` make it a sub-expression:
((!is_infix) && match(opt, .None => false, .Some(x) => pred(x))) => handle()
```

This applies at any nesting depth: whenever you write `!expr && rhs`, add an extra layer of parentheses: `((!expr) && rhs)`.

**Special note for `object` types**: passing by value already propagates mutations (RC fields are shared), so `*(MyObject)` pointers are rarely needed. Prefer passing by value and avoid `&obj` in most cases.

## Recursion requires `recur`

Yo does **not** allow a function to call itself by name. Use the `recur` keyword instead:

```rust
// WRONG — "Variable 'factorial' not found":
factorial :: (fn(n : i32) -> i32)(
  cond(
    (n <= i32(1)) => i32(1),
    true => (n * factorial((n - i32(1))))
  )
);

// CORRECT — use recur:
factorial :: (fn(n : i32) -> i32)(
  cond(
    (n <= i32(1)) => i32(1),
    true => (n * recur((n - i32(1))))
  )
);
```

For methods, pass `self` explicitly as the first argument:

```rust
impl(Tree,
  depth : (fn(self : Self) -> i32)(
    cond(
      self.is_leaf() => i32(0),
      true => (i32(1) + recur(self.left()))
    )
  )
)
```

`recur` works in any `fn` body (free functions and methods). The arguments must match the function's parameter types.

### Async recursion — `recur` does NOT work inside `io.async`

`recur` refers to the **nearest enclosing `fn`**. Inside `io.async((using(io)) => ...)`, that lambda _is_ the enclosing `fn`, so `recur` would call the lambda — not the outer function. This causes an argument-type mismatch error.

**Pattern for async recursion**: Replace recursion with an iterative worklist:

```rust
// WRONG — "Variable 'walk_dir' not found" inside io.async:
walk_dir :: (fn(path: Path, using(io: IO)) -> Impl(Future(unit, IO)))(
  io.async((using(io)) => {
    entries := io.await(read_dir(path));
    // CANNOT call walk_dir recursively here
  })
);

// CORRECT — use an explicit stack inside a single io.async:
walk_dir :: (fn(root: Path, using(io: IO, exn: Exception)) -> Impl(Future(unit, IO, Exception)))(
  io.async((using(io, exn)) => {
    stack := ArrayList(Path).new();
    { stack.push(root); };
    while(runtime((stack.len() > usize(0))), {
      cur := match(stack.pop(), .Some(p) => p, .None => return());
      entries := io.await(read_dir(cur));
      // process entries, push subdirs to stack…
    });
  })
);
```

### `Self` in generic type constructors

`Self` works inside generic type constructor functions too — it refers to the current type instantiation (e.g., `Tree(T)` inside `Tree`):

```rust
// CORRECT — Self refers to Tree(T):
Tree :: (fn(comptime(T) : Type) -> comptime(Type))(
  enum(
    Leaf(value : T),
    Node(left : Box(Self), right : Box(Self))
  )
);

// WRONG — Tree is not available inside its own body:
Tree :: (fn(comptime(T) : Type) -> comptime(Type))(
  enum(
    Leaf(value : T),
    Node(left : Box(Tree(T)), right : Box(Tree(T)))
  )
);
```

Use `recur(args)` only when calling the type constructor with **different** type arguments than the current instantiation (e.g., `recur(i32)` inside `Tree(T)` to get `Tree(i32)`).

## Module imports

Use destructured imports for files in the same directory:

```rust
// CORRECT — destructured import with relative path:
{ RegexNode, NodeKind, CharRange } :: import("./node.yo");

// CORRECT - Named module
node_module :: import("./node.yo");

// CORRECT — open import for std library modules:
open(import("std/collections/array_list"));
open(import("std/string"));

// WRONG — `import "path" as name` does NOT work for .yo files:
// import "./node.yo" as node;  // causes "Invalid function call on type: comptime_string"

// WRONG — absolute-style paths from within a subdirectory:
// import "std/regex/node" as node;  // module resolution fails
```

For files within the same directory, always use relative paths (`./file.yo`). For std library modules, use the standard `"std/module"` path.

**Do NOT import `std/prelude`** — the prelude is automatically loaded for every file. Explicitly importing it (`import "std/prelude"` or `import "std/prelude.yo"`) will produce a compile error. Third-party modules named `prelude.yo` are fine — only the std prelude is blocked.

## GADT enum syntax

GADT constructors use `-> recur(Type1, Type2, ...)` after fields to specify the return type:

```rust
Value :: (fn(comptime(T) : Type) -> comptime(Type))(
  enum(
    IntVal(i : i32) -> recur(i32),       // constructs Value(i32)
    BoolVal(b : bool) -> recur(bool),    // constructs Value(bool)
    MGeneric(v : T)                       // no annotation = unconstrained
  )
);
```

With discriminants, wrap the variant in parentheses:

```rust
Tagged :: (fn(comptime(T) : Type) -> comptime(Type))(
  enum(
    (TagInt(i : i32) -> recur(i32)) = 10,
    (TagBool(b : bool) -> recur(bool)) = 20
  )
);
```

## Other syntax notes

- `unit` is a type not value, `()` is the unit value.
- There is no `loop` function. Use `while(true, body)` for a runtime infinite loop.
- **`while(cond, body)` is always a runtime loop**, regardless of whether `cond` is compile-time known.
- **`while(comptime(cond), body)`** explicitly opts into compile-time loop unrolling. Requires `cond` to be a compile-time-known value. The evaluator will error if it detects an infinite loop (e.g., `while(comptime(true), ...)` with no `break`/`return`/`escape`).
- If you use a comptime-only (`::`) variable in a bare `while` condition (without `comptime()`), the compiler will **error**: the condition would never change at runtime, causing an infinite loop.
- When calling `assert`, always add 2nd argument: `assert(condition, "error message");`
- Pointer arithmetic uses `&+`, `&-`, `&<`, `&>`, `&<=`, `&>=` operators with `&` prefix.

## `for` loop macro — correct form

The `for` macro is a 2-argument prelude macro. The **first argument must be an iterator** (an expression with a `.next()` method):

```rust
for(list.iter(), x => { process(x); });          // ArrayList/array — call .iter() first
for(map.into_iter(), bucket => { ... });          // consuming iterator
for(list.iter(), (ptr) => { ptr.* = transform(ptr.*); });  // borrowing iterator
```

- First argument: an **iterator** expression — call `.iter()` or `.into_iter()` on collections first
- Second argument: an anonymous closure `item => { body }` (the `=>` form, no type annotation needed)
- **Do NOT pass a raw array/ArrayList as first arg without `.iter()`** — they don't have `.next()`
- **Do NOT use `for(x, arr, { body })`** — this older 3-arg form is an evaluator-internal representation and is not valid top-level Yo source. (The self-hosted evaluator's internal for-loop handler currently only understands the 3-arg form; this is tracked in `issues/eval-for-loop-3arg-vs-2arg.md`.)

## Function call syntax — required immediate `(`

In Yo, function calls must always use immediate parentheses:

- `func(a, b)` — normal call with two arguments
- `func (a, b)` — invalid whitespace before `(`
- `func a, b, c` — invalid paren-less call
- Prefix operators follow the same rule: `&(x)`, `!(ready)`, `-(value)`
- Control flow follows the same rule: `return(value)`, `return()`, `escape(value)`, `escape()`

Always use `func(a, b)` with no space. Never `func (a, b)` or `func a, b`.

## Partial application with `_` placeholder

Use `_` as a placeholder argument to partially apply any comptime function:

```rust
// Type constructors (return comptime(Type)):
IntResult :: Result(_, i32);    // fn(comptime(T) : Type) -> comptime(Type)
(r : IntResult(bool)) = .Ok(true);  // = Result(bool, i32)

// Comptime value functions:
add :: (fn(comptime(x) : i32, comptime(y) : i32) -> comptime(i32))((x + y));
add1 :: add(i32(1), _);  // fn(comptime(y) : i32) -> comptime(i32)
result :: add1(i32(2));   // 3
```

- `_` is only valid in arguments to **comptime functions** (functions with `comptime` return type)
- The number of arguments must match the original function's parameter count
- `_` cannot be used with runtime functions

## `return` requires parentheses

`return expr` is invalid. Use `return(expr)` or `return()` for unit. Inside match/cond branches, use begin blocks when you need early return:

```rust
// WRONG — paren-less return:
match(opt,
  .Some(p) => return str.from_raw_parts(p, len),
  .None => return ""
)

// CORRECT — explicit return calls:
match(opt,
  .Some(p) => {
    return(str.from_raw_parts(p, len));
  },
  .None => {
    return(str.from_raw_parts(*(u8)(""), usize(0)));
  }
)
```

Better yet, if the entire function body is just a match/cond expression, use the expression form (no body block) to avoid needing `return` at all:

```rust
// BEST — expression form, no return needed:
as_str : (fn(self: Self) -> str)(
  match(self._bytes._ptr,
    .Some(p) => str.from_raw_parts(p, self._bytes._length),
    .None => str.from_raw_parts(*(u8)(""), usize(0))
  )
)
```

## Nested destructuring patterns are NOT supported

Yo does not support nested pattern matching like `.Ok(.Some(value))`. Use multi-level matching instead:

```rust
// WRONG — nested destructuring:
match(result,
  .Ok(.Some(s)) => printf("got: %s\n", s),
  .Ok(.None) => printf("none\n"),
  .Err(e) => printf("error\n")
)

// CORRECT — two-level matching:
match(result,
  .Ok(inner) => match(inner,
    .Some(s) => printf("got: %s\n", s),
    .None => printf("none\n")
  ),
  .Err(e) => printf("error\n")
)
```

## Match destructuring forms

Match arms support three destructuring shapes for enum variants. All three coexist (different arms can use different forms within the same `match`):

```rust
Shape :: enum(
  Circle(radius : i32),
  Rectangle(width : i32, height : i32)
);

match(s,
  // 1. Positional — order matches field declaration. Must list all fields.
  .Rectangle(w, h) => (w * h),

  // 2. Labeled — `(label: var)` pairs. Order-free, supports partial matches.
  .Circle(radius: r) => (r * r),

  // 3. Curly shorthand — `{a, b: c}` is sugar for `(a: a, b: c)`.
  //    Bare atoms become `name: name`. Order-free, supports partial matches.
  .Rectangle({width, height: h}) => (width * h)
)
```

Curly destructuring rules:

- `{a}` binds field `a` to a variable named `a` (label = name shortcut).
- `{a: x}` binds field `a` to a variable named `x` (rename).
- `{a: _}` asserts field `a` exists but ignores its value.
- Partial matches are allowed: `{width}` on `Rectangle(width, height)` skips `height`.
- Empty `{}` is rejected — use `.Variant` (no parens) for fieldless variants.
- Bare `_` (e.g., `{_}`) is rejected — use `{label: _}` to ignore a specific field.
- Nested curly `.Foo({a: {b}})` is rejected — destructure in the body instead.

The parser rewrites `{...}` to `_(...)` and turns bare atoms into `(name: name)` pairs at parse time, so internally curly form is just a labeled-destructuring pattern wrapped in `_(...)`. The match evaluator unwraps that wrapper.

## String literal types

- Double-quoted strings `"hello"` return `str` type (a newtype over `Slice(u8)`) at runtime, but `comptime_string` at compile time.
- `comptime_string` does NOT automatically convert to `str` in return statements. Use `str.from_raw_parts(*(u8)("..."), usize(N))` if you need a runtime `str`.
- `*(u8)("literal")` works — casting `comptime_string` to pointer is valid.
- Only pointer-to-pointer and `comptime_string`-to-pointer casts are allowed. Integer-to-pointer casts like `*(void)(usize(0))` are NOT supported.
- **Template strings for constant `String` values**: Use `` `hello` `` instead of `String.from("hello")`. Template strings without interpolation produce the same `String` result in fewer characters.

## Trait method dispatch syntax

### Implicit dispatch (via where-clause)

When a generic function has `where(T <: Trait)`, calling `self.method()` on a parameter of type `T` dispatches to `Trait`'s method:

```rust
use_t1 :: (fn(forall(T : Type), self : T, where(T <: T1)) -> i32)({
  return(self.get_number());  // Dispatches to T1.get_number
});
```

### Explicit trait dispatch

Use `(T <: Trait).method(self)` to explicitly select which trait's method to call:

```rust
use_t2 :: (fn(forall(T : Type), self : T, where(T <: T2)) -> i32)({
  return((T <: T2).get_number(self));  // Explicitly calls T2.get_number
});
```

This is necessary when:

- A type implements multiple traits with the same method name
- You want to be explicit about which trait's method is called
- The `self` parameter type doesn't uniquely determine the trait

## `impl(...)` requires a trailing semicolon

`impl(...)` is a statement and requires a trailing `;` at the top level:

```rust
// WRONG — missing semicolon causes "Invalid function call on type":
impl(MyType,
  get : (fn(self : Self) -> i32)(self.x)
)

// CORRECT:
impl(MyType,
  get : (fn(self : Self) -> i32)(self.x)
);
```

## Reserved keywords cannot be used as variable or field names

The word `type` is a reserved keyword in Yo. Never use it as a parameter name, field name, or variable name:

```rust
// WRONG — `type` is reserved:
Variable :: object(name : String, type : TypeValue);
define :: (fn(ty : TypeValue) -> unit)(...)  // CORRECT, use `ty`

// CORRECT — rename to `ty`:
Variable :: object(name : String, ty : TypeValue);
```

Other reserved words to avoid as identifiers: `fn`, `type`, `trait`, `impl`, `enum`, `struct`, `object`, `newtype`, `match`, `cond`, `if`, `while`, `for`, `return`, `escape`, `recur`, `export`, `import`, `using`, `given`, `forall`, `where`.

## `___` (discard) cannot be used twice in the same scope

Yo does not allow redeclaring `___` twice in the same begin-block scope. Each use is a fresh variable binding and shadowing is not allowed:

```rust
// WRONG — second `___` shadows the first, causing a compile error:
___ := foo();
___ := bar();

// CORRECT — use unique names, or call without binding:
_a := foo();
_b := bar();

// ALSO CORRECT — if you don't need the results:
foo();
bar();
```

## ArrayList indexing via `arr(index)`

`ArrayList(T)` implements the `Index` trait, so elements can be accessed with call syntax:

```rust
{ ArrayList } :: import("std/collections/array_list");

list := ArrayList(i32).new();
list.push(i32(10));
list.push(i32(20));

val := list(usize(0));       // → i32  (value copy)
list(usize(0)) = i32(99);   // mutate in place directly (preferred)

// When you need the pointer explicitly:
ptr := &(list(usize(0)));    // → *(i32)
ptr.* = i32(100);            // also works
```

- `list(i)` returns the value `T` directly (not a pointer)
- `list(i) = val` mutates in place directly — preferred form
- `&(list(i))` returns `*(T)` for in-place mutation via pointer (explicit form)
- `list.get(i)` returns `Option(T)` for safe bounds-checked access
- Out-of-bounds access via `list(i)` panics at runtime

## Module-level declarations are processed in order

`::` definitions at the top level are evaluated sequentially. A function body that calls another top-level function declared later in the same file will fail with **"Variable not found"** at module load time.

Always define helper functions **before** the callers (bottom-up order):

```rust
// WRONG — evaluate references eval_atom which is not yet defined:
evaluate :: (fn(e : AstExpr, env : Env) -> Option(Result))(
  match(e,
    .Atom(tok) => eval_atom(tok, env),  // ERROR: Variable "eval_atom" not found
    _ => .None
  )
);

eval_atom :: (fn(tok : Token, env : Env) -> Option(Result))(...);

// CORRECT — define leaves first, callers last:
eval_atom :: (fn(tok : Token, env : Env) -> Option(Result))(...);

evaluate :: (fn(e : AstExpr, env : Env) -> Option(Result))(
  match(e,
    .Atom(tok) => eval_atom(tok, env),  // OK
    _ => .None
  )
);
```

**Exception**: methods inside the same `impl(...)` block **do** support forward references — a method declared earlier can call one declared later within the same block.

## Named constructor arguments are required for `struct`/`object` types

When constructing a `struct(...)` or `object(...)` value, always use named field syntax:

```rust
Point :: struct(x : i32, y : i32);

// CORRECT — named fields:
p := Point(x: i32(1), y: i32(2));

// WRONG — positional construction for struct/object is not supported:
p := Point(i32(1), i32(2));
```

`enum` variant construction is positional (fields are matched by order):

```rust
// CORRECT — enum variants use positional args:
(v : Option(i32)) = .Some(i32(42));
```
