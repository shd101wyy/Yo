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
io.async((io : Io) => {
  cond(
    done => .Ok(()),
    true => .Err(e)
  )
})

// CORRECT - lambda body is just the expression, no {...}:
io.async((io : Io) =>
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

## Don't write unnecessary parentheses

`yo fmt` deliberately preserves every parenthesis you write (the gofmt
position — see `plans/archive/FMT_PAREN_CANONICALIZATION.md`), so paren
hygiene is on the author. The rule of thumb: **a comma or a closing paren
already delimits the expression — don't wrap it again.**

```rust
// WRONG — redundant parens around comma-delimited call arguments:
if((x == y), { ... });
assert((a == b), "msg");
while((i < n), { ... });

// CORRECT — the comma is the delimiter:
if(x == y, { ... });
assert(a == b, "msg");
while(i < n, { ... });
```

But keep the parens the GRAMMAR needs — these are NOT unnecessary:

- **`cond`/`match` arm conditions that are infix expressions**:
  `cond((x == y) => a, true => b)` — `==` next to `=>` is two adjacent
  different operators, so the parens are required.
- **Mixed-operator chains**: `(a + b) * c` — no precedence; required.
- **Struct-literal field values with infix**: `{ x : (1 + 2), y : 3 }`.
- **Prefix-operator INFIX operands**: `-(1 + 2)` — a prefix operator
  binds exactly ONE postfix expression
  (plans/PREFIX_OPERATOR_OPERAND_RULE.md Rule 1, landed 2026-08-21), so
  an infix-chain operand needs parens. Bare-primary operands do NOT:
  `-1`, `!x`, `~m`, `&v`, `?*T` (= `?(*(T))`), `**T`, and `3 - -3` are
  all valid and preferred in NEW user code. **Seed constraint: `src/`
  and `std/` must keep the parenthesized spellings (`-(1)`, `!(x)`)
  until a release with this rule becomes the seed** — the seed binary
  still rejects paren-less prefix calls.

Same-operator chains never need parens: `a + b + c`, `a && b && c`.

## `if` is sugar for `cond`

`if(...)` calls are desugared to `cond(...)` at parse time (`desugar_if_calls` in `src/expr.yo`), so every pass after parsing sees a real `cond` node. The equivalent macro definition is kept in `prelude.yo` as the spec and as a fallback for dynamically built ASTs (plans/MACRO_POLICY.md Part 3.2):

```rust
if(condition, then_body)        // → cond(condition => then_body, true => ())
if(condition, then_body, else)  // → cond(condition => then_body, true => else)
```

Use `if` for simple two-branch conditionals — especially for comptime early-return guards:

```rust
if(arch == Arch.Wasm32, {
  printf("  skipped on wasm32\n");
  return();
});
```

Use `cond` when there are more than two branches or when the branches are large.

## Function definitions

- `(fn(param1 : Type1, param2 : Type2) -> ReturnType)({ body; return(expr); })`
- No space between `(fn() -> ReturnType)` and `({ body; })`
- Function type body creation is a normal call: `(fn(...) -> T)({ body })`, not `(fn(...) -> T) { body }`
- Top-level aliases for function types also need parentheses: `Callback :: (fn(x : i32) -> i32);`, not `Callback :: fn(x : i32) -> i32;`
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

If a `match`/`cond` branch returns an enum variant and the evaluator reports
"Failed to infer enum variant type", qualify the variant explicitly, e.g.
`TypeValue.Unit` instead of `.Unit`.

Do not write sibling enum-payload literal patterns such as `.Some(false)` and
`.Some(true)`. Match the variant once (`.Some(value)`) and branch on `value`
inside the arm. The self-hosted codegen can otherwise emit duplicate C `case`
labels for the same enum variant.

When writing large enum matches, avoid binding a pattern variable with the same
name as a variant field (for example, prefer `struct_field_types` over
`field_types`). Some self-hosted codegen paths can currently emit invalid C for
those shadowing-shaped bindings.

## All function and keyword calls require immediate `(...)`

- Write `func(arg1, arg2)`, not `func arg1, arg2`.
- Do not insert whitespace before call parentheses: `func(arg)`, not `func (arg)`.
- Control-flow keywords follow the same rule: `return(value)`, `return()`, `unwind(value)`, `unwind()`.
- In `(exn : Exception) = Exception(throw: ((err) -> { ... }))` handlers, add `unwind(...)` / `unwind()` when the handler does not resume normally. Calls like `exit(int(1))` return `unit`; they do not satisfy the handler's `ResumeType` by themselves. (`unwind` requires the handler's lambda to be typed as `ctl(...) -> R`, which it is when bound to a `ctl`-typed field like `Exception.throw`.)
- Prefix operators may use the call form (`&(x)`, `!(ready)`) or bind one bare postfix expression (`&x`, `!ready`, `-value` — plans/PREFIX_OPERATOR_OPERAND_RULE.md Rule 1; see "Unary (prefix) operators" below, including the src/std seed constraint). A no-whitespace `(` after the operator is always the call form.
- Macro unquote syntax is also tight: use `#(expr)` and `...#(exprs)`.
- **The operator token set is CLOSED** (plans/OPERATOR_SET_AND_PRECEDENCE.md): a run of operator characters is split greedily against the fixed table in `src/lexer.yo` (`_is_two_char_operator`/`_is_one_char_operator`); an unknown run is a lex error, and `**x` lexes as `*`,`*`,`x`. Reserved operators (`= := :: : => -> <: ?= && || # ...#`, ranges) can never be bound or overloaded (`is_reserved_operator_name` in `src/token.yo`, gated in `evaluator/exprs/binding.yo`). Adding a new operator = editing the lexer table deliberately, like a keyword.
- **DEFINING a macro (a `quote(...)` parameter or `unquote(...)` return type) requires `pragma(Pragma.AllowMacroDef);` at the top of the file** (plans/MACRO_POLICY.md). Calling macros and working with quoted `Expr` values (the derive-rule mechanism) is ungated. std is exempt this generation (seed-bootstrap constraint — see `is_macro_def_capable_file` in `src/evaluator/memory_safety.yo`). The std `try` macro was REMOVED — match on the `Result`, or define a local equivalent under the pragma.
- Dynamic field access with unquote requires grouping after the dot: `value.(#(field_expr))`, not `value.#(field_expr)`.

