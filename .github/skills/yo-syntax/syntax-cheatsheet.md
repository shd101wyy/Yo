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
{ println } :: import("std/fmt");

app_name :: "yo-demo";

main :: (fn() -> unit)({
  value := i32(1);
  (message : str) = "hello";
  println(message);
});

export(main);
```

- Top-level binding: `name :: expr;`
- Local binding: `name := expr;`
- Typed binding: `(name : Type) = expr;`
- Function definition: `name :: (fn(args...) -> ReturnType)(body);`
- Export: `export(name);`

## Blocks and expressions

| Goal              | Write                        | Avoid                        |
| ----------------- | ---------------------------- | ---------------------------- |
| Single expression | `cond(...)`                  | `{ cond(...) }`              |
| Begin block       | `{ x := i32(1); x }`         | `{ x := i32(1), x }`         |
| Struct literal    | `{ name : "yo", ok : true }` | `{ name : "yo"; ok : true }` |

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

In struct literals, keep spaces around `:` and parenthesize infix field values: `{ x : (1 + 2), y : 3 }`, not `{ x: 1 + 2, y: 3 }`.

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
- Write `return(value)` or `return()`; `return value` is invalid.
- Write `unwind(value)` or `unwind()`; `unwind value` is invalid.
- If a `match`/`cond` branch returns an enum variant and inference fails, qualify
  the variant with its enum type: `TypeValue.Unit` instead of `.Unit`.
- Do not match enum payload literals directly, e.g. avoid `.Some(false)` and
  `.Some(true)` as sibling branches. Match `.Some(value)` once, then branch with
  `if(value, ...)` or `cond(...)` inside the arm; otherwise generated C can
  contain duplicate enum `case` labels.
- In large enum matches, avoid binding a pattern variable with the same name as a
  variant field (for example, prefer `struct_field_types` over `field_types`).
  This can currently produce invalid generated C in some self-hosted codegen
  paths.

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

- Calls require immediate parentheses: `func(arg1, arg2)`
- `func arg1, arg2` and `func (arg1, arg2)` are invalid
- Yo has no operator precedence; fully parenthesize binary expressions
- Preserve grouping around infix expressions on operator RHS positions: `true => (x / y)`, `value := (x + y)`, `(ptr &+ 1).*`
- Line breaks can disambiguate operator chains; keep line-leading operators like `(4\n| 5\n| 6)` and newlines after `:` before a lambda unless you add equivalent grouping
- When an operator ends a line, indent its RHS one level as a continuation: `(x : T) =\n  (v) -> { ... }`
- Prefix operators (`!`, `&`, `-`, `~`) require parenthesized operands: `func(&(s), a, b)`, `!(ready)`, `-(value)`.
- Tight special forms also require immediate parentheses: `#(expr)`, `?*(u8)`, `T <: !(Runtime)`
- Dynamic field access with unquote must keep grouping after the dot: `value.(#(field_expr))`, not `value.#(field_expr)`.
- Unquote splicing is the tight operator `...#(exprs)`; do not insert a space between `...` and `#`.
- Canonical pointer dereference is `ptr.*`; formatter should canonicalize legacy `ptr.(*)` to `ptr.*`.
- **Pointer deref (`p.*`), arithmetic (`&+`, `&-`, `&/`), and `consume(p.* = v)` require `unsafe(...)`, AND the file must declare `pragma(Pragma.AllowUnsafe);` at the top before `unsafe(...)` is usable.** Pointer comparison (`&==`, `&<`, etc.) and pointer-type casts (`*(u8)(p)`) stay safe. `unsafe(expr)` is a one-arg builtin call: `v := unsafe(p.*);`, `unsafe(p.* = i32(5));`, `unsafe(p &+ usize(1))`. Every file in `std/`, `yo-self/`, and `tests/` declares the pragma explicitly. User code (default) does not, so attempts to use `unsafe(...)` are rejected with a hint to add the pragma. See `plans/MEMORY_SAFETY.md`.
- **In-place mutation without raw pointers:** use the `ref(name) : T` parameter modifier (parallel to `own(name)`). `swap :: (fn(ref(a) : i32, ref(b) : i32) -> unit)({ tmp := a; a = b; b = tmp; });` — caller writes `swap(x, y)` with no `&()` syntax. The compiler lowers `ref(name) : T` to `T*` in C and inserts `&(arg)` at the call site automatically. Cannot combine with `own(...)` or with `forall`/`using` (those are erased at runtime — no binding to mutate). CAN combine with `comptime` as `comptime(ref(name)) : T` — the parameter is erased at runtime and mutations propagate via the evaluator's compile-time binding update path (used by prelude `ComptimeIndex`). See `plans/MEMORY_SAFETY.md` Phase B.
- **Object-type params:** use plain `name : Type`, NOT `*(Type)` or `ref(name) : Type`. Object types (`Environment`, `EvalContext`, `CodegenContext`, `Emitter`, `HashMap`, `ArrayList`, …) carry reference semantics — passing by name already shares the underlying RC state, so mutations through the param propagate to the caller. `*(Type)` requires `pragma(Pragma.AllowUnsafe);` for the `.* ` derefs and clutters the API; `ref(name) : Type` is redundant since object semantics already share state. Use the plain form: `foo :: (fn(ctx : EvalContext) -> unit)(ctx.method());`. The same applies at call sites — don't wrap object arguments with `&(obj)`; just pass `obj`. For receivers on object methods, plain `self : Self` is the idiom (`yo-self/env.yo`, `yo-self/codegen/context.yo`, `yo-self/emitter.yo` all follow this). `ref(self) : Self` is reserved for receivers on value-type methods (the form used by `Hash`, `Clone`, `ToString`, `Index`, `ComptimeIndex`, `Writer`, `Reader`).
- **Byte-buffer params:** prefer `Slice(u8)` over `*(u8) + usize` for public signatures (e.g. `random_bytes`, `fnv1a_hash_bytes`). `Slice` carries the length, eliminating the (`ptr`, `wrong-size`) footgun. Convert at the FFI seam with `slice.ptr()` and `slice.len()`; construct from existing storage with `Slice(u8).from_raw_parts(&(buf(0)), len)`. The `_cstr` family is the explicit raw-pointer variant — those names signal raw-pointer use by contract.
- **Audit public stdlib safety with `./yo-cli public-safe-report [path]`.** Flags every top-level public `fn(...)` whose params or return type expose `*(T)` outside an `extern(...)` block. Skips FFI-by-construction directories (`libc/`, `linux/`, `darwin/`, `cuda/`, `sys/`, `sync/`) and names that signal raw-pointer use by contract (`*_cstr`, `*_ptr`, `*_raw`, `raw_*`, `from_raw_parts`, `as_ptr`, `argv`, `argc`). Currently reports 0 findings on `./std` and `./yo-self`; keep it that way when adding new APIs.
- **Extern "c" call sites require `unsafe(...)` even in pragma'd files.** `unsafe(memcpy(dst, src, n))`, `unsafe(strlen(s))`, etc. The pragma authorizes DECLARING the FFI symbol via `extern(...)` / `c_include(...)`; the wrap is the per-call audit marker so `yo unsafe-report` lines up with UB-capable lines. `asm(...)` and `extern(...)` / `c_include(...)` declarations themselves do NOT need a wrap (the keyword / declaration syntax is its own marker). See `plans/EXTERN_UNSAFE_WRAP.md`.
- **Slice-flowability rule:** a function returning a slice-bearing type (`Slice(T)`, `str`, a struct wrapping a Slice, ...) must root the returned value in caller-owned storage (a `ref`-bound parameter, any non-`ref` parameter, a `comptime`/literal source, or a flowable projection chain). `(fn() -> Option(Slice(i32)))({ arr := ArrayList(i32).new(); arr.as_slice() })` is rejected; `(fn(ref(arr) : ArrayList(i32)) -> Option(Slice(i32)))(arr.as_slice())` is accepted. See `plans/SLICE_FLOWABILITY.md`.
- **Return-slot modifier placement: on the LABEL, not the type.** In a _labeled_ return slot, a `ref`/`comptime` modifier attaches to the label, mirroring the parameter convention (`ref(name) : T`). Valid: `-> ref(T)` and `-> comptime(T)` (unlabeled — modifier on the sole type), `-> (ref(name) : T)`, `-> (comptime(name) : T)`. **Rejected:** `-> (name : ref(T))`, `-> (name : comptime(T))` (modifier on the type when labeled), and `-> (ref(name) : ref(T))` (double-ref — "pick one"). Enforced at function-type eval in `src/evaluator/types/function.ts` (and the yo-self port).
- **Signed-integer overflow is defined (wrap-around).** Yo passes `-fwrapv` to clang/gcc/zig by default so `x + i32(1)` on `i32(MAX)` wraps to `i32(MIN)` instead of UB. Opt-out: `--cflags='-fno-wrapv'`.
- **`// SAFETY:` comment convention.** Every non-obvious `unsafe(...)` site in stdlib should have a `// SAFETY:` comment in the previous ~8 lines explaining the contract. `yo unsafe-report` picks them up and shows them inline under each finding.
- **User-facing memory-safety guide:** `docs/en-US/MEMORY_SAFETY.md` (English) and `docs/zh-CN/MEMORY_SAFETY.md` (Chinese). Refer users there instead of `plans/MEMORY_SAFETY.md` (which is the design document — not shipped via npm).
- Keep single-line array and tuple literals compact during formatting: `[1, 2, 3]`, `(1, 2, 3)`.
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
- Top-level aliases for function types need parentheses too:
  `Callback :: (fn(x : i32) -> i32);`, not `Callback :: fn(x : i32) -> i32;`
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

