# Yo Core Patterns Cheatsheet

These patterns are aimed at everyday Yo application and library code.

## Strings and output

```rust
open import "std/fmt";
open import "std/string";

(name : str) = "yo";
greeting := `Hello ${name}`;

println(greeting);
println("plain str is also fine");
```

- `"hello"` is a `str` literal in normal runtime code
- `` `hello ${name}` `` creates a `String`
- Prefer template strings for constant `String` values instead of `String.from("...")`
- Prefer `print`/`println` when a type implements `ToString`

### String type disambiguation

| Type              | When you see it                              | Key behavior                           |
| ----------------- | -------------------------------------------- | -------------------------------------- |
| `str`             | `"hello"` in runtime contexts                | Slice of bytes, no ownership           |
| `String`          | Template strings `` `hello` ``               | Owned UTF-8, reference-counted         |
| `comptime_string` | `"hello"` inside `comptime` functions/macros | Compile-time only, distinct from `str` |

Key rules:

- In **runtime** code, `"hello"` is always `str`. Mixing literal and variable branches in `cond`/`match` works fine.
- In **comptime** functions (return type `comptime(...)`), `"hello"` is `comptime_string`. It does NOT auto-convert to `str`. Use `str.from_raw_parts(*(u8)("..."), usize(N))` if a comptime function needs to return `str`.
- For `String` constants, prefer `` `hello` `` over `String.from("hello")`.

## Import patterns

```rust
{ LocalType } :: import "./local_type.yo";
open import "std/string";
{ ArrayList } :: import "std/collections/array_list";
{ HashMap } :: import "std/collections/hash_map";
{ Url } :: import "std/url";
{ Regex } :: import "std/regex";
{ fetch, HttpRequest } :: import "std/http";
```

| Need                           | Import pattern                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------------ |
| Local module in same directory | `./file.yo`                                                                          |
| Module with a clean index      | `std/url`, `std/regex`, `std/http`, `std/log`, `std/glob`                            |
| Collections                    | `std/collections/array_list`, `std/collections/hash_map`, `std/collections/hash_set` |
| File system                    | `std/fs/file`, `std/fs/dir`, `std/path`                                              |
| Networking                     | `std/net/tcp`, `std/net/udp`, `std/net/dns`                                          |

Do not import `std/prelude`; it is already available.

## Option and Result

```rust
open import "std/string";

(value : Option(i32)) = .Some(i32(21));
doubled := value.map((x) => (x * i32(2)));
fallback := value.unwrap_or_else(() => i32(0));

(parsed : Result(i32, String)) = .Ok(i32(42));
text := match(parsed,
  .Ok(n) => `value=${n}`,
  .Err(err) => err
);
```

- Use `Option(T)` when absence is expected and ordinary
- Use `Result(T, E)` when the caller should handle failure
- Prefer combinators for straight-line transforms: `map`, `and_then`, `map_err`, `or_else`
- Switch to `match(...)` when branches need different logic or side effects

## Collections

```rust
{ ArrayList } :: import "std/collections/array_list";
{ HashMap } :: import "std/collections/hash_map";
open import "std/string";

numbers := ArrayList(i32).new();
numbers.push(i32(1));
numbers.push(i32(2));

counts := HashMap(String, i32).new();
counts.set(`yo`, i32(1));
```

| Type             | Use when                                 |
| ---------------- | ---------------------------------------- |
| `ArrayList(T)`   | Ordered growable sequence                |
| `HashMap(K, V)`  | Key/value lookup with `Eq` + `Hash` keys |
| `HashSet(T)`     | Membership tests and deduplication       |
| `BTreeMap(K, V)` | Ordered map with `Ord` keys              |
| `Deque(T)`       | Push/pop on both ends                    |
| `String`         | Owned UTF-8 text                         |

## Traits and associated types

```rust
Iterator :: trait(
  Item : Type,
  next : (fn(self : *(Self)) -> Option(Self.Item))
);
```

- Traits use labeled fields directly inside `trait(...)`
- Associated types are fields like `Item : Type` or `Output : Type`
- Wrap `fn` types in parentheses inside traits and type annotations

## Boxes, pointers, and nullability

```rust
counter := box(i32(0));
counter.* = (counter.* + i32(1));

(ptr : Option(*(u8))) = .None;
```

- Use `Box(T)` or `box(value)` for owned heap allocation
- Use `*(T)` for raw pointers
- Model nullable pointers as `Option(*(T))` or `?*(T)`, not sentinel integers

## Unicode and platform checks

```rust
{ Platform, platform } :: import "std/process";

separator := cond(
  (platform == Platform.Windows) => `\\`,
  true => `/`
);
```

- Use `rune` for Unicode code points
- Branch on `platform` and `Platform` for OS-specific behavior

## Type categories

```rust
Point :: struct(x : i32, y : i32);

FilePermission :: newtype(mode : u32);

TcpStream :: object(fd : i32, buffer : ArrayList(u8));
```

