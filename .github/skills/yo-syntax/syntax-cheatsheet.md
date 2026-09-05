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

**`yo fmt` is not a syntax gate for this.** It parses `{ single_expr }` happily as a struct literal and pretty-prints it, so a `yo fmt` that says "Formatted 1 Yo file(s)" tells you nothing about whether you wrote the block you meant. Measured 2026-08-25: an `if(cond, { single_expr }, other)` passed `yo fmt` and then failed `yo check` with exactly that struct-literal error. **Run `yo check <file>` on every file you edit — and pass `YO_STD=<worktree>/std` when working in a worktree**, or `check` silently validates against the INSTALLED std instead of yours.

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
- `if(a, b)` and `if(a, b, c)` are sugar over `cond` (desugared at parse time; the prelude macro remains as spec/fallback)
- **The operator set is CLOSED** (plans/reference/OPERATOR_SET_AND_PRECEDENCE.md): operator-char runs split greedily against a fixed table (`src/lexer.yo`), so `**x` = `*`,`*`,`x` (no `**` token — `Exponentiation` is the word method `pow`), and an unknown run (`@@`) is a lex error. Reserved (never bindable/overloadable): `= := :: : => -> <: ?= && || # ...#` and ranges. The retired pointer-arithmetic operators (`&+`/`&-`/`&/`) are NOT tokens any more — use `.add`/`.sub`.
- Defining a macro (`quote(...)` param / `unquote(...)` return) needs `pragma(Pragma.AllowMacroDef);` at the top of the file; CALLING macros needs nothing. The std `try` macro was removed — match on the `Result` instead.
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

| Syntax             | Type           | Context                          |
| ------------------ | -------------- | -------------------------------- |
| `"hello"`          | `str`          | Runtime contexts (most code)     |
| `"hello"`          | `comptime_str` | Inside `comptime` functions      |
| `` `hello ${x}` `` | `String`       | Always (template string)         |
| `` `hello` ``      | `String`       | Always (template without interp) |
| `*(u8)("hello")`   | `*(u8)`        | Pointer cast for C interop       |

Key rules:

- In **runtime** code, `"hello"` is `str`. Mixing literals and variables in `cond`/`match` branches is fine.
- In **comptime** functions (return type `comptime(...)`), `"hello"` is `comptime_str` — it does NOT auto-convert to `str`.
- For `String` constants, prefer `` `hello` `` over `String.from("hello")`.
- **`String.from(`` `...` ``)` is WRONG**: `` `...` `` is already `String`; `String.from` takes `str`. Use `` `...` `` directly or `String.from("...")` with double quotes.
- **A double-quoted literal does NOT concatenate with a `String` variable**: `"prefix " + var` fails with `Cannot unify incompatible types: "String" and "comptime_str"`. For a runtime concat starting from a literal, write `String.from("prefix ") + var` (measured 2026-09-02).
- **A template string may NOT contain another template string inside `${…}`.** Writing an inner `` ` ``-string in an interpolation hole is rejected, and the diagnostic is actively misleading: `error[E0403]: Module field "to_string" not found in module type` pointing at **line 1, column 1** of the file (the first `import`), naming neither the construct nor the real line — the inner backtick terminates the outer literal at the lexer level. Hoist the inner value into a local first (`inner := f(...);` then interpolate `inner`). Measured 2026-09-05; filed as `issues/template-string-nested-inside-an-interpolation-fails-to-parse.md` (sibling of the backslash-before-`${…}` bug).
- **`assert`/`panic` require an explicit import**: `{ assert, panic } :: import("std/assert");` — they are NOT prelude-ambient. Both are generic over `where(T <: ToString)`, so `str`, `String` (template strings), integers, etc. all work as messages: `assert(cond, `got ${x}`)`. `assert(cond)` uses the default message.
- **`__yo_panic` is the diverging builtin** (message must be `str`/`comptime_str`/`*(u8)`). Use it (not `panic`) in VALUE-position match/cond arms — e.g. `.None => __yo_panic("...")` in an arm that must yield `T` — because `std/assert`'s `panic` is a normal fn returning `unit` and cannot adopt the sibling arm's type. Statement-position `panic("...")` from `std/assert` is fine.
- Low-level std modules inside `std/assert`'s own dependency cycle (`std/string/string.yo`, `std/collections/array_list.yo`, …) cannot import it — they use `cond`/`if` + `__yo_panic` directly.
- **`__yo_panic` takes the ENCLOSING FUNCTION's return type, so it cannot sit beside a `()` arm as a guard statement.** In a `fn(...) -> u64`, `cond(bad => __yo_panic("…"), true => ());` fails with `Incompatible types: u64 / unit` (and the other order fails the other way). Make the panic the cond's VALUE instead — wrap the real body in the `true =>` arm: `cond(bad => __yo_panic("…"), true => { …body…; result })` — exactly how `ArrayList.with_capacity` guards its overflow (`std/rand.yo`'s `next_below`/`range` are the 2026-09-06 examples).
- **No mid-body `return(...)` inside an `io.async` body.** A `return` nested in a `while`/`cond` arm of an `io.async(e => { … })` body is not lowered by the async state machine: `check` stays clean, and `compile` dies at codegen with `internal compiler error: … this io.async closure's body was never fully evaluated`. A `return(x)` as the body's LAST statement is fine. Record the outcome in a local (`failed := i32(0); … failed = i32(2); done = true;`), let the loop end, and produce the value in the tail expression (`std/http/wire.yo`'s `read_http_message`, 2026-09-06). The same body used `e.exn.throw(...)` at those spots before, which is why throwing worked and returning did not.

## Calls, operators, and whitespace

```rust
sum := add(i32(1), i32(2));
flag := ((a > b) && (b > c));
masked := ((A | B) | C);
```

- Calls require immediate parentheses: `func(arg1, arg2)`
- `func arg1, arg2` and `func (arg1, arg2)` are invalid
- Yo has no operator precedence: a chain of the SAME operator left-associates (`a + b + c` ⇒ `(a + b) + c`, no parens needed); adjacent DIFFERENT operators require parentheses (`(a + b) * c`, not `a + b * c`)
- An operator RHS that itself contains a different top-level operator must be parenthesized: `true => (x / y)`, `value := (x + y)`, `(x : T) = ((v) -> { ... })`, `next : (fn(...) -> T)`
- The rule also applies on the LEFT of a `cond` arm's `=>`: a same-operator chain like `a || b || c` is fine alone, but `a || b || c => v` mixes `||` with `=>` — wrap the whole condition: `(a || b || c) => v` ("Adjacent different operators need parentheses")
- `yo fmt` canonicalizes the redundant set (plans/archive/FMT_PAREN_ELISION.md): prefix calls go bare (`-x`, `!flag`, `?*T`), atom-operand and left same-op groups elide (`(x) + (y)` → `x + y`, `(a + b) + c` → `a + b + c`), whole call arguments unwrap (`f((a + b))` → `f(a + b)`); a re-parse AST-equality gate backstops every elision. An operator's infix RHS keeps its group (`y := (1 + 2)`), as do mixed-operator and right-operand groups
- …and on the RIGHT of an arm's `=>` too, in BOTH `cond` and `match`. An arm body that is a bare infix expression mixes the operator with `=>`: `.Some(qv) => qv != u8(34)` is rejected, `.Some(qv) => (qv != u8(34))` is accepted. Same for `+`, `==`, `&&`, … in arm-body position. The SAME applies to a CLOSURE's `=>`: `(m) => a + b` is rejected — wrap the whole body: `(m) => ((a + b) + c)` (even a same-operator chain needs the outer wrap when `=>` is the adjacent operator; measured 2026-09-02).
- **`yo fmt` does NOT catch either form.** `yo fmt` and `yo fmt --check` both pass on the unparenthesised version; only the evaluator rejects it. A clean `fmt` is not evidence the file parses — run `yo check` on the file after editing arms.
- Source layout does NOT affect grouping — there is no newline-based associativity
- Prefix operators (`-` `!` `~` `&` `*` `?` `^`) bind ONE postfix expression (plans/reference/PREFIX_OPERATOR_OPERAND_RULE.md): `-1`, `!ready`, `&s`, `?*T`, `3 - -3` are valid; an INFIX operand still needs parens (`-(1 + 2)`). SEED CONSTRAINT: keep parenthesized forms (`-(1)`, `!(x)`) in `src/` and `std/` until a rule-bearing release becomes the seed.
- Tight special forms also require immediate parentheses: `#(expr)`, `?(*(u8))`, `T <: !(Runtime)`
- **Don't write unnecessary parens** — commas already delimit call args: `if(x == y, ...)`, `assert(a == b, "msg")`, NOT `if((x == y), ...)`. Parens stay where grammar needs them: infix arm conditions `(x == y) => a`, mixed-op chains `(a + b) * c`, struct fields `{ x : (1 + 2) }`, prefix INFIX operands `-(1 + 2)`. Bare-primary prefix operands need none (`-1`/`!x`/`?*T` — Rule 1 landed 2026-08-21; src/ and std/ keep parens until the seed catches up). `yo fmt` preserves whatever you write — it never removes parens.
- Dynamic field access with unquote must keep grouping after the dot: `value.(#(field_expr))`, not `value.#(field_expr)`.
- Unquote splicing is the tight operator `...#(exprs)`; do not insert a space between `...` and `#`.
- Canonical pointer dereference is `ptr.*`; formatter should canonicalize legacy `ptr.(*)` to `ptr.*`.
- **Pointer comparison is plain `==`/`<`/… (Eq/Ord impls on `*(T)`, address identity); pointer arithmetic is METHODS**: `p.add(n)` / `p.sub(n)` (offset by `usize` elements), `p.offset_from(q)` (signed element distance, `isize`). All lower to the `__yo_ptr_*` builtins via the generic prelude impls. Comparisons are safe (no `unsafe(...)`); arithmetic methods require `unsafe(...)` — e.g. `unsafe(p.add(usize(1)))`. NOTE the identity-vs-value split: `*(T) ==` compares ADDRESSES, while reference-semantics types (`ref(struct(...))`) compare VALUES via their own `Eq` impls (same split as Rust's `Rc` `==` vs `Rc::ptr_eq`).
- **Pointer deref (`p.*`), arithmetic (`.add(n)`, `.sub(n)`, `.offset_from(q)`), and `consume(p.* = v)` require `unsafe(...)`, AND the file must declare `pragma(Pragma.AllowUnsafe);` at the top before `unsafe(...)` is usable.** Pointer comparison (`==`, `<`, etc.) and pointer-type casts (`*(u8)(p)`) stay safe. `unsafe(expr)` is a one-arg builtin call: `v := unsafe(p.*);`, `unsafe(p.* = i32(5));`, `unsafe(p.add(usize(1)))`. Every file in `std/`, `src/`, and `tests/` declares the pragma explicitly. User code (default) does not, so attempts to use `unsafe(...)` are rejected with a hint to add the pragma. See `plans/reference/MEMORY_SAFETY.md`.
- **In-place mutation without raw pointers:** use the `inout(name) : T` parameter modifier (parallel to `own(name)`). `swap :: (fn(inout(a) : i32, inout(b) : i32) -> unit)({ tmp := a; a = b; b = tmp; });` — caller writes `swap(x, y)` with no `&()` syntax. The compiler lowers `inout(name) : T` to `T*` in C and inserts `&(arg)` at the call site automatically. Cannot combine with `own(...)` or with `generic`/`using` (those are erased at runtime — no binding to mutate). CAN combine with `comptime` as `comptime(inout(name)) : T` — the parameter is erased at runtime and mutations propagate via the evaluator's compile-time binding update path (used by prelude `ComptimeIndex`). See `plans/reference/MEMORY_SAFETY.md` Phase B.
- **Reference-semantics-type params:** use plain `name : Type`, NOT `*(Type)` or `inout(name) : Type`. Reference-semantics types — `ref(struct(...))` / `ref(enum(...))` (and `atomic(ref(...))`) — such as `Environment`, `EvalContext`, `Emitter`, `HashMap`, `ArrayList`, … carry reference semantics: passing by name already shares the underlying RC state, so mutations through the param propagate to the caller. `*(Type)` requires `pragma(Pragma.AllowUnsafe);` for the `.* ` derefs and clutters the API; `inout(name) : Type` is redundant since reference semantics already share state. Use the plain form: `foo :: (fn(ctx : EvalContext) -> unit)(ctx.method());`. The same applies at call sites — don't wrap reference-semantics arguments with `&(obj)`; just pass `obj`. For receivers on reference-semantics methods, plain `self : Self` is the idiom (`src/env.yo` and `src/emitter.yo` both follow this). `inout(self) : Self` is reserved for receivers on value-type methods (the form used by `Hash`, `Clone`, `ToString`, `Index`, `ComptimeIndex`, `Writer`, `Reader`).
- **Byte-buffer params:** for SAFE public signatures use owned collections (`ArrayList(u8)`/`String`). For pragma'd internals/FFI, `RawSlice(u8)` carries ptr+len (construct with `RawSlice(u8)(ptr : &(buf(0)), len : n)`; read `.ptr`/`.len` fields). The `_cstr` family is the explicit raw-pointer variant — those names signal raw-pointer use by contract.
- **Audit public stdlib safety with `yo public-safe-report [path]`.** Flags every top-level public `fn(...)` whose params or return type expose `*(T)` outside an `extern(...)` block. Skips FFI-by-construction directories (`libc/`, `linux/`, `darwin/`, `cuda/`, `sys/`, `sync/`) and names that signal raw-pointer use by contract (`*_cstr`, `*_ptr`, `*_raw`, `raw_*`, `from_raw_parts`, `as_ptr`, `argv`, `argc`). Currently reports 0 findings on `./std` and `./src`; keep it that way when adding new APIs.
- **Extern "c" call sites require `unsafe(...)` even in pragma'd files.** `unsafe(memcpy(dst, src, n))`, `unsafe(strlen(s))`, etc. The pragma authorizes DECLARING the FFI symbol via `extern(...)` / `c_include(...)`; the wrap is the per-call audit marker so `yo unsafe-report` lines up with UB-capable lines. `asm(...)` and `extern(...)` / `c_include(...)` declarations themselves do NOT need a wrap (the keyword / declaration syntax is its own marker). See `plans/archive/EXTERN_UNSAFE_WRAP.md`.
- **A `c_include` opaque type is emitted by its bare name — a C `struct` tag is NOT added.** `tm : Type` from `<time.h>` renders as `tm*` in the C, which clang rejects (`must use 'struct' tag to refer to type 'tm'`); the same holds for any struct-tagged libc type (`std/libc/sys/stat.yo` already notes it for `stat`). Pass such objects as `*(void)` — declare the binding's pointer parameters/returns as `*(void)` and cast the buffer with `(*(void))(&buf(usize(0)))`; C converts `void*` to and from `struct tm*` implicitly. Do not declare a prototype-conflicting signature for a name the header already declares (`std/libc/time.yo`'s `localtime_r`, 2026-09-06).
- **`extern("Yo", …)` runtime symbols come from DIFFERENT preambles, and not all are always emitted.** `__yo_get_thread_id` is defined in the ASYNC runtime core (`src/codegen/async/runtime_core.yo`), which a program without `io` never emits — std code that calls it makes every such program fail to link (`undefined symbol`, after an `implicit-function-declaration` warning). For thread identity in std use `__yo_thread_self()` (a macro in the always-present threading preamble, `src/codegen/types/generation.yo`), declared as `__yo_thread_self : (fn() -> usize)`. Before leaning on any `__yo_*` runtime function from std, `grep -rn "static .*NAME" src/codegen/` and check WHICH preamble defines it and when that preamble is emitted; then compile a probe whose `main` has NO `io` (`std/thread.yo`, 2026-09-06).
- **Static-str model (post slice-rework):** builtin `Slice(T)`, `as_str()`, `as_slice()` are DELETED. `str` = static string view (no flow constraints); ranges COPY (`arr(a..b)` → ArrayList, String range → String, str range → str window); safe windows = `ListView(T)`; pragma'd ptr+len = `RawSlice(T)` (naming any raw-ptr-carrying type in an annotation requires the pragma). See `docs/en-US/FLOWABILITY.md`.
- **KNOWN MISCOMPILE — a trait method carrying its own `generic(...)` reads a PRIMITIVE `inout(self)` as a POINTER (OPEN, 2026-08-25).** `g : (fn(generic(S : Type), inout(self) : Self, dummy : S) -> u64)(u64(self))` on `i32` returns the receiver's ADDRESS, not `42`. Silent — no diagnostic, no crash, and `-Wint-conversion` cannot see it because the emitted cast is explicit (`(uint64_t)(self)` where `(*self)` is meant). Needs all three of: the method's own `generic(...)`, an `inout(self)` receiver, and a primitive receiver type — a STRUCT receiver reads its fields correctly, and a by-value `self` is fine. Until it is fixed, write such a method with a by-value `self`, or keep the receiver a struct. `issues/generic-trait-method-reads-primitive-inout-self-as-pointer.md` (reproducer under `issues/repros/`).
- **`inout` is PARAMETER-ONLY (v4.1, plans/archive/BORROW_EXCLUSIVITY.md).** `-> inout(T)`, `-> (inout(name) : T)`, `-> (name : inout(T))` AND the local binding form `inout(r) := lvalue` are all rejected (both compilers, teaching errors). They exist ONLY as `inout(name) : T` parameters. Migrations: return the value (reference-semantics values are handles that mutate in place; struct values copy); read/write fields directly (`h.s = v`); bind the handle (`b := a.b`) to keep a reference-semantics value alive; or take a callback parameter receiving `inout(v) : T` (`Mutex.with_lock` pattern). An inout ARGUMENT is a simple lvalue place: a variable, or `var.field` rooted at a local/param — intermediate reference-semantics-value hops and module-level field roots are rejected (bind to a local first). `comptime` return modifiers go on the LABEL when labeled: `-> comptime(T)` / `-> (comptime(name) : T)` valid; `-> (name : comptime(T))` rejected. See `tests/ref_return_ban.test.yo`, `tests/ref_local_binding.test.yo`, `tests/ref_field_borrow.test.yo`.
- **Signed-integer overflow is defined (wrap-around) at RUNTIME, but REJECTED at comptime.** Yo passes `-fwrapv` to clang/gcc/zig by default so `x + i32(1)` on a runtime `x = i32(MAX)` wraps to `i32(MIN)` instead of UB (opt-out: `--cflags='-fno-wrapv'`). Written as a folded constant, `(i32(2147483647) + i32(1))` picks the `Comptime*` overload and hard-errors with "Integer overflow in compile-time evaluation". So a wrap-around test must build its EXPECTED value from a runtime binding too: `(seed : i32) = i32(2147483647); (expected : i32) = (seed + i32(1));`.
- **`// SAFETY:` comment convention.** Every non-obvious `unsafe(...)` site in stdlib should have a `// SAFETY:` comment in the previous ~8 lines explaining the contract. `yo unsafe-report` picks them up and shows them inline under each finding.
- **User-facing memory-safety guide:** `docs/en-US/MEMORY_SAFETY.md` (English) and `docs/zh-CN/MEMORY_SAFETY.md` (Chinese). Refer users there instead of `plans/reference/MEMORY_SAFETY.md` (which is the design document — not shipped via npm).
- Keep single-line array and tuple literals compact during formatting: `[1, 2, 3]`, `(1, 2, 3)`.
- Bare prefix operators bind ONE postfix expression (Rule 1, plans/reference/PREFIX_OPERATOR_OPERAND_RULE.md, 2026-08-21): `-1`, `!ready`, `&v`, `?*u8`, `3 - -3` are valid and preferred in NEW user code; an INFIX operand still needs parens (`-(1 + 2)`). **Seed constraint: `src/` and `std/` keep the call forms (`!(x)`, `-(value)`) until a release with the rule becomes the seed.**
- **`!x && y` groups as `(!x) && y`** — the prefix op binds only one postfix expression. Unary and infix are different operators (no precedence), so write the other intent as `!(x && y)` (= `NOT (x AND y)`).

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
- **Module-level `::` definitions and `impl(...)` registrations are order-independent** (`docs/en-US/DEFINITION_ORDER.md`; see "Definition order" below for what stays ordered and the SEED GATE that still binds `std/` and `src/`). Sibling methods inside one `impl` block reference each other through `self.method()` / `Self.method(...)`, never by bare name.

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
  i := usize(0);
  while(i < list.len(), {
    list(i) = f(list(i));
    i = (i + usize(1));
  });
});
```

- `(params) => expr` — lambda / closure syntax
- `Impl(Fn(params) -> ReturnType)` — STATIC closure type: monomorphized, capture struct passed BY VALUE, direct call, no heap allocation / vtable / refcount on the closure itself
- `Dyn(Fn(params) -> ReturnType)` — TYPE-ERASED closure type: capture struct heap-boxed behind a refcount header, called through a `{data, vtable}` fat pointer. Wrap the value with `dyn(...)`: `(f : Dyn(Fn(y : i32) -> i32)) = dyn((y) => (y + 1));`
- Value types are captured by copy; reference-semantics types by reference. In BOTH forms the captured value is what carries the refcount — the `Impl` closure itself has none
- Each closure has a unique anonymous type, so one `Impl(Fn(...))` variable cannot hold two different closures. Use `Dyn(Fn(...))` to store heterogeneous closures in one variable, field or collection
- `Impl(Fn(...))` is REJECTED as a struct/enum/union field type (capture-dependent size — the error names `Dyn(Fn(...))` as the fix). Either use `Dyn(Fn(...))`, or make the containing type generic over the closure type: `MyStruct :: (fn(comptime(F) : Type) -> comptime(Type))(struct(cb : F));`

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

Curly `{a, b: c}` is sugar for `(a: a, b: c)` — order-free, supports partial matches (omit fields). Use `{label: _}` to ignore a specific field. Bare `{_}` is rejected.

**Bind-nothing forms** (match a variant, ignore ALL its fields):

```rust
match(s,
  .Circle           => 0,   // bare `.Variant` — allowed even when it has fields
  .Rectangle({})    => 1    // empty curly — the zero case of partial curly
)
```

Both `.Variant` and `.Variant({})` mean "match this variant, bind none of its
fields" — use them instead of `.Variant(_, _, …)` when no field is needed.
They are NOT errors for multi-field variants (this is intentionally more
permissive than Rust). `tests/match_bind_nothing.test.yo` is the spec.

> **Critical**: Within a single match arm, you must use **either all positional or all named** field patterns. Mixing positional and named fields in the same arm (e.g., `.Foo(x, y: z, w)`) causes C codegen to emit undeclared identifiers for the named fields. This is a parser/codegen limitation — do not mix.

## Generics and compile-time

```rust
identity :: (fn(generic(T : Type), value : T) -> T)(value);