### Effect parameters (explicit)

```rust
Raise :: (ctl(msg : String) -> i32);

safe_divide :: (fn(x : i32, y : i32, raise : Raise) -> i32)(
  cond(
    (y == i32(0)) => raise(`divide by zero`),
    true => (x / y)
  )
);

caller :: (fn() -> i32)({
  // Handler value bound to a local. Lambdas on the RHS of `=` need outer parens.
  (raise : Raise) = ((msg) -> {
    unwind(i32(0));
  });

  safe_divide(i32(10), i32(0), raise)
});
```

- Effect handlers are regular parameters — pass them explicitly at the call site.
- `ctl(args) -> R` types a handler that may `unwind` (discard the continuation).
  Use plain `fn(args) -> R` for handlers that always resume.
- Bundle multiple effects into a struct (`Ctx :: struct(raise : Raise, log : Log)`)
  and pass one parameter when there are many.

### Closures and anonymous functions

```rust
(closure : Impl(Fn(x : i32) -> i32)) = ((x) => (x + i32(1)));

result := closure(i32(5));

transform :: (fn(list : ArrayList(i32), f : Impl(Fn(x : i32) -> i32)) -> unit)({
  for(list, ref(x) => {
    x = f(x);
  });
});
```

- `(params) => expr` — lambda / closure syntax
- `Impl(Fn(params) -> ReturnType)` — closure type
- Value types are captured by copy; object types by reference
- Each closure has a unique type; you cannot assign different closures to the same variable

