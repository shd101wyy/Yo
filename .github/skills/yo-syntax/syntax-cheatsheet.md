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

Remember: `{ expr }` without semicolons is a struct literal, not a block. The parser now detects this mistake and emits a clear error if the single expression is not a valid struct field.

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
- **`String.from(`` `...` ``)` is WRONG**: `` `...` `` is already `String`; `String.from` takes `str`. Use `` `...` `` directly or `String.from("...")` with double quotes.
- **`assert` takes `str`, not `String`**: `assert(cond, "message")` — always use `""`. Passing a template string `` `...` `` causes a type mismatch. Use a custom `check_str` helper when you need `String` diagnostics.

## Calls, operators, and whitespace

```rust
sum := add(i32(1), i32(2));
flag := ((a > b) && (b > c));
masked := ((A | B) | C);
```

- Prefer parenthesized calls: `func(arg1, arg2)`
- `func (a, b)` is a different parse shape than `func(a, b)`
- Yo has no operator precedence; fully parenthesize binary expressions
- **All unary operators (`!`, `&`, `-`, `~`) greedily consume everything that follows, including comma-separated args.** `func(&s, a, b)` is parsed as `func(&(s, a, b))` — ONE tuple argument! Preferred fix: parenthesize the operand: `func(&(s), a, b)`. The outer-parens form `func((&s), a, b)` also works. Either is fine; the operand-parens form `&(x)` matches how the parser thinks about it.
- Parenthesize other unary operands too: `!(ready)`, `-(value)`
- **`!x && y` is parsed as `!(x && y)`**, not `(!x) && y`. Prefix `!` greedily consumes the full right-hand expression. To get `(!x) && y`, write `((!x) && y)` with explicit inner parens.
- **Nested `&&` / `||` in a single compound condition causes "Ambiguous operator precedence"** even with explicit parentheses: `((A && B) && (C && D))` on one line triggers the error. Fix: extract sub-conditions into named booleans first: `_c1 := (A && B); _c2 := (C && D); if((_c1 && _c2), ...)`.

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
- Use `Self` in method signatures and in type definitions for recursive references (the type name is not available during its own definition)
- `Self` also works inside generic type constructors — it refers to the current instantiation (e.g., `Tree(T)` inside `Tree`). Use `recur(args)` only when type arguments differ from the current instantiation.
- Use `struct(...)` for record and effect-record types. The legacy `module(...)`,
  `Module`, and `SelfModule` syntax has been removed; imported files are
  represented as namespace structs, and recursive references use normal `Self`.
- Bare `Module` is not a type alias. Use `Type` for comptime type values; type
  reflection reports source-module namespaces as `TypeInfo.Struct(...)`.
- Wrap `fn` types in parentheses when they appear after `:`
- **Forward references between methods in the same `impl` block are supported.** A method defined later in the block can be called by a method defined earlier. Both `self.method()` and `Self.method(...)` dispatch work. Only the canonical `name : (fn(...) -> R)(body)` method shape participates; bare lambdas do not get forward-ref shells.
- **Module-level `::` function definitions are processed in order.** A function body that calls another function declared later in the same file will fail with "Variable not found". Always define leaf helpers first (bottom-up order): `eval_identifier` → `eval_atom` → `evaluate`.

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

Three destructuring shapes for arms (mix freely across arms):

```rust
Shape :: enum(Circle(radius : i32), Rectangle(width : i32, height : i32));

match(s,
  .Circle(r)                       => (r * r),         // positional
  .Rectangle(width: w, height: h)  => (w * h),         // labeled
  .Rectangle({width, height: h})   => (width * h)      // curly shorthand
)
```

Curly `{a, b: c}` is sugar for `(a: a, b: c)` — order-free, supports partial matches (omit fields). Use `{label: _}` to ignore a specific field. Bare `{_}` and empty `{}` are rejected.

