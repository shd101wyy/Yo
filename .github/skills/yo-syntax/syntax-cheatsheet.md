# Yo Syntax Cheatsheet

These are baseline syntax rules for portable Yo code.

## Mental model

- Everything is an expression.
- Separators change meaning:
  - commas build tuples, arrays, or struct literals
  - semicolons create sequencing or type shapes
- Prefer explicit syntax over relying on parser guesswork.

## Common declaration forms

```rust
{ println } :: import "std/fmt";

app_name :: "yo-demo";

main :: (fn() -> unit)({
  value := i32(1);
  (message : str) = "hello";
  println(message);
});

export main;
```

- Top-level binding: `name :: expr;`
- Local binding: `name := expr;`
- Typed binding: `(name : Type) = expr;`
- Function definition: `name :: (fn(args...) -> ReturnType)(body);`

## Blocks and expressions

| Goal              | Write                      | Avoid                      |
| ----------------- | -------------------------- | -------------------------- |
| Single expression | `cond(...)`                | `{ cond(...) }`            |
| Begin block       | `{ x := i32(1); x }`       | `{ x := i32(1), x }`       |
| Struct literal    | `{ name: "yo", ok: true }` | `{ name: "yo"; ok: true }` |

```rust
result := cond(
  ready => .Ok(()),
  true => .Err(`not ready`)
);

total := {
  base := i32(40);
  (base + i32(2))
};
```

Remember: `{ expr }` without semicolons is a struct literal, not a block.

## Control flow

```rust
value := cond(
  (x < i32(0)) => i32(-1),
  (x == i32(0)) => i32(0),
  true => i32(1)
);

label := match(token,
  .Identifier(name) => name,
  .Number(_) => "number",
  .Eof => "eof"
);

if(done, println("done"), println("pending"));
```

- Always write `cond(...)`, never bare `cond ...`
- Always write `match(...)`, never bare `match ...`
- `if(a, b)` and `if(a, b, c)` are macro forms over `cond`

## String types

| Syntax             | Type              | Context                          |
| ------------------ | ----------------- | -------------------------------- |
| `"hello"`          | `str`             | Runtime contexts (most code)     |
| `"hello"`          | `comptime_string` | Inside `comptime` functions      |
| `` `hello ${x}` `` | `String`          | Always (template string)         |
| `` `hello` ``      | `String`          | Always (template without interp) |
| `*(u8)("hello")`   | `*(u8)`           | Pointer cast for C interop       |

Key rules:

- In **runtime** code, `"hello"` is `str`. Mixing literals and variables in `cond`/`match` branches is fine.
- In **comptime** functions (return type `comptime(...)`), `"hello"` is `comptime_string` — it does NOT auto-convert to `str`.
- For `String` constants, prefer `` `hello` `` over `String.from("hello")`.

## Calls, operators, and whitespace

```rust
sum := add(i32(1), i32(2));
flag := ((a > b) && (b > c));
masked := ((A | B) | C);
```

- Prefer parenthesized calls: `func(arg1, arg2)`
- `func (a, b)` is a different parse shape than `func(a, b)`
- Yo has no operator precedence; fully parenthesize binary expressions
- Parenthesize unary operands: `!(ready)`, `-(value)`

## Functions and methods

```rust
double :: (fn(x : i32) -> i32)(
  (x * i32(2))
);

Counter :: struct(current : i32);

impl(Counter,
  next : (fn(self : Self) -> i32)({
    self.current = (self.current + i32(1));
    self.current
  })
);
```

- No space between a function type and its body: `(fn(...) -> T)(...)`
- Use `Self` in method signatures
- Wrap `fn` types in parentheses when they appear after `:`

### Named arguments and default values

```rust
create_user :: (fn(
  name : String,
  (age : i32) ?= 18
) -> User)(
  User(name: name, age: age)
);

create_user(name: `Alice`);
create_user(name: `Bob`, age: 30);
```

- Named arguments must keep the same order as the definition
- Default values use `?=` and must be compile-time known

### Implicit parameters (`using` / `given`)

```rust
Raise :: (fn(msg : String) -> i32);

safe_divide :: (fn(x : i32, y : i32, using(raise : Raise)) -> i32)(
  cond(
    (y == i32(0)) => raise(`divide by zero`),
    true => (x / y)
  )
);

caller :: (fn() -> i32)({
  (given(raise) : Raise) = (fn(msg : String) -> i32)({
    return i32(0);
  });

  safe_divide(i32(10), i32(0))
});
```

