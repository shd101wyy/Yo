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

## All function, keyword, and prefix-operator calls require immediate `(...)`

- Write `func(arg1, arg2)`, not `func arg1, arg2`.
- Do not insert whitespace before call parentheses: `func(arg)`, not `func (arg)`.
- Control-flow keywords follow the same rule: `return(value)`, `return()`, `unwind(value)`, `unwind()`.
- In `(exn : Exception) = Exception(throw: ((err) -> { ... }))` handlers, add `unwind(...)` / `unwind()` when the handler does not resume normally. Calls like `exit(int(1))` return `unit`; they do not satisfy the handler's `ResumeType` by themselves. (`unwind` requires the handler's lambda to be typed as `ctl(...) -> R`, which it is when bound to a `ctl`-typed field like `Exception.throw`.)
- Prefix operators follow the same rule: `&(x)`, `!(ready)`, `-(value)`, `~(bits)`.
- Macro unquote syntax is also tight: use `#(expr)` and `...#(exprs)`.
- Dynamic field access with unquote requires grouping after the dot: `value.(#(field_expr))`, not `value.#(field_expr)`.

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

Newlines around operators can also be semantically significant because they disambiguate right-associative parses. Do not collapse line-leading operators or a newline after `:` into a single line unless you add equivalent parentheses:

```rust
// Valid because each `|` stays line-leading:
(4
| 5
| 6)

// Valid because newline after `:` confirms the RHS:
raise :
  (msg) -> {
    unwind(());
  }

// Formatter style: indent the RHS one level under the line-ending operator:
(yield : Yield) =
  (v) -> {
    return(v * i32(3));
  };

// Also valid: explicit grouping on the RHS.
raise : ((msg) -> {
  unwind(());
})
```

Formatter-specific syntax preservation:

- Canonical pointer dereference is `ptr.*`; format legacy `ptr.(*)` as `ptr.*`.
- Keep compact collection and tuple literals compact when they are single-line, even inside a multiline call: `[1, 2, 3]`, `(1, 2, 3)`.

This also applies to `fn` type annotations on the same line — always wrap in parentheses to avoid ambiguity with `->`:

```rust
// WRONG — bare fn type on same line as `:`:
next : fn(ref(self) : Self) -> Option(Self.Item)

// CORRECT — parenthesized fn type:
next : (fn(ref(self) : Self) -> Option(Self.Item))

// ALSO CORRECT — newline after `:` triggers right associativity:
next :
  fn(ref(self) : Self) -> Option(Self.Item)
```

Special tight syntaxes must stay immediate: macro splices `#(expr)`, optional pointer types `?*(T)`, and negated trait constraints `T <: !(Runtime)` must not be formatted as `# (expr)`, `?* (T)`, or `T <: !(Runtime)`.

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

## Parameter form by type kind

The right shape for a function parameter depends on what kind of type the value is:

| Type kind                                                     | Shape                                                   | Why                                                                                                             |
| ------------------------------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `object(...)`                                                 | `name : Type`                                           | Object types have reference semantics — mutations propagate via the underlying RC value. No pointer needed.     |
| `struct(...)` value type (read-only)                          | `name : Type`                                           | Pass by value. Cheap if small; consider `ref` for large structs.                                                |
| `struct(...)` value type (need mutation)                      | `ref(name) : Type`                                      | Caller's binding sees in-place writes. See [`ref` section](#refname--t-parameters-for-in-place-mutation) below. |
| `enum(...)` (read-only)                                       | `name : Type`                                           | Same as struct.                                                                                                 |
| `enum(...)` (need mutation)                                   | `ref(name) : Type`                                      | Same as struct.                                                                                                 |
| Primitive (`i32`, `bool`, …)                                  | `name : Type` for read, `ref(name) : Type` for mutation | Same rule.                                                                                                      |
| Receiver of mutating method on `object`                       | `self : Self`                                           | Object semantics — explicit `ref(self)` is unnecessary noise (though it works).                                 |
| Receiver of mutating method on value type (trait or inherent) | `ref(self) : Self`                                      | Caller-side writes propagate. Established for `Hash`, `Clone`, `ToString`, `Iterator`.                          |
| Raw FFI pointer (legitimate `*(T)`)                           | `name : *(T)`                                           | Only when interfacing with C / the runtime ABI. Requires `pragma(Pragma.AllowUnsafe);` at the file top.         |