max :: (fn(comptime(a) : i32, comptime(b) : i32) -> comptime(i32))(
  cond((a > b) => a, true => b)
);

show :: (fn(generic(T : Type), value : T, where(T <: ToString)) -> unit)(
  println(value)
);
```

- `generic(T : Type)` introduces a generic type parameter
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
- **The parentheses are mandatory.** `export main;` is a syntax error — Yo has no
  paren-less calls, and `export` is an ordinary call, not a keyword form. The
  parser rejects it with "Paren-less function and operator calls are not
  supported. Use parentheses."

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

// for loop — 2-arg prelude macro iterating BY VALUE (implicit
// .into_iter()). Reference-semantics elements are handles: mutating
// them in the body mutates the element in place.
for(list, (x) => {
  process(x);
});
for(names, (s) => {
  s.push_str("!");            // String element mutated in place
});

// In-place struct/scalar element mutation: index loop + index writes.
i := usize(0);
while(i < list.len(), {
  list(i) = transform(list(i));
  i = (i + usize(1));
});

// Combinator chains (.map / .filter / .into_iter / etc.) yield
// computed values; pass them as the first arg:
for(list.into_iter().map((x) => (x + i32(1))), (y) => println(y));
```

- Use `recur(...)` for self-recursion
- `while(cond, body)` is **always a runtime loop** — use this for open-ended loops (e.g., server accept loops, event loops)
- `while(comptime(cond), body)` explicitly unrolls at compile time — `cond` must be a compile-time-known value
- Using a comptime-only (`::`) variable in a bare `while` condition without `comptime()` is a **compile error** (would be an infinite loop at runtime)
- **`for(coll, (x) => body)`** — the only form; macro expands to `coll.into_iter()` then iterates by value (`x : T`; a handle for reference-semantics element types).
- **The borrow form `for(coll, ref(x) => body)` was REMOVED** (v4, plans/archive/BORROW_EXCLUSIVITY.md — no interior refs); it emits a teaching compile error with the migration recipe.
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
// WRONG — str + str causes "comptime_str vs str" type unification error:
content := String.from("line1\n" + "line2\n");