| Keyword        | Semantics                               |
| -------------- | --------------------------------------- |
| `struct(...)`  | Value type, copied on assignment        |
| `newtype(...)` | Single-field value wrapper              |
| `object(...)`  | Reference-counted, shared on assignment |

- Use `newtype(...)` when the type has exactly one field
- Use `object(...)` for types that need shared ownership

## Impl blocks and generics

```rust
impl(Point,
  distance : (fn(self : Self, other : Point) -> f64)({
    dx := f64((self.x - other.x));
    dy := f64((self.y - other.y));
    sqrt(((dx * dx) + (dy * dy)))
  })
);

impl(forall(T), where(T <: ToString), Box(T),
  show : (fn(self : Self) -> unit)(
    println(self.*)
  )
);
```

- Use `Self` inside impl method signatures
- `forall(T)` + `where(T <: Trait)` for generic impls
- Trait impls: `impl(MyType, MyTrait(args), : trait_field_bindings...)`

## Partial application

```rust
IntResult :: Result(_, i32);
(r : IntResult(bool)) = .Ok(true);

add :: (fn(comptime(x) : i32, comptime(y) : i32) -> comptime(i32))((x + y));
add1 :: add(i32(1), _);
```

- Use `_` placeholder in comptime function calls to partially apply
- Works with type constructors: `Result(_, i32)` makes a one-argument type function
- Only valid for functions with `comptime` return types

## Dynamic dispatch

```rust
(value : Dyn(ToString)) = dyn(i32(42));
println(value);
```

- `Dyn(Trait)` is a type-erased trait object
- `dyn(expr)` wraps a concrete value into the trait object
- `Impl(Trait)` is the static dispatch counterpart

## Derive traits

```rust
Point :: struct(x : i32, y : i32);
derive(Point, Eq, Hash, Clone, Ord, ToString);

p1 := Point(1, 2);
p2 := p1.clone();
assert((p1 == p2), "equal after clone");
println(p1.to_string());
```

- Built-in derivable traits: `Eq`, `Hash`, `Clone`, `Ord`, `ToString`
- Works for both structs and enums
- Custom derives can be registered with `derive_rule`; see [DERIVE_TRAITS.md](https://github.com/shd101wyy/Yo/blob/develop/docs/en-US/DERIVE_TRAITS.md)

## Error handling

```rust
open import "std/error";

DivError :: enum(DivByZero);
impl(DivError, ToString(to_string : ((self) -> `division by zero`)));
impl(DivError, Error());

safe_div :: (fn(a : i32, b : i32) -> Result(i32, DivError))(
  cond(
    (b == i32(0)) => .Err(.DivByZero),
    true => .Ok((a / b))
  )
);
```

- Custom error types implement both `ToString` and `Error` traits
- `AnyError` is `Dyn(Error)` — wraps any error: `(err : AnyError) = dyn(MyError.Foo)`
- Use `downcast(err, MyError)` to recover the concrete type from `AnyError`
- For exception-style control flow, see [yo-async-effects](../yo-async-effects/SKILL.md)

## Closures as values

```rust
(inc : Impl(Fn(x : i32) -> i32)) = ((x) => (x + i32(1)));
result := inc(i32(5));

transform :: (fn(values : ArrayList(i32), f : Impl(Fn(x : i32) -> i32)) -> unit)({
  for values.iter(), (ptr) => {
    ptr.* = f(ptr.*);
  };
});
```

- `(params) => expr` creates a closure
- `Impl(Fn(params) -> ReturnType)` is the closure type
- Closures capture: value types by copy, object types by reference
- Each closure has a unique type

## Iterator and for loop

```rust
{ ArrayList } :: import "std/collections/array_list";

list := ArrayList(i32).new();
list.push(i32(1));
list.push(i32(2));

for list.iter(), (ptr) => {
  println(ptr.*);
};

for list.into_iter(), (value) => {
  println(value);
};
```

| Method         | Yields | Semantics                           |
| -------------- | ------ | ----------------------------------- |
| `.iter()`      | `*(T)` | Borrow via pointer; yields pointers |
| `.into_iter()` | `T`    | Takes ownership; yields values      |

- Implement `Iterator` trait to make custom types iterable
- Implement `IntoIterator` trait for collection-style iteration

## Module-level mutable variables

```rust
counter := i32(0);

inc :: (fn() -> unit)({
  counter = (counter + i32(1));
});
```

- Top-level `:=` creates a C `static` file-scope variable
- Cannot be exported; only compile-time values can be exported
- Not allowed inside `impl` blocks; use `::` for constants there

## Anonymous modules

```rust
my_module :: impl {
  helper :: (fn(x : i32) -> i32)((x + i32(1)));
  export helper;
};

result := my_module.helper(i32(5));
```

- `impl { ... }` creates a module namespace
- Only `::` (compile-time) bindings are allowed inside