**Anti-patterns to avoid:**

```rust
// ✗ Pointer on an object type — wraps a reference in another reference
foo : (fn(ctx : *(EvalContext)) -> unit)({ ctx.*.method() })

// ✗ Inout on an object type — redundant; object semantics already share state
foo : (fn(ref(ctx) : EvalContext) -> unit)({ ctx.method() })

// ✓ Plain — concise and correct
foo : (fn(ctx : EvalContext) -> unit)({ ctx.method() })
```

The same applies at call sites: don't wrap object arguments with `&(obj)` to pass to a function expecting an object; just pass `obj`.

When choosing between `ref(self) : Self` and `self : Self` for a method receiver:

- If the receiver type is fundamentally a value type (anything other than `object`), use `ref(self) : Self` for mutators.
- If the receiver type is `object`, plain `self : Self` is the idiom — the methods documented in `yo-self/env.yo`, `yo-self/codegen/context.yo`, etc. follow this.
- Trait declarations should match the dominant case of their impl targets. Existing widely-implemented traits (`Hash`, `Clone`, `ToString`, `Iterator`, `Index`) use `ref(self) : Self` for the reasons above; new traits that are object-specific can use plain `self : Self`.

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
- **Do NOT wrap the `while` condition in `runtime(...)`** — `while(runtime(cond), body)` is redundant because the condition is already evaluated at runtime by default. Write `while(cond, body)`. (`runtime(...)` only matters in a `::`/comptime context to force runtime evaluation; a `while` condition is never that context.)
- **`while(comptime(cond), body)`** explicitly opts into compile-time loop unrolling. Requires `cond` to be a compile-time-known value. The evaluator will error if it detects an infinite loop (e.g., `while(comptime(true), ...)` with no `break`/`return`/`unwind`).
- If you use a comptime-only (`::`) variable in a bare `while` condition (without `comptime()`), the compiler will **error**: the condition would never change at runtime, causing an infinite loop.
- When calling `assert`, always add 2nd argument: `assert(condition, "error message");`
- Pointer arithmetic uses `&+`, `&-`, `&<`, `&>`, `&<=`, `&>=` operators with `&` prefix.

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
- Pointer arithmetic: `&+`, `&-`, `&/`
- `consume(p.* = v)` (deref-and-init)

Operations that stay safe (no wrap needed): `&(x)` to take an address, passing/storing/returning pointers, pointer comparison (`&==`, `&<`, etc.), and pointer-type casts (`*(u8)(p)`).

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

`auto-generated://` URIs (macros, derive expansions) bypass the per-call wrap — the macro author owns the contract via the expansion site. See `plans/EXTERN_UNSAFE_WRAP.md`.

### Slice-flowability rule

A function whose return type transitively carries a raw pointer in its representation (`Slice(T)`, `str`, a struct wrapping a Slice, ...) must root the returned value in caller-owned storage. The evaluator runs the same R1–R4 flowability check used for `-> ref(T)` returns, with carve-outs for non-ref parameters and `comptime`/literal sources:

```rust
// REJECTED: arr is a local, dies with the call frame.
make_dangling :: (fn() -> Option(Slice(i32)))({
  arr := ArrayList(i32).new();
  arr.push(i32(1));
  arr.as_slice()
});

// ACCEPTED: caller's storage outlives the call.
borrow :: (fn(ref(arr) : ArrayList(i32)) -> Option(Slice(i32)))(arr.as_slice());

// ACCEPTED: string literal lives in static storage.
greet :: (fn() -> str)("hello");
```

See `plans/SLICE_FLOWABILITY.md` and `tests/slice_flowability.test.yo`.

### Return-slot modifier placement: on the label, not the type

In a **labeled** return slot, a `ref`/`comptime` modifier attaches to the **label**, mirroring the parameter convention (`ref(name) : T`). Unlabeled returns put the modifier on the sole type expression.