- `using(name : Type)` declares an implicit parameter (effect)
- `given(name) := Type(fields...)` installs a handler in the caller's scope
- Effects are matched by **type**, not by name
- The handler is auto-resolved at call sites; pass explicitly with `using(name)`

### Closures and anonymous functions

```rust
(closure : Impl(Fn(x : i32) -> i32)) = ((x) => (x + i32(1)));

result := closure(i32(5));

transform :: (fn(list : ArrayList(i32), f : Impl(Fn(x : i32) -> i32)) -> unit)({
  for list.iter(), (ptr) => {
    ptr.* = f(ptr.*);
  };
});
```

- `(params) => expr` — lambda / closure syntax
- `Impl(Fn(params) -> ReturnType)` — closure type
- Value types are captured by copy; object types by reference
- Each closure has a unique type; you cannot assign different closures to the same variable

## Imports and modules

```rust
{ Parser } :: import "./parser.yo";
parser_module :: import "./parser.yo";

open import "std/string";
{ ArrayList } :: import "std/collections/array_list";
```

- Use relative imports for nearby `.yo` files
- Use `open import "std/module"` for standard-library modules you want fully in scope
- Do not write `import "./file.yo" as name`
- Do not import `std/prelude`

## Enums and pattern matching

```rust
Option :: (fn(comptime(T) : Type) -> comptime(Type))(
  enum(None, Some(value : T))
);

(value : Option(i32)) = .Some(i32(42));

text := match(value,
  .Some(inner) => "present",
  .None => "missing"
);
```

- Enum definitions omit the leading `.`
- Construction and match branches use the leading `.`
- Nested destructuring is not supported; match one layer at a time

## Generics and compile-time

```rust
identity :: (fn(forall(T : Type), value : T) -> T)(value);

max :: (fn(comptime(a) : i32, comptime(b) : i32) -> comptime(i32))(
  cond((a > b) => a, true => b)
);

show :: (fn(forall(T : Type), value : T, where(T <: ToString)) -> unit)(
  println(value)
);
```

- `forall(T : Type)` introduces a generic type parameter
- `comptime(x) : T` makes a parameter compile-time only
- `where(T <: Trait)` constrains a type parameter
- Functions returning `comptime(...)` are evaluated at compile time

## Exports

```rust
main :: (fn() -> unit)(());
export main;

export
  helper,
  Config
;
```

- `export name;` exports a single binding
- Block form exports multiple bindings separated by commas
- Every executable needs `export main;`

## Static and dynamic dispatch types

```rust
show :: (fn(value : Impl(ToString)) -> unit)(
  println(value)
);

(erased : Dyn(ToString)) = dyn(i32(42));
println(erased);
```

- `Impl(Trait)` — static dispatch; concrete type chosen at compile time
- `Dyn(Trait)` — dynamic dispatch via trait object
- `dyn(expr)` wraps a concrete value into its `Dyn(Trait)` form

## Naming conventions

| Kind                        | Style              | Example            |
| --------------------------- | ------------------ | ------------------ |
| File / directory / module   | `snake_case`       | `array_list`       |
| Function / variable         | `snake_case`       | `safe_divide`      |
| Trait / type / enum variant | `PascalCase`       | `ToString`, `Some` |
| Constant                    | `UPPER_SNAKE_CASE` | `MAX_SIZE`         |

Use 2-space indentation.

## Recursion and loops

```rust
factorial :: (fn(n : i32) -> i32)(
  cond(
    (n <= i32(1)) => i32(1),
    true => (n * recur((n - i32(1))))
  )
);

while runtime(true), {
  work();
};
```

- Use `recur(...)` for self-recursion
- `while true` runs at compile time
- Use `while runtime(true), { ... }` for open-ended runtime loops

## Return and branch safety

```rust
// WRONG — return consumes the comma, capturing the next match branch:
match(opt,
  .Some(v) => return v,    // parsed as return(v, .None => ...)
  .None => default_value()
);

// CORRECT — begin blocks isolate return from the comma:
match(opt,
  .Some(v) => {
    return v;
  },
  .None => {
    return default_value();
  }
);

// BEST — expression-bodied function, no return needed:
get_value :: (fn(opt : Option(i32)) -> i32)(
  match(opt,
    .Some(v) => v,
    .None => i32(0)
  )
);
```

