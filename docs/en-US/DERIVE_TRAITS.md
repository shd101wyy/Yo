# Derive Traits

`derive` is a compile-time builtin that automatically generates trait implementations for struct and enum types. It works similarly to Rust's `#[derive(...)]` attribute but uses function call syntax.

## Basic Usage

```rust
Point :: struct(x : i32, y : i32);
derive(Point, Eq, Hash, Clone);

main :: (fn() -> unit) {
  p1 := Point(i32(1), i32(2));
  p2 := Point(i32(1), i32(2));
  assert((p1 == p2), "points should be equal");
};
export main;
```

`derive` accepts a type as the first argument followed by one or more trait names. It generates `impl` blocks for each trait.

## Built-in Derivable Traits

### Eq

Generates structural equality comparison. Two values are equal if all their fields are equal.

```rust
Color :: struct(r : u8, g : u8, b : u8);
derive(Color, Eq);

// Now you can use == and !=
assert((Color(u8(255), u8(0), u8(0)) == Color(u8(255), u8(0), u8(0))), "same color");
```

For enums, equality checks the variant tag first, then compares fields if the variants match:

```rust
Shape :: enum(Circle(radius : i32), Rect(w : i32, h : i32));
derive(Shape, Eq);

assert((.Circle(i32(5)) == .Circle(i32(5))), "same circle");
```

### Hash

Generates a hash function by combining the hashes of all fields using `hash_combine`. For enums, the variant index is included in the hash.

```rust
derive(Point, Hash);
// Point now implements the Hash trait
```

### Clone

Generates a clone method that creates a deep copy by cloning each field.

```rust
derive(Point, Clone);

p := Point(i32(1), i32(2));
p2 := p.clone();
```

### Ord

Generates lexicographic ordering by comparing fields left-to-right. Returns `Ordering` (`.Less`, `.Equal`, `.Greater`). For enums, variants are ordered by their index, then by field values.

```rust
derive(Point, Ord);

p1 := Point(i32(1), i32(2));
p2 := Point(i32(1), i32(3));
assert((p1.compare(p2) == .Less), "p1 < p2");
```

### ToString

Generates a string representation. Structs produce `TypeName(field1, field2, ...)` format. Enums produce `TypeName.Variant(field1, ...)` format.

```rust
derive(Point, ToString);

p := Point(i32(1), i32(2));
// p.to_string() returns "Point(1, 2)"
```

## Multiple Traits

You can derive multiple traits in a single call:

```rust
derive(Point, Eq, Hash, Clone, Ord, ToString);
```

This is equivalent to calling `derive` separately for each trait.

## Explicit Trait Arguments

You can pass explicit trait type arguments using `Trait(Type)` syntax:

```rust
Vec2 :: struct(x : f64, y : f64);
derive(Vec2, Eq(Vec2));
```

Both bare trait names (`Eq`) and explicit trait type arguments (`Eq(Vec2)`) are supported and can be mixed:

```rust
derive(Vec2, Eq(Vec2), Hash, Clone);
```

## Enum Support

All built-in derives work with enums, including enums with fields:

```rust
// Fieldless enum
Direction :: enum(North, South, East, West);
derive(Direction, Eq, Hash, Clone, Ord, ToString);

// Enum with fields
Result :: enum(Ok(value : i32), Err(msg : str));
derive(Result, Eq, Clone, ToString);
```

For fieldless enums, equality and ordering are based on the variant index. For enums with fields, the variant is checked first, then fields are compared.

## Requirements

Each field type in the struct or enum must already implement the trait being derived. For example, to `derive(Point, Eq)`, the types `i32` (used for `x` and `y`) must implement `Eq`. Built-in types (`i32`, `u8`, `bool`, `str`, `String`, etc.) implement all standard traits.

## Type Reflection Builtins

Yo provides compile-time type reflection builtins used internally by `derive` and available for user-defined derives:

| Builtin                                     | Description                                            |
| ------------------------------------------- | ------------------------------------------------------ |
| `__yo_type_is_struct(T)`                    | Returns `true` if T is a struct type                   |
| `__yo_type_is_enum(T)`                      | Returns `true` if T is an enum type                    |
| `__yo_type_get_name(T)`                     | Returns the type name as a `comptime_string`           |
| `__yo_type_field_count(T)`                  | Returns the number of struct fields                    |
| `__yo_type_get_field_name(T, i)`            | Returns the name of the i-th field                     |
| `__yo_type_get_field_type(T, i)`            | Returns the type of the i-th field                     |
| `__yo_type_variant_count(T)`                | Returns the number of enum variants                    |
| `__yo_type_get_variant_name(T, i)`          | Returns the name of the i-th variant                   |
| `__yo_type_get_variant_field_count(T, i)`   | Returns the number of fields in the i-th variant       |
| `__yo_type_get_variant_field_name(T, i, j)` | Returns the name of the j-th field in the i-th variant |
| `__yo_type_get_variant_field_type(T, i, j)` | Returns the type of the j-th field in the i-th variant |

All builtins are compile-time only and work with `comptime(T) : Type` parameters.

## `comptime_eval`

The `comptime_eval` builtin parses and evaluates a `comptime_string` as Yo code at compile time:

```rust
comptime_eval("derive(MyType, Eq)");
```

This is the foundation for user-defined derive functions — they build code strings using type reflection and evaluate them with `comptime_eval`.

## User-Defined Derives

You can define your own derive functions as comptime functions with signature `fn(comptime(T) : Type) -> comptime(unit)`:

```rust
// Define a custom derive that generates a `describe` method
derive_describe :: (fn(comptime(T) : Type) -> comptime(unit)) {
  name :: __yo_type_get_name(T);
  code ::
    (("impl(T, describe : (fn(self : Self) -> String)(  `" + name) + "`))");
  comptime_eval(code);
};

// Use it
MyStruct :: struct(x : i32, y : i32);
derive(MyStruct, derive_describe);

// Now MyStruct has a .describe() method
s := MyStruct(i32(1), i32(2));
s.describe(); // returns "MyStruct"
```

### How It Works

1. **Type reflection** — Use `__yo_type_*` builtins to inspect the type's structure
2. **Code generation** — Build an `impl(T, ...)` code string using string concatenation
3. **Evaluation** — Call `comptime_eval(code)` to inject the generated impl

The generated code should use `T` (the type parameter, which is in scope) rather than the type name for the type position in `impl`. The type name can be used in string literals (e.g., for display purposes).

### Example: Generating Field-Aware Code

```rust
// A derive that generates a field_count method
derive_field_count :: (fn(comptime(T) : Type) -> comptime(unit)) {
  count :: __yo_type_field_count(T);
  comptime_eval(("impl(T, field_count : (fn(self : Self) -> i32)( i32(" + count) + ")))");
};
```

## Variadic Comptime Parameters

`derive` uses variadic comptime parameters internally, allowing any number of trait arguments:

```rust
derive(Point, Eq, Hash, Clone, Ord, ToString);  // 5 traits in one call
```

This feature is also available for user code. See the variadic comptime parameters documentation for details.
