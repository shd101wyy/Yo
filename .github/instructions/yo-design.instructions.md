---
applyTo: "**/*.yo, std/**"
description: "Use when making design decisions about the Yo language, writing std library code, or working with Yo types. Covers type conventions, rune, Box, str vs String, Pointer, SomeType, and platform-specific code."
---

# Yo Language Design Decisions

## Type naming conventions

- Lowercase for value types (non-reference-counted): `rune`, `i32`, `u32`, `bool`
- Use `struct(...)` for value types
- Use `ref(struct(...))` / `ref(enum(...))` for reference-counted (reference-semantics) types; `atomic(ref(struct(...)))` / `atomic(ref(enum(...)))` for atomic RC
- Use `newtype(...)` instead of `struct(...)` when the type has only a single field (e.g., `FilePermission :: newtype(mode : u32)`)
- Imported source-file namespaces are represented as structs. Do not introduce
  `module(...)`, `Module`, or `SelfModule` syntax; use `struct(...)`, `Type`,
  and normal `Self`.

## Struct runtime layout

- Fields written with `name :: value` or `comptime(name) : Type` are compile-time-only static fields/methods. They are available through the type metadata but are not emitted into the C runtime layout.
- Ordinary fields with compile-time-only types (for example `x : comptime_int`) are still data fields. They make the containing struct comptime-only unless another rule changes the type; do not treat them like `::` fields.
- **`header` is RESERVED as a runtime field name in a reference struct.** A `ref(struct(...))` emits `{ __yo_ref_header_t header; <user fields...> }`, so a user field of that name would be a second member with the same name — and every access would silently resolve to the reference-count header instead. The evaluator rejects it at declaration time with a source location (`src/evaluator/types/struct.yo`), so `yo check` catches it rather than the backend emitting C that will not compile.
  - The reservation is narrow, on purpose: it does not apply to VALUE structs (they inject nothing), it does not apply to `::` comptime fields (erased from the layout), and it does not cover the header's OWN members — `ref_count`, `gc_flags`, `type_id`, `dispose_fn`, `borrow_count`, `gc_mark` are nested INSIDE `__yo_ref_header_t` and so remain usable as field names.
  - Field-name MANGLING (renaming the user field instead of reserving the name) is the nicer fix and is deliberately deferred: it would have to rename a C member consistently across struct declaration, constructor parameters and body, struct-literal emission, field access, `_ptr_field_access`, match destructuring, `open()`, the traversal functions, dup/drop/dispose, and the `box->${field}` sites in `src/codegen/functions/dyn.yo` — and one missed site reproduces the bug or, worse, reads the wrong member. See `issues/fixed/ref-struct-field-named-header-collides-with-rc-header.md`.

## `Self` in type definitions

Always use `Self` to refer to the type being defined inside `struct(...)`, `ref(struct(...))`, `ref(enum(...))`, and `enum(...)` bodies. The type name is not yet bound during its own definition, so using it causes a "Variable not found" error:

```rust
// CORRECT — Self for recursive references:
TypeValue :: enum(
  IntType(bits : u8),
  PointerType(pointee : Box(Self)),
  ArrayType(element : Box(Self), length : usize)
);

// WRONG — TypeValue not available inside its own enum:
TypeValue :: enum(
  IntType(bits : u8),
  PointerType(pointee : Box(TypeValue)),
  ArrayType(element : Box(TypeValue), length : usize)
);
```

This applies equally to `impl` method signatures (use `Self` for parameter and return types).

`Self` also works inside **generic type constructor functions** — it refers to the current type instantiation (e.g., `Tree(T)` inside `Tree`):

```rust
// CORRECT — Self refers to Tree(T):
Tree :: (fn(comptime(T) : Type) -> comptime(Type))(
  enum(
    Leaf(value : T),
    Node(left : Self, right : Self)
  )
);

// WRONG — Tree is not available inside its own function body:
Tree :: (fn(comptime(T) : Type) -> comptime(Type))(
  enum(
    Leaf(value : T),
    Node(left : Tree(T), right : Tree(T))
  )
);
```

Use `recur(args)` only when calling the type constructor with **different** type arguments than the current instantiation (e.g., `recur(i32)` inside `Tree(T)` to get `Tree(i32)`).

## Unicode: `rune` not `Char`