## Imports and modules

```rust
{ Parser } :: import("./parser.yo");
parser_module :: import("./parser.yo");

open(import("std/string"));
{ ArrayList } :: import("std/collections/array_list");
```

- Use relative imports for nearby `.yo` files
- Use `open(import("std/module"))` for standard-library modules you want fully in scope
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
Shape :: enum(
  Circle(radius : i32),
  Rectangle(width : i32, height : i32),
  Triangle(base : i32, height : i32, label : str)
);

match(s,
  // ✅ Preferred — curly shorthand names only the fields you use.
  .Triangle({base, height: h})  => (base * h),

  // Also OK — labeled (label : var) pairs; order-free, partial matches OK.
  .Circle(radius: r)             => (r * r),

  // ⚠️ Avoid for 2+ field variants — positional with `_` is brittle when
  //    a field is added and harder to read (each `_` requires counting).
  //    OK when the variant has one field, or when every field is named.
  .Rectangle(w, h)               => (w * h)
)
```

**Preferred form**: `.Variant({label, label: alias})`. Names only the fields the arm binds, so adding a field to the variant later doesn't silently break every arm. `tests/match_curly.test.yo` is the spec.

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
export(main);

export(
  helper,
  Config
);
```

- `export(name);` exports a single binding
- Block form exports multiple bindings separated by commas
- Every executable needs `export(main);`

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

// Runtime infinite loop — `while(cond, body)` is ALWAYS runtime
while(true, {
  work();
});

// Compile-time loop unrolling — requires comptime() modifier
while(comptime((i < 10)), {
  // body evaluated/unrolled at compile time
});

// for loop — 2-arg prelude macro. First arg is the collection
// directly; the macro dispatches on the body's binding shape to
// pick value-form vs borrow-form iteration:
for(list, (x) => {            // value form: implicit .into_iter()
  process(x);
});