| Form                                            | Verdict                                      |
| ----------------------------------------------- | -------------------------------------------- |
| `-> ref(T)`, `-> comptime(T)`                   | ✅ valid (unlabeled)                         |
| `-> (ref(name) : T)`, `-> (comptime(name) : T)` | ✅ valid (modifier on the label)             |
| `-> (name : ref(T))`, `-> (name : comptime(T))` | ❌ rejected — move the modifier to the label |
| `-> (ref(name) : ref(T))`                       | ❌ rejected (double-ref — "pick one")        |

Enforced at function-type evaluation (`src/evaluator/types/function.ts`, in the labeled-return branch, after label-side modifier processing) and the yo-self port (`yo-self/evaluator/types/function.yo`). See `tests/ref_return_labeled.test.yo`.

### Signed-integer overflow is defined (wrap-around)

Yo passes `-fwrapv` to clang/gcc/zig by default, so signed-integer overflow is two's-complement wrap-around, not UB. `x := i32(2147483647); y := (x + i32(1));` evaluates to `i32(-2147483648)`, not silent miscompilation. Opt-out: `--cflags='-fno-wrapv'`.

### `// SAFETY:` comment convention

Every non-obvious `unsafe(...)` site in stdlib should have a `// SAFETY:` comment explaining the contract (what invariant guarantees the deref/arith is in bounds and the pointer is live). `yo unsafe-report` scans the previous ~8 lines preceding each unsafe site and surfaces the comment in the report.

```rust
match(
  self._ptr,
  // SAFETY: pos bounds-checked above (pos < self._length);
  // _ptr points at the Rc-managed heap buffer.
  .Some(_ptr) => unsafe(_ptr &+ pos),
  .None => panic("ArrayList: empty")
)
```

## `ref(name) : T` parameters for in-place mutation