// CORRECT — use .concat() on String objects:
content := String.from("line1\n").concat(String.from("line2\n"));

// Also CORRECT — single long string literal:
content := String.from("line1\nline2\n");
```

- `"hello" + "world"` at runtime uses `+` on `str` values, which can cause type mismatches
- The `str + str` operator can produce a `comptime_str` in some contexts, which is not always compatible with `str`
- Prefer `.concat()` method on `String` objects when building multi-part strings at runtime

## Iterator and for loop

```rust
{ ArrayList } :: import("std/collections/array_list");

list := ArrayList(i32).new();
list.push(i32(10));
list.push(i32(20));

// Value form — implicit .into_iter(). The only form.
for(list, (value) => {
  println(value);
});

// In-place element mutation: index writes (struct/scalar elements) or
// mutate the handle (reference-semantics elements).
i := usize(0);
while(i < list.len(), {
  list(i) = (list(i) + i32(1));
  i = (i + usize(1));
});
```

- `for(coll, (x) => body)` — macro expands to `coll.into_iter()` and yields elements by value (a handle for reference-semantics element types — mutating it mutates the element in place).
- The borrow form `for(coll, ref(x) => body)` was REMOVED (v4); it emits a teaching compile error.
- Combinator chains (`coll.into_iter().map(f).filter(g)`) work as the first arg with `(x) => body`.

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
- In a standalone program, get `io` by declaring it in `main`'s SIGNATURE —
  `main :: (fn(io : Io) -> unit)({ ... })` — codegen injects it automatically.
  `Io` is the ONLY effect parameter `main` may take (`fn(io : Io, exn : Exception)`
  is not a valid main shape). Do NOT write `io :: __yo_builtin_io` inside a fn body; that form is an
  internal mechanism of the batched test runner's synthesized programs only.
- `assert(condition, "message")` — runtime assertion; requires `{ assert } :: import("std/assert");` at the top of the test file
- `comptime_assert(condition)` — compile-time assertion (builtin, no import).
  **It fires wherever the condition folds to a CONCRETE `false`** — at module
  level and inside any function body (`main`, a called fn, a `comptime` fn, a
  `test("…", { … })` block) alike.
  When the condition is NOT comptime-decidable — a runtime value, or a generic
  body whose type parameters are still unbound — it only TYPE-CHECKS the
  argument and cannot fail. A `comptime_assert` over an unresolved generic is
  therefore still no gate; pin such a result with a **module-level `::` binding
  observed by a runtime `assert`** — the binding folds at comptime and the
  runtime assert sees what the folder produced:
  ```rust
  _DIV :: (u64.MAX / u64(2));            // folded at comptime
  test("…", { assert(_DIV == u64(9223372036854775807), `folded to ${_DIV}`); });
  ```
  Always verify a new test goes RED on a compiler without your fix; that is
  the only way to know the gate is real.
  Until 2026-09-05 `comptime_assert` was inert in EVERY function body, so all
  1559 of them under `tests/` verified nothing
  (issues/fixed/comptime-assert-never-fires-inside-a-function-body.md). The
  guard against a regression is the cli-case
  `tests/cli-cases/compile-comptime-assert-in-fn-body`.
- `comptime_expect_error(expr)` — verify code produces a compile error

## Design-by-contract clauses

`plans/backlog/FORMAL_VERIFICATION.md` Phase 0. No SMT verifier yet — these
lower to runtime `assert(...)` (runtime fns) or `comptime_assert(...)`
(comptime fns, returning `comptime(T)`).

```rust
// requires/ensures are SIGNATURE clauses, after params and where(...).
// ENFORCED order: generic, params, where, requires, ensures — a clause
// out of order is a syntax error ("X appears after Y").
divide :: (fn(x : i32, y : i32, requires(y != i32(0)), ensures(result == (x / y))) -> i32)(
  x / y
);

// Inside ensures: `result` = return value, old(expr) = entry-time value.
increment :: (fn(inout(n) : i32, ensures(n == (old(n) + i32(1)))) -> unit)({ n = (n + i32(1)); });

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
- **`short`, `long`, `int`, `char` cannot be used as variable names.** They are
  builtin type names, so `short := ...` fails with `Failed to define variable
"short"` — a message that points at the binding and says nothing about
  keywords, so it reads like a type-inference failure in the RHS and sends you
  debugging the wrong expression. Measured 2026-08-12: `short`/`long`/`int`/`char`
  are rejected; `float`, `double`, `signed`, `unsigned`, `register`, `volatile`
  are all fine. Rename the local (`truncated`, `count`, `ch`, …).

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

### `forall` / `exists` / `∀` / `∃` are RESERVED — the type binder is `generic`

The type-parameter binder is `generic(T : Type)`. `forall` was renamed to it
(`plans/archive/FORALL_TO_GENERIC.md`) so the quantifier words stay free for
Dafny-style verification, where they will bind VALUES with a predicate inside
`requires` / `ensures`. All four words are rejected at LEX time with a targeted
message (`src/lexer.yo`):

```
`forall` is reserved for verification quantifiers. Use `generic(T : Type)` to
declare type parameters.
```

```rust
// WRONG:
sum :: (fn(forall(T : Type), a : T, b : T) -> T)((a + b));

// CORRECT:
sum :: (fn(generic(T : Type), a : T, b : T) -> T)((a + b));
```

Note the INTERNAL identifiers (`forall_labels`, `forall_types`,
`forallParameters`, …) deliberately keep the old name in both compilers — they
are invisible to users and renaming them would churn the bootstrap fixpoint for
no gain.

### `type` is a reserved keyword — avoid as field/param name

```rust
// WRONG:
Variable :: ref(struct(name : String, type : TypeValue));

// CORRECT:
Variable :: ref(struct(name : String, ty : TypeValue));
```

### 1-element array literals require a trailing comma

`[expr]` without a trailing comma is **parsed as a slice-type form** (now an error — the builtin Slice type is deleted, so it surfaces "Variable \"Slice\" not found"), not an array literal. To create a 1-element array value, add a trailing comma:

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

### Named fields required for `struct`/`ref(struct(...))` constructors

```rust
Point :: struct(x : i32, y : i32);

// CORRECT:
p := Point(x: i32(1), y: i32(2));

// WRONG — positional not supported for struct/ref(struct(...)):
p := Point(i32(1), i32(2));
```

