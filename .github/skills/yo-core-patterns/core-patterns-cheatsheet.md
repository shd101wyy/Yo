# Yo Core Patterns Cheatsheet

These patterns are aimed at everyday Yo application and library code.

## Strings and output

```rust
open(import("std/fmt"));
open(import("std/string"));

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

| Type           | When you see it                              | Key behavior                           |
| -------------- | -------------------------------------------- | -------------------------------------- |
| `str`          | `"hello"` in runtime contexts                | View of STATIC bytes, no constraints   |
| `String`       | Template strings `` `hello` ``               | Owned UTF-8, reference-counted         |
| `comptime_str` | `"hello"` inside `comptime` functions/macros | Compile-time only, distinct from `str` |

Key rules:

- In **runtime** code, `"hello"` is always `str`. Mixing literal and variable branches in `cond`/`match` works fine.
- In **comptime** functions (return type `comptime(...)`), `"hello"` is `comptime_str`. It does NOT auto-convert to `str`. A comptime function returning `str` materializes its `comptime_str` result automatically.
- For `String` constants, prefer `` `hello` `` over `String.from("hello")`.
- **PITFALL:** Never write `String.from(`hello`)` — backtick strings are already `String`, not `str`. `String.from` takes `str`, so wrapping a backtick in `String.from` causes a type error ("Cannot unify String and str"). Only use `String.from(str_expr)` for actual `str` values.

## Import patterns

```rust
{ LocalType } :: import("./local_type.yo");
open(import("std/string"));
{ ArrayList } :: import("std/collections/array_list");
{ HashMap } :: import("std/collections/hash_map");
{ Url } :: import("std/url");
{ Regex } :: import("std/regex");
{ fetch, HttpRequest } :: import("std/http");
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
open(import("std/string"));

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

### Match destructuring: prefer curly `{field}`, avoid positional `_` padding

For a variant with **2+ fields**, destructure by **name** with curly braces —
name only the fields the arm uses. Do NOT count positions and pad with `_`.

```rust
// ✅ Curly — names only what you need; order-free; partial matches OK.
//    Robust: adding a field to the variant later doesn't shift anything.
match(v,
  .FuncVal({ func_id }) => use(func_id),          // bind field `func_id`
  .Struct({ id, name: n }) => use2(id, n),        // rename via `field: alias`
  .EnumT({ id }) => use3(id),                     // ignore the other 6 fields
  _ => ()
)

// ❌ Avoid — positional with many `_`; brittle and unreadable:
//    .FuncVal(_, _, _, _, _, _, _, _, func_id) => …   // count the 8 _'s!
```

`{a}` = bind field `a`; `{a: x}` = rename to `x`; `{a: _}` = assert-exists-ignore.
Empty `{}` and bare `{_}` are rejected. Spec: `tests/match_curly.test.yo`.
(Full rules: `.github/instructions/yo-syntax.instructions.md` § Match
destructuring forms.)

## Collections

```rust
{ ArrayList } :: import("std/collections/array_list");
{ HashMap } :: import("std/collections/hash_map");
open(import("std/string"));

numbers := ArrayList(i32).new();
numbers.push(i32(1));
numbers.push(i32(2));

// Index via call syntax (Index trait) — returns the value directly:
first := numbers(usize(0));  // → i32  (value)

// Mutate in place — direct assignment syntax:
numbers(usize(0)) = i32(99);

// When you need the pointer explicitly:
ptr := &(numbers(usize(0)));  // → *(i32)
ptr.* = i32(100);

// Safe access:
match(numbers.get(usize(0)),
  .Some(v) => println(`${v}`),
  .None => ()
);

// Do NOT write the verbose forms when X(i) works:
//   ✗ (&(numbers)).index(usize(0)).* = i32(99);   // needs pragma, scans as raw-ptr code
//   ✗ v := numbers.get(usize(0)).unwrap();        // panic-on-OOB anyway — just use call syntax
// ✓ numbers(usize(0)) = i32(99);
// ✓ v := numbers(usize(0));

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
  next : (fn(inout(self) : Self) -> Option(Self.Item))
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
- Model nullable pointers as `Option(*(T))` or `?(*(T))`, not sentinel integers
- Constructor syntax: `Box(T)(value)` — NOT `Box(T).new(value)`
- Single-payload reference-semantics values may use `(*) : T`; access the payload with `value.*`.
  This is a value payload accessor for reference-semantics values, while pointer dereference
  still applies when the receiver has pointer type.
- For self-referential `ref(struct(...))` / `ref(enum(...))` types, use a DIRECT `Self` field —
  NO `Box(Self)` needed. A reference-semantics value is already a heap pointer, so the
  recursion terminates at the handle. (`Box(Self)` is only for self-referential VALUE
  `struct(...)` / `enum(...)` types, where it breaks the recursive cycle.)

```rust
Node :: ref(struct(
  value : i32,
  next  : Option(Self)   // direct Self — the ref handle is already a pointer
));

