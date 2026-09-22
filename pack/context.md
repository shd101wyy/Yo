# Yo — context pack for coding agents

pack-version: 1 — shipped with the toolchain; yo context prints this file.
It covers the LANGUAGE only. API listings come from the toolchain, never
from here: yo context --list (modules), yo context <module> [name]
(signatures + docs), yo context --search <query>. Code blocks below are
canonical Yo; every example compiles.

## What Yo is

A statically-typed, expression-oriented language that compiles to C11 and
lets the system C compiler finish the job. Memory is compile-time RC with a
cycle collector — no borrow checker, no GC pauses. Async is single-threaded
event-loop (C#-style); threads are a separate explicit runtime. Yo is
designed for LLM authorship: regular syntax, no precedence table, no
overloading, fast checker (`yo check`), errors that carry repairs.

## The toolchain loop

```bash
yo check ./src            # type-check only — run after EVERY edit; fast
yo compile main.yo -o app # full pipeline (emits C, invokes cc)
yo build                  # project build via build.yo (yo.toml declares deps)
yo test ./tests           # language tests; yo test ./std for std's own
yo fmt file.yo            # format (yo fmt --check verifies)
yo explain E0xxx          # offline diagnostic explanation
yo fix file.yo            # apply structured repairs from diagnostics
```

- `check` is evaluator-only: async state-machine rules fire in codegen, so
  gate those with `yo compile main.yo --skip-c-compiler`.
- `yo compile` cannot run on `*.test.yo` files.
- Errors render as JSON with `--error-format json` (repairs included).
- A `-O0` binary that SIGSEGVs on deep recursion is stack exhaustion
  (multi-MB `-O0` frames), not heap corruption: validate deep recursion with
  `--optimize 2`.

## Declarations and bindings

```rust
{ println } :: import("std/fmt");       // import (destructuring)
name :: "yo";                           // top-level binding, order-independent
main :: (fn() -> unit)({                // fn def: TYPE then BODY
  x := i32(1);                          // local bind, inferred
  (msg : str) = "hello";                // typed local bind
  println(msg);
});
export(main);                           // only exported names are public
```

- Top-level `name :: value;` bindings and `impl` registrations are
  order-independent within a module.
- Function definition: `name :: (fn(a : T, b : U) -> R)(body);` — the fn
  TYPE is parenthesized; the body is a second parenthesized group.
- Methods are `impl` entries taking `self : Self`; call with `obj.m(args)`.
- `main` returns `unit` and is `export`ed.

## Braces: a record unless it has a `;`

THE rule that breaks Rust instincts. A `{ ... }` group is a **record
(struct-literal) when its top level is comma-separated `field : value`**,
and a **block only when it contains semicolons**:

```rust
p := { x : i32(1), y : i32(2) };        // record literal (named fields)
block := {
  a := i32(1);
  (a + i32(2))                          // block: `;`-sequenced, value = tail
};
```

`{ single_expr }` parses as a one-field record, not a block — and `yo fmt`
accepts it silently. Run `yo check` on every edit. Struct literals want
spaces around `:` and parenthesized infix values: `{ x : (a + b), y : c }`.

## Operators: no precedence, parenthesize

There is NO operator precedence table. Parenthesize every compound
expression; `yo fmt` preserves your parens:

```rust
y := ((a + b) * c);                     // never  a + b * c
ok := ((x > i32(0)) && (y < i32(9)));   // parenthesize comparisons too
```

A binary right-hand side must be parenthesized (`E0003`): `x := (a + b);`,
not `x := a + b;`. The operator set is closed and fixed; `&&`/`||` chains of
3+ operands need explicit parens.

## Control flow: calls, not keywords

```rust
grade := cond(
  (s >= i32(90)) => "A",
  (s >= i32(60)) => "B",
  true => "F"                           // `true` closes a cond
);

label := match(opt,
  .Some(v) => v,
  .None => "none"
);

if(done, println("yes"), println("no")); // sugar over cond
```

- `cond(...)` arms are `predicate => value`; `match(...)` arms are
  `pattern => value`. Arms are VALUES: sibling arms must agree in type.
- `if(a, b)` / `if(a, b, c)` desugar to `cond` at parse time.
- A block body cannot START with `cond(`/`match(` — bind first:
  `r := match(...); r`.
- `return(v)` and `unwind(v)` are always called, never bare.

## Pattern matching (match on values, not just primitives)

```rust
// int scrutinee: ranges, guards, whole-value bindings
category := match(n,
  (0..10) => "small",
  (v && (v < i32(0))) => "negative",     // guard sees the binding
  (big := 100) => "exactly a hundred",   // whole-value binding
  _ => "large"
);
// variant scrutinee: payloads bind, or-patterns group
text := match(shape,
  .Circle(r) => `r=${r}`,
  (.Rect(_) | .Unit) => `other`,
  _ => `?`
);
```

Nested variants, literals, ranges `(0..10)`, string scrutinees, or-patterns
`(.Err(.A) | .Err(.B))`, and guards are supported. Exhaustiveness is
enforced: a non-exhaustive match is E0607 (with a structural witness),
unreachable arms E0608. Prefer matching `.Some(v)` once and branching inside
the arm over `.Some(true)`/`.Some(false)` sibling arms.

## Types

```rust
Point :: struct(x : i32, y : i32);            // value semantics
Node :: ref(struct(next : Option(Self), v : i32));   // reference semantics (RC)
Shape :: enum(Circle(r : f64), Rect(w : f64, h : f64), Unit);
Tree :: (fn(comptime(T) : Type) -> comptime(Type))(   // generic TYPE = type-fn
  ref(enum(Leaf, Node2(l : Self, v : T, r : Self)))
);

Counter :: trait(
  count : (fn(self : Self) -> i32)
);

impl(Point, Counter(count : (fn(self : Self) -> i32)(self.x)));
derive(Point, Eq(Point), Hash, Clone, Ord(Point), ToString, Default);
```

- `struct` = value semantics (copied); `ref(struct(...))`/`ref(enum(...))` =
  heap + RC, shared by handle. `Self` refers to the type being defined.
- Constructors take named fields: `Point(x : i32(1), y : i32(2))`.
- Generic types are TYPE-FUNCTIONS:
  `Name :: (fn(comptime(T) : Type) -> comptime(Type))(...);`. Generic
  FUNCTIONS take `comptime(T) : Type` as a first parameter with a
  where-clause: `(fn(comptime(T) : Type, x : T, where(T <: Show)) -> String)`,
  called as `show(Show, x)` (type argument first). Generic impls pair with a
  concrete type: `impl(generic(T), where(T <: Show), Box(T), m : ...)`.
- Derivable: `Eq`, `Hash`, `Clone`, `Ord`, `ToString`, `Default` (Eq/Ord
  take the type: `Eq(Point)`).
- NO overloading: not for functions, not for inherent methods. Trait
  methods may share names — dispatch picks by argument types.
- NO operator precedence (above) and a closed operator set; traits implement
  `(==)`, `(<)`, `(+)` etc.

## Strings, numbers, templates

- `str` = static, immutable view of literal bytes. `String` = owned growable
  UTF-8. Template strings produce `String`: `` `hi ${name}` ``. A backtick
  literal WITHOUT `${...}` is a `str`.
- No `String + str` operator. Build strings with a `StringBuilder`-style
  buffer or template strings.
- A real newline inside `"..."` is a parse error; templates cannot nest
  `${...}` inside `${...}`; a backtick ends a template — never emit
  markdown fences from code that builds Yo source.
- Integer literals are polymorphic and often need a cast or typed binding:
  `x := i32(1);` or `(x : i32) = 1;`. Distinct integer types do not mix
  implicitly: `(i32(1) + usize(1))` is an error.
- Fixed arrays: `[i32, 3]`, literal `[i32(1), i32(2), i32(3),]` (trailing
  comma required for 1-element arrays). Slices are `[]i32`.

## Option, Result, errors

```rust
(maybe : Option(i32)) = Option(i32).Some(i32(7));   // .Some(v) | .None
DivError :: enum(DivByZero);                        // recoverable: Error enum
derive(DivError, Error(.DivByZero => `division by zero`));
(res : Result(i32, DivError)) = .Ok(i32(6));

// Exception-style: Exception + throw; awaited IO rethrows via an exn
{ Exception, IoExn } :: import("std/error");
swallow := Exception(throw : ((_e) -> unwind(())));
data := io.await(read_to_string(p, io), IoExn(io : io, exn : swallow));
```

- `unwrap`/`expect` and the panic vocabulary are COMPILE ERRORS in safe
  files (a call may not discard failure information the type carries):
  match the `Option`/`Result`, or use checked indexing (`xs.get(i)`).
- `AnyError` is `Dyn(Error)`; `dyn(err_type_value)` boxes an error into it;
  `downcast(any, MyError)` recovers (`.None` if not that type).
- Safe code traps, never UB: array/str indexing is bounds-checked, integer
  `/` `%` by zero and `MIN / -1` abort with a diagnostic, overflow traps
  (`wrapping_*` methods are the escape hatch), casts saturate.

## Ownership and references

- Values are reference-counted at compile time (dup/drop inserted by the
  compiler); a cycle collector reclaims `ref` cycles. You do not write
  refcounts.
- Moves happen on `box(v)`, on storing into a `ref` field, and on returning
  ownership; using a moved value is a compile error. `.clone()` when you
  need both.
- NO lifetimes/borrow types. Shared mutation goes through `inout` parameter
  mode or `ref` semantics types; a runtime exclusivity backstop guards
  violations.
- `_` is the discard pattern; `___` is a named discard usable once per
  scope. A name starting with `_` is MODULE-PRIVATE (compiler-enforced,
  E0405).
- Parameters are read-only by default; `inout(self)` for mutation; methods
  take `self : Self` explicitly.

## Async (single-threaded) and effects

- All async I/O runs on ONE event-loop thread. Never add mutexes/atomics to
  async-runtime state; use `spawn_blocking` for CPU/blocking work.
- `await` inside `cond`/`match` arms has restricted shapes — prefer binding
  in a statement, then branching. An arm that awaits and uses a novel
  pattern form is rejected at codegen with a workaround message.
- Effects: a handler's `return(expr)` RESUMES the awaited continuation;
  `unwind(expr)` DISCARDS it and exits the enclosing fn. An unwound async
  task enters the Aborted state. C's `abort()` (panic) is a different,
  process-level thing.

## Modules and projects

```rust
{ a, b } :: import("std/string");       // named destructuring
{ ... } :: import("std/collections");   // glob
```

- Dependencies live in `yo.toml` (`yo add user/repo`), fetched by
  `yo install` / `yo build`; `import("dep/...")` resolves through the
  nearest manifest.
- An anonymous module (a file with no exports) evaluates for side effects.
- Module doc comments are `//!` at the top of the file; item docs are `///`.

## Threads (separate runtime)

`Thread(T)`, `ThreadPool`, `Channel` with `Send`/`Acyclic` bounds live in
`std/thread` — this is the multi-threaded story, distinct from async. Don't
reach for it to parallelize I/O; that's the event loop's job.

## Verification (optional, gradual)

`requires(...)`/`ensures(...)` clauses, `invariant`/`decreases` loops,
ghost values, `yo verify` with a Z3 backend. `assumed()` marks a contract
whose body is outside the verified subset — a green `yo verify` is not
"everything proved"; read per-function outcomes.

## Naming and sharp edges (rapid fire)

- `type` is a reserved word — never a field/param name. Avoid Windows macro
  names (`near`, `far`, `IN`, `OUT`) as locals.
- `impl(...)` blocks need the trailing semicolon.
- ArrayList indexing is CALL syntax: `xs(i)` reads, `xs(i) = v` writes,
  `xs.get(i)` is the checked form.
- Match/cond arms are values; `push`-style mutators return `Result` — a bare
  call in arm-tail position type-checks as a value and fails.
- Iterator loops: `for(x : xs)` for value types; check the trait docs for
  `inout` iteration over `ref` containers.
- A local `(fn(...) -> T)(body)` literal cannot capture enclosing locals —
  use a named fn or pass what you need.
- Recursive enums + `derive(Eq/Clone)` + `ArrayList` fields can form a
  circular derive dependency — derive on the `ref` wrapper or order manually.
- Template `${...}` interpolations call `to_string()` implicitly only for
  `ToString` types; a `\\` immediately before `${` kills the interpolation.
- Template strings are `String`, `"..."` literals are `str` — sibling
  match/cond arms must agree: mix them and the arm-type error points at the
  literal.
- Doc comments: `///` items, `//!` modules; `yo doc ./std` renders the API.

## Where to look next

- `yo context --list` then `yo context <module>` — the real API surface.
- `yo explain E0xxx` for any diagnostic; `yo fix` for machine-applicable
  repairs.
- Docs: `docs/en-US/` (GRAMMAR, DESIGN, ASYNC_AWAIT, MEMORY_SAFETY,
  ALGEBRAIC_EFFECTS, FORMAL_VERIFICATION).
- The LSP (`yo lsp`, VS Code extension) gives hover/completion/go-to-def in
  editors.
