---
applyTo: "**/*.yo"
description: "Use when writing or editing Yo language code. Covers critical syntax rules: curly brace semantics, cond/match parentheses, function definitions, parsing ambiguities, and expression vs block distinctions."
---
# Yo Language Syntax Rules

## Curly braces `{...}` behave differently based on separators

- `{ expr }` without semicolons creates an **anonymous struct value**, NOT a block!
- `{ expr; }` with semicolons creates a **begin block** (sequence of statements)
- If you want a single expression, write `expr` directly. Don't wrap it in `{...}` unless you need a struct.

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
  return ();
});
```

Use `cond` when there are more than two branches or when the branches are large.

## Function definitions

- `(fn(param1 : Type1, param2 : Type2) -> ReturnType)({ body; return expr; })`
- No space between `(fn() -> ReturnType)` and `({ body; })`
- Method definitions in struct use double parentheses: `method :: ((fn(self: Self) -> ReturnType) body)`
- Use `Self` instead of the type name in method signatures

## Return value rules

- The last expression in `{ ... }` without semicolon is the return value of the struct or enum constructor.
- With semicolon, like `{ expr; }`, the return value is `unit`.

## Always add `()` after function name to avoid parsing ambiguity

Because we didn't write `await(...`, code like:

```rust
cond(
  (fd >= i32(0)) => await file.close(fd),
  true => ()
);
```

gets parsed as:

```rust
cond(
  (fd >= i32(0)) =>
  await(
    file.close(fd),
    true => ()
  )
);
```

Always add `()` after function name to prevent this.

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

Unary operators like `!` greedily consume everything that follows, including comma-separated arguments. Always wrap the operand in parentheses.

```rust
// WRONG — `!` captures `d.is_empty(), "msg"` as one expression:
assert(!d.is_empty(), "should not be empty");

// CORRECT — parentheses limit the operand:
assert(!(d.is_empty()), "should not be empty");
```

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

## Module imports

Use destructured imports for files in the same directory:

```rust
// CORRECT — destructured import with relative path:
{ RegexNode, NodeKind, CharRange } :: import "./node.yo";

// CORRECT - Named moudle
node_module :: import "./node.yo";

// CORRECT — open import for std library modules:
open import "std/collections/array_list";
open import "std/string";

// WRONG — `import "path" as name` does NOT work for .yo files:
// import "./node.yo" as node;  // causes "Invalid function call on type: comptime_string"

// WRONG — absolute-style paths from within a subdirectory:
// import "std/regex/node" as node;  // module resolution fails
```

For files within the same directory, always use relative paths (`./file.yo`). For std library modules, use the standard `"std/module"` path.

**Do NOT import `std/prelude`** — the prelude is automatically loaded for every file. Explicitly importing it (`import "std/prelude"` or `import "std/prelude.yo"`) will produce a compile error. Third-party modules named `prelude.yo` are fine — only the std prelude is blocked.

## Other syntax notes

- `unit` is a type not value, `()` is the unit value.
- There is no `loop` function. Use `while runtime(true), body` for runtime, or `while true, body` for comptime.
- **`while true` is evaluated at compile time!** If the loop body has no runtime values and no `break`/`return`/`escape`, the evaluator will hang or exceed the iteration limit. Always use `while runtime(true), { ... }` for infinite runtime loops (e.g., server accept loops, event loops).
- When calling `assert`, always add 2nd argument: `assert(condition, "error message");`
- Pointer arithmetic uses `&+`, `&-`, `&<`, `&>`, `&<=`, `&>=` operators with `&` prefix.

## Function call syntax — no space before `(`

In Yo, function calls are parsed differently depending on spacing:

- `func(a, b)` — normal call with two arguments
- `func (a, b)` — **space before `(`** makes `(a, b)` a tuple, so this is `func((a, b))` — one argument!
- `func a, b, c` — no parentheses: parsed as `func(a, b, c)` — three arguments
- `func a, b; c` — semicolon terminates argument list: `func(a, b); c`

Always use `func(a, b)` with no space. Never `func (a, b)`.

## `return` without parentheses consumes all following comma-separated arguments

`return` without parentheses follows the same rule as any other call: `return expr1, expr2` is parsed as `return(expr1, expr2)`. Inside match/cond branches, commas separate branches, so:

```rust
// WRONG — parsed as return(str.from_raw_parts(p, len), .None => return("")):
match(opt,
  .Some(p) => return str.from_raw_parts(p, len),
  .None => return ""
)

// CORRECT — begin blocks terminate the argument list at the semicolon:
match(opt,
  .Some(p) => {
    return str.from_raw_parts(p, len);
  },
  .None => {
    return str.from_raw_parts(*(u8)(""), usize(0));
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

## String literal types

- Double-quoted strings `"hello"` return `str` type (a newtype over `Slice(u8)`) at runtime, but `comptime_string` at compile time.
- `comptime_string` does NOT automatically convert to `str` in return statements. Use `str.from_raw_parts(*(u8)("..."), usize(N))` if you need a runtime `str`.
- `*(u8)("literal")` works — casting `comptime_string` to pointer is valid.
- Only pointer-to-pointer and `comptime_string`-to-pointer casts are allowed. Integer-to-pointer casts like `*(void)(usize(0))` are NOT supported.
- **Template strings for constant `String` values**: Use `` `hello` `` instead of `String.from("hello")`. Template strings without interpolation produce the same `String` result in fewer characters.