Note how the prefix rule disambiguates `&x, y`: a bare `&` binds ONE
postfix expression, so `call(&x, y)` passes a pointer to `x` plus `y`.
Taking the address of a tuple needs the call form:

```rust
// Pointer to x, plus y (bare prefix binds one postfix expression):
call(&x, y)      // same as call(&(x), y)

// Address of the tuple (x, y) — call form required:
call(&(x, y))
```

Parens are also required for zero-argument control flow:

```rust
if((arch == Arch.Wasm32), {
  return();
});
```

## No operator precedence

Yo has **no operator precedence**. Two rules:

1. **A chain of the SAME operator is left-associative** — no parentheses needed.
   `a + b + c` parses as `(a + b) + c`; `(A | B | C | D)` is fine as-is.
2. **Adjacent DIFFERENT operators require explicit parentheses** — otherwise a
   parse error: _"Adjacent different operators need parentheses to clarify
   grouping."_

```rust
// CORRECT — same operator, no nesting needed:
(A | B | C | D)
1 + 2 + 3        // ⇒ (1 + 2) + 3

// WRONG — different operators with no parentheses:
a + b * c
// CORRECT — choose the grouping explicitly:
(a + b) * c      // or: a + (b * c)
```

**Source layout no longer affects grouping.** There is NO newline-based
associativity (an earlier rule let a leading/trailing newline pick
associativity; it has been removed — see `plans/OPERATOR_ASSOCIATIVITY.md`).

`:`, `:=`, `=`, `::`, and `->` are ordinary operators with no precedence, so a
type/value containing a _different_ top-level operator must be parenthesized:

```rust
// `:` vs `->` — wrap the fn type:
next : (fn(inout(self) : Self) -> Option(Self.Item))

// `::` vs `->` — wrap a fn-type alias:
FuncType :: (fn() -> void)

// `:` vs `=` — wrap the typed binding:
(err1 : AnyError) = dyn(ErrA(`error A`));

// `:=` vs `&&` — wrap the operator RHS:
is_neg := ((a == "-") && (b == 1));
```

Formatter-specific syntax preservation:

- Canonical pointer dereference is `ptr.*`; format legacy `ptr.(*)` as `ptr.*`.
- Keep compact collection and tuple literals compact when they are single-line, even inside a multiline call: `[1, 2, 3]`, `(1, 2, 3)`.

Special tight syntaxes must stay immediate: macro splices `#(expr)`, Option sugar `?(T)` / nullable pointers `?(*(T))`, and negated trait constraints `T <: !(Runtime)` must not be formatted as `# (expr)`, `? (T)`, or `T <: !(Runtime)`.

Example: `((value <= 0x10FFFF) && ((value < 0xD800) || (value > 0xDFFF)))`

## Unary (prefix) operators bind exactly ONE postfix expression

Since 2026-08-21 (plans/PREFIX_OPERATOR_OPERAND_RULE.md Rule 1), a bare
prefix operator (`-` `!` `~` `&` `*` `?` `^`) followed by a primary is
valid: it binds exactly one postfix expression — the primary plus its
dot-chains and calls — and nothing more.

```rust
// Valid, and preferred in NEW user code:
x := -1;
assert(!d.is_empty(), "bare prefix binds the whole call chain");
p := &x;
t :: ?*u8;      // = ?(*(u8)) — Option of raw pointer
y := 3 - -3;    // infix minus, then prefix minus

// An INFIX operand still needs parens (one postfix expression only):
-(1 + 2)        // NOT -1 + 2, which is (-1) + 2
```

**Seed constraint: `src/` and `std/` must keep the parenthesized
spellings (`-(1)`, `!(x)`, `&(s)`) until a release with this rule becomes
the seed** — the seed binary still rejects paren-less prefix calls. The
formatter emits bare prefix forms tight (`-1`, `!x`, `?*i32`), keeps
`- -1` spaced (a tight `--1` reads as a C decrement), and never tightens
a pair that would re-lex as one token (`& &x` stays spaced — `&&` is a
token).

**`!x && y` groups as `(!x) && y`** — the prefix operator binds only the
one postfix expression. Since unary and infix are _different operators
with no precedence_, write the other intent with parens:

```rust
// (NOT x) AND y:
!x && y

// NOT (x AND y):
!(x && y)
```

**Special note for reference-semantics types** (`ref(struct(...))` / `ref(enum(...))`): passing by value already propagates mutations (RC fields are shared), so `*(MyRefType)` pointers are rarely needed. Prefer passing by value and avoid `&obj` in most cases.

## Parameter form by type kind

The right shape for a function parameter depends on what kind of type the value is:

| Type kind                                                          | Shape                                                     | Why                                                                                                                 |
| ------------------------------------------------------------------ | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `ref(struct(...))` / `ref(enum(...))` (incl. `atomic(ref(...))`)   | `name : Type`                                             | Reference-semantics types — mutations propagate via the underlying RC value. No pointer needed.                     |
| `struct(...)` value type (read-only)                               | `name : Type`                                             | Pass by value. Cheap if small; consider `inout` for large structs.                                                  |
| `struct(...)` value type (need mutation)                           | `inout(name) : Type`                                      | Caller's binding sees in-place writes. See [`inout` section](#inoutname--t-parameters-for-in-place-mutation) below. |
| `enum(...)` (read-only)                                            | `name : Type`                                             | Same as struct.                                                                                                     |
| `enum(...)` (need mutation)                                        | `inout(name) : Type`                                      | Same as struct.                                                                                                     |
| Primitive (`i32`, `bool`, …)                                       | `name : Type` for read, `inout(name) : Type` for mutation | Same rule.                                                                                                          |
| Receiver of mutating method on `ref(struct(...))`/`ref(enum(...))` | `self : Self`                                             | Reference semantics — explicit `inout(self)` is unnecessary noise (though it works).                                |
| Receiver of mutating method on value type (trait or inherent)      | `inout(self) : Self`                                      | Caller-side writes propagate. Established for `Hash`, `Clone`, `ToString`, `Iterator`.                              |
| Raw FFI pointer (legitimate `*(T)`)                                | `name : *(T)`                                             | Only when interfacing with C / the runtime ABI. Requires `pragma(Pragma.AllowUnsafe);` at the file top.             |

**Anti-patterns to avoid:**

```rust
// ✗ Pointer on a reference-semantics type — wraps a reference in another reference
foo : (fn(ctx : *(EvalContext)) -> unit)({ ctx.*.method() })

// ✗ Inout on a reference-semantics type — redundant; reference semantics already share state
foo : (fn(inout(ctx) : EvalContext) -> unit)({ ctx.method() })

// ✓ Plain — concise and correct
foo : (fn(ctx : EvalContext) -> unit)({ ctx.method() })
```

The same applies at call sites: don't wrap reference-semantics arguments with `&(obj)` to pass to a function expecting one; just pass `obj`.

When choosing between `inout(self) : Self` and `self : Self` for a method receiver:

- If the receiver type is fundamentally a value type (anything other than `ref(struct(...))` / `ref(enum(...))`), use `inout(self) : Self` for mutators.
- If the receiver type is a reference-semantics type (`ref(struct(...))` / `ref(enum(...))`), plain `self : Self` is the idiom — the methods documented in `src/env.yo`, `src/emitter.yo`, etc. follow this.
- Trait declarations should match the dominant case of their impl targets. Existing widely-implemented traits (`Hash`, `Clone`, `ToString`, `Iterator`, `Index`) use `inout(self) : Self` for the reasons above; new traits that are reference-semantics-specific can use plain `self : Self`.

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

`recur` refers to the **nearest enclosing `fn`**. Inside `io.async((io : Io) => ...)`, that lambda _is_ the enclosing `fn`, so `recur` would call the lambda — not the outer function. This causes an argument-type mismatch error.

**Pattern for async recursion**: Replace recursion with an iterative worklist:

```rust
// WRONG — "Variable 'walk_dir' not found" inside io.async:
walk_dir :: (fn(path: Path, io: Io) -> Impl(Future(unit, Io)))(
  io.async((io : Io) => {
    entries := io.await(read_dir(path, io), io);
    // CANNOT call walk_dir recursively here
  })
);

// CORRECT — bundle the needed effects into one struct and iterate with a stack:
WalkCtx :: struct(io : Io, exn : Exception);

walk_dir :: (fn(root: Path, ctx : WalkCtx) -> Impl(Future(unit, WalkCtx)))(
  io.async((ctx : WalkCtx) => {
    stack := ArrayList(Path).new();
    { stack.push(root); };
    while(stack.len() > usize(0), {
      cur := match(stack.pop(), .Some(p) => p, .None => return());
      entries := ctx.io.await(read_dir(cur, ctx.io), ctx.io);
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
// import "./node.yo" as node;  // causes "Invalid function call on type: comptime_str"

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

## `short`, `long`, `int`, `char` are not usable as variable names

They are builtin type names. `short := io.await(...)` fails with:

```
Error: Failed to define variable "short":
```

The diagnostic points at the binding and never mentions keywords, so it reads
like the RHS failed to type — the wrong place to look. Measured 2026-08-12:
`short`, `long`, `int` and `char` are rejected; `float`, `double`, `signed`,
`unsigned`, `register` and `volatile` are accepted. Rename the local.

## Other syntax notes

- `unit` is a type not value, `()` is the unit value.
- There is no `loop` function. Use `while(true, body)` for a runtime infinite loop.
- **`while(cond, body)` is always a runtime loop**, regardless of whether `cond` is compile-time known.
- **Do NOT wrap the `while` condition in `runtime(...)`** — `while(runtime(cond), body)` is redundant because the condition is already evaluated at runtime by default. Write `while(cond, body)`. (`runtime(...)` only matters in a `::`/comptime context to force runtime evaluation; a `while` condition is never that context.)
- **`while(comptime(cond), body)`** explicitly opts into compile-time loop unrolling. Requires `cond` to be a compile-time-known value. The evaluator will error if it detects an infinite loop (e.g., `while(comptime(true), ...)` with no `break`/`return`/`unwind`).
- If you use a comptime-only (`::`) variable in a bare `while` condition (without `comptime()`), the compiler will **error**: the condition would never change at runtime, causing an infinite loop.
- `assert`/`panic` live in `std/assert` (`{ assert, panic } :: import("std/assert");`) — not prelude-ambient. Messages accept any `ToString` type (template strings OK); `assert(cond)` uses a default message. The diverging builtin for value-position arms is `__yo_panic("str only")`.
- Pointer comparison is plain `==`/`!=`/`<`/`<=`/`>`/`>=` (Eq/Ord impls on `*(T)`, address identity). Pointer arithmetic is METHODS: `p.add(n)`, `p.sub(n)` (offset by `usize` elements), `p.offset_from(q)` (signed element distance → `isize`). Comparisons are safe; arithmetic methods require `unsafe(...)`.
- **Associated-type binding syntax works only on BARE trait names, not parameterized trait constructors.** `where(Self <: Iterator(Item := A))` is fine (`Iterator` is a bare trait); `where(T <: Add(T, Output := T))` is REJECTED ("Argument count mismatch: expected 1, got 2") because `Add` is a trait CONSTRUCTOR (`Add(Rhs)`) and the binding parses as a second argument. Use the plain bound (`where(T <: (Add(T), Default))`) and let per-call specialization resolve `Output` — measured working end-to-end (prelude `Iterator.sum`).
- **A module-level `NAME :: <backtick String literal>` is REJECTED** ("Expected compile-time value for NAME"): `::` constants must be comptime values, and a backtick literal (like `String.from(...)`) constructs a runtime RC `String`. Double-quoted `str` (`app_name :: "yo-demo";`) and numeric constants (`_COMMA :: u8(44);`) are fine — `str` is static. For big `String` data (e.g. an embedded table), put the backtick literal INSIDE the function that consumes it (`data := ` + blob) — it is one C string literal there; a module-level `:=` global also works but runs at module init and module globals get unmangled C names (alias hazard). Precedent: `std/encoding/html_entities.yo`.

## `unsafe(...)` and `pragma(Pragma.AllowUnsafe);` for raw pointer operations

User code is memory-safe by default. To use raw pointers, a `.yo` file must declare `pragma(Pragma.AllowUnsafe);` at the top — this opts the entire file into unsafe-capability. Without the pragma, `unsafe(...)` itself is a compile error and pointer ops are forbidden.

```rust
pragma(Pragma.AllowUnsafe);

main :: (fn() -> unit)({
  x := i32(42);
  p := &(x);
  v := unsafe(p.*);   // OK
});
```

Inside an unsafe-capable file, the following operations require an explicit `unsafe(...)` wrap (so the unsafe surface stays greppable):

- Pointer dereference: `p.*` (read), `p.* = v` (write)
- Pointer arithmetic: `.add(n)`, `.sub(n)`, `.offset_from(q)`
- `consume(p.* = v)` (deref-and-init)

Operations that stay safe (no wrap needed): `&(x)` to take an address, passing/storing/returning pointers, pointer comparison (`==`, `<`, etc.), and pointer-type casts (`*(u8)(p)`).

`unsafe(expr)` is a regular builtin call taking exactly one argument — the same shape as `return(...)`, `consume(...)`. It's a compile-time marker only; at codegen it lowers to its inner expression.

`pragma(...)` is also a regular builtin call. The argument `Pragma.AllowUnsafe` is recognized at the AST level; you can place the pragma anywhere at the top of the file (after the file's leading `//` comments). Multiple `pragma(...)` declarations are allowed.

```rust
// Single expression:
v := unsafe(p.*);

// Assignment:
unsafe(p.* = i32(12));

// cond / match wrapped directly (no braces — `{...}` without `;` is a struct):
result := unsafe(cond(
  (n > i32(0)) => p.*,
  true => i32(0)
));

// Multi-statement begin-block (semicolons required):
n := unsafe({
  p.* = i32(1);
  (p.* + i32(2))
});
```

`unsafe(...)` does NOT propagate through function calls — each function body is evaluated with its own context. If a function's body does pointer ops, the body must wrap them locally; callers don't need `unsafe(...)` at the call site. See `plans/MEMORY_SAFETY.md`; user-facing version: `docs/en-US/MEMORY_SAFETY.md`.

### Extern "c" calls also require an `unsafe(...)` wrap

Even inside a pragma'd file, every `extern "c"` call site must be wrapped in `unsafe(...)`. The pragma authorizes DECLARING the FFI symbol (via `extern(...)` / `c_include(...)`); the wrap is the per-call audit marker that lets `yo unsafe-report` line up with the actual UB-capable lines.

```rust
pragma(Pragma.AllowUnsafe);
{ memcpy, strlen } :: import("std/libc/string");

copy :: (fn(dst : *(u8), src : *(u8), n : usize) -> unit)({
  _ := unsafe(memcpy((*(void))(dst), (*(void))(src), n));   // wrap required
});

len :: (fn(s : *(char)) -> usize)(unsafe(strlen(s)));        // wrap required
```

`asm(...)` and `extern(...)`/`c_include(...)` declarations themselves do NOT need a wrap — the `asm` keyword and the declaration syntax are themselves the per-site markers, and the pragma is the file-level gate.

### c_include-typed integers: cast to a Yo int before comparing

Values typed by a `c_include` type alias (`ssize_t`, `off_t`, …) can fail to
transpile in comparisons (`n <= isize(0)` emits `// Failed to transpile` in
condition position — a class `yo check` cannot see; the C compiler then
errors). Casts DO emit correctly, so bind through a cast at the call site:

```rust
// WRONG — may emit "// Failed to transpile n <= isize(0)":
n := unsafe(write(int(fd), *(void)(p), count));   // n : ssize_t
if(n <= isize(0), { ... });

// CORRECT — cast to a Yo integer at the binding:
n := i64(unsafe(write(int(fd), *(void)(p), count)));
if(n <= i64(0), { ... });
```

See `issues/cinclude-int-comparison-fails-to-transpile.md`.

`auto-generated://` URIs (macros, derive expansions) bypass the per-call wrap — the macro author owns the contract via the expansion site. See `plans/archive/EXTERN_UNSAFE_WRAP.md`.

### Raw views and the static-str model (post slice-rework)

The builtin `Slice(T)` and the view methods `String.as_str()` /
`ArrayList.as_slice()` are DELETED (plans/archive/SLICE_REWORK.md). The model:

- `str` is the builtin view of STATIC string bytes (literals / template
  segments) — immortal backing, freely storable/returnable, no flow
  constraints.
- Range indexing COPIES: `arr(a..b)` → new `ArrayList(T)`, `s(a..b)` on
  `String` → new `String`; `str` ranges stay zero-copy static windows.
- There is no aliasing view type: `ListView(T)` was deleted (no `Index`, no
  iteration, no consumers — superseded by the copying range forms above). If a
  real view type is ever needed it comes back with iteration and `Index`.
- Privileged ptr+len plumbing uses `RawSlice(T)` (prelude). Naming it —
  or any type whose representation carries a raw pointer — in a
  parameter annotation requires `pragma(Pragma.AllowUnsafe);` (a
  representation-based gate, not just the `*(T)` syntax gate).
- `inout(name) : T` flowability (rules R1–R4) is unchanged. See
  `docs/en-US/FLOWABILITY.md` and `tests/flowability_comprehensive.test.yo`.

### Return-slot modifiers: `inout` is BANNED; `comptime` goes on the label

**Functions cannot return `inout`, and there are no local inout bindings** (v4/v4.1, `plans/archive/BORROW_EXCLUSIVITY.md`): they are second-class and exist ONLY in parameter position. `inout(r) := …` is rejected (fields read/write in place: `h.s = v`). Return the value instead (reference-semantics values are handles that mutate in place; struct values copy), or take a callback parameter that receives `inout(name) : T`. An inout ARGUMENT is a simple lvalue place: a variable, or `var.field` rooted at a local/param — chains through an intermediate reference-semantics value and module-level field roots are rejected (bind the value to a local first: `b := a.b`).

| Form                                                              | Verdict                                       |
| ----------------------------------------------------------------- | --------------------------------------------- |
| `-> comptime(T)` (unlabeled), `-> (comptime(name) : T)` (labeled) | ✅ valid                                      |
| `-> inout(T)`, `-> (inout(name) : T)`, `-> (name : inout(T))`     | ❌ rejected — functions cannot return `inout` |
| `-> (name : comptime(T))`                                         | ❌ rejected — modifier goes on the label      |

Enforced at function-type evaluation (`src/evaluator/types/function.yo`). See `tests/ref_return_ban.test.yo`.

### Signed-integer overflow is defined (wrap-around)

Yo passes `-fwrapv` to clang/gcc/zig by default, so signed-integer overflow is two's-complement wrap-around, not UB. `x := i32(2147483647); y := (x + i32(1));` evaluates to `i32(-2147483648)`, not silent miscompilation. Opt-out: `--cflags='-fno-wrapv'`.

**COMPTIME arithmetic is the opposite: it REJECTS overflow.** The wrap-around above is a property of the *runtime* operator. Whenever both operands are compile-time constants the `Comptime*` overload is selected instead (`__yo_comptime_i32_add` and friends in `std/prelude.yo`), and that one raises a hard error rather than wrapping:

```rust
y := (i32(2147483647) + i32(1));   // ERROR: Integer overflow in compile-time evaluation
                                    //   2147483647 + 1 = 2147483648
                                    //   Result 2147483648 exceeds i32 range [-2147483648, 2147483647]

x := i32(2147483647);
y := (x + i32(1));                  // OK — runtime add, wraps to i32(-2147483648)
```

The two forms look nearly identical, so this bites when writing a test that asserts wrap-around: the *expected* value must also be built from a runtime binding, e.g. `(seed : i32) = i32(2147483647); (expected : i32) = (seed + i32(1));`. Writing the expectation as a folded constant fails the compile instead of the assertion. (Measured 2026-08-25 while adding the atomic `fetch_*` family — `tests/sync/atomic.test.yo` "wraps like the runtime operator".)

### `// SAFETY:` comment convention

Every non-obvious `unsafe(...)` site in stdlib should have a `// SAFETY:` comment explaining the contract (what invariant guarantees the deref/arith is in bounds and the pointer is live). `yo unsafe-report` scans the previous ~8 lines preceding each unsafe site and surfaces the comment in the report.

```rust
match(
  self._ptr,
  // SAFETY: idx bounds-checked above (idx < self._length);
  // _ptr points at the Rc-managed heap buffer.
  .Some(_ptr) => (_ptr.add(idx)),
  .None => __yo_panic("ArrayList: empty")
)
```

## `inout(name) : T` parameters for in-place mutation

For mutating a caller's variable without raw pointers, use the `inout` parameter modifier. It wraps the parameter name (parallel to `own(name)`) and gives second-class reference semantics — reads/writes through the parameter access the caller's storage.

