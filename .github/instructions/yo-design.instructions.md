---
applyTo: "**/*.yo, std/**"
description: "Use when making design decisions about the Yo language, writing std library code, or working with Yo types. Covers type conventions, rune, Box, str vs String, Pointer, SomeType, and platform-specific code."
---
# Yo Language Design Decisions

## Type naming conventions

- Lowercase for value types (non-reference-counted): `rune`, `i32`, `u32`, `bool`
- Use `struct(...)` for value types
- Use `object(...)` for reference-counted types
- Use `newtype(...)` instead of `struct(...)` when the type has only a single field (e.g., `FilePermission :: newtype(mode : u32)`)

## Unicode: `rune` not `Char`

- `char` is the C character type (8-bit)
- `rune` represents Unicode code points (32-bit, like Go's rune)
- File: `std/data/rune.yo`

## Strings

- Double quote string returns `str` type (contains `[u8]` byte slice)
- Template string returns `String` type (utf-8 encoded `object` type). Its syntax is the same as JavaScript template strings. The `${...}` interpolation is also supported for types that implement `ToString` trait.  
- `str` is a builtin type — don't use it as a variable or type name.
- **Use template strings for constant `String` values**: Instead of `String.from("hello")`, write `` `hello` ``. Template strings without interpolation produce the same result but are more concise. This applies anywhere a `String` value is needed — return values, comparisons, arguments, etc.
- Use `println` or `print` function from `std/fmt` to print instead of `printf`. You can pass template string or any value whose type implements `ToString` trait to both `println` and `print`.

## Box and box

Implemented in `prelude.yo`:
```rust
Box :: (fn(comptime(V) : Type) -> comptime(Type))
  object(
    (*) : V
  )
;
box :: (fn(forall(V : Type), value : V) -> Box(V))
  Box(V)(value)
;
```

## Pointers

- `Pointer` works in both compile-time and runtime contexts (`Runtime` and `Comptime` traits in `prelude.yo`).
- Pointer arithmetic: `&+`, `&-`, `&<`, `&>`, `&<=`, `&>=`
- No NULL in Yo. Nullable pointer: `Option(*(T))` or `?*(T)`. `Option(*(T)).None` is optimized as NULL in C codegen.

## SomeType

- `SomeType` automatically implements the `Runtime` trait by default.
- Never write functions to resolve `SomeType` — struct/enum/union are nominal types, replacing SomeType causes problems.
- **Never substitute SomeType within another Type.** Because many types like struct/enum/union etc in Yo are nominal type, simple substitution can break type identity. The correct approach is to re-evaluate the type expression in an environment where the type parameter is bound to the concrete type.

## Platform-specific code

Use `process.yo` module `platform` and `Platform`:
```rust
AF_INET6 :: cond(
  (platform == Platform.Darwin) => i32(30),
  true => i32(10)
);
```

Current goal: make Yo work on Linux, macOS, and Windows.

## Breaking changes are acceptable

Yo is a new, evolving language. Don't worry about breaking changes when making design decisions.

## Compile-time only functions must use `comptime` return types

Functions that only execute at compile time (e.g., build system functions, macro-like utilities) must wrap their return type in `comptime(...)`. If the return type is not wrapped in `comptime`, the evaluator treats it as a runtime function.

```rust
// WRONG — unit return without comptime means runtime:
register_module :: (fn(comptime(config) : ModuleConfig) -> unit) {
  __yo_build_module(config);
};

// CORRECT — comptime(unit) signals compile-time only:
register_module :: (fn(comptime(config) : ModuleConfig) -> comptime(unit)) {
  __yo_build_module(config);
};

// CORRECT — comptime(Step) for functions returning compile-time values:
executable :: (fn(comptime(config) : Executable) -> comptime(Step)) {
  __yo_build_executable(config.name, config.root, ...);
  Step(name: config.name, kind: StepKind.Executable)
};
```

This applies to all parameters and return types in comptime-only APIs:
- Parameters: `comptime(name) : comptime_string`
- Return: `-> comptime(Step)`, `-> comptime(unit)`, `-> comptime(str)`

## Algebraic effects

- Effects are matched by **type**, not by name. A `given(raise) : Raise` handler matches any `using(my_raise : Raise)` parameter regardless of the variable name — the match is on the `Raise` type.
- `return expr` inside an effect handler **resumes** the continuation.
- `escape expr` inside an effect handler **discards** the continuation and exits the enclosing `fn`.
- Effect row variables (`forall(...(E))` with `using(...(E))`) allow functions to be polymorphic over their effects — they forward whatever effects the caller provides.
- Effect handlers use Evidence Passing (function pointer parameters) for zero-overhead calls.
- **Handler functions are standalone, not closures.** Effect handlers are compiled as standalone C functions and cannot reference variables from the enclosing scope. Pass state as explicit function arguments instead.
- For the full design document with overhead analysis and implementation details, see `docs/en-US/ALGEBRAIC_EFFECTS.md`.

## Future return types with effects

- `Future` takes the result type as the first argument and effect types as rest arguments: `Future(ResultType, Effect1, Effect2, ...)`
- When a function uses `using(io : IO)`, its return type must include `IO` in the `Future`: `Impl(Future(Result(T, E), IO))` — NOT `Impl(Future(Result(T, E)))`
- Return `io.async(...)` directly as the last expression — do NOT assign to an intermediate variable:

```rust
// WRONG — intermediate variable prevents enum variant type inference:
my_fn :: (fn(using(io : IO)) -> Impl(Future(Result(i32, IOError), IO)))({
  task := io.async((using(io)) => {
    .Ok(i32(42))
  });
  return task;
});

// CORRECT — return io.async directly:
my_fn :: (fn(using(io : IO)) -> Impl(Future(Result(i32, IOError), IO)))(
  io.async((using(io)) => {
    .Ok(i32(42))
  })
);
```

## JoinHandle(T) — spawned task handle

`JoinHandle(T)` is a builtin generic type returned by `io.spawn`. It wraps a pointer to the spawned future and allows awaiting its result.

### API
```rust
handle := io.spawn(task, using(io, raise));  // → JoinHandle(T)
result := handle.await(using(io));            // → Option(T)
```

### Semantics
- `io.spawn(task, using(io, effects...))` cold-starts the future, injects effect handlers, returns a `JoinHandle(T)`.
- `handle.await(using(io))` polls the spawned future until completion or abort, returns `Option(T)`:
  - `.Some(result)` — task completed normally
  - `.None` — task was aborted (effect handler called `escape`)
- When used as fire-and-forget (`io.spawn(task)` without binding result), the JoinHandle is discarded with no RC overhead.
- `JoinHandle(T)` is a non-owning view — it does not increment the future's reference count. The original task variable (`task1`, etc.) owns the future.

### Definition (in prelude.yo)
```rust
JoinHandle :: (fn(comptime(T) : Type) -> comptime(Type))
  struct(__future : *(T))
;
```
The `*(T)` field is required so the type parameter `T` appears in the struct fields, enabling the type synthesizer to extract `T` bindings during generic impl matching.

## Traits with associated types

Traits use direct `trait(...)` syntax with associated types as labeled `Type` fields:

```rust
// Trait definition — Item is an associated type
Iterator :: trait(
  Item : Type,
  next : (fn(self : *(Self)) -> Option(Self.Item))
);

// impl — provide concrete values for all fields
impl(Counter, Iterator(
  Item : i32,
  next : (fn(self : *(Self)) -> Option(Self.Item))(cond(
    (self._current >= self._max) => .None,
    true => { val := self._current; self._current = (self._current + i32(1)); .Some(val) }
  ))
));

// Where clause — use `:=` to constrain associated types (not `:`)
IntoIterator :: trait(
  Item : Type,
  IntoIter : Type,
  into_iter : (fn(self : Self) -> Self.IntoIter),
  where(Self.IntoIter <: Iterator(Item := Self.Item))
);
```

- **`:` in impl** creates a TraitValue (provides all fields).
- **`:=` in where clause** creates a specialized TraitType (constrains associated types only).
- Always wrap `fn` types in parentheses inside trait field definitions: `next : (fn(...) -> T)`, not `next : fn(...) -> T`.

## Comptime/runtime function specialization

Yo does **not** support function overloading. To provide comptime variants of functions, use explicit naming with a `comptime_` prefix (e.g., `comptime_unwrap` alongside `unwrap`). For operators, the `Call :: (runtime_fn, comptime_fn)` tuple pattern inside a module provides dispatch.

Use separate `impl` blocks with `where(Self <: Comptime)` constraints for comptime method variants on generic types like `Option(T)` and `Result(T, E)`.

**Duplicate method names across impl blocks are disallowed.** Defining `unwrap` in two separate impl blocks for the same type produces an error. Use distinct names (e.g., `comptime_unwrap`) instead. This ensures unambiguous method extraction via `Type.method_name`.

**Enum type method extraction** works: `Option(i32).unwrap` returns the method as a callable function value, matching struct type behavior.

## Operator traits use associated type Output

All operator traits (Add, Sub, Mul, Div, Mod, BitAnd, BitOr, BitXor, BitLeftShift, BitRightShift, Exponentiation, Negate, BitNot) use `Output` as an **associated type** in the trait body — the same pattern as the `Index` trait. The `Output` is NOT a function parameter.

Binary operator traits take `Rhs` as a type parameter:
```rust
Add :: (fn(comptime(Rhs) : Type) -> comptime(Trait))(
  trait(
    Output : Type,
    (+) : (fn(lhs: Self, rhs: Rhs) -> Self.Output)
  )
);
```

Unary operator traits (Negate, BitNot) are parameterless:
```rust
Negate :: trait(
  Output : Type,
  (neg): (fn(self: Self) -> Self.Output)
);
```

Comptime variants add `where(Self <: Comptime, Self.Output <: Comptime)`:
```rust
ComptimeAdd :: (fn(comptime(Rhs) : Type, where(Rhs <: Comptime))-> comptime(Trait))(
  trait(
    Output : Type,
    (+) : (fn(comptime(lhs): Self, comptime(rhs): Rhs) -> comptime(Self.Output)),
    where(Self <: Comptime, Self.Output <: Comptime)
  )
);
```

Impls must provide `Output : Type` explicitly:
```rust
impl(i32, Add(i32)(
  Output : i32,
  (+): ((lhs, rhs) -> __yo_op_add(lhs, rhs))
));

impl(i32, Negate(
  Output : i32,
  (neg): ((self) -> __yo_op_neg(self))
));
```

## Higher-Kinded Types (HKT)

Yo supports HKT by using **comptime function types as kinds**. Type constructors like `Option` and `Result` are already first-class comptime functions — HKT lets you abstract over them.

### Function-typed forall parameters

Declare a forall parameter with a function-type kind to accept type constructors:

```rust
// F is a type constructor (kind: Type → Type)
identity :: (fn(forall(F : (fn(comptime(T) : Type) -> comptime(Type)), A : Type), x : F(A)) -> F(A))(x);
```

### HKT traits

Define traits parameterized by type constructors:

```rust
Functor :: (fn(comptime(F) : (fn(comptime(T) : Type) -> comptime(Type))) -> comptime(Type))(
  trait(
    map : (fn(forall(A : Type, B : Type), self : F(A), f : (fn(a : A) -> B)) -> F(B))
  )
);
```

### Where clauses with TypeApplication

Use `where(F(A) <: SomeTrait(F))` to constrain type constructor applications:

```rust
do_map :: (fn(
  forall(F : (fn(comptime(T) : Type) -> comptime(Type)), A : Type, B : Type),
  container: F(A),
  f: (fn(a : A) -> B),
  where(F(A) <: Functor(F))
) -> F(B))(
  container.map(forall(B), f)
);
```

### TypeApplication resolution

`TypeApplication` (`F(A)`) is compile-time only — it gets fully resolved during specialization and must never reach codegen.

## Partial Application with `_`

Multi-parameter comptime functions can be partially applied using `_` as a placeholder:

```rust
// Type constructors:
IntResult :: Result(_, i32);     // kind: Type -> Type
StrResult :: Result(str, _);     // kind: Type -> Type

// Comptime value functions:
add :: (fn(comptime(x) : i32, comptime(y) : i32) -> comptime(i32))((x + y));
add1 :: add(i32(1), _);          // fn(comptime(__0) : i32) -> comptime(i32)
result :: add1(i32(2));           // 3
```

Partial application works on **any** comptime function (functions whose return type is `comptime`). It cannot be used on runtime functions.

## Option and Result combinators

`Option(T)` and `Result(T, E)` provide Rust-style combinator methods. Key methods:

- **Option**: `map`, `and_then`, `filter`, `or_else`, `flatten`, `map_or`, `map_or_else`, `ok_or`, `ok_or_else`, `and`, `or`, `unwrap_or_else`
- **Result**: `map`, `map_err`, `and_then`, `or_else`, `and`, `or`, `ok`, `err`, `map_or`, `map_or_else`, `unwrap_or_else`

Combinators use `Impl(Fn(...))` callbacks, and the forall type parameter is inferred automatically. Lambda syntax `(a) => expr` works too — parameter types are inferred from context:

```rust
(x : Option(i32)) = .Some(i32(5));

// Lambda with fully inferred types:
result := x.map((a) => (a * i32(2)));
// result = .Some(i32(10))

chained := x.and_then((a) =>
  cond((a > i32(0)) => Option(i32).Some((a * i32(2))), true => Option(i32).None)
);
```

## Generalized Algebraic Data Types (GADTs)

GADTs extend enum types with per-constructor return type annotations using `-> recur(...)`:

```rust
Value :: (fn(comptime(T) : Type) -> comptime(Type))(
  enum(
    IntVal(i : i32) -> recur(i32),
    BoolVal(b : bool) -> recur(bool),
    PairVal(a : i32, b : bool) -> recur(i32)
  )
);
```

Key semantics:
- `-> recur(ConcreteType)` after variant fields specifies what type the constructor produces
- When omitted, defaults to the unconstrained type parameters (regular enum behavior)
- Match type refinement: in `match(v, .IntVal(i) => i, .BoolVal(b) => b)`, each branch refines T to the variant's declared type
- Exhaustiveness: unreachable variants (e.g., `BoolVal` when matching `Value(i32)`) are excluded from exhaustiveness checking
- Runtime representation is identical to regular enums — all GADT logic is erased at compile time
- GADTs with custom discriminants: wrap variant in parens `(TagInt(i : i32) -> recur(i32)) = 10`
- Mixed GADT/regular variants: some variants can have `-> recur(...)` while others remain unconstrained
- For full design document, see `plans/GADTS.md` and `docs/en-US/GADTS.md`

## Standard library module organization (`std/`)

## reEvaluateFunctionType — impl specialization

`reEvaluateFunctionType` in `src/evaluator/values/impl.ts` re-evaluates a function type's parameter/return type expressions with concrete substitutions during generic impl specialization.

Key invariants:
- The **returned `env`** must have the same frame count as `specializedEnv` (the caller's specialization env). Using `functionType.env` (the original definition scope) adds extra frames from impl field list evaluation, breaking the frame-level check in `assignment.ts`.
- The **re-evaluation env** (`reEvalEnv`) can differ from the returned env — it's used only for evaluating type expressions and can include extra scope (HKT variables like `F`).
- Variables from `functionType.env` that don't exist in `specializedEnv` (e.g., `F` from HKT trait scopes) must be merged into the returned env because `exprs.typeExpr` still references original expressions.
- The `exprs.typeExpr` on parameters retains the **original** source expressions (e.g., `F(A)` from a trait definition), so every re-evaluation needs the same variables available.

### When to use `specializedEnv` vs `functionType.env`

| Purpose | Use |
|---|---|
| Returned function type's `env` field | `specializedEnv` (correct frame count) + merged missing vars |
| Re-evaluating type expressions inside `reEvaluateFunctionType` | `reEvalEnv` (built from `functionType.env`, has all scope vars) |
| Frame-level checks in `assignment.ts` | Compared against `functionType.env.frames.length` |

### Standard library module organization (`std/`)

### When to use `index.yo`

Only create `index.yo` when the directory contains a **single public module file whose name duplicates the directory name** (the `dir/dir.yo` pattern). Rename that file to `index.yo` so users get clean imports without repetition:

```rust
// std/url/url.yo → std/url/index.yo
// Users write:
{ Url } :: import "std/url";
// Instead of the redundant:
{ Url } :: import "std/url/url";
```

Modules that follow this pattern: `std/url`, `std/regex`, `std/glob`, `std/log`.

### When NOT to use `index.yo`

Do **not** create `index.yo` re-export files for directories with multiple distinct submodules. Users should import each submodule explicitly:

```rust
// CORRECT — explicit submodule imports:
{ TcpStream } :: import "std/net/tcp";
{ HashMap } :: import "std/collections/hash_map";
open import "std/fs/file";

// WRONG — don't create catch-all index.yo for these:
// open import "std/net";   // which module? tcp? udp? dns?
// open import "std/fs";    // which module? file? dir? walker?
```

Modules in this category: `std/net`, `std/fs`, `std/sync`, `std/time`, `std/os`, `std/io`, `std/crypto`, `std/encoding`, `std/collections`, `std/cli`, `std/testing`.

### Multi-file modules with a primary file

When a directory has a primary public file matching the directory name **plus** additional files, use an `index.yo` that re-exports all public submodules:

```rust
// std/http/ has http.yo (types) + client.yo (async fetch)
// std/http/index.yo re-exports both:
_http :: import "./http.yo";
_client :: import "./client.yo";
export ...(_http), ...(_client);

// Users write:
{ HttpRequest, fetch } :: import "std/http";
```

## Index trait (unified indexing)

All container indexing uses the `Index` trait. Array/Slice have special compiler builtins to avoid infinite recursion.

### Architecture

- `Index(Idx)` — runtime indexing trait with associated type `Output`
- `ComptimeIndex(Idx)` — compile-time variant (parameters and return are `comptime`)
- Array/Slice Index impls delegate to compiler builtins (`__yo_array_index`, `__yo_slice_index`, etc.)
- Other types (ArrayList, HashMap, BTreeMap, Deque, String) implement Index with normal methods

### Array/Slice builtins

| Runtime builtin | Comptime builtin | Purpose |
|---|---|---|
| `__yo_array_index` | `__yo_comptime_array_index` | Element access |
| `__yo_slice_index` | `__yo_comptime_slice_index` | Element access |
| `__yo_array_index_range` | `__yo_comptime_array_index_range` | Range slicing |
| `__yo_array_index_range_inclusive` | `__yo_comptime_array_index_range_inclusive` | Inclusive range slicing |
| `__yo_slice_index_range` | `__yo_comptime_slice_index_range` | Range slicing |
| `__yo_slice_index_range_inclusive` | `__yo_comptime_slice_index_range_inclusive` | Inclusive range slicing |

Runtime builtins generate inline C code (`(&(arr->data[idx]))`). Comptime builtins handle bounds checking, value extraction, and `arrayElementRef` for mutation.

### comptime_string indexing

`comptime_string` supports indexing via `ComptimeIndex`:
- `"Hello"(0)` → `"H"` (single character as comptime_string)
- `"Hello"(0..3)` → `"Hel"` (range slicing)
- `"Hello"(0..=2)` → `"Hel"` (inclusive range slicing)

Builtins: `__yo_comptime_string_index`, `__yo_comptime_string_index_range`, `__yo_comptime_string_index_range_inclusive`

### Self.Output resolution in generic impls

When a type has multiple Index impls (e.g., `Index(usize)` and `Index(Range(usize))`), `Self.Output` is resolved by:
1. `extractTraitTypeArgsFromImplExpr` extracts associated type field expressions from impl body args (e.g., `Output : T`)
2. The re-evaluation loop in `findMethodsFromGenericImpls` evaluates these expressions with concrete substitutions
3. `property-access.ts` checks the env for `Output` before calling `findAssociatedTypeFromGenericImpls` (which would be ambiguous)

### arrayElementRef for comptime mutation

Comptime array indexing returns an `arrayElementRef` that enables:
- `arr(0) = val` — compile-time mutation via `assignment.ts`
- `&(arr(0))` — compile-time pointer creation via `ptr-fns.ts`