> **Critical**: Within a single match arm, you must use **either all positional or all named** field patterns. Mixing positional and named fields in the same arm (e.g., `.Foo(x, y: z, w)`) causes C codegen to emit undeclared identifiers for the named fields. This is a parser/codegen limitation — do not mix.

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

// Runtime infinite loop — `while cond` is ALWAYS runtime
while true, {
  work();
};

// Compile-time loop unrolling — requires comptime() modifier
while comptime(i < 10), {
  // body evaluated/unrolled at compile time
};

// for loop — 2-arg prelude macro; first arg MUST be an iterator (has .next()):
for(list.iter(), x => {    // ArrayList, array → call .iter() first
  process(x);
});

for(map.into_iter(), bucket => {
  println(bucket.key);
});

for(list.iter(), (ptr) => { // ptr is a mutable reference to each element
  ptr.* = transform(ptr.*);
});
```

- Use `recur(...)` for self-recursion
- `while cond` is **always a runtime loop** — use this for open-ended loops (e.g., server accept loops, event loops)
- `while comptime(cond)` explicitly unrolls at compile time — `cond` must be a compile-time-known value
- Using a comptime-only (`::`) variable in a bare `while` condition without `comptime()` is a **compile error** (would be an infinite loop at runtime)
- **`for(arr, item => { body })`** — correct 2-arg prelude macro form. The `item => { body }` is an anonymous closure.
- **Do NOT use `for(x, arr, { body })`** — this older 3-arg form is an evaluator-internal representation, not valid top-level Yo syntax. (The self-hosted evaluator currently only understands the 3-arg form in its internal for-loop handler; track issue: `issues/eval-for-loop-3arg-vs-2arg.md`)

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
- `return` must be the **last expression** in a begin block — dead code after `return` is rejected. Do NOT write `{ return x; fallback_val }`. Write `{ return x; }` only.
- If the whole function is one expression, prefer expression-bodied style and skip `return` entirely
- The same trap applies to any function call without parens in match branches

## String concatenation pitfall

```rust
// WRONG — str + str causes "comptime_string vs str" type unification error:
content := String.from("line1\n" + "line2\n");

// CORRECT — use .concat() on String objects:
content := String.from("line1\n").concat(String.from("line2\n"));

// Also CORRECT — single long string literal:
content := String.from("line1\nline2\n");
```

- `"hello" + "world"` at runtime uses `+` on `str` values, which can cause type mismatches
- The `str + str` operator can produce a `comptime_string` in some contexts, which is not always compatible with `str`
- Prefer `.concat()` method on `String` objects when building multi-part strings at runtime

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

## Common pitfalls

### `&&` short-circuit with `match`/`cond` on RHS causes C codegen scope bug

Using `&&` where the right-hand side is a `match` or `cond` expression causes
a C codegen bug: the temp variable for the RHS is declared inside the short-circuit
`if` block but the cleanup drop is emitted outside it. This produces a C compile
error ("use of undeclared identifier").

```rust
// WRONG — triggers codegen scope bug:
is_ok := (av.is_compile_time_only && match(av.value,
  .Some(v) => compute(v),
  .None    => false
));

// CORRECT — use an explicit if block to scope the match:
(is_ok : bool) = false;
if(av.is_compile_time_only, {
  is_ok = match(av.value,
    .Some(v) => compute(v),
    .None    => false
  );
});
```

This only affects `&&`/`||` where the **right-hand side contains a `match`,
`cond`, or other expression that allocates heap-managed temporaries** (e.g.,
`String`, `ArrayList`, `Option(HeapType)`). Pure boolean expressions on both
sides are fine.

### `impl(...)` requires a trailing semicolon

```rust
// WRONG — "Invalid function call on type" at runtime:
impl(MyType,
  get : (fn(self : Self) -> i32)(self.x)
)

// CORRECT:
impl(MyType,
  get : (fn(self : Self) -> i32)(self.x)
);
```

### `___` discard variable cannot appear twice in the same scope

```rust
// WRONG — shadowing of ___ is not allowed:
___ := foo();
___ := bar();