- `return expr1, expr2` parses as a single function call: `return(expr1, expr2)`
- In `cond` or `match` branches, **always use begin blocks** when you need `return`
- If the whole function is one expression, prefer expression-bodied style and skip `return` entirely
- The same trap applies to any function call without parens in match branches

## Iterator and for loop

```rust
{ ArrayList } :: import "std/collections/array_list";

list := ArrayList(i32).new();
list.push(i32(10));
list.push(i32(20));

for list.iter(), (ptr) => {
  println(ptr.*);
};

for list.into_iter(), (value) => {
  println(value);
};
```

- `for collection, (variable) => { body }` iterates via the `Iterator` trait
- `.iter()` borrows the collection and yields pointers
- `.into_iter()` takes ownership and yields values

## Testing

```rust
test "Addition works", {
  assert(((i32(1) + i32(1)) == i32(2)), "1+1 should be 2");
};

test "Compile-time check", {
  comptime_assert((2 + 2) == 4);
  comptime_expect_error({ x :: (1 / 0); });
};

test "Async test", {
  io.await(yield());
};
```

- `test "description", { body }` defines a test — `io : IO` is automatically available
- All tests can use `io.async(...)`, `io.await(...)`, etc. without a `using` clause
- `assert(condition, "message")` — runtime assertion (always include a message)
- `comptime_assert(condition)` — compile-time assertion
- `comptime_expect_error(expr)` — verify code produces a compile error

## Advanced features (reference)

These features are powerful but less commonly used. Consult the linked docs for full details.

| Feature                | Syntax hint                                              | Documentation                                                                                                          |
| ---------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Higher-Kinded Types    | `forall(F : (fn(comptime(T) : Type) -> comptime(Type)))` | [DESIGN.md § HKT](https://github.com/shd101wyy/Yo/blob/develop/docs/en-US/DESIGN.md#higher-kinded-types-hkt)           |
| GADTs                  | `enum(IntVal(i : i32) -> recur(i32))`                    | [GADTS.md](https://github.com/shd101wyy/Yo/blob/develop/docs/en-US/GADTS.md)                                           |
| Derive traits          | `derive(MyType, Eq, Hash, Clone, Ord, ToString)`         | [DERIVE_TRAITS.md](https://github.com/shd101wyy/Yo/blob/develop/docs/en-US/DERIVE_TRAITS.md)                           |
| Type reflection        | `Type.get_info(T)` returns `TypeInfo`                    | [TYPE_REFLECTION.md](https://github.com/shd101wyy/Yo/blob/develop/docs/en-US/TYPE_REFLECTION.md)                       |
| Inline assembly        | `asm("mov {0}, #42", out(reg, i32))`                     | [INLINE_ASSEMBLY.md](https://github.com/shd101wyy/Yo/blob/develop/docs/en-US/INLINE_ASSEMBLY.md)                       |
| Metaprogramming        | `quote(...)`, `unquote(...)`, `unquote_splicing(...)`    | [DESIGN.md § Meta](https://github.com/shd101wyy/Yo/blob/develop/docs/en-US/DESIGN.md#meta-programming)                 |
| Effect row variables   | `forall(...(E))` with `using(...(E))`                    | [ALGEBRAIC_EFFECTS.md](https://github.com/shd101wyy/Yo/blob/develop/docs/en-US/ALGEBRAIC_EFFECTS.md)                   |
| Custom derive rules    | `derive_rule(MyTrait, (fn(...) -> unquote(Expr)){...})`  | [DERIVE_TRAITS.md](https://github.com/shd101wyy/Yo/blob/develop/docs/en-US/DERIVE_TRAITS.md#user-defined-derive-rules) |
| Isolated types         | `Iso(T)` for data-race-free parallelism                  | [ISOLATED.md](https://github.com/shd101wyy/Yo/blob/develop/docs/en-US/ISOLATED.md)                                     |
| Arc (atomic ref count) | `arc(value)`, `shared.(*)` for cross-thread sharing      | [ARC.md](https://github.com/shd101wyy/Yo/blob/develop/docs/en-US/ARC.md)                                               |
| Parallelism            | Thread pool, `io.spawn` for parallel work                | [PARALLELISM.md](https://github.com/shd101wyy/Yo/blob/develop/docs/en-US/PARALLELISM.md)                               |