Enum variant construction is positional (no field names needed).

### Reference-semantics types (RC) are passed by value

`HashMap`, `ArrayList`, and other `ref(struct(...))` / `ref(enum(...))` types are reference-counted. Passing them by value shares the underlying data — mutations are visible to all holders.

```rust
// DO NOT use pointer params for RC reference-semantics values:
// WRONG: fn(m : *(HashMap(String, V))) — will cause greedy & issues at call site
// CORRECT: fn(m : HashMap(String, V)) — pass by value, mutations propagate via RC

process_map :: (fn(m : HashMap(String, i32)) -> unit)({
  m.insert(String.from("key"), i32(42));  // mutation visible to caller
});

counts := HashMap(String, i32).new();
process_map(counts);
// counts now has "key" => 42
```

### `String` out-parameters silently discard writes

`String` is a **value** type whose byte buffer is lazily allocated (`_bytes : .None` until the first push). A `String` parameter is therefore a COPY: pushing into it allocates the buffer *in the copy*, and the caller sees nothing — no error, no warning, just an empty string. This is the opposite of `ArrayList`/`HashMap`/`HashSet` (RC `ref` types), where mutations DO propagate, which makes it an easy trap when a function needs to return two strings.

```rust
// WRONG — caller's `hdr`/`body` stay EMPTY, silently:
split :: (fn(text : String, hdr_out : String, body_out : String) -> unit)({
  hdr_out.push_str("...");   // mutates a copy
  body_out.push_str("...");  // mutates a copy
});
hdr := String.new();
body := String.new();
split(src, hdr, body);       // hdr and body are still empty

// CORRECT — return a `ref` struct:
Split :: ref(struct(head_part : String, body_part : String));
split :: (fn(text : String) -> Split)({
  Split(head_part : h, body_part : b)
});

// ALSO CORRECT — collect into an RC container (mutations propagate):
collect :: (fn(text : String, out : ArrayList(String)) -> unit)({
  out.push(String.from("..."));
});
```

This cost a full debug cycle in the chunked-C-emission work: an entire emitter buffer was dropped from the output, and the only symptom was a far-downstream C error (`unknown type name`) in the generated code. If a function must fill several strings, return a `ref` struct — and remember that a `String` fetched back out of an `ArrayList(String)` is likewise a value copy, so mutating it does not update the stored element.

### Definition order: `::` definitions and `impl` registrations are order-independent (in `std/` and `src/` too, since the seed bump after v0.2.24)

Since 2026-09-05 (`docs/en-US/DEFINITION_ORDER.md`, `plans/reference/LAZY_TOPLEVEL_BINDINGS.md`) a module-level `name :: <definition>` may reference any other `::` definition of the same module regardless of position, and an `impl(T, ...)` may sit below the code that uses its methods or trait defaults. Bare-name self-recursion and mutual recursion between free functions work; `export(...)` may name a later definition.

```rust
// fine anywhere — tests/, std/ and src/ alike (the seed carries the feature since the first release after v0.2.24):
caller :: (fn() -> unit)({ helper(); });
helper :: (fn() -> unit)({ println("hi"); });
fact :: (fn(n : i32) -> i32)(cond((n <= 1) => 1, true => (n * fact(n - 1))));
```

One limit: from INSIDE an `impl(T, …)` block, a method defined in a LATER `impl(T, …)` block is still unreachable (misses on `T` while one of its impls is being evaluated are the in-block sibling case, never a force) — put methods that call each other in one block; free functions, generic bodies and other types' impls may use any later block.

What stays ORDERED (still "define before use"): imports (`{ a } :: import(...)`, `open(import(...))`), `pragma(...)`, module-level runtime globals (`x := v`, `(g : T) = v`), the declare-then-assign `comptime(x) : T; x = v` spelling, `comptime_assert`, and the bindings inside an `impl({ ... })` block. A forced definition sees only what precedes the REFERENCE that forced it — keep imports/opens at the top. Cycles between constants/types are `cyclic definition: a (line N) → b (line M) → a` errors; a definition that fails while forced reports its own error plus a `note: ... was evaluated here because it is referenced before its definition`.

**SEED GATE — do NOT rely on this in `std/` or `src/` yet.** `yo build` compiles `std/` and `src/` with the SEED compiler (`SEED_VERSION`), which predates the feature and still fails with `Variable "X" not found` on a forward reference (and needs `recur` for self-recursion). Keep the callee-before-caller / impl-before-caller order in `std/` and `src/` until a release carrying the feature becomes the seed (`plans/backlog/SEED_VERSION_AUTOMATION.md` is the scheduling point). `tests/` are compiled by the stage-1 built from the tree and may use the new order.

### Named tuple fields in type syntax are not allowed

Yo does not support named tuple field types in the syntax `(name : Type, ...)`. Use a named struct instead:

```rust
// WRONG — "Labelled field is not allowed in tuple value":
get_range :: (fn(ty : TypeValue) -> Option((min : i64, max : u64)))(
  .Some((min: i64(-128), max: u64(127)))
);

// CORRECT — define a named struct:
Range :: ref(struct(min : i64, max : u64));
get_range :: (fn(ty : TypeValue) -> Option(Range))(
  .Some({min: i64(-128), max: u64(127)})
);
```

Named fields work in struct/ref(struct(...)) constructors `{min: ..., max: ...}`, just not in the type syntax for tuples.

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

Bare unary `!` binds one postfix expression (Rule 1, 2026-08-21) — both
spellings are valid; NEW user code prefers the bare form, while `src/` and
`std/` keep the call form until a rule-bearing release becomes the seed:

```rust
// Preferred in new user code:
if(!cond, { do_thing(); });

// Call form — required inside src/ and std/ this generation:
if(!(cond), { do_thing(); });
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

This also applies to reference-semantics types (`ref(struct(...))` / `ref(enum(...))`): you can mutate fields (`env.field = val`)
but cannot rebind the variable (`env = other_env`).

### String cloning

`.clone()` on a `String` works directly, including on struct fields and
method-chain results (the historical `*(Self)`-overload ambiguity no
longer reproduces; verified 2026-06):

```rust
name := token.value.clone();            // OK
```

### Template strings produce `String`, literals are `str`

```rust
// Template string `` `...` `` → String
// String literal "..." → str
```

A heap `String` can NEVER become `str` (`as_str()` is deleted — `str` is
the STATIC string view; plans/archive/SLICE_REWORK.md). If a function must accept
runtime text, its parameter should be `String`; `str` parameters are for
literals/static text only.

**Format specs — `${value:spec}`** (D3.10, landed 2026-08-25). An interpolation
may carry Rust's/Python's spec after a colon:
`spec := [[fill]align][+][#][0][width][.precision][kind]`, `align` one of
`< > ^`, `kind` one of `x X b o`. Examples: `` `${name:>8}` `` (right-align to
8), `` `${name:*>6}` `` (fill with `*`), `` `${n:#06x}` `` → `0x00ff`,
`` `${pi:.2}` `` → `3.14`, `` `${pi:>8.3}` `` (width applies AFTER precision).
Width counts CHARACTERS; zero padding on a number lands between the sign/prefix
and the digits (`-0000042`, not `000-0042`). Anything `ToString` gets
width/fill/align/truncate; numbers also get sign/radix/zero-fill.
**The colon takes NO SPACE before it** — a spaced colon (`${a : b}`) is left
alone and keeps its ordinary colon-pair meaning, and a colon inside a call's
arguments or a string literal (`${parts.join(":")}`) is never a separator,
because the spec is peeled by a backward walk over a character set that excludes
`)`, `]`, `}`, quotes, comma and whitespace. A file that uses no spec keeps
importing `std/fmt/to_string`; one that uses any spec imports `std/fmt/format`.

These features are powerful but less commonly used. Consult the linked docs for full details.

| Feature                    | Syntax hint                                               | Documentation                                                                                                          |
| -------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Higher-Kinded Types        | `generic(F : (fn(comptime(T) : Type) -> comptime(Type)))` | [DESIGN.md § HKT](https://github.com/shd101wyy/Yo/blob/develop/docs/en-US/DESIGN.md#higher-kinded-types-hkt)           |
| GADTs                      | `enum(IntVal(i : i32) -> recur(i32))`                     | [GADTS.md](https://github.com/shd101wyy/Yo/blob/develop/docs/en-US/GADTS.md)                                           |
| Derive traits              | `derive(MyType, Eq, Hash, Clone, Ord, ToString, Default)`          | [DERIVE_TRAITS.md](https://github.com/shd101wyy/Yo/blob/develop/docs/en-US/DERIVE_TRAITS.md)                           |
| Type reflection            | `Type.get_info(T)` returns `TypeInfo`                     | [TYPE_REFLECTION.md](https://github.com/shd101wyy/Yo/blob/develop/docs/en-US/TYPE_REFLECTION.md)                       |
| Inline assembly            | `asm("mov {0}, #42", out(reg, i32))`                      | [INLINE_ASSEMBLY.md](https://github.com/shd101wyy/Yo/blob/develop/docs/en-US/INLINE_ASSEMBLY.md)                       |
| Metaprogramming            | `quote(...)`, `unquote(...)`, `unquote_splicing(...)`     | [DESIGN.md § Meta](https://github.com/shd101wyy/Yo/blob/develop/docs/en-US/DESIGN.md#meta-programming)                 |
| Effect bundle polymorphism | `generic(E : Type.Struct)` over a bundle struct           | [ALGEBRAIC_EFFECTS.md](https://github.com/shd101wyy/Yo/blob/develop/docs/en-US/ALGEBRAIC_EFFECTS.md)                   |
| Custom derive rules        | `derive_rule(MyTrait, (fn(...) -> unquote(Expr)){...})`   | [DERIVE_TRAITS.md](https://github.com/shd101wyy/Yo/blob/develop/docs/en-US/DERIVE_TRAITS.md#user-defined-derive-rules) |
| Isolated types             | `Iso(T)` for data-race-free parallelism                   | [ISOLATED.md](https://github.com/shd101wyy/Yo/blob/develop/docs/en-US/ISOLATED.md)                                     |
| Arc (atomic ref count)     | `arc(value)`, `shared.(*)` for cross-thread sharing       | [ARC.md](https://github.com/shd101wyy/Yo/blob/develop/docs/en-US/ARC.md)                                               |
| Parallelism                | Thread pool, `io.spawn` for parallel work                 | [PARALLELISM.md](https://github.com/shd101wyy/Yo/blob/develop/docs/en-US/PARALLELISM.md)                               |

---

## Compiler limitations and pitfalls

These were catalogued while porting the compiler to Yo, when the TypeScript
compiler still accepted some of the rejected forms. That compiler is gone —
`src/` is the only compiler — so everything below applies to **all** Yo
code, not just the compiler's own sources.

### Match patterns: no bare identifier catch-all

The parser only accepts three match arm forms:

- `.VariantName` — unit variant
- `.VariantName(p1, p2, ...)` — tuple variant
- `_` — wildcard

**Bare identifier catch-all `t => ...` is NOT supported.** Use `_` and access the outer binding directly:

```rust
// ❌ NOT supported in src/
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
result := (parts + item);

// ✅ Template strings
result := `${parts}, `;
result := `${parts}${item}`;
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

### Sibling match/cond arms must agree in type — brace statement-like arms

An unbraced arm's value is the expression's value, and `list.push(x)` /
`map.insert(k, v)` return non-unit — so mixing an unbraced push arm with a
block-shaped (unit) sibling arm is a type error ("Incompatible types" /
"{ ... } without semicolons"). Brace-and-semicolon every arm whose result
is not meant to be the value: `(c) => { bytes.push(b); },`.

### A trait where-clause cannot bind another trait's assoc type to its OWN

A trait may name its own associated type in a METHOD signature (`Self.Item`),
but it may not use that projection as the VALUE of an associated-type
constraint in its where clause:

```rust
// ❌ Error: Expected type for associated type constraint "Item", got: (Self.Item)
DoubleEndedIterator :: trait(
  Item : Type,
  next_back : (fn(inout(self) : Self) -> Option(Self.Item)),
  where(Self <: Iterator(Item := Self.Item))
);

// ✅ the method signature may still name Self.Item; drop the where clause
DoubleEndedIterator :: trait(
  Item : Type,
  next_back : (fn(inout(self) : Self) -> Option(Self.Item))
);
```

`IntoIterator`'s `where(Self.IntoIter <: Iterator(Item := Self.Item))` works
because the SUBJECT is a different type (`Self.IntoIter`); what is rejected is a
`Self`-projection appearing as the constraint's value while constraining `Self`
itself. When two traits must agree on an associated type, state the coherence
rule in the doc comment — the assoc-type registry is keyed by (type id, label)
with no trait discrimination and takes the first match, so a mismatch is
silently first-wins rather than diagnosed.

### Static (self-less) trait methods work — the FromJson pattern

A trait method with no `self` (`Maker :: trait(make : (fn(x : i32) -> Self))`)
dispatches as `Point.make(x)` on any impl'd type, and through a generic
where-constrained fn (`(fn(comptime(T) : Type, x : i32, where(T <: Maker)) -> T)(T.make(x))`).
Constructor-style traits (`FromJson.from_json`) are therefore expressible.
(A forall-binding-order bug that broke this inside generic impls on
multi-param receivers — `HashMap(String, V)` bound `V := String` — was
fixed 2026-08-22:
issues/fixed/generic-impl-fromjson-container-decode-failures.md.)
### Don't name locals after Windows macros (`near`, `far`, `pascal`, `IN`, `OUT`)

Emitted C keeps user local names, and `windef.h` defines the legacy Win16
set (`near`, `far`, `pascal`, …) to NOTHING — a local named `near`
compiles everywhere except the windows target, where `if (near)` becomes
`if ()` (caught by PR #218's windows leg; see
issues/emitted-c-locals-collide-with-windows-macros.md).

### A local `(fn(...) -> T)(body)` literal cannot capture enclosing locals

A typed fn literal bound inside another function is a full function
definition (def-time evaluated), NOT a closure — its body fails with
`Variable "x" not found` for any enclosing local it references. Arrow
closures (`(a) -> expr`, `(a) => { ... }`) capture; typed fn literals do
not. Hoist the fn to module level and pass the state as parameters:

```rust
// ❌ inner fn cannot see `out` from the enclosing fn's scope
outer :: (fn(out : ArrayList(i32)) -> unit)({
  push_twice := (fn(v : i32) -> unit)({ out.push(v); out.push(v); });
  push_twice(i32(1));
});

// ✅ module-level helper takes the state explicitly
_push_twice :: (fn(v : i32, out : ArrayList(i32)) -> unit)({ out.push(v); out.push(v); });
outer :: (fn(out : ArrayList(i32)) -> unit)({ _push_twice(i32(1), out); });
```

### Writing derive rules (outside the prelude works)

`derive_rule(MyTrait, __my_rule)` works in any module with
`pragma(Pragma.AllowMacroDef)`; the deriving module imports the trait and
whatever names the GENERATED code references. Authoring gotchas, each of
which otherwise surfaces as the misleading
`derive rule must return(comptime(Expr)); got Comptime`:

- Code strings passed to `.to_expr()` must parse as EXACTLY ONE
  expression — wrap statement blocks in parens: `"({ a := 1; () })"`,
  never a bare `"{ … }"`.
- A raw backtick inside a `"..."` code string splits the parse — generate
  `String.from("x")` in the code instead of a template literal.
- Invoke derives with trait arguments: `derive(Point, Eq(Point))`. The bare
  `derive(Point, Eq)` is REJECTED — since 2026-09-05 with the real cause
  anchored on the `derive(...)` line ("derive on \"Point\" failed: Argument count
  mismatch: expected 1, got 0"); before that it killed the module's evaluation
  and blamed Point's next use
  (issues/fixed/bare-derive-form-kills-module-eval.md).

### Template strings cannot be nested inside `${...}` interpolations

A template string literal (`` ` `` ... `` ` ``) inside a `${...}` interpolation of another template string closes the outer string. The compiler gives confusing parse errors.

```rust
// ❌ Inner backtick closes the outer template string — parse error
lines.push(`**Implements:** ${`, `.join(names)}`);

// ✅ Assign the separator to a variable first
sep := `, `;
lines.push(`**Implements:** ${sep.join(names)}`);
```

#### The same trap inside EMITTED C — including in its comments

Every C emitter in `src/codegen/` writes its C through backtick templates, so a
backtick ANYWHERE in that text ends the string — a `${...}` interpolation is not
required. Writing Markdown-style `` `identifier` `` in a C comment (a very
natural habit when the comment cites a Yo name) is enough:

```rust
em.emit_declaration_string_line(
  `// this runtime writes `{0}` into the handle    ← ❌ the 2nd backtick ends the
   #define __YO_THREAD_HANDLE_IS_NULL(t) ((t) == 0)`  //   string; the rest is
);                                                    //   parsed as Yo code
```

The failure is doubly confusing: `yo fmt` reformats the now-"code" text (`{0}`
becomes `{ 0 }`), and the parse error lands on the COMMENT line with a message
about paren-less calls. Write such comments with plain quotes or no delimiter at
all.

### A literal `\\` immediately before `${...}` silently kills the interpolation

`\\` is the escape for one literal backslash and works everywhere EXCEPT
directly in front of an interpolation, where the backslash is swallowed AND the
`${...}` is emitted as literal text. No error, no warning — you only see it in
the printed string.

```rust
n := usize(7);
println(`A: ${n}`);    // A: 7
println(`B: \\${n}`);   // B: ${n}   ❌ backslash eaten, interpolation dead
println(`C: \\ ${n}`);  // C: \ 7    ✅ any character in between is fine
println(`D: \\x${n}`);  // D: \x7    ✅
```

Cause: the lexer encodes "escaped dollar" as the two characters `\$`, which is
byte-identical to "literal backslash, then a real `${`"
(`src/lexer.yo:415-433` → `src/parser.yo:376-384`) —
issues/template-string-backslash-before-interpolation-eats-both.md. Until that
is fixed, reword so no backslash abuts an interpolation, or build the string
with a separator variable.

### A backtick literal WITHOUT `${...}` interpolation is a `str`, not a `String`

`String.from(`` `...` ``)` looks harmless but a backtick literal with no
interpolation types as a plain `str`, and in some positions (e.g. a
`format_error_message(tok, msg, ...)` argument chain inside a large fn)
the def-time check reports a misleading `Cannot unify: Expected "String"
Given "str"` pointing at the ENCLOSING fn's return type, not the literal.
Use a double-quoted string (escape inner `"` as `\"`) for constant
messages; reserve backticks for templates that actually interpolate.

```rust
// ❌ def-time check fails with a misleading location
exn.throw(dyn(format_error_message(tok, String.from(`Cannot use "asm" here.`), false, .None)));

// ✅ double-quoted with escapes
exn.throw(dyn(format_error_message(tok, String.from("Cannot use \"asm\" here."), false, .None)));
```

### Pushing RC struct fields into ArrayList does not need `.clone()`

String (and other RC reference-semantics) fields of structs can be passed directly to `ArrayList.push()` — the RC bump happens automatically:

```rust
names.push(param.name);
```

`.clone()` on String fields also works (`names.push(param.name.clone())`,
`h.name.clone()` — verified 2026-06); the historical
`fn(self: String)` vs `fn(self: *(String))` ambiguity error no longer
reproduces. `x.clone()` is the idiomatic replacement for the retired
`String.from(x.as_str())` roundtrip.

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
  .Some(.IntLit(n)) => assert(n == "3", "ok"),
  _ => assert(false, "err")
)

// ✅ CORRECT — two-level match:
match(v.get(usize(0)),
  .Some(x) => match(x, .IntLit(n) => assert(n == "3", "ok"), _ => assert(false, "err")),
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

**String indexing is BYTE-based, everywhere.** Since 2026-08-26
(`plans/STD_API_AUDIT_D4_PLAN.md` D4 PR 3) `String.len()`, `at`, `substring`,
the `s(a..b)` / `s(a..=b)` sugar, `index_of`, `last_index_of`,
`contains(from_index)`, `starts_with(position)`, `ends_with(end_position)` and
the whole `Pattern` trait all speak BYTE offsets — the same unit as
`byte_at` / `as_bytes` / `Index(usize)` / `str.len()` / `StringBuilder.len()`.
`String.from("a→b").len()` is `5`, not `3`. **This is the reverse of what it
used to be**: before that flip they were rune-based, and mixing the two bases
was the standing hazard. Rune work goes through `chars()` / `char_indices()`
composed with iterator methods (see the vocabulary below).

**Comptime strings share the byte basis** (D4 PR 7, 2026-08-26): comptime
`s.len()`, `s.slice(a, b)`, `s(i)` and `s(a..b)` all speak byte offsets too.
Comptime `s(i)` yields the RUNE starting at byte `i` as a 1-rune `comptime_str`
(mirroring runtime `at(i)`; runtime `s(i)` yields the `u8` — that result-type
split is deliberate), and a mid-rune offset is a compile error where the
runtime `substring` would panic.

```
// ✅ byte loop, byte bound — the bases now agree
while(i < s.len(), { b := s.byte_at(i); ... });

// ✅ index_of's answer feeds straight back into substring
match(s.index_of(w), .Some(idx) => s.substring(idx, idx + w.len()), .None => ...);

// ✅ rune iteration with the byte offset of each rune
it := s.char_indices();
// p._0 is the BYTE offset, p._1 the rune

// ❌ WRONG — a rune count is not a byte offset
while(i < s.chars().count(), { b := s.byte_at(i); ... });
// ❌ PANICS — an endpoint inside a rune
s.substring(usize(0), usize(1)) // on "→…", byte 1 is a continuation byte
```

**Boundary policy for `substring` (and the `s(a..b)` sugar):** out-of-range
CLAMPS, but a **non-boundary index PANICS** — an offset inside a rune is a
programmer error, not a range condition. The escape hatches:
`try_substring(a, b)` returns `.None` instead, and
`floor_char_boundary` / `ceil_char_boundary` snap an arbitrary offset onto a
boundary first. `index_of` / `starts_with` / `ends_with` never panic: a
valid-UTF-8 needle simply cannot match at a continuation byte, so a mid-rune
argument answers `false` / `.None`.

**The rune vocabulary** (`std/string/string.yo`; the same names exist on
`std/imm/string.yo`, whose `len()` and `at()` are byte-based the same way
since D4 PR 4). The shape is Rust's exactly: byte slicing + iterators for
rune work; there is no char-indexed slicing and no second length method
(`bytes_len`/`char_len`/`char_substring`/`truncate_chars` were all removed
2026-08-26):

| call | basis | meaning |
| --- | --- | --- |
| `s.chars().count()` | runes | **THE rune count.** O(n) — and the iterator spelling keeps that cost visible at the call site (Rust reserves `len()` for `ExactSizeIterator`, which a chars iterator is not). Say this whenever you mean "how many characters" — `len()` is bytes. |
| `s.char_indices()` | — | iterator of `IterPair(byte_offset, rune)`; `p._0` is the BYTE offset, `p._1` the rune. This is the replacement for `while(i < s.len()) { s.at(i) }`, which now visits continuation bytes and yields `.None` at each of them. |
| `s.is_char_boundary(i)` | byte | is byte `i` the start of a rune? `0` and `len()` are boundaries; past the end is not. |
| `s.floor_char_boundary(i)` / `s.ceil_char_boundary(i)` | byte | snap an arbitrary byte offset back/forward onto a rune start (clamped to `len()`). |
| `s.try_substring(a, b)` | byte | `Option(String)`; `.None` for `a > b`, `b > len()`, or an endpoint inside a rune. The non-panicking `substring`. |

The iterator idioms replace the removed one-shot methods (all three verified
with a compiled multibyte probe):

```
// rune count
n := s.chars().count();
// truncate to at most n runes: byte offset where rune n starts, byte-slice to it
cut := match(
  s.char_indices().nth(n),
  .Some(p) => s.substring(usize(0), p._0),
  .None => s // fewer than n+1 runes — keep the whole string
);
// first rune + the rest
first := s.chars().next(); // Option(rune)
```

`chars()` / `char_indices()` sit on `std/encoding/utf8`, so they inherit its
malformed-input behaviour: they stop at the first sequence that will not
decode.

**Lexer/AST note:** `Token.character` is a RUNE offset into `Token.input`
(the lexer walks `input.chars()`); `Token.byte_offset` is the byte offset of
the same position. **Never index `input` with `character`** — that was
`issues/fixed/yo-self-formatter-corrupts-files-with-non-ascii.md`, where `yo
fmt` silently destroyed non-ASCII source at rc=0. `Token.column` is likewise a
rune column, so a width added to it must be a RUNE count
(`value.chars().count()`), never `value.len()`.

## Async: await only at the async-closure statement level

An `e.io.await(...)` nested inside if-branches of an `io.async` closure has
been observed to compile SILENTLY WRONG (the branch's continuation never
ran — issues/async-await-nested-if-lost-continuation.md; `check` cannot
catch it, and only SOME shapes are rejected at codegen). Until that bug is
minimized and fixed: hoist every await-bearing step to a top-level
statement of the closure and branch on plain booleans afterwards.

## Block bodies cannot START with `cond(`/`match(` — and other body-statement rules

A function/method body written `({...})` whose FIRST statement is `cond(...)` or
`match(...)` fails to parse with the misleading "{ ... } without semicolons is
parsed as a struct literal" error. Lead with any assignment instead — e.g. hoist
the scrutinee: `(first : Option(usize)) = sep.index_in(self, usize(0));` then
`match(first, ...)`. Related body rules learned the hard way:

- Typed assignments need the whole pair parenthesized: `(x : T) = expr;` — bare
  `x : T = expr` is rejected as "adjacent different operators" (`x := expr` is
  fine unparenthesized).
- Module-level bindings use `::`; `name : (fn(...))` at module level parses as a
  CALL of the type value.
- `1e-12`-style exponent float literals do not lex — spell the mantissa out
  (`f64(0.000000000001)`).

## Tuples: semicolon TYPE, comma VALUE, `.0` access, no destructuring patterns

`(A; B)` is the tuple TYPE (semicolons); `(a, b)` is the tuple VALUE (commas).
Field access is by integer index: `p.0`, `p.1`. (The comment at
src/parser.yo's tuple branch states the mapping backwards —
tests/internal/parser.test.yo "Parse tuple value (a, b)" / "Parse Tuple type
(a; b)" are the truth.) Match patterns CANNOT destructure tuples: write
`.Some(p) => p.0`, never `.Some((k, v))`. The first std API returning one is
`String.split_once -> Option((String; String))`.

## `__yo_panic` comptime-evaluates its message argument

The builtin evaluates its argument and requires an ExprInfo: pass a plain
`*u8`/str-typed binding. An Option `.unwrap()` chain on the argument leaves it
without an ExprInfo and fails with "Failed to evaluate panic message" — bind
the pointer through a local/`match` first (see std/assert.yo's `panic`).

## `println` comes from `std/fmt`; `join` runs separator-first

`{ println } :: import("std/fmt");` — there is no `io.println`. And `join` is
`separator.join(list : ArrayList(String))`, not `list.join(sep)`.

## Match/cond arms are VALUES — `push` returns `Result`

`ArrayList.push` returns `Result(unit, ArrayListError)`, so a `push(...)`
call in an arm position mismatches a `()` sibling arm ("Incompatible types:
Previous: <enum…> / Current: unit"). Discard into a binding first (one `___`
per block — redeclaring `___` in the same scope is an error):

```rust
match(xs.get(i),
  .Some(x) => {
    ___ := out.push(x);   // block value is the binding: unit
  },
  .None => ()
);
```

Same class: a `return(...)` inside one arm types that arm as the RETURN type,
mismatching a `()` sibling — restructure with a found-flag + trailing value,
or use `__yo_panic("literal")` for diverging value-position arms (str only).

## A real newline inside `"…"` is a parse error — reported misleadingly

Double-quoted strings do not span lines: a real newline inside `"…"` produces
`Adjacent different operators need parentheses to clarify grouping (near :)`
pointing at a construct far from the string (issues/
multiline-double-quoted-string-parse-error-misleading.md). Write `\n` as the
two-character escape — and beware tools that materialize real newlines when
writing source. Backtick templates span lines fine.

## No nested backtick templates inside `${…}`; `push_str` takes static `str`

`f(\`outer ${g(\`inner\`)}\`)` fails to evaluate ("Module field … not found").
Precompute the inner template into a local first. And `push_str` on the
emitter/string-builder wants a static `str` literal — anything interpolated
(runtime `String`) goes through `push_string`.

## A backtick inside a template string ENDS it — never markdown-quote in emitted C

The per-platform runtime files (`src/codegen/async/runtime_io_*.yo`) hold whole
C programs inside backtick template strings. Writing a habitual markdown
`` `struct stat` `` in a C **comment** in there closes the template mid-C, and
the rest of the C body is parsed as Yo. The diagnostic points at the middle of
a C comment and says something unrelated:

```
error[E0008]: paren-less function and operator calls are not supported; use parentheses
    --> ./src/codegen/async/runtime_io_macos.yo:498:65
    |
498 | // path is ENOENT), so this is a plain fstat(2) into the same ` struct stat `
```

Worse, `yo fmt` will then "format" the accidental Yo fragment — inserting the
spaces you see inside those backticks — so the file no longer matches what you
typed. Inside any emitted-C template, write `struct stat`, not the quoted form.

## Async value-position `cond`: two shapes miscompile — use the statement form

Inside an `io.async` body, a `cond` used as a VALUE (`x := cond(...)`) breaks in
two ways that `yo check` cannot see:

1. **An arm that awaits, with a `while` around the cond** → the binding is never
   written and EVERY arm yields the zero value (`0`, or an enum's first
   variant). No diagnostic, no clang error
   (issues/async-cond-value-with-await-arm-inside-while-yields-zero.md).
2. **An arm that `throw`s, after an await in the body**, where a surviving arm's
   value is a variable read → clang fails with `use of undeclared identifier
   '_file____User_temp_N'`
   (issues/async-cond-value-with-throwing-arm-after-await-undeclared-temp.md).

Both have the same safe rewrite — predeclare, then assign from STATEMENT-form
`cond`s:

```rust
(ft : FileType) = FileType.Other;          // predeclared, mutable
cond(
  (dt == DT_UNKNOWN) => {
    ft = e.io.await(_file_type_or_other(p, e.io), e.io);   // fine as a statement
  },
  true => ()
);
cond(
  (result < i32(0)) => e.exn.throw(dyn(IoError.from_errno(...))),
  true => ()
);
ft                                          // bare tail
```

An UNCONDITIONAL await bound in a `while` (`v := e.io.await(...)`) is fine, and
a value-position `cond` with an awaiting arm and no `while` around it is fine —
it is the combinations above that break.