For mutating a caller's variable without raw pointers, use the `ref` parameter modifier. It wraps the parameter name (parallel to `own(name)`) and gives second-class reference semantics — reads/writes through the parameter access the caller's storage. (Naming note: `ref` was previously called `inout`; the renamed keyword is the same feature, matching C#'s `ref` parameter convention.)

```rust
swap :: (fn(ref(a) : i32, ref(b) : i32) -> unit)({
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

- `ref(...)` cannot combine with `own(...)` (opposite calling conventions) or with `forall`/`using` parameters (those are erased at runtime — no callee-side binding to mutate).
- `ref` CAN combine with `comptime` as `comptime(ref(name)) : T` (outer comptime, inner ref). The parameter is erased at runtime and mutations propagate via the evaluator's compile-time binding update path. The prelude `ComptimeIndex` trait uses this form (`index : (fn(comptime(ref(self)) : Self, comptime(idx) : Idx) -> comptime(*(Self.Output)))`) to let comptime index methods mutate the caller's value without a raw pointer parameter.
- Inside the callee, the ref-param identifier behaves like a regular variable for reads (`tmp := a;`) and assignments (`a = b;`).
- Calls through ref-params chain naturally: `fn outer(ref(x))` calling `fn inner(ref(p))` with `inner(x)` passes `&x` to `inner` (the caller-side `&` is implicit).
- At codegen, `ref(name) : T` lowers to `T*` in C. Reads of `name` in the callee become `(*name)`; writes become `(*name) = v`. No runtime cost vs hand-written pointer code. `comptime(ref(name))` has zero codegen impact (the parameter is erased).

`ref` is the safe in-place-mutation primitive for user code. Stdlib trait methods that previously took `(self : *(Self))` have all been migrated to `(ref(self) : Self)` — Hash, Clone, ToString, Index, ComptimeIndex, Writer, Reader, and `Iterator` (the for-loop redesign documented in `plans/ITERATOR_REDESIGN.md` shipped alongside Phase D of `plans/MEMORY_SAFETY.md`).

### Public stdlib boundary — no raw pointer leaks

Every public top-level `fn(...)` in `std/` should take and return value or `ref`-bound types. Raw `*(T)` in a public signature is allowed only when (a) the function lives in an FFI directory (`libc/`, `linux/`, `darwin/`, `cuda/`, `sys/`, `sync/`), or (b) the function name signals raw-pointer use by contract (`*_cstr`, `*_ptr`, `from_raw_parts`, `as_ptr`, names starting with `raw_`). Anything else is a leak — migrate to `Slice(T)` for buffers, `ref(name) : T` for in-place mutation, or a higher-level safe type.

Verify with `./yo-cli public-safe-report ./std` (or `./yo-self`). It scans every top-level public `fn(...)` declaration, skips `extern(...)` blocks and the directories/name patterns above, and reports any remaining raw-pointer leak. Source: `src/public-safe-report.ts`. Currently reports 0 findings; keep it that way when adding new stdlib surface.

## `for` loop macro — correct form

The `for` macro is a 2-argument prelude macro. The **first argument is the collection or an iterator chain** (the macro inserts `.into_iter()` / `.iter()` as needed based on the body's binding shape):

```rust
for(list, (x) => { process(x); });               // value form: macro expands to list.into_iter()
for(list, ref(x) => { x = transform(x); });      // borrow form: macro expands to list.iter() + list.project(pos)
for(chain.map(f), (y) => println(y));            // combinator chain: pass as the value-form iterator
```

- First argument: the collection itself, or an iterator chain (`.map().filter()`-style).
- Second argument: an anonymous closure. The binding shape selects the form:
  - `(x) => body` — value form. Macro expands to `coll.into_iter()`; `x` is `T` by value.
  - `ref(x) => body` — borrow form. Macro expands to `coll.iter()` (a position iterator yielding `usize`) + `coll.project(pos)` (from the `Indexable` trait); `x` is a writable binding into the collection.
- **Do NOT write `for(coll.iter(), (x) => …)` for the value form** — `.iter()` now yields _positions_ (usize), not elements. The macro calls `.into_iter()` itself for the value form.
- **Do NOT use `for(x, arr, { body })`** — this older 3-arg form is an evaluator-internal representation and is not valid top-level Yo source. (The self-hosted evaluator's internal for-loop handler currently only understands the 3-arg form; this is tracked in `issues/eval-for-loop-3arg-vs-2arg.md`.)
- Combinator chains support **only the value form** — they yield computed values, not borrows. `coll.iter().map(f)` works as the first arg in `(x) => body`.

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

Other reserved words to avoid as identifiers: `fn`, `type`, `trait`, `impl`, `enum`, `struct`, `object`, `newtype`, `match`, `cond`, `if`, `while`, `for`, `return`, `unwind`, `recur`, `export`, `import`, `using`, `given`, `forall`, `where`.

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

## Design-by-contract clauses (`requires` / `ensures` / `invariant` / `ghost`)

Phase 0 of `plans/FORMAL_VERIFICATION.md` adds a contract surface. The
SMT verifier is NOT built yet — in Phase 0 these lower to runtime
`assert(...)` (runtime functions) or `comptime_assert(...)` (comptime
functions, i.e. those returning `comptime(T)`).

### `requires` / `ensures` go in the function signature

They are clauses in the parameter list, after regular params and
`where(...)`. The clause order is **enforced** (not just conventional):
`forall(...), ...params..., where(...), requires(...), ensures(...)`.
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
  `ref(name) : T` params). `result` is NOT a reserved word — it is a
  local the ensures-wrapper binds, so it does not clash with `result`
  used as an ordinary variable elsewhere.

```rust
increment :: (fn(ref(n) : i32, requires(n < i32(100)), ensures(n == (old(n) + i32(1)))) -> unit)({
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
`object(...)` are NOT implemented in Phase 0.)

### `ghost(...)` vs `ghost_fn(...)`

- `ghost(name := expr)` — a spec-only binding (Phase 0: a no-op marker).
- `ghost_fn(fn_value)` — declares a ghost (spec-only) function. These
  are SEPARATE builtins; do not write `ghost(some_fn_value)`.

```rust
permutation :: ghost_fn((fn(a : Slice(i32), b : Slice(i32)) -> bool)(/* ... */));
```

### Pragmas

- `pragma(Pragma.NoContracts);` erases all contract clauses (no asserts
  emitted) — for release/benchmark builds.
- `pragma(Pragma.Verify);` / `pragma(Pragma.VerifyOrAssert);` parse but
  warn "verify mode not implemented" — the SMT backend is a later phase.

Refinement-type aliases live in `std/spec/` (`NonZero`, `Bounded`,
`Positive`, …); in Phase 0 they are plain aliases for the underlying
type (the predicate is enforced once the verifier lands).