```rust
swap :: (fn(inout(a) : i32, inout(b) : i32) -> unit)({
  tmp := a;
  a = b;
  b = tmp;
});

main :: (fn() -> unit)({
  x := i32(1);
  y := i32(2);
  swap(x, y);              // no `&()` syntax at the call site
  assert((x == i32(2)), "swapped");
});
```

Rules:

- `inout(...)` cannot combine with `own(...)` (opposite calling conventions) or with `generic`/`using` parameters (those are erased at runtime — no callee-side binding to mutate).
- `inout` CAN combine with `comptime` as `comptime(inout(name)) : T` (outer comptime, inner inout). The parameter is erased at runtime and mutations propagate via the evaluator's compile-time binding update path. The prelude `ComptimeIndex` trait uses this form (`index : (fn(comptime(inout(self)) : Self, comptime(idx) : Idx) -> comptime(*(Self.Output)))`) to let comptime index methods mutate the caller's value without a raw pointer parameter.
- Inside the callee, the inout-param identifier behaves like a regular variable for reads (`tmp := a;`) and assignments (`a = b;`).
- Calls through inout-params chain naturally: `fn outer(inout(x))` calling `fn inner(inout(p))` with `inner(x)` passes `&x` to `inner` (the caller-side `&` is implicit).
- At codegen, `inout(name) : T` lowers to `T*` in C. Reads of `name` in the callee become `(*name)`; writes become `(*name) = v`. For interior-ref arguments (`xs(i)`, `self->_inner(i)`), the codegen emits `__yo_borrow_acquire/release` bracketing the call (a same-cache-line counter increment/decrement on the container's RC header — ~0% overhead). Container growth operations (realloc/free inside a reference-semantics method) auto-assert the counter is zero, turning the one statically-unprovable interior-ref shape into a deterministic panic. `comptime(inout(name))` has zero codegen impact (the parameter is erased).

`inout` is the safe in-place-mutation primitive for user code. Stdlib trait methods that previously took `(self : *(Self))` have all been migrated to `(inout(self) : Self)` — Hash, Clone, ToString, Index, ComptimeIndex, Writer, Reader, and `Iterator` (the for-loop redesign documented in `plans/archive/ITERATOR_REDESIGN.md` shipped alongside Phase D of `plans/MEMORY_SAFETY.md`).

### Public stdlib boundary — no raw pointer leaks

Every public top-level `fn(...)` in `std/` should take and return value or `inout`-bound types. Raw `*(T)` in a public signature is allowed only when (a) the function lives in an FFI directory (`libc/`, `linux/`, `darwin/`, `cuda/`, `sys/`, `sync/`), or (b) the function name signals raw-pointer use by contract (`*_cstr`, `*_ptr`, `from_raw_parts`, `as_ptr`, names starting with `raw_`). Anything else is a leak — migrate to owned collections (`ArrayList(u8)`/`String`) for buffers, `inout(name) : T` for in-place mutation, or a higher-level safe type (`RawSlice(T)` for pragma'd internals).

Verify with `yo public-safe-report ./std` (or `./src`). It scans every top-level public `fn(...)` declaration, skips `extern(...)` blocks and the directories/name patterns above, and reports any remaining raw-pointer leak. Source: `src/public_safe_report.yo`. Currently reports 0 findings; keep it that way when adding new stdlib surface.

## `for` loop macro — correct form

The `for` macro is a 2-argument prelude macro iterating BY VALUE (it expands to `coll.into_iter()`):

```rust
for(list, (x) => { process(x); });               // value form: macro expands to list.into_iter()
for(names, (s) => { s.push_str("!"); });         // reference-semantics elements are HANDLES: mutates in place
for(chain.map(f), (y) => println(y));            // combinator chain: pass as the value-form iterator
```

- First argument: the collection itself, or an iterator chain (`.map().filter()`-style).
- Second argument: an anonymous closure `(x) => body`; `x` is `T` by value (a handle for reference-semantics element types — mutating it mutates the element in place).
- **The borrow form `for(coll, ref(x) => body)` was REMOVED** (v4, `plans/archive/BORROW_EXCLUSIVITY.md` — no interior refs). It produces a teaching compile error. For in-place struct/scalar element mutation use an index loop with index writes: `while(i < coll.len(), { coll(i) = transform(coll(i)); i = (i + usize(1)); })`.
- **Do NOT use `for(x, arr, { body })`** — this older 3-arg form is an evaluator-internal representation and is not valid top-level Yo source. (The self-hosted evaluator's internal for-loop handler currently only understands the 3-arg form; this is tracked in `issues/eval-for-loop-3arg-vs-2arg.md`.)

## Function call syntax — required immediate `(`

In Yo, function calls must always use immediate parentheses:

- `func(a, b)` — normal call with two arguments
- `func (a, b)` — invalid whitespace before `(`
- `func a, b, c` — invalid paren-less call
- Prefix operators follow the same rule: `&(x)`, `!(ready)`, `-(value)`
- Control flow follows the same rule: `return(value)`, `return()`, `unwind(value)`, `unwind()`

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
raw_bytes : (fn(self: Self) -> RawSlice(u8))(
  match(self._bytes._ptr,
    .Some(p) => RawSlice(u8)(ptr : p, len : self._bytes._length),
    .None => RawSlice(u8)(ptr : *(u8)(""), len : usize(0))
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
  Rectangle(width : i32, height : i32),
  Triangle(base : i32, height : i32, label : str)
);

match(s,
  // ✅ Preferred — Curly shorthand: `{a, b: c}` names only the fields
  //    the arm uses. Order-free, partial matches allowed.
  .Triangle({base, height: h}) => (base * h),

  // Also OK — Labeled `(label: var)` pairs. Order-free, partial matches OK.
  .Circle(radius: r) => (r * r),

  // ⚠️ Avoid for variants with 2+ fields — Positional ordering with `_`
  //    padding is brittle (adding a field shifts every later position)
  //    and hard to read (each `_` requires counting fields). Fine when
  //    every field is named *and* the variant has one or two fields.
  .Rectangle(w, h) => (w * h)
)
```

**Preferred form: curly shorthand `.Variant({field1, field2: alias})`** —
names only the fields the arm needs, so adding a new field to the variant
later does not silently shift positions in every arm. The
`tests/match_curly.test.yo` spec covers this form end-to-end.

Curly destructuring rules:

- `{a}` binds field `a` to a variable named `a` (label = name shortcut).
- `{a: x}` binds field `a` to a variable named `x` (rename).
- `{a: _}` asserts field `a` exists but ignores its value.
- Partial matches are allowed: `{width}` on `Rectangle(width, height)` skips `height`.
- Empty `{}` is allowed: `.Variant({})` matches the variant and binds NO fields
  (the zero case of partial curly). Bare `.Variant` (no parens) does the same —
  both work even for variants WITH fields ("ignore all fields"), so you don't
  need `.Variant(_, _, …)`. (Intentionally more permissive than Rust.)
  `tests/match_bind_nothing.test.yo` is the spec.
- Bare `_` (e.g., `{_}`) is rejected — use `{label: _}` to ignore a specific field.
- Nested curly `.Foo({a: {b}})` is rejected — destructure in the body instead.

The parser rewrites `{...}` to `_(...)` and turns bare atoms into `(name: name)` pairs at parse time, so internally curly form is just a labeled-destructuring pattern wrapped in `_(...)`. The match evaluator unwraps that wrapper.

## String literal types

- Double-quoted strings `"hello"` return `str` (the BUILTIN view of static string bytes) at runtime, but `comptime_str` at compile time.
- `comptime_str` does NOT automatically convert to `str` in return statements. Use `str.from_raw_parts(*(u8)("..."), usize(N))` if you need a runtime `str`.
- `*(u8)("literal")` works — casting `comptime_str` to pointer is valid.
- Only pointer-to-pointer and `comptime_str`-to-pointer casts are allowed. Integer-to-pointer casts like `*(void)(usize(0))` are NOT supported.
- **Template strings for constant `String` values**: Use `` `hello` `` instead of `String.from("hello")`. Template strings without interpolation produce the same `String` result in fewer characters.

## Trait method dispatch syntax

### Implicit dispatch (via where-clause)

When a generic function has `where(T <: Trait)`, calling `self.method()` on a parameter of type `T` dispatches to `Trait`'s method:

```rust
use_t1 :: (fn(generic(T : Type), self : T, where(T <: T1)) -> i32)({
  return(self.get_number());  // Dispatches to T1.get_number
});
```

### Explicit trait dispatch

Use `(T <: Trait).method(self)` to explicitly select which trait's method to call:

```rust
use_t2 :: (fn(generic(T : Type), self : T, where(T <: T2)) -> i32)({
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
Variable :: ref(struct(name : String, type : TypeValue));
define :: (fn(ty : TypeValue) -> unit)(...)  // CORRECT, use `ty`

// CORRECT — rename to `ty`:
Variable :: ref(struct(name : String, ty : TypeValue));
```

Other reserved words to avoid as identifiers: `fn`, `type`, `trait`, `impl`, `enum`, `struct`, `ref`, `atomic`, `inout`, `newtype`, `match`, `cond`, `if`, `while`, `for`, `return`, `unwind`, `recur`, `export`, `import`, `using`, `given`, `generic`, `where`.

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

### Don't write the verbose `(&(X)).index(i).*` form

The Index trait method `.index(i)` returns `*(T)`. The verbose form

```rust
(&(self.field)).index(i).* = value;    // ✗ writes through raw pointer
elem := (&(self.field)).index(i).*;    // ✗ same, but as a read
v := list.get(i).unwrap();             // ✗ Option unwrap of safe form
```

requires `pragma(Pragma.AllowUnsafe);` because of the `.*` deref, and
just clutters the call site. Use the call-syntax form everywhere it
works:

```rust
self.field(i) = value;                 // ✓ same write, no `.*`
elem := self.field(i);                 // ✓ same read
v := list(i);                          // ✓ same panic-on-OOB semantics
```

Out-of-bounds panic is preserved — `list(i)` panics via the Index
trait's bounds assertion, the same as `.unwrap()` on `.get(i)` would.

Use the verbose form **only** when you need to keep the raw `*(T)` —
e.g., to pass it to another routine that mutates through the pointer
multiple times, or when borrowing through a non-Index trait method.

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

## Named constructor arguments are required for `struct`/`ref(struct(...))` types

When constructing a `struct(...)` or `ref(struct(...))` value, always use named field syntax:

```rust
Point :: struct(x : i32, y : i32);

// CORRECT — named fields:
p := Point(x: i32(1), y: i32(2));

// WRONG — positional construction for struct/ref(struct(...)) is not supported:
p := Point(i32(1), i32(2));
```

`enum` variant construction is positional (fields are matched by order):

```rust
// CORRECT — enum variants use positional args:
(v : Option(i32)) = .Some(i32(42));
```

## Design-by-contract clauses (`requires` / `ensures` / `invariant` / `ghost`)

Phase 0 of `plans/FORMAL_VERIFICATION.md` adds a contract surface. The
SMT verifier is NOT built yet — in Phase 0 these lower to runtime
`assert(...)` (runtime functions) or `comptime_assert(...)` (comptime
functions, i.e. those returning `comptime(T)`).

### `requires` / `ensures` go in the function signature

They are clauses in the parameter list, after regular params and
`where(...)`. The clause order is **enforced** (not just conventional):
`generic(...), ...params..., where(...), requires(...), ensures(...)`.
A clause out of order — `ensures` before `requires`, `where` after
`requires`, a regular param after `where`/`requires` — is a syntax
error ("X appears after Y in the function signature").

```rust
// requires = precondition, ensures = postcondition.
divide :: (fn(x : i32, y : i32, requires(y != i32(0)), ensures(result == (x / y))) -> i32)(
  x / y
);
```

- **Single-call rule**: at most ONE `requires(...)` and ONE
  `ensures(...)` per signature. Multiple predicates go inside one call:
  `requires(a, b, c)`. Two `requires(...)` clauses is a syntax error.
- **Zero-argument** `requires()` / `ensures()` is a syntax error — omit
  the clause instead.
- Inside `ensures(...)`: `result` is the return value, and `old(expr)`
  is the value of `expr` on function entry (correct for mutated
  `inout(name) : T` params). `result` is NOT a reserved word — it is a
  local the ensures-wrapper binds, so it does not clash with `result`
  used as an ordinary variable elsewhere.

```rust
increment :: (fn(inout(n) : i32, requires(n < i32(100)), ensures(n == (old(n) + i32(1)))) -> unit)({
  n = (n + i32(1));
});
```

- `where(P)` with a `bool` predicate is treated like `requires(P)`;
  choose `where` for type-intent, `requires` for value-intent.

### `invariant(...)` is the FIRST statement of a `while` body

```rust
while(i < n, {
  invariant((i >= i32(0)) && (i <= n), acc >= i32(0)); // must be first
  i = (i + i32(1));
  acc = (acc + i);
});
```

Placing `invariant(...)` anywhere except the first non-comment statement
of the loop body — a later statement, inside a `cond`/`match` branch, or
a nested block — is a syntax error. (Type-body invariants inside
`ref(struct(...))` are NOT implemented in Phase 0.)

### `ghost(...)` vs `ghost_fn(...)`

- `ghost(name := expr)` — a spec-only binding (Phase 0: a no-op marker).
- `ghost_fn(fn_value)` — declares a ghost (spec-only) function. These
  are SEPARATE builtins; do not write `ghost(some_fn_value)`.

```rust
permutation :: ghost_fn((fn(a : ArrayList(i32), b : ArrayList(i32)) -> bool)(/* ... */));
```

### Pragmas

- `pragma(Pragma.NoContracts);` erases all contract clauses (no asserts
  emitted) — for release/benchmark builds.
- `pragma(Pragma.Verify);` / `pragma(Pragma.VerifyOrAssert);` parse but
  warn "verify mode not implemented" — the SMT backend is a later phase.

Refinement-type aliases live in `std/spec/` (`NonZero`, `Bounded`,
`Positive`, …); in Phase 0 they are plain aliases for the underlying
type (the predicate is enforced once the verifier lands).

## "Frame level N has different number of values for different cases"

Observed 2026-08-16 while adding temporary `eprintln` instrumentation. **The
mechanism below is an inference from a controlled A/B, not a verified rule** —
treat it as a debugging lead, not a language guarantee.

What was measured, same file, same function, three builds:

| instrumentation                                                | build  |
| -------------------------------------------------------------- | ------ |
| 2 × `eprintln` at **function-body** statement level            | **OK** |
| + 1 × `eprintln` inside one `match` arm (sibling is `_ => ()`) | FAIL   |
| + 3 × `eprintln` inside that same arm                          | FAIL   |

The passing build included an `if(...)` inside a string interpolation, so
interpolated conditionals are **not** the trigger. The only varying factor was
whether the added statement sat **inside a `match` arm whose sibling was empty**.

Inferred rule: sibling arms appear to need to agree on how many values they push
onto the frame, so adding statements to one arm while another stays a bare `()`
breaks it:

```
Error: Frame level 7 has different number of values for different cases.
```

This bites hardest when adding temporary instrumentation, because the edit looks
completely innocuous:

```rust
// BEFORE — fine
match(t, .SomeT({ id : rid }) => match(lookup(rid), .Some(g) => { r = g; }, .None => ()), _ => ());

// AFTER — "Frame level N has different number of values"
match(
  t,
  .SomeT({ id : rid }) => {
    eprintln(`probe ${rid}`);          // <-- extra frame value in THIS arm only
    match(lookup(rid), .Some(g) => { r = g; }, .None => ());
  },
  _ => ()                               // <-- sibling still empty
);
```

Fixes, in order of preference:

1. **Hoist the statement out of the `match` entirely** — put the `eprintln`
   before or after, on a value the arms have already written. Usually the
   instrumentation did not need to be inside the arm at all.
2. Give every sibling arm the same shape (add a matching statement to `_ => {}`).

The error names a frame _level_, not a file or line, so it does not point at the
arm you edited. If it appears right after you touched a `match`, assume this
before hunting elsewhere.