// CORRECT — use unique names or bare calls:
_a := foo();
_b := bar();
// or simply:
foo();
bar();
```

### Enum pattern matching does NOT support literal values

Match patterns on enum variants only support **variable binding**, not literal comparison.
`.BoolVal(true)` binds the inner value to a variable named `true` — it does NOT check
if the value is `true`. The arm always matches any `BoolVal`.

```rust
// ❌ WRONG — always matches (true is a variable binding, not a comparison)
match(val,
  .BoolVal(true) => handle_true(),
  _ => ()
);

// ✅ CORRECT — bind to variable, then check with cond
match(val,
  .BoolVal(b) => cond(b => handle_true(), true => ()),
  _ => ()
);
```

Same applies to `.IntLit(42)`, `.StrLit("hello")`, etc.

### `type` is a reserved keyword — avoid as field/param name

```rust
// WRONG:
Variable :: object(name : String, type : TypeValue);

// CORRECT:
Variable :: object(name : String, ty : TypeValue);
```

### ArrayList indexing uses call syntax

```rust
list := ArrayList(i32).new();
list.push(i32(42));

val := list(usize(0));         // → i32  (value copy via Index trait)
list(usize(0)) = i32(99);     // mutate in place directly

// When you need the pointer explicitly:
ptr := &(list(usize(0)));     // → *(i32)
ptr.* = i32(99);              // also works

// Safe access (returns Option(T)):
match(list.get(usize(0)),
  .Some(v) => println(`${v}`),
  .None => ()
);
```

- `list(i)` returns the value `T` (not a pointer)
- `list(i) = val` mutates in place directly (preferred)
- `&(list(i))` returns `*(T)` if you need the pointer explicitly
- `list.get(i)` returns `Option(T)` for safe bounds-checked access

### Named fields required for `struct`/`object` constructors

```rust
Point :: struct(x : i32, y : i32);

// CORRECT:
p := Point(x: i32(1), y: i32(2));

// WRONG — positional not supported for struct/object:
p := Point(i32(1), i32(2));
```

Enum variant construction is positional (no field names needed).

### Object types (RC) are passed by value

`HashMap`, `ArrayList`, and other `object(...)` types are reference-counted. Passing them by value shares the underlying data — mutations are visible to all holders.

```rust
// DO NOT use pointer params for RC objects:
// WRONG: fn(m : *(HashMap(String, V))) — will cause greedy & issues at call site
// CORRECT: fn(m : HashMap(String, V)) — pass by value, mutations propagate via RC

process_map :: (fn(m : HashMap(String, i32)) -> unit)({
  m.set(String.from("key"), i32(42));  // mutation visible to caller
});

counts := HashMap(String, i32).new();
process_map(counts);
// counts now has "key" => 42
```

### Forward references are NOT allowed

Top-level bindings are evaluated strictly in order. A function must be defined BEFORE it is called (even inside closures that are called later).

```rust
// WRONG — forward reference:
caller :: (fn() -> unit)({ helper(); });
helper :: (fn() -> unit)({ println("hi"); });

// CORRECT — helper before caller:
helper :: (fn() -> unit)({ println("hi"); });
caller :: (fn() -> unit)({ helper(); });
```

This applies to ALL callee-before-caller relationships:

- `_walk_dag` before `build_dag`
- `compile_artifact`, `run_executable`, `run_test_suite` before `execute_node`
- `execute_node` before `execute_dag`
- `_print_summary_node` before `print_build_summary`
- `print_build_summary` before `execute_step`
- Exports section must come AFTER all definitions

### Named tuple fields in type syntax are not allowed

Yo does not support named tuple field types in the syntax `(name : Type, ...)`. Use an `object` struct instead:

```rust
// WRONG — "Labelled field is not allowed in tuple value":
get_range :: (fn(ty : TypeValue) -> Option((min : i64, max : u64)))(
  .Some((min: i64(-128), max: u64(127)))
);