for(list, ref(x) => {         // borrow form: iter() + project(pos)
  x = transform(x);           // writes propagate back into list
});

// Combinator chains (.map / .filter / .into_iter / etc.) yield
// computed values; pass them as the first arg in the value form:
for(list.iter().map((x) => (x + i32(1))), (y) => println(y));
```

- Use `recur(...)` for self-recursion
- `while(cond, body)` is **always a runtime loop** — use this for open-ended loops (e.g., server accept loops, event loops)
- `while(comptime(cond), body)` explicitly unrolls at compile time — `cond` must be a compile-time-known value
- Using a comptime-only (`::`) variable in a bare `while` condition without `comptime()` is a **compile error** (would be an infinite loop at runtime)
- **`for(coll, (x) => body)`** — value form; macro expands to `coll.into_iter()` then iterates by value (`x : T`).
- **`for(coll, ref(x) => body)`** — borrow form; macro expands to `coll.iter()` (position iterator) + `coll.project(pos)` (`Indexable.project` impl) so `x` is a writable binding. Writes propagate back into the collection.
- **Do NOT write `for(coll.iter(), (x) => …)` for the value form** — `.iter()` yields positions (usize), not the collection's elements. Use the bare collection or `.into_iter()`.
- **Do NOT use `for(x, arr, { body })`** — this older 3-arg form is an evaluator-internal representation, not valid top-level Yo syntax. (The self-hosted evaluator currently only understands the 3-arg form in its internal for-loop handler; track issue: `issues/eval-for-loop-3arg-vs-2arg.md`)

## Return and branch safety

```rust
// WRONG — paren-less return is invalid:
match(opt,
  .Some(v) => return v,
  .None => default_value()
);