n := Node(value: i32(1), next: Option(Node).None);
child := Node(value: i32(2), next: Option(Node).None);
parent := Node(value: i32(1), next: Option(Node).Some(child));
```

## Unicode and platform checks

```rust
{ Platform, platform } :: import("std/process");

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

TcpStream :: ref(struct(fd : i32, buffer : ArrayList(u8)));
```

| Keyword                                               | Semantics                                      |
| ----------------------------------------------------- | ---------------------------------------------- |
| `struct(...)`                                         | Value type, copied on assignment               |
| `newtype(...)`                                        | Single-field value wrapper                     |
| `ref(struct(...))`                                    | Reference-counted struct, shared on assignment |
| `ref(enum(...))`                                      | Reference-counted enum, shared on assignment   |
| `atomic(ref(struct(...)))` / `atomic(ref(enum(...)))` | Atomic RC (cross-thread sharing)               |

- Use `newtype(...)` when the type has exactly one field
- Use `ref(struct(...))` / `ref(enum(...))` for types that need shared ownership (`atomic(ref(...))` for atomic RC)
- **Parameter form by type kind:**
  - `ref(struct(...))` / `ref(enum(...))`: plain `name : Type` (reference semantics — no pointer or inout needed).
    `foo :: (fn(ctx : EvalContext) -> unit)(ctx.do_stuff());`
  - `struct(...)` / `enum(...)` / primitive, read-only: plain `name : Type`.
  - `struct(...)` / `enum(...)` / primitive, need mutation: `inout(name) : Type`.
    `swap :: (fn(inout(a) : i32, inout(b) : i32) -> unit)(...);`
  - Method receiver on `ref(struct(...))` / `ref(enum(...))`: plain `self : Self`.
  - Method receiver on value type (traits + inherent mutators): `inout(self) : Self`.
  - Raw FFI pointer: `name : *(T)` (requires `pragma(Pragma.AllowUnsafe);`).
- Source-file imports are namespace structs. The old `module(...)`, `Module`,
  and `SelfModule` syntax is gone; use `struct(...)`, `Type`, and normal `Self`.
- Fields written as `name :: value` or `comptime(name) : Type` are compile-time-only static fields/methods and have no runtime layout
- A normal field with a compile-time-only type, such as `x : comptime_int`, is still a data field and makes the struct comptime-only

## Impl blocks and generics

```rust
impl(Point,
  distance : (fn(self : Self, other : Point) -> f64)({
    dx := f64((self.x - other.x));
    dy := f64((self.y - other.y));
    sqrt(((dx * dx) + (dy * dy)))
  })
);