// CORRECT — define a named struct:
Range :: object(min : i64, max : u64);
get_range :: (fn(ty : TypeValue) -> Option(Range))(
  .Some({min: i64(-128), max: u64(127)})
);
```

Named fields work in struct/object constructors `{min: ..., max: ...}`, just not in the type syntax for tuples.

### `Option` equality comparison limitations

Comparing `Option(T)` with `== .None` or `== .Some(...)` fails when the inner type `T` lacks a derived `Eq` implementation or when `.None` is type-ambiguous. Always use the method API:

```rust
// WRONG — "No matching call found with arguments: r == .None":
assert((r == .None), "should be None");

// CORRECT — use .is_none() / .is_some() / .unwrap():
assert(r.is_none(), "should be None");
assert(r.is_some(), "should be Some");
assert((r.unwrap() == expected_value), "value check");

// Also fine in match:
match(r,
  .Some(v) => assert((v == expected_value), "value check"),
  .None    => assert(false, "unexpected None")
);
```

The `!` operator is greedy and consumes all following args including the block. Always parenthesize:

```rust
// WRONG — ! consumes "cond, block" as one arg:
if(!cond, { do_thing(); });

// CORRECT — ! only consumes (cond):
if((!cond), { do_thing(); });
```

### `escape` requires a nested-function context

`escape value` exits the **enclosing function** — the nearest `fn(...)` that
wraps the current code. It requires that the code is inside a nested function
(e.g., a closure or `given` handler lambda), NOT at the top level of a
standalone function definition.

```rust
// CORRECT — escape inside a given handler lambda (lambda has enclosing fn):
given(exn) := Exception(throw: ((err) -> {
  escape result   // exits the outer function that contains this given()
}));
do_something(using(exn));

// CORRECT — escape inside a closure passed as argument:
result := match(opt, .Some(x) => x, .None => {
  // This is NOT a nested function — use return:
  // WRONG: escape default_val  // ERROR: no enclosing fn
  return default_val  // CORRECT: return exits the enclosing fn directly
});

// WRONG — escape inside a match arm (not a nested fn):
match(opt,
  .Some(x) => { escape x }  // ERROR: "can only be used inside a function that has an enclosing function"
);
```

**Rule of thumb**: Use `escape` only inside lambdas passed to `given()` handlers.
In all other contexts (match arms, if blocks, begin blocks, top-level fn bodies),
use `return` for early exit.

`return` inside a lambda exits that lambda only; `escape` exits the OUTER function
(the one that installed the `given` handler).

### Parameter reassignment

Function parameters are **NOT reassignable**. To reassign, declare a mutable local:

```rust
// WRONG — cannot reassign parameter 'env':
my_fn :: (fn(env : Environment) -> Environment)({
  env = other_env;  // ERROR: "cannot reassign itself"
  env
});

// CORRECT — create a mutable local copy:
my_fn :: (fn(init_env : Environment) -> Environment)({
  (env : Environment) = init_env;
  env = other_env;  // OK — reassigning local variable
  env
});
```

This also applies to `object` types: you can mutate fields (`env.field = val`)
but cannot rebind the variable (`env = other_env`).

### String cloning

Calling `.clone()` on a `String` field from a struct/method chain requires a
reference — take `&` first:

```rust
// WRONG — .clone() requires *(Self) but gets Self value from field access:
name := token.value.clone();            // ERROR

// CORRECT — take reference first:
tok := some_fn_call();
name := (&tok.value).clone();           // OK

// ALSO CORRECT — use String.from on the str slice:
name := String.from(token.value.as_str());
```

### Template strings produce `String`, literals are `str`

```rust
// Template string `` `...` `` → String
// String literal "..." → str

// If a function takes `str`, call .as_str() on a template string:
fn_taking_str((`prefix_${value}`).as_str());