- `char` is the C character type (8-bit)
- `rune` represents Unicode code points (32-bit, like Go's rune)
- File: `std/string/rune.yo`

## Strings

- Double quote string returns `str` type (contains `[u8]` byte slice)
- Template string returns `String` type (utf-8 encoded reference-semantics type). Its syntax is the same as JavaScript template strings. The `${...}` interpolation is also supported for types that implement `ToString` trait.
- `str` is a builtin type — don't use it as a variable or type name.
- **String indexing is BYTE-based, everywhere** (D4, `plans/STD_API_AUDIT_D4_PLAN.md`, 2026-08-26): `String.len()` is the byte count at O(1), and `at` / `substring` / `s(a..b)` / `index_of` / `last_index_of` / the positional arguments of `contains` / `starts_with` / `ends_with` / the `Pattern` trait all take and return byte offsets — the same unit as `str.len()` and `StringBuilder.len()`, which were always bytes. `substring` clamps out-of-range but PANICS on an offset inside a rune; `try_substring` is the non-panicking form, `floor_char_boundary` / `ceil_char_boundary` snap arbitrary offsets. Rune work goes through `chars()` / `char_indices()` composed with iterator methods — the rune count is `s.chars().count()` (the iterator spelling keeps the O(n) cost visible; `len()` is O(1) everywhere in std). Comptime strings share the byte basis (D4 PR 7). Full contract: `docs/en-US/STRINGS.md` / `docs/zh-CN/STRINGS.md`.
- **Use template strings for constant `String` values**: Instead of `String.from("hello")`, write `` `hello` ``. Template strings without interpolation produce the same result but are more concise. This applies anywhere a `String` value is needed — return values, comparisons, arguments, etc.
- Use `println` or `print` function from `std/fmt` to print instead of `printf`. You can pass template string or any value whose type implements `ToString` trait to both `println` and `print`.

## Box and box

Implemented in `prelude.yo`:

```rust
Box :: (fn(comptime(V) : Type) -> comptime(Type))
  ref(struct(
    (*) : V
  ))
;
box :: (fn(generic(V : Type), value : V) -> Box(V))
  Box(V)(value)
;
```

Single-payload reference-semantics types can use the payload field syntax `(*) : T` and are
accessed with `value.*`. Treat this as a value payload accessor for reference-semantics values,
not automatically as a pointer dereference; pointer dereference still applies
when the receiver itself has pointer type.

## Pointers

- `Pointer` works in both compile-time and runtime contexts (`Runtime` and `Comptime` traits in `prelude.yo`).
- Pointer comparison: plain `==`/`!=`/`<`/`<=`/`>`/`>=` (Eq/Ord impls on `*(T)`, address identity). Pointer arithmetic: the methods `p.add(n)`, `p.sub(n)`, `p.offset_from(q)` (require `unsafe(...)`).
- No NULL in Yo. Nullable pointer: `Option(*(T))` or `?(*(T))` (the `?*` token was removed 2026-08-21 — `?` is the Option alias). `Option(*(T)).None` is optimized as NULL in C codegen.

## Unsafe operations

The `unsafe` module in `prelude.yo` provides low-level escape hatches:

- `unsafe.drop(value)` — manually drop `value`, running its destructor immediately.
- `unsafe.cast(value, TargetType)` — reinterpret cast (alias for the internal `__yo_as` builtin).

```rust
// Cast between types (use sparingly)
result := unsafe.cast(ptr, *(u8));
```

**Note:** `__yo_as` is still exported from prelude as a top-level symbol because the evaluator internally transforms type casts (e.g., `u32(x)`) into `__yo_as` calls. Do not remove `export __yo_as;`.

## SomeType

- `SomeType` automatically implements the `Runtime` trait by default.
- Never write functions to resolve `SomeType` — struct/enum/union are nominal types, replacing SomeType causes problems.
- **Never substitute SomeType within another Type.** Because many types like struct/enum/union etc in Yo are nominal type, simple substitution can break type identity. The correct approach is to re-evaluate the type expression in an environment where the type parameter is bound to the concrete type.
- **Every `Impl(Trait)` annotation wrapper is a SomeT with the RESERVED name `"Impl"`** (`src/evaluator/builtins/impl_constraint.yo`). Any evaluator logic that matches or binds SomeTs BY NAME (param↔return substitution, env markers, where-clause bookkeeping) must exclude that name (and nameless dyn wrappers) — two wrappers in one signature are unrelated. Missing the exclusion makes a call typed as one of its ARGUMENTS' types (C27, `issues/fixed/generic-impl-async-method-closure-param-return-type-collapse.md`). Do NOT "fix" it by renaming the SomeT (every `== "Impl"` reservation check breaks), by skipping its env binding (std stops checking), or by keying env bindings per id (io.async/io.await share wrapper bindings by name — `async_await` regresses).

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
register_module :: (fn(comptime(config) : ModuleConfig) -> unit)({
  __yo_build_module(config);
});

// CORRECT — comptime(unit) signals compile-time only:
register_module :: (fn(comptime(config) : ModuleConfig) -> comptime(unit))({
  __yo_build_module(config);
});

// CORRECT — comptime(Step) for functions returning compile-time values:
executable :: (fn(comptime(config) : Executable) -> comptime(Step))({
  __yo_build_executable(config.name, config.root, ...);
  Step(name: config.name, kind: StepKind.Executable)
});
```

This applies to all parameters and return types in comptime-only APIs:

- Parameters: `comptime(name) : comptime_str`
- Return: `-> comptime(Step)`, `-> comptime(unit)`, `-> comptime(str)`

## Algebraic effects

- Effect handlers are **explicit parameters**. A function that uses an effect names it in its signature, e.g. `safe_divide :: (fn(x : i32, y : i32, raise : Raise) -> i32)`. Callers pass the handler by name at the call site: `safe_divide(i32(10), i32(0), raise)`.
- Install a handler at the use site with a local binding: `(raise : Raise) = ((msg) -> { unwind(i32(-1)); });`. Lambdas on the RHS of `=` need outer parens.
- A handler whose body may `unwind` must have type `ctl(args) -> R`. A handler that always resumes can be plain `fn(args) -> R`. Subtyping is one-way: `fn(T) -> R <: ctl(T) -> R`.
- `return(expr)` inside an effect handler **resumes** the continuation.
- `unwind(expr)` inside an effect handler **discards** the continuation and exits the install frame (the function that bound the handler). `unwind` is only valid inside a `ctl(...) -> R` body.
- For effect-bundle polymorphism, quantify over a struct: `generic(E : Type.Struct)` and pass `E` as the Future's single effect argument.
- Effect handlers use Evidence Passing (function pointer parameters) for zero-overhead calls.
- **Handler functions are standalone, not closures.** Effect handlers are compiled as standalone C functions and cannot reference variables from the enclosing scope. Pass state as explicit function arguments instead.
- Pointers/references to control-bound types (any type transitively containing a `ctl(...) -> R`) are rejected — handlers must live on the stack of the install frame.
- For the full design document with overhead analysis and implementation details, see `docs/en-US/ALGEBRAIC_EFFECTS.md`.

## Future return types with effects

- `Future` takes the result type as the first argument and (optionally) a single effect bundle as the second: `Future(T)` or `Future(T, E)`.
- `E` is a single type — typically a struct that bundles every effect the async body needs. Define one bundle struct (e.g. `Ctx :: struct(io : Io, raise : Raise)`) and pass it as the single `E`.
- The async closure takes that bundle as one parameter: `io.async((ctx : Ctx) => { ctx.raise(...); ... })`.
- When a function uses `io : Io` and runs an async body, the bundle must include `Io`, so the return type names it: `Impl(Future(Result(T, E), Ctx))`.
- Return `io.async(...)` directly as the last expression — do NOT assign to an intermediate variable:

```rust
// WRONG — intermediate variable prevents enum variant type inference:
my_fn :: (fn(io : Io) -> Impl(Future(Result(i32, IoError), Io)))({
  task := io.async((io : Io) => {
    .Ok(i32(42))
  });
  return(task);
});

// CORRECT — return io.async directly:
my_fn :: (fn(io : Io) -> Impl(Future(Result(i32, IoError), Io)))(
  io.async((io : Io) => {
    .Ok(i32(42))
  })
);
```

## JoinHandle(T) — spawned task handle

`JoinHandle(T)` is a builtin generic type returned by `io.spawn`. It wraps a pointer to the spawned future and allows awaiting its result.

### API

```rust
handle := io.spawn(task, ctx);   // → JoinHandle(T), ctx is the task's effect bundle
result := handle.await(io);      // → Option(T)
```

### Semantics

- `io.spawn(task, e)` cold-starts the future with the effect bundle `e`, and returns a `JoinHandle(T)`.
- `handle.await(io)` polls the spawned future until completion or abort, returns `Option(T)`:
  - `.Some(result)` — task completed normally
  - `.None` — task was aborted (effect handler called `unwind`)
- When used as fire-and-forget (`io.spawn(task, e)` without binding result), the JoinHandle is discarded with no RC overhead.
- `JoinHandle(T)` is a non-owning view — it does not increment the future's reference count. The original task variable owns the future.

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
// Trait definition — Item is an associated type. Iterator was
// migrated to take inout(self) : Self in plans/archive/ITERATOR_REDESIGN.md
// (the old *(Self) signature would be forbidden in safe code).
Iterator :: trait(
  Item : Type,
  next : (fn(inout(self) : Self) -> Option(Self.Item))
);

// impl — provide concrete values for all fields
impl(Counter, Iterator(
  Item : i32,
  next : (fn(inout(self) : Self) -> Option(Self.Item))(cond(
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

## Trait method disambiguation with where-clause constraints

When a type implements multiple traits that each define a method with the same name, where-clause constraints disambiguate which trait's method is used:

```rust
T1 :: trait(get_number : (fn(self : Self) -> i32));
T2 :: trait(get_number : (fn(self : Self) -> i32));

Point :: struct(x : i32, y : i32);
impl(Point, T1(get_number : (self -> self.x)));
impl(Point, T2(get_number : (self -> self.y)));

// Implicit dispatch — where(T <: T1) constrains self.get_number() to T1's method
use_t1 :: (fn(generic(T : Type), self : T, where(T <: T1)) -> i32)({
  return(self.get_number());  // Dispatches to T1.get_number -> returns x
});

// Explicit dispatch — (T <: T2).get_number accesses T2's method directly
use_t2 :: (fn(generic(T : Type), self : T, where(T <: T2)) -> i32)({
  return((T <: T2).get_number(self));  // Dispatches to T2.get_number -> returns y
});
```

**Implementation details:**

- Where-clause constraints are applied BEFORE argument binding so the SomeType has trait constraints during method lookup
- Runtime parameters with constrained SomeType stay typed as the SomeType (not the concrete arg type) to preserve trait filtering
- `getReceiverMethodsByNameFromEnv` filters impl'd traits by the SomeType's where-clause constraint IDs
- Concrete FunctionValues are resolved from trait impls for codegen static dispatch (avoids vtable-style dispatch)

## Comptime/runtime function specialization

Yo does **not** support function overloading — same stance as Rust, and ENFORCED since 2026-08-21 (`plans/FUNCTION_OVERLOADING_POLICY.md`): an exported `Call` holding a tuple of two or more candidates is rejected everywhere except std/prelude.yo, whose runtime/comptime operator modules (`(-)`/`(!)`/`(~)`, `Call :: (neg, comptime_neg)`) are the single sanctioned overload sets (`is_overload_set_capable_file` in `src/evaluator/memory_safety.yo`, gated at the export choke point in `src/evaluator/values/anonymous_module.yo`). A single-function `Call` — a callable module — is not an overload set and stays allowed. To provide comptime variants of functions, use explicit naming with a `comptime_` prefix (e.g., `comptime_unwrap` alongside `unwrap`).

Use separate `impl` blocks with `where(Self <: Comptime)` constraints for comptime method variants on generic types like `Option(T)` and `Result(T, E)`.

**Duplicate method names across impl blocks are disallowed** — ENFORCED since 2026-08-21: a second same-name INHERENT impl for the same type errors with `Method "X" is already defined for this type` (gated at inherent registration in `src/evaluator/values/impl.yo`, keyed on the defining site so loader re-evaluation and per-instantiation generic re-registration stay legal — `plans/backlog/DUPLICATE_INHERENT_METHOD_REJECTION.md`). Trait-provided methods sharing a name remain legal by design. Use distinct names (e.g., `comptime_unwrap`) for variants. This ensures unambiguous method extraction via `Type.method_name`.

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

### Function-typed generic parameters

Declare a generic parameter with a function-type kind to accept type constructors:

```rust
// F is a type constructor (kind: Type → Type)
identity :: (fn(generic(F : (fn(comptime(T) : Type) -> comptime(Type)), A : Type), x : F(A)) -> F(A))(x);
```

### HKT traits

Define traits parameterized by type constructors:

```rust
Functor :: (fn(comptime(F) : (fn(comptime(T) : Type) -> comptime(Type))) -> comptime(Type))(
  trait(
    map : (fn(generic(A : Type, B : Type), self : F(A), f : Impl(Fn(a : A) -> B)) -> F(B))
  )
);
```

### Where clauses with TypeApplication

Use `where(F(A) <: SomeTrait(F))` to constrain type constructor applications:

```rust
do_map :: (fn(
  generic(F : (fn(comptime(T) : Type) -> comptime(Type)), A : Type, B : Type),
  container: F(A),
  f: Impl(Fn(a : A) -> B),
  where(F(A) <: Functor(F))
) -> F(B))(
  container.map(generic(B), f)
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

Combinators use `Impl(Fn(...))` callbacks, and the generic type parameter is inferred automatically. Lambda syntax `(a) => expr` works too — parameter types are inferred from context:

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

## std error handling: three blessed styles, no fourth

Decided in `plans/STD_API_AUDIT.md` D1. Before this, std shipped four styles,
sometimes inside one file. When you add or change a fallible std API, pick from
exactly these three — and if none fits, that is a design discussion, not a
licence to invent a fourth.

| Situation | Style |
| --- | --- |
| I/O, and anything on the `io` path (fs, net, http, process) | **effects** — `exn : Exception` / `IoExn` |
| pure fallible transforms: parsing, decoding, conversion | **`Result(T, TypedError)`** |
| lookups where absence is not an error | **`Option(T)`** |

Rules that follow from it:

- **`Result(_, String)` is banned.** An error type is a real enum implementing
  `Error()`. A string error cannot be matched on, downcast, or wrapped, and it
  forces every caller into prose comparison.
- **Never drop the payload on failure.** `Channel.send` returning
  `Result(unit, unit)` discarded the value the caller still owned; return it.
- A fallible constructor that cannot fail should not be fallible — do not add a
  `Result` "for symmetry".
- Absence and failure are different: do not model a missing key as an error, and
  do not model an I/O failure as `None`.

## std naming conventions

Decided in `plans/STD_API_AUDIT.md` D2. One name per concept, across the whole
tree. Use these when adding an API; a new module that invents a synonym is a
review defect, not a style preference.

| Concept | Blessed name | Do not use |
| --- | --- | --- |
| element count | `len()`, plus `is_empty()` on EVERY container | a public `size` field |
| map insert | `insert(k, v) -> Option(V)` (returns the old value) | `set` |
| set insert | `insert(v) -> bool` | `add` |
| sequence append | `push` / `push_front` / `push_back` | — |
| membership | `contains` (sequence/set), `contains_key` (map) | — |
| value iterator | `into_iter()` | — |
| pointer iterator | `iter()` | `iter_ptr` |
| accessors | a bare noun | a `get_` prefix |
| byte codecs | `encode` / `decode` | `to_ascii` / `to_unicode` |
| text formats | `parse` / `stringify` | `decode_html`-style verb-first names |
| conversion | `from_` / `to_` / `into_`, with Rust's discipline (`into_` consumes) | two spellings of one conversion (`to_cstr` vs `to_c_str`) |
| comptime twins | `Comptime` prefix on the trait, `comptime_` prefix on the method | an infix `_comptime_` |

Two conventions that are easy to miss:

- **`sys/` is plumbing, `std/*` is the product.** Every user-relevant syscall
  gets a typed wrapper, and an underscore-private name must never appear in an
  `export(...)` list.
- **Traits are the API.** An inherent method that duplicates a trait method
  becomes a trait impl, so generic code can dispatch on it. Types that should
  compose get `Eq` / `Ord` / `Hash` / `Clone` / `ToString`.
- **Hashing is Rust-shaped (plans/HASHER_REDESIGN.md).** `Hash.hash(self,
  inout(hasher) : H)` FEEDS bytes; a `Hasher` (`std/hash`: `SipHasher13` =
  `DefaultHasher`, `Fnv1aHasher`) turns them into the `u64`. Never write a
  `-> u64` hash method or fold hashes with `* 31`; a new type's impl calls
  `hasher.write_*` per field (or `derive(Hash)`), variable-length data writes a
  terminator/length, and `hash_one(v)` is the one-value helper. Maps use FIXED
  default keys so emitted C and printed maps are reproducible (the fixpoint
  gate compares C byte for byte); `HashMap.with_keys` is the per-instance opt-in.

## UTF-8 lives in exactly one module

`std/encoding/utf8.yo` is the only place in the tree that is allowed to know how
UTF-8 is laid out. Before it landed, **eleven** `std/` files carried their own
copy of the same bit twiddling (STD_API_AUDIT D8), and three latent bugs were
hiding in the copies. Do not add a twelfth.

| you need | call |
| --- | --- |
| decode a rune at a byte offset, strictly | `decode(bytes, i) -> Result(Decoded, Utf8Error)` |
| decode without ever failing (a scanner over untrusted bytes) | `decode_lossy(bytes, i) -> Decoded` — U+FFFD, width ≥ 1 |
| decode from a buffer that is not an `ArrayList(u8)` | `decode_parts(b0, b1, b2, b3, available, index)` — fetch the bytes yourself, no allocation |
| encode a `rune` | `encode_into(r, out)` / `encode(r)` |
| encode a raw `u32` from a decoder (`\uXXXX`, a UTF-16 unit, `towlower`) | `encode_lossy_into(code, out)` — substitutes U+FFFD, so you cannot emit CESU-8 |
| advance a rune-walking loop | `step_len(b)` — never `cond((b < 0x80) => 1, (b < 0xE0) => 2, …)` |
| test a rune boundary | `is_boundary(b)` / `is_continuation(b)` |
| check a whole buffer or a sub-range | `validate(bytes)` / `validate_range(bytes, from, to)` |

Two constraints on that module you must not break:

- **It stays below `std/error` and `std/fmt`.** It imports only
  `std/string/rune` and `std/collections/array_list`, because
  `std/string/string.yo` is a consumer and `std/error`/`std/fmt` both import
  `std/string`. That is why `Utf8Error` has inherent `message()`/`index()`
  instead of `ToString`/`Error()` impls — same reason `AllocError` has none.
  A module that wants a throwable UTF-8 error wraps it, the way
  `StringError.InvalidUtf8(cause : Utf8Error)` does.
- **`String.from_bytes` does not validate** — it is the *unchecked*
  constructor, and its ~170 call sites (26 of them in `vendor/markdown_yo`) are
  why it still has that name. Use `String.from_utf8` for bytes of unknown
  provenance: a file, a socket, a subprocess, a decoded payload. Use
  `from_bytes` only when the bytes demonstrably came from UTF-8 already.
  `String.from_cstr` does not validate either, deliberately: it is how every
  `${number}` in every template string is built.

## Standard library module organization (`std/`)

## Function-type re-evaluation during impl specialization

> **Provenance: these invariants were derived on the retired TypeScript
> evaluator**, where the pass was a single function called
> `reEvaluateFunctionType`. The self-hosted evaluator has no function by that
> name (older `plans/` and `issues/` docs still use it); the work happens inside
> generic-impl specialization in `src/evaluator/values/impl.yo`. The
> invariants themselves still hold, because the frame-level check they protect
> is live in `src/evaluator/exprs/assignment.yo` (~line 1075).

Re-evaluating a function type's parameter/return type expressions with concrete substitutions during generic impl specialization has to preserve these:

- The **returned env** must have the same frame count as the specialization env. Using the function type's own captured env (the original definition scope) adds extra frames from impl field list evaluation, breaking the "defined outside the function body" frame-level check in `assignment.yo`.
- The **re-evaluation env** can differ from the returned env — it's used only for evaluating type expressions and can include extra scope (HKT variables like `F`).
- Variables from the captured env that don't exist in the specialization env (e.g., `F` from HKT trait scopes) must be merged into the returned env, because the parameters' stored type expressions still reference the original expressions.
- Parameters retain their **original** source type expressions (e.g., `F(A)` from a trait definition), so every re-evaluation needs the same variables available.

### Which env goes where

| Purpose                                     | Use                                                                     |
| ------------------------------------------- | ----------------------------------------------------------------------- |
| Returned function type's captured env       | the specialization env (correct frame count) + merged missing vars      |
| Re-evaluating the stored type expressions   | an env built from the function type's captured env (has all scope vars) |
| Frame-level checks in `assignment.yo`       | compared against the captured env's frame count                         |

### Standard library module organization (`std/`)

### When to use `index.yo`

Only create `index.yo` when the directory contains a **single public module file whose name duplicates the directory name** (the `dir/dir.yo` pattern). Rename that file to `index.yo` so users get clean imports without repetition:

```rust
// std/url/url.yo → std/url/index.yo
// Users write:
{ Url } :: import("std/url");
// Instead of the redundant:
{ Url } :: import("std/url/url");
```

Modules that follow this pattern: `std/url`, `std/regex`, `std/glob`, `std/log`.

### Flat `.yo` file for truly single-file modules

If a module has **only one file and no planned submodules**, keep it as a flat `.yo` file in its parent directory — do **not** create a subdirectory just to house an `index.yo`:

```
// CORRECT — single-file module as a flat file:
std/env.yo        ← import "std/env"

// WRONG — unnecessary directory with a single index.yo:
std/env/index.yo  ← same import path, but adds a directory for no reason
```

Use a directory with `index.yo` only when the module already has or plans to have companion files (helpers, platform-specific splits, sub-APIs).

### When NOT to use `index.yo`

Do **not** create `index.yo` re-export files for directories with multiple distinct submodules. Users should import each submodule explicitly:

```rust
// CORRECT — explicit submodule imports:
{ TcpStream } :: import("std/net/tcp");
{ HashMap } :: import("std/collections/hash_map");
open(import("std/fs/file"));

// WRONG — don't create catch-all index.yo for these:
// open(import("std/net")); // which module? tcp? udp? dns?
// open(import("std/fs"));  // which module? file? dir? walker?
```

Modules in this category: `std/net`, `std/fs`, `std/sync`, `std/time`, `std/crypto`, `std/encoding`, `std/collections`, `std/cli`, `std/testing`.

### Multi-file modules with a primary file

When a directory has a primary public file matching the directory name **plus** additional files, use an `index.yo` that re-exports all public submodules:

```rust
// std/http/ has http.yo (types) + client.yo (async fetch)
// std/http/index.yo re-exports both:
_http :: import("./http.yo");
_client :: import("./client.yo");
export(...(_http), ...(_client));

// Users write:
{ HttpRequest, fetch } :: import("std/http");
```

## Index trait (unified indexing)

All container indexing uses the `Index` trait. Array/Slice have special compiler builtins to avoid infinite recursion.

### Architecture

- `Index(Idx)` — runtime indexing trait with associated type `Output`. Self is taken by `inout(self) : Self` so the index method can return a pointer to a field of the caller's value.
- `ComptimeIndex(Idx)` — compile-time variant (parameters and return are `comptime`). Self is taken by `comptime(inout(self)) : Self` — the comptime binding is erased at runtime but mutations through it propagate to the caller via the evaluator's binding-update path.
- Array/Slice Index impls delegate to compiler builtins (`__yo_array_index`, `__yo_slice_index`, etc.)
- Other types (ArrayList, HashMap, BTreeMap, Deque, String) implement Index with normal methods

### Array/Slice builtins

| Runtime builtin                    | Comptime builtin                            | Purpose                 |
| ---------------------------------- | ------------------------------------------- | ----------------------- |
| `__yo_array_index`                 | `__yo_comptime_array_index`                 | Element access          |
| `__yo_slice_index`                 | `__yo_comptime_slice_index`                 | Element access          |
| `__yo_array_index_range`           | `__yo_comptime_array_index_range`           | Range slicing           |
| `__yo_array_index_range_inclusive` | `__yo_comptime_array_index_range_inclusive` | Inclusive range slicing |
| `__yo_slice_index_range`           | `__yo_comptime_slice_index_range`           | Range slicing           |
| `__yo_slice_index_range_inclusive` | `__yo_comptime_slice_index_range_inclusive` | Inclusive range slicing |

Runtime builtins generate inline C code (`(&(arr->data[idx]))`). Comptime builtins handle bounds checking, value extraction, and `arrayElementRef` for mutation.

### comptime_str indexing

`comptime_str` supports indexing via `ComptimeIndex`. Since D4 PR 7
(2026-08-26) the indices are **BYTE offsets**, matching the runtime basis:

- `"Hello"(0)` → `"H"` — the RUNE starting at byte 0, as a 1-rune comptime_str
  (runtime `s(i)` yields the `u8` instead; that result-type split is
  deliberate — see `docs/en-US/STRINGS.md`)
- `"Hello"(0..3)` → `"Hel"` (byte-range slicing)
- `"Hello"(0..=2)` → `"Hel"` (inclusive byte-range slicing)
- an offset inside a rune is a **compile error** (where the runtime
  `substring` panics); out of range is a compile error too

Builtins: `__yo_comptime_string_index`, `__yo_comptime_string_index_range`, `__yo_comptime_string_index_range_inclusive`

### Self.Output resolution in generic impls

When a type has multiple Index impls (e.g., `Index(usize)` and `Index(Range(usize))`), `Self.Output` is resolved by:

1. The associated-type field expressions are extracted from the impl body args (e.g., `Output : T`)
2. The re-evaluation loop in `find_methods_from_generic_impls` (`src/evaluator/values/impl.yo`) evaluates these expressions with concrete substitutions
3. `src/evaluator/exprs/property_access.yo` checks the env for `Output` before calling `find_associated_type_from_generic_impls` (which would be ambiguous)

### Comptime element pointers for comptime mutation

Comptime array indexing returns a comptime element pointer —
`EvalValue.PtrVal(target_value, target_index)` in `src/value.yo`, where
`target_value(0)` is the backing `ArrayVal` and `target_index` is the element
index. That enables:

- `arr(0) = val` — compile-time mutation via `src/evaluator/exprs/assignment.yo`
- `&(arr(0))` — compile-time pointer creation via `src/evaluator/builtins/ptr_fns.yo`

## Compiler-source (`src/`) pitfalls

These patterns bite when writing or editing the compiler's own Yo source.
They were catalogued during the TypeScript → Yo port (hence the TS-vs-Yo
contrasts below); `yo check ./src` is what catches them:

### Reference-semantics parameters: never use `&()` for Environment/EvalContext

`Environment` and `EvalContext` are `ref(struct(...))` types (reference-counted),
not value types. Mutations to a reference-semantics value's fields are visible to all
holders of the reference. Using `&(env)` creates a pointer-to-pointer
(`*(Environment)`) which won't match `Environment`.

```rust
// WRONG — unnecessary &() creates type mismatch:
_some_fn(&(ee), &(ge));

// CORRECT — just pass the reference-semantics value:
_some_fn(ee, ge);
```

### Reassigning Effect-handler parameters: use field-level copy

Function parameters in Yo are immutable. To "reassign" an effect-handler
variable that was passed in (e.g., `env`, `expected_env`, `env_mut`),
use field-level assignment instead of variable reassignment:

```rust
// WRONG — cannot reassign parameter:
env_mut = result.env;

// CORRECT — mutate fields of the referenced value:
env_mut.frames = result.env.frames;
env_mut.module_path = result.env.module_path;
env_mut.function_declaration_frame_level = result.env.function_declaration_frame_level;
env_mut.input_string = result.env.input_string;
```

### `io.async` closures: one parameter, effects struct

`io.async` takes one closure argument typed `Impl(Fn(e : E) -> T)` and returns
`Impl(Future(T, E))` (`std/prelude.yo`). The closure takes exactly
one parameter — the **effects struct** `e : E`. When the future needs
`IoExn` effects, the parameter type is `IoExn`, and all effect operations
go through `e.io` and `e.exn`. The closure body must NOT capture `io` or
`exn` from the enclosing scope (CTL values cannot be captured).

```rust
// WRONG — two parameters:
io.async((io, exn) => { ... });

// WRONG — captures enclosing io (CTL capture error):
io.async((e : IoExn) => {
  io.await(future, io);  // captured io!
});

// CORRECT — all effects through e:
io.async((e : IoExn) => {
  e.io.await(create_dir_all(path, e.io), e);
  e.exn.throw(dyn(`error`));
});
```

For `Io`-only futures, use `(io : Io) =>` — just the `Io` handler:

```rust
// Io-only future: closure parameter is just Io
io.async((io : Io) => {
  io.await(some_io_future(io), io);
});
```

### `io.await` effect records: match the future's effects type

`io.await(future, e)` takes `e : E` where `E` matches the future's effects:

- `Future(T, Io)` → `io.await(future, io)`
- `Future(T, IoExn)` → `e.io.await(future, e)` (using `e : IoExn`)
- Low-level IO futures (`IO_*`) → `io.await(future, io)` only

### Exception threading: always add `exn` to calls

The evaluator threads `Exception` explicitly as the last parameter of every
function that may error — Yo has no ambient `throw`. Any new fallible helper
needs `exn : Exception` as its last parameter, passed on to all callees:

```rust
// Raise an error:
exn.throw(dyn(format_error_message(...)));

// Call a fallible helper — exn goes last:
evaluate_type_annotation(expr, env, ctx, exn);
```

### `.*` pointer dereference in check mode

`env_ptr.*` and other `.*` patterns are C-level pointer operations.
In `check` mode (no codegen), write field-level operations directly
on the reference-semantics value:

```rust
// WRONG — C pointer deref fails in check:
env_ptr.* = info.env;

// CORRECT — field mutation on reference-semantics value:
env_ptr.frames = info.env.frames;
env_ptr.module_path = info.env.module_path;
// ... etc
```