impl(generic(T), where(T <: ToString), Box(T),
  show : (fn(self : Self) -> unit)(
    println(self.*)
  )
);
```

- Use `Self` inside impl method signatures
- Use `Self` inside `struct(...)`, `ref(struct(...))`, `ref(enum(...))`, `enum(...)` definitions for recursive type references (the type name is not yet available during its own definition)
- `Self` also works inside generic type constructors — it refers to the current instantiation (e.g., `Tree(T)` inside `Tree`). Use `recur(args)` only when the type arguments differ from the current instantiation.
- `generic(T)` + `where(T <: Trait)` for generic impls
- Trait impls: `impl(MyType, MyTrait(args), : trait_field_bindings...)`

### Overloading: functions NO, inherent methods NO (policy), trait YES

Function overloading does not exist (Rust stance,
plans/FUNCTION_OVERLOADING_POLICY.md): rebinding a name is rejected
everywhere, and an exported `Call` tuple of ≥2 candidates (an overload set)
is rejected outside std/prelude.yo — the prelude's runtime/comptime operator
pairs (`Call :: (neg, comptime_neg)`) are the ONLY sanctioned overload sets.
A single-function `Call` (callable module) is fine. Duplicate same-name
inherent methods are disallowed as POLICY but not yet enforced — today the
compiler silently accepts them (same signature: first wins; different arity:
both dispatch) — so never rely on it either way
(issues/duplicate-inherent-method-impls-not-rejected.md). But
**trait-provided methods may share a name** with an inherent
method and with same-name methods from other traits; dispatch picks by
argument types. This is how std gives `String` both `contains(String)`
(inherent) and `contains(str)` (via the `StrPattern` trait), and both
`Eq(String)` and `Eq(str)` `(==)` overloads:

```rust
PickStr :: trait(pick : (fn(self : Self, x : str) -> i32));
impl(V, pick : (fn(self : Self, x : V) -> i32)(i32(1)));        // inherent
impl(V, PickStr(pick : (fn(self : Self, x : str) -> i32)(i32(2))));
v.pick(v);    // 1 — inherent overload
v.pick("s");  // 2 — trait overload, chosen by argument type
```

- Heterogeneous parametric-trait impls work: `impl(String, Eq(str)(...))`
  beside `impl(String, Eq(String)(...))`; `x == "lit"` dispatches by RHS type.
- Provide only `(==)`; `(!=)` comes from the `Eq` trait's `?=` default and
  resolves to the right overload by argument types.

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

### ⚠️ Circular derive trap: recursive enum with `ArrayList`

`derive(T, Eq)` and `derive(T, Clone)` fail when any field's type requires the derived trait to be already registered:

```rust
// PROBLEM: derive expansion generates `fields_l == fields_r` (ArrayList(Node) needs
// Eq(Node)), but Eq(Node) isn't registered yet — compile error.
Node :: enum(Leaf, Branch(children : ArrayList(Self)));
derive(Node, Eq);  // ← ERROR: "No matching call found for __lhs_children == __rhs_children"
```

**Fix**: skip `derive`, write a manual recursive equality function with `recur`:

```rust
node_eq :: (fn(a : Node, b : Node) -> bool)(
  match(a,
    .Leaf => match(b, .Leaf => true, _ => false),
    .Branch(acs) =>
      match(b,
        .Branch(bcs) => {
          cond(
            (acs.len() != bcs.len()) => false,
            true => {
              (i : usize) = usize(0);
              (ok : bool) = true;
              while(((i < acs.len()) && ok), {
                match(acs.get(i),
                  .Some(ac) => match(bcs.get(i),
                    .Some(bc) => { ok = recur(ac, bc); },
                    .None     => { ok = false; }
                  ),
                  .None => { ok = false; }
                );
                i = (i + usize(1));
              });
              ok
            }
          )
        },
        _ => false
      )
  )
);

impl(Node, Eq(Node)(
  (==) : (fn(a : Self, b : Self) -> bool)(node_eq(a, b))
));
```

Same issue applies to `Clone` when fields contain `ArrayList(Self)`.
Yo's reference counting handles shallow copies automatically (no `Clone` trait call needed);
the `Clone` trait is only for deep cloning and has the same circularity problem.
In practice, passing `EvalValue`-like types by value works fine without a `Clone` impl.

### Comparing complex enum types

Complex enum types (structs/enums with nested fields) do not support `==`/`!=` unless `Eq` is
derived or implemented. For **tag-only equality** (checking which variant), use a tag function:

```rust
// WRONG — TypeValue enum doesn't support !=
if(my_type != t_unit(), { ... });

// CORRECT — compare tags instead
{ type_value_tag } :: import("../../types/type.yo");
{ TypeTag }        :: import("../../types/tags.yo");
if((type_value_tag(my_type) != TypeTag.TUnit), { ... });
```

## Error handling

```rust
open(import("std/error"));

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
  i := usize(0);
  while(i < values.len(), {
    values(i) = f(values(i));
    i = (i + usize(1));
  });
});
```

- `(params) => expr` creates a closure
- `Impl(Fn(params) -> ReturnType)` is the closure type
- Closures capture: value types by copy, reference-semantics types by reference
- Each closure has a unique type

## Iterator and for loop

```rust
{ ArrayList } :: import("std/collections/array_list");