// CORRECT — explicit return calls in begin blocks:
match(opt,
  .Some(v) => {
    return(v);
  },
  .None => {
    return(default_value());
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

- `return expr` is invalid; write `return(expr)` or `return()` for unit
- In `cond` or `match` branches, **always use begin blocks** when you need `return`
- `return(...)` must be the **last expression** in a begin block — dead code after `return(...)` is rejected. Do NOT write `{ return(x); fallback_val }`. Write `{ return(x); }` only.
- If the whole function is one expression, prefer expression-bodied style and skip `return` entirely
- The same rule applies to all calls in match branches: use immediate `(...)`

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
{ ArrayList } :: import("std/collections/array_list");

list := ArrayList(i32).new();
list.push(i32(10));
list.push(i32(20));

// Value form — implicit .into_iter().
for(list, (value) => {
  println(value);
});

// Borrow form — implicit .iter() + .project(pos). `x` is a writable
// binding into the collection; assignments propagate back.
for(list, ref(x) => {
  x = (x + i32(1));
});
```

- `for(coll, (x) => body)` — value form. Macro expands to `coll.into_iter()` and yields elements by value.
- `for(coll, ref(x) => body)` — borrow form. Macro expands to `coll.iter()` (a position iterator yielding `usize`) + `coll.project(pos)` (from the `Indexable` trait) so the body sees a writable binding.
- Combinator chains (`coll.iter().map(f).filter(g)`) only support the value form — pass the chain as the first arg with `(x) => body`.
- The for macro accepts the collection directly; do NOT call `.iter()` for the value form, that yields positions (usize), not elements.

## Testing

```rust
test("Addition works", {
  assert(((i32(1) + i32(1)) == i32(2)), "1+1 should be 2");
});

test("Compile-time check", {
  comptime_assert((2 + 2) == 4);
  comptime_expect_error({ x :: (1 / 0); });
});

test("Async test", {
  io.await(yield());
});
```

- `test("description", { body })` defines a test — `io : Io` is automatically available
- All tests can use `io.async(...)`, `io.await(...)`, etc. without a `using` clause
- `assert(condition, "message")` — runtime assertion (always include a message)
- `comptime_assert(condition)` — compile-time assertion
- `comptime_expect_error(expr)` — verify code produces a compile error

## Design-by-contract clauses

`plans/FORMAL_VERIFICATION.md` Phase 0. No SMT verifier yet — these
lower to runtime `assert(...)` (runtime fns) or `comptime_assert(...)`
(comptime fns, returning `comptime(T)`).

```rust
// requires/ensures are SIGNATURE clauses, after params and where(...).
// ENFORCED order: forall, params, where, requires, ensures — a clause
// out of order is a syntax error ("X appears after Y").
divide :: (fn(x : i32, y : i32, requires(y != i32(0)), ensures(result == (x / y))) -> i32)(
  x / y
);

// Inside ensures: `result` = return value, old(expr) = entry-time value.
increment :: (fn(ref(n) : i32, ensures(n == (old(n) + i32(1)))) -> unit)({ n = (n + i32(1)); });

// invariant(...) must be the FIRST statement of a while body.
// NOTE: do NOT wrap the condition in runtime(...) — while conditions are
// runtime by default, so `while(runtime(i < n), …)` is redundant; use `while(i < n, …)`.
while(i < n, {
  invariant(i <= n, acc >= i32(0));
  i = (i + i32(1)); acc = (acc + i);
});

// ghost binding vs ghost function (SEPARATE builtins):
ghost(snap := (a + b));
is_pos :: ghost_fn((fn(x : i32) -> bool)(x > i32(0)));
```

- One `requires(...)` and one `ensures(...)` max per signature; put
  multiple predicates inside the single call: `requires(a, b)`. Two
  `requires(...)` clauses, or a zero-arg `requires()`, is a syntax error.
- `result` is a wrapper-bound local (NOT a reserved word) — it coexists
  with `result` used as an ordinary variable name elsewhere.
- `pragma(Pragma.NoContracts);` erases contracts; `pragma(Pragma.Verify);`
  parses but warns "verify mode not implemented".
- `std/spec/` exposes refinement aliases (`NonZero`, `Bounded`,
  `Positive`, …) — Phase 0 they are plain aliases for the base type.

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

### 1-element array literals require a trailing comma

`[expr]` without a trailing comma is **parsed as a Slice type** `Slice(expr)`, not an array literal. To create a 1-element array value, add a trailing comma:

```rust
// WRONG — parsed as Slice type, not array literal:
arr := [i32(42)];

// CORRECT — trailing comma makes it an array literal:
arr := [i32(42),];

// Multi-element arrays work fine (comma separator detected):
arr2 := [i32(1), i32(2), i32(3)];  // ✓
```

This also applies inside source strings in proto-evaluator tests.

### ArrayList indexing uses call syntax

```rust
list := ArrayList(i32).new();
list.push(i32(42));

val := list(usize(0));         // → i32  (value copy via Index trait)
list(usize(0)) = i32(99);      // mutate in place directly

// When you need the pointer explicitly:
ptr := &(list(usize(0)));      // → *(i32)
ptr.* = i32(99);               // also works

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

**Don't write `(&(X)).index(i).*` or `X.get(i).unwrap()` when you mean
`X(i)`.** Use the call-syntax form everywhere it works:

```rust
// ✗ Verbose, scans like raw-pointer code (and requires the file's
//   pragma(Pragma.AllowUnsafe); because `.*` is gated):
(&(self.field)).index(i).* = value;
elem := (&(self.field)).index(i).*;
v := list.get(usize(0)).unwrap();

// ✓ Same semantics, no `.*`, no pragma needed:
self.field(i) = value;
elem := self.field(i);
v := list(usize(0));
```

Both forms call the same `Index` trait method. The call-syntax form
is shorter, doesn't need raw-pointer plumbing in user code, and
panics on out-of-bounds identically to `.unwrap()` on `.get(...)`.

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

### `unwind` requires a nested-function context

`unwind(value)` exits the **install frame** — the function that bound the
`ctl(...) -> R` value being called. It is only valid inside the body of a
`ctl(...) -> R` value (an effect handler).

```rust
Raise :: (ctl(msg : String) -> i32);

caller :: (fn() -> i32)({
  // The handler is a `ctl` value bound in `caller`. `unwind` exits `caller`.
  (raise : Raise) = ((msg) -> {
    eprintln(msg);
    unwind(i32(-1));
  });
  safe_divide(i32(10), i32(0), raise)  // call site: handler is passed explicitly
});

// WRONG — `unwind` in a regular `fn` body (no install frame here) is rejected.
bad :: (fn() -> unit)({
  unwind(());  // ERROR: unwind requires a ctl(...) body
});

// WRONG — capturing a `ctl` value into a closure is rejected (closures escape).
make_closure :: (fn(raise : Raise) -> Impl(Fn() -> unit))(
  () => { raise(`x`); }  // ERROR: closure captures a control-bound value
);
```

**Rule of thumb**: `unwind` belongs only inside the lambda bound to a
`ctl(...) -> R` handler. From any other position, use `return` to exit the
current `fn`.

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

| Feature                    | Syntax hint                                              | Documentation                                                                                                          |
| -------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Higher-Kinded Types        | `forall(F : (fn(comptime(T) : Type) -> comptime(Type)))` | [DESIGN.md § HKT](https://github.com/shd101wyy/Yo/blob/develop/docs/en-US/DESIGN.md#higher-kinded-types-hkt)           |
| GADTs                      | `enum(IntVal(i : i32) -> recur(i32))`                    | [GADTS.md](https://github.com/shd101wyy/Yo/blob/develop/docs/en-US/GADTS.md)                                           |
| Derive traits              | `derive(MyType, Eq, Hash, Clone, Ord, ToString)`         | [DERIVE_TRAITS.md](https://github.com/shd101wyy/Yo/blob/develop/docs/en-US/DERIVE_TRAITS.md)                           |
| Type reflection            | `Type.get_info(T)` returns `TypeInfo`                    | [TYPE_REFLECTION.md](https://github.com/shd101wyy/Yo/blob/develop/docs/en-US/TYPE_REFLECTION.md)                       |
| Inline assembly            | `asm("mov {0}, #42", out(reg, i32))`                     | [INLINE_ASSEMBLY.md](https://github.com/shd101wyy/Yo/blob/develop/docs/en-US/INLINE_ASSEMBLY.md)                       |
| Metaprogramming            | `quote(...)`, `unquote(...)`, `unquote_splicing(...)`    | [DESIGN.md § Meta](https://github.com/shd101wyy/Yo/blob/develop/docs/en-US/DESIGN.md#meta-programming)                 |
| Effect bundle polymorphism | `forall(E : Type.Struct)` over a bundle struct           | [ALGEBRAIC_EFFECTS.md](https://github.com/shd101wyy/Yo/blob/develop/docs/en-US/ALGEBRAIC_EFFECTS.md)                   |
| Custom derive rules        | `derive_rule(MyTrait, (fn(...) -> unquote(Expr)){...})`  | [DERIVE_TRAITS.md](https://github.com/shd101wyy/Yo/blob/develop/docs/en-US/DERIVE_TRAITS.md#user-defined-derive-rules) |
| Isolated types             | `Iso(T)` for data-race-free parallelism                  | [ISOLATED.md](https://github.com/shd101wyy/Yo/blob/develop/docs/en-US/ISOLATED.md)                                     |
| Arc (atomic ref count)     | `arc(value)`, `shared.(*)` for cross-thread sharing      | [ARC.md](https://github.com/shd101wyy/Yo/blob/develop/docs/en-US/ARC.md)                                               |
| Parallelism                | Thread pool, `io.spawn` for parallel work                | [PARALLELISM.md](https://github.com/shd101wyy/Yo/blob/develop/docs/en-US/PARALLELISM.md)                               |

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

Having two `:: import("path")` lines importing from the same file causes a compile error.
Always merge them into a single destructuring import:

```rust
// ❌ Two imports from the same path
{ Foo } :: import("../../mod.yo");
{ Bar } :: import("../../mod.yo");

// ✅ Merged
{ Foo, Bar } :: import("../../mod.yo");
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

### Nested enum patterns in match are NOT supported

Yo does **not** support nested enum patterns inside a single match arm.
You cannot write `.Some(.IntLit(n))` — this is a parser error.

```rust
// ❌ WRONG — nested enum pattern, parser error:
match(v.get(usize(0)),
  .Some(.IntLit(n)) => assert(n.as_str() == "3", "ok"),
  _ => assert(false, "err")
)

// ✅ CORRECT — two-level match:
match(v.get(usize(0)),
  .Some(x) => match(x, .IntLit(n) => assert(n.as_str() == "3", "ok"), _ => assert(false, "err")),
  .None => assert(false, "err")
)
```

This applies to ALL nested enum patterns: `.Some(.BoolVal(b))`, `.Some(.ArrayVal(arr))`, etc. — always use a two-level match.

### `get_callee()` returns ExprVal directly, not an Option-wrapped EnumVal

In the proto-evaluator source strings (`evaluate_module_body`), `ExprVal.get_callee()` on a FnCall returns the callee `ExprVal` directly — NOT wrapped in an `Option` EnumVal. Chaining `.is_some()` fails with SIGABRT because `is_some()` requires an `EnumVal` receiver.

```rust
// ❌ SIGABRT — get_callee() returns ExprVal, not Option(EnumVal)
result := quote(foo(i64(1))).get_callee().is_some();

// ✅ Chain .is_atom() or .is_fn_call() on the returned ExprVal
result := quote(foo(i64(1))).get_callee().is_atom();   // true: callee "foo" is an atom
result := quote(foo(i64(1))).get_callee().is_fn_call(); // false: callee "foo" is not a fn call
```

Similarly, calling `get_callee()` on an Atom causes the overall evaluation to fail — do not test the Atom case via `get_callee()` in source strings.

### Source-string evaluation pitfalls (proto-evaluator tests)

When writing source strings passed to `evaluate_module_body` in proto-evaluator tests:

**`cond` form**: Always use the `cond(condition => value, true => fallback)` form, NOT `cond(condition, value, fallback)`. The 3-arg form does NOT work inside lambdas or recursive functions in source strings.

```
// ❌ WRONG — crashes inside lambdas and recursive functions
cond((n <= i32(1)), i32(1), (n * recur((n - i32(1)))))

// ✅ CORRECT
cond((n <= i32(1)) => i32(1), true => (n * recur((n - i32(1)))))
```

**Recursive functions**: Use `recur(...)` for self-recursion inside named `::` functions. Never call the function by name from inside its own body.

**Chaining function calls with operators**: `f(a) + f(b) + f(c)` throws an exception. Use fold over an array instead:

```
// ❌ WRONG — exception in source strings
result := abs_val(i32(3)) + abs_val(i32(1)) + abs_val(i32(4));

// ✅ CORRECT
arr := [i32(3), i32(1), i32(4)];
result := arr.fold(i32(0), (fn(acc : i32, x : i32) -> i32)((acc + abs_val(x))));
```

**Empty array `[]` in cond branches**: `cond(condition => [x], true => [])` crashes because the empty array type is unknown. Avoid empty array literals in conditional branches inside `flat_map` lambdas.

**Option types**: Must use `Option(T).Some(val)` not `Option.Some(val)`. `Option(T).None` with a type annotation crashes — use `r := Option(i32).None` without annotation. `.is_none()` is not supported; use `!(r.is_some())`. `and_then(f)` returns the raw value (not wrapped in Option), so calling `.unwrap_or()` on the result crashes.

**Number literals**: `i32(-3)` crashes — use `(i32(0) - i32(3))`. `i32.as_usize()` / `usize.as_i32()` not supported.

**Fibonacci without tmp variable**: `b = (a + b); a = (b - a)` computes fib correctly without a temp variable. After N iterations, `a` holds fib(N) and `b` holds fib(N+1).

**3-term multiplication in source strings**: `(x * x * x)` causes an exception in evaluated source strings. Break it into a block:

```
// ❌ WRONG — causes exception
cubes := arr.map((fn(x : i32) -> i32)((x * x * x)));

// ✅ CORRECT — use a block with a local binding
cubes := arr.map((fn(x : i32) -> i32)({
  sq := (x * x);
  (sq * x)
}));
```

**3-term sum in fold on tuples**: `(acc + p.0 + p.1)` inside a fold lambda on tuple pairs crashes. Always map pairs to scalars first, then fold:

```
// ❌ WRONG — crashes in fold on (i32, i32) tuples
total := pairs.fold(i32(0), (fn(acc : i32, p : (i32, i32)) -> i32)((acc + p.0 + p.1)));

// ✅ CORRECT — map to scalars first, then fold
sums := pairs.map((fn(p : (i32, i32)) -> i32)((p.0 + p.1)));
total := sums.fold(i32(0), (fn(acc : i32, x : i32) -> i32)((acc + x)));
```

**`&&` in `cond` conditions inside `while` body**: Crashes. Avoid by restructuring (e.g., start loop at 1 instead of 0 to eliminate the `&& (i > 0)` guard).

**Test API format**: Use `evaluate_module_body(exprs, &(env))` (reference syntax, returns `Option`). Match with function-style `match(result, .None => ..., .Some(m) => ...)`. Do NOT use block-style `match(result) { ... }` — it causes a parse error ("Paren-less function and operator calls are not supported").