// Or change the function to take String
```

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

---

## Self-hosted evaluator (`yo-self/`) — known limitations and pitfalls

These constraints apply **only** to the self-hosted Yo evaluator (code inside `yo-self/`). The TypeScript-compiled Yo compiler does not have these restrictions.

### Match patterns: no bare identifier catch-all

The self-hosted parser only accepts three match arm forms:

- `.VariantName` — unit variant
- `.VariantName(p1, p2, ...)` — tuple variant
- `_` — wildcard

**Bare identifier catch-all `t => ...` is NOT supported.** Use `_` and access the outer binding directly:

```rust
// ❌ NOT supported in yo-self/
match(val, {
  .SomeVariant(x) => x,
  t => t,      // ERROR: bare identifier not a valid pattern
})

// ✅ Correct — use outer binding
match(val, {
  .SomeVariant(x) => x,
  _ => val,    // refer to outer binding
})
```

### String concatenation: no `String + str` operator

The `+` operator does not accept mixed `String`/`str` operands.
**Always use template strings** for concatenation:

```rust
// ❌ Type error
result := (parts + ", ");
result := (parts + item.as_str());

// ✅ Template strings
result := `${parts}, `;
result := `${parts}${item}`;
```

### `clone()` on extracted String fields is ambiguous

When a `String` field is bound in a match arm, calling `.clone()` triggers an ambiguity error (two impls: `fn(self: String)` and `fn(self: *(String))`).

```rust
// ❌ Ambiguous
.StructVal(name, fields) => name.clone()

// ✅ Use from + as_str
.StructVal(name, fields) => String.from(name.as_str())
```

### `box(val)` is a move — cannot box the same value twice

```rust
// ❌ Move error: target is moved by first box(target)
p1 := PtrVal(box(target), usize(0));
p2 := PtrVal(box(target), usize(0));  // ERROR: target already moved

// ✅ Create separate instances
p1 := PtrVal(box(EvalValue.IntLit(String.from("42"))), usize(0));
p2 := PtrVal(box(EvalValue.IntLit(String.from("42"))), usize(0));
```

### `recur(...)` for self-recursive lambdas

Lambdas defined as `name :: (fn(args) -> T)(body)` cannot call `name` inside `body`.
Use `recur(...)` instead:

```rust
// ❌ Would not find `my_fn` inside its own body
my_fn :: (fn(x : i32) -> i32)({
  my_fn(x - 1)   // ERROR: `my_fn` not in scope yet
});

// ✅ Use recur
my_fn :: (fn(x : i32) -> i32)({
  recur(x - 1)
});
```

### `{ expr }` without semicolons is a struct literal, not a block

```rust
// ❌ Parsed as struct literal `{ match(...) }`
fn :: (fn() -> T)({ match(x, arms) })

// ✅ Remove braces or add semicolon
fn :: (fn() -> T)(match(x, arms))
fn :: (fn() -> T)({ match(x, arms); })
```

### Template strings cannot be nested inside `${...}` interpolations

A template string literal (`` ` `` ... `` ` ``) inside a `${...}` interpolation of another template string closes the outer string. The compiler gives confusing parse errors.

```rust
// ❌ Inner backtick closes the outer template string — parse error
lines.push(`**Implements:** ${`, `.join(names)}`);

// ✅ Assign the separator to a variable first
sep := `, `;
lines.push(`**Implements:** ${sep.join(names)}`);
```

### Pushing RC struct fields into ArrayList does not need `.clone()`

String (and other RC object) fields of structs can be passed directly to `ArrayList.push()`. Calling `.clone()` triggers an ambiguity error between `fn(self: String)` and `fn(self: *(String))` overloads.

```rust
// ❌ Ambiguous clone call
names.push(param.name.clone());