list := ArrayList(i32).new();
list.push(i32(1));
list.push(i32(2));

// Value form — implicit .into_iter(). The only form.
for(list, (value) => {
  println(value);
});

// In-place element mutation: index writes.
i := usize(0);
while(i < list.len(), {
  list(i) = (list(i) + i32(10));
  i = (i + usize(1));
});
```

| Form                          | Expansion                                 | When to use                                                                 |
| ----------------------------- | ----------------------------------------- | --------------------------------------------------------------------------- |
| `for(coll, (x) => …)`         | `coll.into_iter()`, yields `T` by value   | All iteration; reference-semantics elements are handles and mutate in place |
| index loop + `coll(i) = v`    | Index trait read/write                    | In-place struct/scalar element mutation                                     |
| `for(chain.map(f), (x) => …)` | Treats chain as the iterator (value form) | Computed values                                                             |

- The borrow form `for(coll, ref(x) => …)` was REMOVED (v4, plans/archive/BORROW_EXCLUSIVITY.md — no interior refs); it emits a teaching compile error.
- `Iterator` trait — defines `next() -> Option(Item)`. Custom iterables impl this.
- `IntoIterator` trait — defines `into_iter() -> IntoIter`. Collections impl this so `for(coll, ...)` works.

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

## yo-self API: String vs str parameter gotchas

Several `src/` APIs take `String` (not `str`) parameters even when the argument is conceptually a name:

- `get_variables_from_env(env, name: String)` — pass the `String` directly
- Most other env/value/type lookup functions follow the same convention
- (`as_str()` no longer exists — heap Strings can never become `str`.)

```rust
// ✅ Pass the String directly
vars := get_variables_from_env(env, prop_name_su);
```

String/str comparisons never need `as_str()` either (slice-rework step 2
swept all of them): `token.value == "fn"`, `name != other_string`, and
`"lit" == x` all dispatch directly via the heterogeneous `Eq(str)`/
`Eq(String)` impls. `as_str()` itself is slated for deletion
(plans/archive/SLICE_REWORK.md) — do not introduce new calls to it.

## `unwind` in a swallow handler SKIPS the restore code after the guarded call

`unwind(...)` discards the continuation and exits the **enclosing `fn`**. So when
you wrap a call in a swallowing exception handler, every statement after that call —
including `save`/`restore` of mutable state — is skipped on the failure path.

```rust
// ❌ BROKEN: on a swallowed error the restore never runs, and the flags stay set
// for the REST OF THE COMPILE.
_analyze :: (fn(..., ctx : EvalContext, exn : Exception) -> bool)({
  saved := ctx.some_flag;
  ctx.some_flag = true;
  r := evaluate_something(..., exn);   // <-- throws; handler unwinds past everything below
  ctx.some_flag = saved;               // <-- NEVER RUNS
  r
});
```

Fix: save and restore in the caller that the `unwind` lands in — `unwind` only
unwinds as far as the `fn` whose body contains the handler, so code after _that_
call always runs.

```rust
// ✅ the restore is OUTSIDE the unwind target
saved := ctx.some_flag;
_try_analyze_swallowing(..., ctx, out);   // handler's unwind exits THIS helper
ctx.some_flag = saved;                    // always runs
```

**Why this matters:** the leak is invisible in isolation and only shows up when
something else is compiled afterwards. Measured 2026-08-05: a leaked
`is_analyzing_ctfe_capability` turned `tests/fn.test.yo` HOLLOW (its `main` failed
to transpile so it reported "24 passed" while running nothing) even though all 24
tests passed individually, and every single-file repro was clean. See
`issues/yo-self-ctfe-nested-fn-analysis-gap.md`.

Corollary: adding a swallow handler to existing code is NOT behaviour-preserving.
Code whose errors previously propagated (aborting compilation, so leaked state never
mattered) starts leaking the moment you swallow.