// ✅ Push directly — RC bump happens automatically
names.push(param.name);
```

If explicit clone is needed elsewhere, use `(&field).clone()` to select the pointer overload.

### `.Some(expr)` in expression position is parsed as a 2-arg property access

Using `.Some(x)` as an expression (not inside a match pattern) is parsed by the Yo parser
as a 2-arg dot property access: `obj.(prop, arg)`. This means `evaluate_property_access` is
invoked on it at compile time, causing confusing errors like "Failed to infer enum variant type".

```rust
// ❌ Parsed as 2-arg property access — NOT an Option::Some constructor call
val := .Some(oi.ty);

// ✅ Use the explicit fully-qualified form
val := Option(TypeValue).Some(oi.ty);
```

### `||` chaining requires explicit parentheses for 3+ operands

Chaining three or more `||` terms in a single expression is rejected with a precedence error.
Always add explicit parentheses around each pair:

```rust
// ❌ Rejected — ambiguous precedence
if ((is_tuple_type(ty) || is_struct_type(ty) || is_union_type(ty)), ...)

// ✅ Parenthesise each pair
if (((is_tuple_type(ty) || is_struct_type(ty)) || is_union_type(ty)), ...)
```

### Duplicate imports from the same path must be merged

Having two `:: import "path"` lines importing from the same file causes a compile error.
Always merge them into a single destructuring import:

```rust
// ❌ Two imports from the same path
{ Foo } :: import "../../mod.yo";
{ Bar } :: import "../../mod.yo";

// ✅ Merged
{ Foo, Bar } :: import "../../mod.yo";
```

### Implicit (`using`) parameters cannot be used with `:=` assignment

Implicit effect parameters introduced via `using(name : Type)` cannot be bound
to a discarded variable with `:= name`. They can only be passed via `using()`.
To suppress "unused parameter" warnings for an implicit param, simply omit the
discard assignment — implicit params never trigger unused-variable errors.

```rust
// WRONG — implicit variable cannot be used in assignment:
foo :: (fn(using(exn : Exception)) -> unit)({
  _ := exn;   // ERROR: Cannot use implicit variable "exn" in assignment
  ()
});

// CORRECT — just omit the discard line:
foo :: (fn(using(exn : Exception)) -> unit)({
  ()
});
```

### Nested `Option` patterns require staging

`match` does not support nested destructuring patterns like `.Some(.TypeVal(x))`.
Split into two separate `match` expressions.

```rust
// WRONG — nested option pattern:
match(opt_value,
  .Some(.TypeVal(box)) => { ... },   // ERROR
  _ => { ... }
);

// CORRECT — match in two stages:
match(opt_value,
  .Some(v) => match(v,
    .TypeVal(box) => { ... },
    _ => { ... }
  ),
  .None => { ... }
);
```

### Outer match on `Option` must have `.None` arm

When using `match(opt, .Some(x) => match(x, ...), ...)`, the outer match
needs its own `.None` arm. The inner match's `_ =>` wildcard does NOT cover
the outer match's `.None` variant.

```rust
// WRONG — outer match missing .None:
match(opt_callee_value,
  .Some(cv) => match(cv,
    .Foo(x) => { ... },
    _ => { throw_phase3() }   // inner wildcard, does NOT cover outer .None
  )                           // outer match closes here — .None uncovered!
);

// CORRECT — add explicit .None arm to outer match:
match(opt_callee_value,
  .Some(cv) => match(cv,
    .Foo(x) => { ... },
    _ => { throw_phase3() }
  ),
  .None => { throw_phase3_none() }
);
```

### Parenthesis balance in deeply nested matches

When using `match(outer, .Some(x) => match(inner, ...), .None => ...)`,
count parentheses carefully:

- The inner `match(inner, ...)` closes with its own `)`
- AFTER that `)`, add a `,` then the outer `.None =>` arm
- The outer match closes with its own `)`
- Only then does `});` close the function body

```rust
// Correct structure:
match(outer_val,
  .Some(x) => match(x,
    arm1,
    arm2,
    _ => { fallback() }   // last inner arm, no trailing comma
  ),                       // ← closes inner match; `,` continues outer
  .None => { fallback() } // ← outer .None arm
)                          // ← closes outer match
```
