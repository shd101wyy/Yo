# Language Design

**Yo** is a multi-paradigm, general-purpose, compiled programming language.
Yo aims to be **Simple** and **Fast**: it compiles to C11, and the goal is
speed comparable to C. The measured gap is in
`plans/backlog/CODEGEN_PERFORMANCE.md`.

**Yo** aims to be a simple to learn programming language for C and JavaScript (TypeScript) programmers 😉.

Our goal is to be a practical language that is easy to use and easy to learn.

The syntax, the data types, functions, closures and pattern matching have
their own pages: [SYNTAX.md](./SYNTAX.md), [DATA_TYPES.md](./DATA_TYPES.md),
[FUNCTIONS.md](./FUNCTIONS.md), [CLOSURES.md](./CLOSURES.md) and
[PATTERN_MATCHING.md](./PATTERN_MATCHING.md). [INDEX.md](./INDEX.md) lists every
manual.

<!-- @import "[TOC]" {cmd="toc" depthFrom=2 depthTo=6 orderedList=false} -->

<!-- code_chunk_output -->

- [Philosophy](#philosophy)
- [Inspiration](#inspiration)
- [CLI Usage](#cli-usage)
- [Shared Cells and Memory Management](#shared-cells-and-memory-management)
  - [Reference-Counted Cells](#reference-counted-cells)
  - [Choosing a value, a borrow or a shared cell](#choosing-a-value-a-borrow-or-a-shared-cell)
  - [Reading the count](#reading-the-count)
  - [Explicit Allocators](#explicit-allocators)
  - [Copy](#copy)
  - [Move-only values](#move-only-values)
  - [std's resources are move-only](#stds-resources-are-move-only)
  - [The destructor: `Drop`](#the-destructor-drop)
- [Pointers](#pointers)
  - [Pointer Operations](#pointer-operations)
  - [Pointer Arithmetic and Comparison](#pointer-arithmetic-and-comparison)
  - [Pointer Operations Reference](#pointer-operations-reference)
  - [The consume Function](#the-consume-function)
  - [Nullable Pointers](#nullable-pointers)
  - [`Option` of a handle is one pointer](#option-of-a-handle-is-one-pointer)
  - [Memory Safety](#memory-safety)
  - [`&mut` Parameters](#mut-parameters)
  - [RAII (Resource Acquisition Is Initialization)](#raii-resource-acquisition-is-initialization)
- [Advanced Type System](#advanced-type-system)
  - [Higher-Kinded Types (HKT)](#higher-kinded-types-hkt)
    - [HKT generic parameters](#hkt-generic-parameters)
    - [HKT traits](#hkt-traits)
    - [Generic functions with HKT where clauses](#generic-functions-with-hkt-where-clauses)
  - [Generalized Algebraic Data Types (GADTs)](#generalized-algebraic-data-types-gadts)
    - [GADT match type refinement](#gadt-match-type-refinement)
    - [GADT exhaustiveness](#gadt-exhaustiveness)
    - [GADT indices are part of the type](#gadt-indices-are-part-of-the-type)
    - [Multi-parameter GADTs](#multi-parameter-gadts)
    - [GADTs with custom discriminants](#gadts-with-custom-discriminants)
    - [Mixed GADT and regular variants](#mixed-gadt-and-regular-variants)
- [Typestate](#typestate)
- [Traits](#traits)
  - [Static trait methods](#static-trait-methods)
  - [Associated types in a trait's `where` clause](#associated-types-in-a-traits-where-clause)
  - [Coherence: one impl per type and trait](#coherence-one-impl-per-type-and-trait)
  - [Trait Method Disambiguation](#trait-method-disambiguation)
- [String](#string)
  - [String literal as `str` or C string pointer](#string-literal-as-str-or-c-string-pointer)
  - [String (Growable UTF-8 String)](#string-growable-utf-8-string)
    - [Writing through a copy of a `String`](#writing-through-a-copy-of-a-string)
    - [Template string interpolation with `${}` syntax:](#template-string-interpolation-with--syntax)
      - [Format specifications — `${value:spec}`](#format-specifications--valuespec)
- [Box: the Uniquely Owned Cell](#box-the-uniquely-owned-cell)
- [Rc and Reference-Counted Cells](#rc-and-reference-counted-cells)
  - [Rc Type](#rc-type)
  - [Usage Examples](#usage-examples)
  - [Auto-dereference](#auto-dereference)
  - [Rc with Assignments](#rc-with-assignments)
  - [Rc and Reference Counting](#rc-and-reference-counting)
  - [Mutating a Shared Payload: `RefCell`, `Rc.get_mut`, `Rc.make_mut`, `Rc.try_unwrap`](#mutating-a-shared-payload-refcell-rcget_mut-rcmake_mut-rctry_unwrap)
  - [Weak: a Handle That Does Not Own](#weak-a-handle-that-does-not-own)
  - [When to Use Rc](#when-to-use-rc)
- [Impl Types](#impl-types)
  - [Basic Usage](#basic-usage)
  - [Impl as Return Type](#impl-as-return-type)
  - [Impl with Multiple Traits](#impl-with-multiple-traits)
- [Dynamic Dispatch](#dynamic-dispatch)
  - [`Dyn` and `dyn`](#dyn-and-dyn)
  - [Examples](#examples)
- [Existential Types](#existential-types)
  - [Packed: `Dyn(Trait)`](#packed-dyntrait)
  - [Opaque: `Impl(Trait)` and closures](#opaque-impltrait-and-closures)
    - [A bare function type never mentions `Impl(Fn(...))`](#a-bare-function-type-never-mentions-implfn)
  - [Not supported: existential enum constructors](#not-supported-existential-enum-constructors)
- [Impl vs Dyn](#impl-vs-dyn)
- [Algebraic Effects and Handlers](#algebraic-effects-and-handlers)
- [Error Handling](#error-handling)
  - [Result Type](#result-type)
  - [Error Trait and AnyError](#error-trait-and-anyerror)
  - [Exception (Non-Resumable)](#exception-non-resumable)
  - [ResumableException](#resumableexception)
- [Async/Await](#asyncawait)
- [Parallelism](#parallelism)
- [Arc Types](#arc-types)
- [Module importing and exporting](#module-importing-and-exporting)
    - [Importing a name twice](#importing-a-name-twice)
    - [Trait impls are visible through your imports](#trait-impls-are-visible-through-your-imports)
  - [Anonymous module](#anonymous-module)
  - [Module-level mutable variables](#module-level-mutable-variables)
- [Testing](#testing)
  - [Basic Test Syntax](#basic-test-syntax)
  - [Running Tests](#running-tests)
  - [Assertions](#assertions)
    - [Runtime Assertions](#runtime-assertions)
    - [Compile-Time Assertions](#compile-time-assertions)
  - [Testing Expected Errors](#testing-expected-errors)
  - [Test Organization](#test-organization)
  - [Testing Drop](#testing-drop)
  - [Test Files](#test-files)
- [Meta-programming](#meta-programming)
  - [Macro functions](#macro-functions)
- [Derive Traits](#derive-traits)
  - [Built-in derives](#built-in-derives)
  - [User-defined derive rules with `derive_rule`](#user-defined-derive-rules-with-derive_rule)
- [Type Reflection](#type-reflection)
- [Compile-Time Evaluation](#compile-time-evaluation)
  - [Compile-Time Variables](#compile-time-variables)
  - [Compile-Time Arithmetic](#compile-time-arithmetic)
  - [Compile-Time Arrays](#compile-time-arrays)
  - [Compile-Time Assertions](#compile-time-assertions-1)
  - [Compile-Time Expected Errors](#compile-time-expected-errors)
  - [Compile-Time vs Runtime](#compile-time-vs-runtime)
  - [Benefits of Compile-Time Evaluation](#benefits-of-compile-time-evaluation)
- [Inline Assembly](#inline-assembly)
- [Index Trait](#index-trait)
- [In Design](#in-design)
- [References](#references)

<!-- /code_chunk_output -->

## Philosophy

**LLM-friendly to write, human-friendly to read.** The two goals
align: a snippet that an LLM can produce without scope-chain reasoning
is also a snippet a human reviewer can understand in a diff. The
design lever is _explicitness_ — every effect, parameter, and capture
is visible at the call site, so what you see is what runs.

**Key Design Principles:**

- **Simple syntax inspired by Lisp** (no keywords, minimal)
- **LLM-friendly syntax** (function, keyword, and prefix-operator calls always use immediate parentheses)
- **First-class types** (types are values)
- **Compile-time evaluation** (powerful `comptime` system)
- **Reference counting with ownership analysis** (eliminate unnecessary RC)
- **Pointer-based memory model** (no references/borrowing complexity)

**A few NO design choices:**

- **No operator precedence** (same-operator chains left-associate; adjacent different operators require explicit parentheses)
- **No variable shadowing** (similar to Zig)
- **No garbage collector** (reference counting frees every cell at its last handle; a reference cycle leaks unless a `Weak` breaks it, as in Rust)

## Inspiration

The **Yo** language is inspired by the following programming languages and absorbs some of their good ideas:

- Lisp
  - [Scheme](https://www.scheme.com/)
  - [Clojure](https://clojure.org/)
- [C](https://www.c-language.org/)/[C++](https://isocpp.org/)
- [Rust](https://www.rust-lang.org/)
- [Haskell](https://www.haskell.org/), [OCaml](https://ocaml.org/), [PureScript](https://www.purescript.org/), [Scala](https://www.scala-lang.org/)
- [JavaScript](https://developer.mozilla.org/en-US/docs/Web/JavaScript), [TypeScript](https://www.typescriptlang.org/)
- [Jai](https://github.com/Ivo-Balbaert/The_Way_to_Jai), [Zig](https://ziglang.org/), [Odin](https://odin-lang.org/)
- [Koka](https://koka-lang.github.io/), [Effekt](https://effekt-lang.org/), [Flix](https://flix.dev/)
- [Nim](https://nim-lang.org/)
- [Dafny](https://dafny.org/)
- [Austral](https://austral-lang.org/)
- [Elixir](https://elixir-lang.org/)
- [Io](https://iolanguage.org/)
- [ATS](https://www.ats-lang.org/)
- [Go](https://go.dev/)
- [Ada](https://www.adacore.com/)
- [hylo](https://www.hylo-lang.org/)
- [Lobster](https://aardappel.github.io/lobster/README_FIRST.html)
- [pony](https://www.ponylang.io/)
- [Swift](https://swift.org/)
- [Vale](https://vale.dev/)

## CLI Usage

```bash
yo --help
yo --version

# Project scaffolding
yo init                     # Create a new project in the current directory
yo init my-project          # Create a new project in ./my-project
yo init my-project --name x # Set project name to "x"

# Build system (see BUILD_SYSTEM.md for details)
yo build              # Build all artifacts (default "install" step)
yo build run          # Build and run the executable
yo build test         # Run tests
yo build --list-steps # List available build steps
yo build --cc zig     # Use zig as the C compiler
yo build --target wasm32-unknown-emscripten  # Cross-compile for WASM (Emscripten)

# Direct compilation (single file, no build.yo needed)
yo compile hello.yo -o hello
yo compile hello.yo --cc clang -o hello
yo compile hello.yo --target wasm32-unknown-emscripten -o hello.html

# Formatting (fixed style, 2-space indentation)
yo fmt                     # Format all .yo files in the current directory
yo fmt src tests           # Format .yo files under src and tests
yo fmt --check             # Check formatting without writing changes
```

For the full build system documentation, see [BUILD_SYSTEM.md](./BUILD_SYSTEM.md).

## Shared Cells and Memory Management

Yo uses **reference-counted cells** (`Rc`, `Arc`) for shared ownership. `Rc(T)` counts its handles non-atomically, and `Arc(T)` counts them atomically. The non-atomic count is sound because an `Rc` is not `Send`: it never leaves its thread, so one thread touches its count ([PARALLELISM.md](./PARALLELISM.md)). Share across threads with `Arc` ([ARC.md](./ARC.md)).

### Reference-Counted Cells

`Rc(T)` and `Arc(T)` are heap cells with automatic reference counting. A handle is a new owner, so a second handle is spelled `Rc.clone(h)`:

```yo
// A shared cell: `Rc(T)` counts the handles to one heap cell.
Resource :: struct(id : i32);
impl(
  Resource,
  Drop(
    drop : (fn(self : &mut Self) -> unit)({
      // `drop` runs when the reference count reaches zero
    })
  )
);

// Usage
s1 := Rc.new(Resource(id : i32(1))); // RC = 1
s2 := Rc.clone(s1); // RC = 2 (both handles point to the same cell)
s3 := Rc.clone(s2); // RC = 3
// When s1, s2, s3 go out of scope, RC decrements
// When RC reaches 0, the payload's `drop` runs and the cell is freed
```

### Choosing a value, a borrow or a shared cell

Two questions pick the shape of a type that holds state:

1. Is it written after construction?
2. Is it needed by two owners that outlive each other's calls?

No and no: a plain `struct`, passed by `&` and returned by value. Yes and no: an
owned value, lent `&mut` where it is written and `&` where it is read. Yes and
yes: `Rc(RefCell(S))`.

std's types show the method shapes. Each method has exactly one:

- A builder consumes and returns: `Command.new(p).arg(a).arg(b)` as a chain, or
  `cmd = cmd.arg(a);` on a `mut(cmd)` binding. `HttpRequest`/`HttpResponse`
  `.header`/`.with_body` and `FetchOptions.with_*` work the same way.
- A mutator lends: `mut(u) := Url.parse(&s).unwrap(); u.set_path(&p);`. So do
  `ArgParser.add_*`, the `Rng` draws and `Interval.tick`.
- A finaliser consumes: a hasher's `update(&mut self)` feeds it, and
  `finish(self)` ends it, so a second `finish` is a use after move (E0901).
- `HttpServer` is the shared one. Its `serve` future owns a `server.clone()`,
  and the kept clone calls `stop` from the handler or another task.

### Reading the count

The builtin `ref_count(x)` returns the number of handles to the cell `x` holds, as a `usize`; an `Arc(T)` is read with an atomic load. For a value type (a plain `struct`, an integer) it is always `1`, known at compile time. A `Box` has no count, so `ref_count(b)` is a compile error. The count is meant for uniqueness checks (copy-on-write) and tests, not for program logic.

```yo
a := Rc.new(i32(42));
b := Rc.clone(a);
assert(ref_count(b) == usize(2), "two handles, one cell");
```

### Explicit Allocators

RC decides when an object dies; an explicit allocator decides where it lives. A creation with no allocator argument goes to the global allocator; a placement is one argument at the creation site: `alloc : .Some(a)`, for `Box.new`, `Rc.new` and `Arc.new` and for the containers' `new` / `with_capacity`:

```yo
{ ArrayList } :: import("std/collections/array-list");
Point :: struct(x : i32, y : i32);

// `a` is any `Allocator` value, e.g. `Allocator.global()`.
p := Rc.new(Point(x : i32(3), y : i32(4)), alloc : .Some(a)); // placed in `a`
p2 := Rc.new(Point(x : i32(1), y : i32(2))); // no argument: the global allocator
xs := ArrayList(i32).new(alloc : .Some(a)); // the buffer lives in `a`
```

No new keyword is involved, and there is no allocation scope: what a call does never depends on its caller. Every block carries its owner in a 16-byte prefix, so its release always returns to the allocator that made it, on any thread. The safety rules are in [MEMORY_SAFETY.md](./MEMORY_SAFETY.md#explicit-allocators); the full guide is [EXPLICIT_ALLOCATORS.md](./EXPLICIT_ALLOCATORS.md).

### Copy

`Copy` is the prelude marker for a value whose copy is a bitwise copy. It requires `Clone`, as Rust's `Copy: Clone` does: the trait is declared `Copy :: trait(where(Self <: Clone))`, so every `Copy` impl needs a `Clone` impl beside it, and `where(T <: Copy)` lets a generic body call `x.clone()`. The integers, floats, `bool`, `char`, `unit`, `str` views and raw pointers implement both, and so do `Option(T)` and `Result(T, E)` when their payloads do. A named type opts in with `derive(T, Copy, Clone)`, and a generic one with a `where` bound:

```yo
Point :: struct(x : i32, y : i32);
derive(Point, Copy, Clone);

Pair :: (fn(comptime(T) : Type) -> comptime(Type))(struct(a : T, b : T));
derive(generic(T : Type), where(T <: Clone), Pair(T), Clone);
derive(generic(T : Type), where(T <: Copy), Pair(T), Copy);

main :: (fn() -> unit)({
  p := Point(x : i32(1), y : i32(2));
  q := p; // a copy: `p` stays usable
  r := p.clone(); // the derived clone, which for a Copy type is the copy
});
export(main);
```

The impl is checked. A `Clone` impl must cover the same instantiations, and the compiler never writes one: `derive(T, Copy)` alone is an error naming `derive(T, Copy, Clone)`. Every field and variant payload must be `Copy`, and the error names the first one that is not (a `String` field: `holds a move-only value in its field \`name\``). A type that implements `Drop` cannot be `Copy`, in either order, and neither can a reference type. `derive(T, Clone)` is always allowed (a field-wise clone of `Copy` fields is the bitwise copy), and it is how a type that is `Copy` only under a bound gets `clone()` at every instantiation: `derive(generic(T : Type), where(T <: Clone), Pair(T), Clone)` — the derive's clone calls `.clone()` on its fields, so it needs the bound. Together with `derive(generic(T : Type), where(T <: Copy), Pair(T), Copy)`, it makes `Pair(i32)` copy implicitly and `Pair(String)` clone explicitly. A hand-written `Clone` impl is an error only on a type that is `Copy` for every instantiation the impl serves, such as a concrete `Copy` type; a generic one that also serves types that are not `Copy`, like the prelude `Option(T)`'s, is allowed. A tuple, an `Array(T, N)`, an anonymous record, a closure and a `fn` pointer have no declaration to annotate, so each is `Copy`, and `Clone`, exactly when all its parts are. When it is `Copy`, `x.clone()` is the copy, so `f.clone()` on a `fn` pointer works; a record or closure that is `Clone` but not `Copy` clones field-wise, copying each `Copy` part and cloning the rest. A closure's parts are its capture record, as in Rust: a by-value capture counts with its own type (a listed `{ s }`, and an implicit capture too, since a closure bound to a name owns what it captures), a `&` capture is a pointer and so `Copy`, and a `&mut` capture makes the closure neither `Copy` nor `Clone`. So a closure that owns a `String` is `Clone` but not `Copy`: `d := c` moves it, and `c.clone()` gives a second closure with its own `String`. `Rc`, `Arc`, `String`, the collections and `Dyn` never are. A raw pointer's `p.clone()` copies the pointer, never the pointee; when the pointee has a field whose name the pointer also owns as a method (`clone`, `add`, `sub`, `offset_from`), `p.m(...)` is an error that names `p.*.m(...)` for the pointee's field and, for the pointer's clone, the copy `q := p`.

`Copy` is the rule. A plain-data type that is not `Copy` is copied only explicitly: `q := p` moves a `Point` without `Copy`, and a later use of `p` is E0901, whose note names `derive(Point, Copy, Clone)` and `p.clone()`. A `&T` parameter or a `match` binding of one borrows it, so storing or returning it there is E0901 too; take the parameter by value (`p : Point`, without `&`) to own it. Compile-time-only types, control-bound records such as `Exception`, unions, C opaque types and refinements of a `Copy` type keep copying implicitly.

### Move-only values

A resource (a file descriptor, a lock, a socket) is a value that must not be copied: two copies would release it twice. A value type (`struct`, `enum`, `newtype`) that implements `Drop` is **move-only**, and so is a plain value type that is neither `Copy` nor `Clone` (a token that must stay unique needs no `Drop`: declare neither), and every value that holds one: a struct field, an enum payload, a tuple or array element, a closure capture. `Option(Fd)` and `Tuple(Fd, i32)` are move-only. A counted handle (`Rc`, `Arc`) never is, whatever it holds, because its copies share one cell; its payload's `Drop` runs once, when the count reaches zero.

```yo
{ println } :: import("std/fmt");
Fd :: struct(n : i32);
impl(
  Fd,
  Drop(
    drop : (fn(self : &mut Self) -> unit)(println(`closing ${self.n}`)) // a real one would close the descriptor
  )
);

peek :: (fn(f : &Fd) -> i32)(f.n); // a `&T` parameter borrows: no copy
keep :: (fn(f : Fd) -> unit)(()); // a by-value parameter moves the value in

main :: (fn() -> unit)({
  a := Fd(n : i32(3));
  n := peek(&a); // borrowed; `a` is still usable
  b := a; // moves `a` into `b`
  // a.n           // E0901: use of moved value: `a`
  keep(b); // moves `b`; `keep` drops it when it returns
});
export(main);
```

Every copy point moves a move-only value: `:=`, `=`, a `sink` argument, a field or element store, a constructor argument, a return and a closure capture. A use after the move is E0901, and its note says why the type is move-only. A move-only value cannot be copied out of storage it does not own either: a `&T` parameter and a `match`/`for` binding borrow it, a field belongs to its holder (there are no partial moves), and a module-level binding is never moved. A value moved in some arms of a `cond`/`match` is dropped at the end of each arm that keeps it, so where the arms meet it is gone on every path and a later use is E0901 (the static form of Rust's drop flag: the arms are structured, so no runtime flag is needed). Where the ways out of a loop meet, a value is still moved on all of them or on none (E0907). An assignment statement (`x = y;`, `h.f = y;`, `xs(i) = y;`) drops the old value right after the store, as Rust does; `old := (x = y)` keeps it in `old` instead. Its single owner runs `drop` exactly once, when it drops the value, and then drops its fields. A type that implements `Clone` is copied explicitly with `x.clone()`; to share one value, put it behind a reference type.

To move a field out of a holder that stays alive, use `std/mem` (Rust's `std::mem`): `replace(&mut h.f, v)` stores `v` and returns the old value, `take(&mut h.f)` stores `T`'s default (`where(T <: Default)`) and returns the old value, and `swap(&mut a, &mut b)` exchanges two places. Each moves bitwise, so a move-only value is neither copied nor dropped twice. They live in their own module rather than the prelude, so the names stay free for your own definitions: `{ replace, take, swap } :: import("std/mem");`.

A generic function is checked at each instantiation: `ArrayList(Fd).get(i)` copies an element out, so that instantiation is E0901, reported at the call. A collection element is reached by place instead: `xs(i)` reads it in place, `xs.with(i, (v) => …)` runs a body on it borrowed `&mut` and returns the body's result, `xs.take(i)` moves it out and leaves `T`'s default, `xs.swap(i, j)` exchanges two elements, and `replace(&mut xs(i), v)` from `std/mem` moves a new value in and the old one out. Each copying accessor has a cloning sibling for an element that implements `Clone`: `get_cloned`, `first_cloned` and `last_cloned` on `ArrayList`; `get_cloned`, `front_cloned` and `back_cloned` on `Deque`; `get_cloned` on the maps, with `get_key_value_cloned` (`HashMap`), `get_index_cloned` (`OrderedMap`) and `first_entry_cloned`/`last_entry_cloned` (`BTreeMap`); and `peek_cloned` on `PriorityQueue`. `xs.extend(ys)` consumes `ys`; `xs.extend_cloned(&ys)` appends clones and keeps it. `Option` and `Result`'s `unwrap`, `expect`, `unwrap_or`, `unwrap_or_else`, `unwrap_or_default`, `unwrap_err` and `expect_err` consume their receiver, so `make().unwrap()` moves a move-only payload out.

### std's resources are move-only

The resources in `std/` are move-only values: `File`, `TempDir`, `TempFile`, `Watcher`, `TcpStream`, `TcpListener`, `UdpSocket`, `UnixStream`, `UnixListener`, `TlsStream`, `HttpClient`, `Child` and its pipe handles (`ChildStdin`, `ChildStdout`, `ChildStderr`), `Thread`, and a `BufReader`/`BufWriter` that owns one of them. Each is a struct whose state lives in a `Box`, so the handle can move while a future or the runtime holds the state's address. Dropping the handle releases the resource: the descriptor is closed, the temporary removed, the watch stopped, the thread detached. The `std/sync` primitives (`Mutex`, `RawMutex`, `RwLock`, `Cond`, `Barrier`, `Semaphore`, `WaitGroup`, `Once`, `OnceCell` and the `Atomic*` types) are move-only values the same way, shared across threads as `Arc(Mutex(T))`; `Channel(T)` is a value holding an `Arc` of its queue, and `ch.clone()` is another handle on it.

- **A copy is E0901.** `g := f` moves the file, and a use of `f` afterwards is E0901 (use of moved value). Storing one handle twice, or capturing it in two closures, is E0901 as well. Before this change a `File` was a reference handle, and a copy shared its descriptor and position.
- **Lend it.** Every method takes `self : &Self`, so `f.read_to_string(io)` borrows `f`. A function that only uses a resource takes `&File`.
- **Share it through a reference type.** On one thread, `Rc.new(f)` gives an `Rc(File)` whose handles all reach the one file (`h.*.read_to_string(io)`). Across threads, use `Arc(Mutex(TcpStream))`; that needs a `Send` resource: the sockets, `File`, the temporaries, `Child` and its pipes, and `Thread` (`File`, the temporaries and `UnixListener` hold a `String` path, a value since B8). `Watcher`, `TlsStream` and `HttpClient` stay on their thread. A `ref` struct that holds a resource holds it as an `Rc` field for the same reason, as `HttpServer` holds its listener.
- **Moving it out.** `Option(T).unwrap` reads through a borrow and cannot move a move-only payload out. Use a consuming match instead: `f := match(opt, .Some(x) => x, .None => …)`.
- **Hand it over.** `BufReader(File).new(f)` and `TcpListener.incoming()` take ownership (`sink`); `get_ref()` and `Incoming.listener()` lend it back, and `BufReader.into_inner()` / `BufWriter.into_parts()` give it back by value. To serve a socket from a spawned task, move it into the task.
- **Dropping it releases it.** A `Child` dropped without `wait()` closes the pipe ends it still holds (it does not wait for the process).

Every I/O method's future borrows the resource until it completes, because the descriptor it uses is closed when the resource drops. That covers every read, write, `close`, `flush`, `set_len`, `metadata`, `accept`, `connect` (UDP), `send`/`recv`, `shutdown` and socket option on the resources above, `BufReader.read_line`, `Child.wait` and its pipe reads and writes, `HttpClient.fetch`, `Watcher.next`, the `Reader`/`Writer` defaults (`read_to_end`, `read_to_string`, `write_all`), and the free functions built on them (`io.copy`, `read_http_message`). A borrowing future follows the rules of §3.13 A2:

- Await it where it is made. It cannot be bound to a name, spawned or returned (E0909).
- Its effect bundle must be a place. Write `b := IoExn(io : io, exn : exn); io.await(f.read_to_string(io), b)`; an inline `IoExn(...)` in the `io.await` is E0910.
- The borrowed resource cannot live inside an `Rc` payload or behind a pointer dereference (E0909): lend the handle instead.

For the same reason there is no `Dyn(Reader)` or `Dyn(Writer)`. The traits' defaults (`read_to_end`, `read_to_string`, `write_all`) return futures that borrow the reader or writer, and a vtable's future type carries no borrow, so `dyn(r)` as either trait object is E0909 for every implementor. Take one through a generic `Impl(Reader)` / `Impl(Writer)` parameter instead.

### The destructor: `Drop`

`Drop` is the destructor trait, and its method `drop` has Rust's semantics: it runs automatically, exactly once, when the owner drops the value or the last `Rc`/`Arc` reference goes away, and a value type that implements it is move-only. Its receiver follows Rust's `drop(&mut self)`: `drop : (fn(self : &mut Self) -> unit)`, so a destructor may take a field out or reset it (`self.f = .None`) before the fields are dropped, and an impl that declares `self : &Self` does not conform.

Calling the destructor by hand is error E0915, as in Rust: `x.drop()`, `Fd.drop(&x)` and `(Fd <: Drop).drop(&x)` would run it a second time on a live value. Reading it as a value, `f := Fd.drop`, is E0915 too, since a call through `f` would do the same. A method of another trait that happens to be named `drop` is an ordinary method, called directly or through `Dyn`. A destructor does not call its fields' destructors either: they drop after it returns. To end a value early, pass it to the prelude's `drop(x)`, which moves it in and drops it when the call returns; a later use of `x` is E0901.

```yo
{ println } :: import("std/fmt");
Fd :: struct(n : i32);
impl(Fd, Drop(drop : (fn(self : &mut Self) -> unit)(println(`closing ${self.n}`))));

main :: (fn() -> unit)({
  a := Fd(n : i32(3));
  drop(a); // prints "closing 3" now
  // a.drop()      // E0915: explicit call of the destructor
  // a.n           // E0901: use of moved value: `a`
});
export(main);
```

A resource that must be released while other references to it may still be live gets an ordinary method its destructor delegates to, such as `TcpStream.close_sync()`.

## Pointers

Yo uses pointers (`*(T)`) for direct memory access, similar to C. Operations that dereference or do arithmetic on raw pointers require an explicit `unsafe(...)` wrap — see [Memory Safety](#memory-safety) below.

```yo
// Pointer type: *(T)
x := 1;
y := 2;

swap :: (fn(a : *i32, b : *i32) -> unit)(
  unsafe({
    tmp := a.*; // Dereference pointer
    a.* = b.*;
    b.* = tmp;
  })
);

swap(addr_of(x), addr_of(y)); // Pass pointers to x and y
// Now x == 2, y == 1
```

For day-to-day in-place mutation, prefer the `name : &mut T` parameter form (see [Type Methods](./FUNCTIONS.md#type-methods)) — it lowers to the same `T*` ABI but stays safe and the caller lends the places with `&mut` (`swap(&mut x, &mut y)`) instead of taking raw addresses. Raw `*(T)` is reserved for FFI and the low-level cases this section covers.

`addr_of(x)` where `x` is a `&T` parameter, or a place inside one (`addr_of(x.field)`), is error E0921: a `&T` parameter is passed as a copy of the caller's value, so its address is the callee's copy and dangles when the call returns. Code that needs the caller's address takes `x : *T` and the caller passes `addr_of(place)`, or takes `x : &mut T`, which is passed as a pointer. A projection's `&T` parameter (a function returning `&T` or `&mut T`) is passed as a pointer and keeps `addr_of`; that is how the prelude's `Array` `Index` impl reaches the element.

### Pointer Operations

```yo
// Create a pointer with addr_of
x := 42;
ptr := addr_of(x); // ptr: *(i32)
// Dereference with .* (requires unsafe — may read invalid memory)
value := unsafe(ptr.*); // value == 42
// Modify through pointer (requires unsafe — could write to invalid memory)
unsafe(ptr.* = 100); // x is now 100
// Pointer arithmetic (requires unsafe — could produce OOB address)
arr := [1, 2, 3, 4, 5];
ptr := addr_of(arr(0)); // Pointer to first element
ptr2 := unsafe(ptr.add(2)); // Point to third element
value := unsafe(ptr2.*); // value == 3
// Pointer casting (safe — just changes type label on the address)
float_ptr := (*f32)(ptr); // Cast pointer to *(f32)
```

### Pointer Arithmetic and Comparison

Pointer arithmetic uses methods — `p.add(n)`, `p.sub(n)`, `p.offset_from(q)` — which require `unsafe(...)`. Pointer comparison uses the ordinary operators (`==`, `!=`, `<`, `<=`, `>`, `>=`) via the `Eq`/`Ord` impls on `*(T)` and stays safe — comparing addresses can't violate memory safety. Note that `*(T) ==` compares ADDRESSES (identity), while a handle such as `Rc(T)` compares VALUES via its own `Eq` impl.

```yo
pragma(Pragma.AllowUnsafe); // raw pointers need the unsafe-capable pragma
{ assert } :: import("std/assert");

test("Pointer arithmetic", {
  x := 12;
  p := addr_of(x);

  // Addition and subtraction (require unsafe — could produce
  // out-of-bounds addresses):
  q := unsafe(p.add(2)); // Advance pointer by 2 elements
  z := unsafe(q.sub(2)); // Go back 2 elements
  // Comparison operators (safe — addresses are just data):
  assert(q > p); // q is after p
  assert(p < q); // p is before q
  assert(q >= p); // Greater or equal
  assert(p <= q); // Less or equal
  assert(z == p); // Equal (same address)
  assert(p != q); // Not equal
  // Pointer difference also requires unsafe (assumes both point
  // into the same object):
  diff := unsafe(q.offset_from(p)); // Distance: 2 elements
  assert(diff == 2);
});
```

### Pointer Operations Reference

Arithmetic (methods, require `unsafe(...)`):

- `p.add(n)` : Advance by `n` elements
- `p.sub(n)` : Go back by `n` elements
- `p.offset_from(q)` : Signed element distance (`isize`)

Comparison (ordinary operators via `Eq`/`Ord` on `*(T)`, safe):

- `==` / `!=` : Address equality / inequality
- `<` / `<=` / `>` / `>=` : Address ordering

### The consume Function

`consume` tells the compiler that you're initializing memory, not overwriting an existing value. This prevents attempting to drop uninitialized memory:

```yo
// Without consume - Error: tries to drop uninitialized value
ptr.* = some_value; // Danger!
// With consume - OK: initialization, no drop
consume(ptr.* = some_value);
```

On any other argument, `consume(x)` moves `x` (a later use is "use of moved value") and, since it returns `unit`, it is the value's last owner: an owned value is released at the consume, exactly as `drop(x)` releases it. A binding that does not own its value (a `&T` borrow) is only marked moved.

For more pointer examples, see `tests/ptr.test.yo`.

### Nullable Pointers

Yo uses `Option(*(T))` for nullable pointers:

```yo
// malloc returns Option(*(void)) — it is NOT generic, so cast before use.
some_ptr := malloc(size_of(i32));
match(
  some_ptr,
  .Some(vp) => {
    ptr := (*i32)(vp);
    ptr.* = i32(42);
    printf("value: %d\n", ptr.*);
    free(some_ptr);
  },
  .None => printf("Allocation failed\n")
);
```

**Note**: Raw pointers are unsafe. Use `Rc`, `Arc`, `Box` and the owned collections for safe memory management whenever possible.

### `Option` of a handle is one pointer

`Option(T)` where `T` is a raw pointer OR a counted or boxed handle (`Rc`, `Arc`, `Box`) lowers to the bare pointer, with `NULL` as `.None`. The same niche applies to any two-variant enum with one fieldless variant and one single-field handle payload. There is no tag word and no extra padding: `size_of` is the pointer's own, and a `match` on such a value compiles to a NULL test.

```yo
pragma(Pragma.AllowUnsafe); // only so size_of may name a pointer type

sz_opt :: size_of(Option(*i32)); // == size_of(*i32) — the pointer itself
sz_str :: size_of(String); // == size_of(*u8)   — the handle itself
Tree :: enum(Empty, Node(child : Rc(Self)));
sz_tree :: size_of(Tree); // == size_of(*u8)   — NULL is Empty
```

### Memory Safety

For the user-facing guide, see [MEMORY_SAFETY.md](MEMORY_SAFETY.md) — covers the safe-by-default contract, `&mut T` parameters, the `pragma(Pragma.AllowUnsafe);` opt-in, `unsafe(...)` per-op wraps, `// SAFETY:` comment convention, `yo unsafe-report`, the `unwrap` ban, and the integer arithmetic rules (overflow, division by zero and out-of-range shifts abort).

Ownership, moves and copies, `&T`/`&mut T` references and their origins, and the borrow rules the compiler checks are explained in [OWNERSHIP_AND_BORROWING.md](OWNERSHIP_AND_BORROWING.md).

Yo's safety model is layered (the design plan is [plans/reference/MEMORY_SAFETY.md](../../plans/reference/MEMORY_SAFETY.md)):

- **`Rc(T)`** is a reference-counted cell, automatically freed at its last handle (a cycle leaks unless a `Weak` breaks it). Memory-safe by construction.
- **`Arc(T)`** provides atomic-RC ownership for thread-shared cases; a `Send` value is transferred to another thread by moving it.
- **`*(T)` raw pointers** are available only in a file that declares `pragma(Pragma.AllowUnsafe);`. Inside such a file the `unsafe(...)` wrap is the per-operation AUDIT MARKER that `yo unsafe-report` keys on — and the convention `std/`, `src/` and `tests/` follow — not a second compiler gate: a bare `p.*` in a pragma'd file compiles. In a file WITHOUT the pragma the whole raw-pointer surface is rejected, including the `*(T)` type itself.

`unsafe(...)` is a regular builtin call that takes exactly one expression. It is purely a compile-time marker — at codegen time it lowers to its inner expression, no runtime cost.

```yo
// Pointer deref requires unsafe:
read :: (fn(p : *i32) -> i32)(unsafe(p.*));

// Pointer arithmetic likewise:
advance :: (fn(p : *i32, n : usize) -> *i32)(unsafe(p.add(n)));

// Multi-statement unsafe with a block:
write_and_read :: (fn(p : *i32, v : i32) -> i32)(
  unsafe({
    p.* = v;
    p.*
  })
);

// Pointer comparison (==, <, etc.) and *(T) casts (e.g., (*u8)(p))
// stay safe — they don't dereference, so they're not gated.
```

**What requires `unsafe(...)`**: pointer dereference (`.*`), pointer arithmetic (`.add(n)`, `.sub(n)`, `.offset_from(q)`), and `consume(p.* = v)`.

**What needs no additional `unsafe(...)` wrap** (inside a file that already declares `pragma(Pragma.AllowUnsafe);`): taking an address (`addr_of(x)`), passing/storing/returning pointers, pointer comparison (`<`, `==`, etc.), pointer-type casts (`(*u8)(p)`), and `asm(...)` (already implicitly unsafe). None of these are available in SAFE code — without the pragma, `&(x)` is rejected at the construction site and a `*(T)` type in any signature is rejected outright.

The unsafe surface is greppable: every `unsafe(` token marks a place where raw memory ops happen. A file must declare `pragma(Pragma.AllowUnsafe);` at the top before it can use `unsafe(...)` or perform raw pointer operations. `std/`, `src/`, and `tests/` files declare this pragma explicitly; user code (`main.yo`, the rest of your project) defaults to safe mode and gets a compile error if it tries to use `unsafe(...)`.

For an at-a-glance audit, run `yo unsafe-report` (or `yo unsafe-report ./std` for stdlib alone). It lists every `unsafe(...)` site, `asm(...)` block, `extern(...)` declaration, and pragma-declaring file, with `file:line:col` jumps for editors. The `--json` flag emits machine-readable output for CI integrations.

```yo ignore
// File without pragma — `unsafe(...)` is rejected:
main :: (fn() -> unit)({
  x := i32(42);
  v := unsafe(x); // error: 'unsafe(...)' is not available in safe code.
  //        To use raw pointer operations, declare at the top:
  //            pragma(Pragma.AllowUnsafe);
});
```

```yo
// Opt in by adding the pragma at the top of the file:
pragma(Pragma.AllowUnsafe);

main :: (fn() -> unit)({
  x := i32(42);
  p := addr_of(x);
  v := unsafe(p.*); // OK
});
```

### `&mut` Parameters

For in-place mutation without raw pointers, use a `name : &mut T` parameter. The `&mut` prefixes the parameter's type, and the parameter behaves like a binding to the caller's variable — reads access the current value, writes update the caller's storage. At codegen time `name : &mut T` lowers to `T*` in C; the caller lends the place with `&mut x` and the compiler passes its address.

```yo
{ assert } :: import("std/assert");

swap :: (fn(a : &mut i32, b : &mut i32) -> unit)({
  tmp := a.*;
  a.* = b.*;
  b.* = tmp;
});

increment :: (fn(n : &mut i32) -> unit)({
  n.* = (n.* + i32(1));
});

main :: (fn() -> unit)({
  mut(x) := i32(1);
  mut(y) := i32(2);
  swap(&mut x, &mut y); // the call site lends each place with `&mut`
  assert(x == i32(2), "swapped");
  assert(y == i32(1), "swapped");

  mut(counter) := i32(0);
  increment(&mut counter);
  increment(&mut counter);
  assert(counter == i32(2), "incremented");
});
```

A `&mut T` parameter cannot be combined with `sink(...)` (opposite calling conventions) or with `generic(...)`; a compile-time parameter carries the mode on its type (`comptime(x) : &mut T`). For chained calls, passing a `&mut T` parameter through to another function's `&mut T` parameter works as expected (the parameter already holds a borrow, so it is passed bare):

```yo
double :: (fn(n : &mut i32) -> unit)({
  n.* = (n.* + n.*);
});

double_both :: (fn(x : &mut i32, y : &mut i32) -> unit)({
  double(x); // passes the borrow through to double's `&mut` parameter
  double(y);
});
```

### RAII (Resource Acquisition Is Initialization)

Yo manages memory automatically: an owned value is dropped at its owner's scope end, and a counted cell (`Rc`, `Arc`) is freed when its reference count reaches zero.

```yo
test :: (fn() -> unit)({
  x := String.from("World!"); // RC = 1
  // ... use x ...
  // At end of scope, RC is decremented
  // If RC reaches 0, memory is automatically freed
});
```

## Advanced Type System

### Higher-Kinded Types (HKT)

Yo supports higher-kinded types through **comptime function types as kinds**. Type constructors like `Option` and `Result` are already first-class comptime function values — HKT lets you abstract over them.

| Haskell Kind  | Yo Equivalent                                                  |
| ------------- | -------------------------------------------------------------- |
| `*`           | `Type`                                                         |
| `* -> *`      | `fn(comptime(T) : Type) -> comptime(Type)`                     |
| `* -> * -> *` | `fn(comptime(A) : Type, comptime(B) : Type) -> comptime(Type)` |

#### HKT generic parameters

Declare a generic parameter with a function-type kind to accept type constructors:

```yo
// F is a type constructor (kind: Type → Type)
identity :: (
  fn(
    generic(F : (fn(comptime(T) : Type) -> comptime(Type)), A : Type),
    x : F(A)
  ) -> F(A)
)(x);

// Usage:
(x : Option(i32)) = .Some(i32(42));
result := identity(generic(Option, i32), x); // result: Option(i32)
inferred := identity(x); // F = Option, A = i32 from the argument
```

A kind-annotated parameter is inferred from an argument's instantiation: `x : F(A)` given an
`Option(i32)` binds `F` to the constructor `Option` and `A` to `i32`, and a result `F(A)` is
then the same `Option(i32)` a direct call would build.

#### HKT traits

Define traits parameterized by type constructors:

```yo
// Functor trait — F is a type constructor
Functor :: (fn(comptime(F) : (fn(comptime(T) : Type) -> comptime(Type))) -> comptime(Trait))(
  trait(
    map : (fn(generic(A : Type, B : Type), self : F(A), f : (fn(a : A) -> B)) -> F(B))
  )
);

// Implement Functor for Option
impl(
  generic(A : Type),
  Option(A),
  Functor(Option)(
    map : (fn(generic(A : Type, B : Type), self : Option(A), f : (fn(a : A) -> B)) -> Option(B))(
      match(
        self,
        .Some(v) => .Some(f(v)),
        .None => .None
      )
    )
  )
);

// Use the trait method
(x : Option(i32)) = .Some(i32(42));
result := x.map(generic(i32), (fn(a : i32) -> i32)(a + i32(1)));
// result = .Some(i32(43))
```

#### Generic functions with HKT where clauses

```yo
do_map :: (
  fn(
    generic(F : (fn(comptime(T) : Type) -> comptime(Type)), A : Type, B : Type),
    container : F(A),
    f : (fn(a : A) -> B),
    where(F(A) <: Functor(F))
  ) -> F(B)
)(
  container.map(generic(B), f)
);

(x : Option(i32)) = .Some(i32(10));
result := do_map(generic(Option, i32, i32), x, (fn(a : i32) -> i32)(a * i32(2)));
// result = .Some(i32(20))
```

### Generalized Algebraic Data Types (GADTs)

GADTs extend enum types by allowing each constructor to specify the exact type parameter instantiation it returns, using `-> recur(Type1, ...)`:

```yo
Value :: (fn(comptime(T) : Type) -> comptime(Type))(
  enum(
    IntVal(i : i32) -> recur(i32),
    BoolVal(b : bool) -> recur(bool),
    PairVal(a : i32, b : bool) -> recur(i32)
  )
);
```

#### GADT match type refinement

When pattern matching on a GADT value, the type system refines type variables in each branch:

```yo
eval_value :: (fn(generic(T : Type), v : Value(T)) -> T)(
  match(
    v,
    .IntVal(i) => i,
    // T refined to i32, returns i32 ✓
    .BoolVal(b) => b,
    // T refined to bool, returns bool ✓
    .PairVal(a, b) => a // T refined to i32, returns i32 ✓
  )
);

v := Value(i32).IntVal(i32(42));
result := eval_value(v); // result : i32 = 42
```

#### GADT exhaustiveness

When matching a GADT value with a concrete type, unreachable variants are excluded from exhaustiveness checking:

```yo
// Value(i32) can only be IntVal or PairVal
// BoolVal is unreachable (it returns Value(bool), not Value(i32))
eval_int_only :: (fn(v : Value(i32)) -> i32)(
  match(
    v,
    .IntVal(i) => i,
    .PairVal(a, b) => a
    // No .BoolVal needed — it's unreachable for Value(i32)
  )
);
```

An arm for an excluded variant is an error (E0608): no `Value(i32)` holds a
`.BoolVal`. In a generic function over `Value(T)` every variant's arm is
needed, because each instantiation excludes different ones.

#### GADT indices are part of the type

`Value(i32)` and `Value(bool)` are different types even though their payloads have the same
shapes, and a variant constructs only the instantiation its `-> recur(...)` index names:
`Value(i32).BoolVal(true)` and `(v : Value(i32)) = .BoolVal(true)` are E0601 errors. See
[GADTS.md](GADTS.md) for the details.

#### Multi-parameter GADTs

```yo
MyPair :: (fn(comptime(A) : Type, comptime(B) : Type) -> comptime(Type))(
  enum(
    MkIntBool(x : i32, y : bool) -> recur(i32, bool),
    MkBoolInt(x : bool, y : i32) -> recur(bool, i32)
  )
);

my_fst :: (fn(generic(A : Type, B : Type), p : MyPair(A, B)) -> A)(
  match(
    p,
    .MkIntBool(x, y) => x,
    .MkBoolInt(x, y) => x
  )
);
```

#### GADTs with custom discriminants

```yo
Tagged :: (fn(comptime(T) : Type) -> comptime(Type))(
  enum(
    (TagInt(i : i32) -> recur(i32)) = 10,
    (TagBool(b : bool) -> recur(bool)) = 20
  )
);
```

#### Mixed GADT and regular variants

```yo
MixedVal :: (fn(comptime(T) : Type) -> comptime(Type))(
  enum(
    MInt(i : i32) -> recur(i32),
    MBool(b : bool) -> recur(bool),
    MGeneric(v : T) // no GADT annotation — unconstrained
  )
);
```

GADTs have the same runtime representation as regular enums — all type refinement is purely compile-time. For the full design document, see [GADTS.md](GADTS.md).

## Typestate

A protocol state can live in a type, as in ATS's indexed resources
(`FILEptr(mode)`): a phantom comptime parameter that no field mentions, and
functions that accept only the state they need. A wrong-state call is a type
error (E0601).

```yo
Open :: struct();
Closed :: struct();
Handle :: (fn(comptime(S) : Type) -> comptime(Type))(struct(fd : i32));

open_h :: (fn(fd : i32) -> Handle(Open))(Handle(Open)(fd : fd));
read_h :: (fn(h : Handle(Open)) -> i32)(h.fd);
close_h :: (fn(sink(h) : Handle(Open)) -> Handle(Closed))(Handle(Closed)(fd : h.fd));

main :: (fn() -> unit)({
  h := open_h(i32(3));
  c := close_h(h);
  // read_h(c);   // E0601: expected Handle(Open), given Handle(Closed)
  // read_h(h);   // E0901: use of moved value `h`
});
export(main);
```

The pattern is only sound when the old state CANNOT be used after a
transition, so two rules apply:

- **The handle is move-only and the transition takes it with `sink(...)`.**
  The move makes the old name unusable (E0901). A handle type that derives
  `Copy` is COPIED into the call, so the closed handle and its `Open` copy
  would both stay usable.
- **No other alias keeps the old state.** A handle cloned into a second name
  before the transition still has the old type. Keep a typestate handle in
  one name.

std's `File` and sockets keep their state at run time instead.

## Traits

Traits define collections of functions and types that can be implemented for types. They work similarly to traits in Rust. Note that `impl` takes the receiver type as the first argument, followed by the trait implementation.

A trait is defined as a function that returns a `Trait` type containing field definitions.

```yo
// Define a trait (like a trait in Rust)
Summary :: trait(
  summarize : (fn(self : &mut Self) -> String)
);

Display :: trait(
  display : (fn(self : &mut Self) -> String),
  where(Self <: Summary) // Constraint
);

NewsArticle :: struct(
  headline : String,
  location : String,
  author : String,
  content : String
);

// Implement the Summary trait for NewsArticle
impl(
  NewsArticle,
  Summary(
    summarize : (
      self ->
        `${self.headline}, by ${self.author} (${self.location})`
    )
  )
);

// Implement the Display trait for NewsArticle
impl(
  NewsArticle,
  Display(
    display : (
      self ->
        `Headline: ${self.headline}\n`
    )
  )
);

// Pass in function
notify :: (fn(item : &mut NewsArticle) -> unit)({
  println(`Breaking news! ${item.summarize()}`);
});

// Generic function with trait constraint
notify2 :: (fn(generic(T : Type), item : &mut T, where(T <: Display)) -> unit)({
  println(`Breaking news! ${item.summarize()}`);
  println(`Breaking news! ${item.display()}`);
});
```

### Static trait methods

A trait method with no `self` parameter is a static method. Call it on an implementing type (`Point.make(...)`), or on a type parameter the trait constrains (`T.make(...)`). Constructor-style traits are written this way; `FromJson`'s `from_json(v)` is one.

```yo
{ println } :: import("std/fmt");

// A trait method without `self` is a static (constructor-style) method.
Make :: trait(make : (fn(n : i32) -> Self));

Point :: struct(x : i32, y : i32);
impl(Point, Make(make : (n -> Point(x : n, y : n))));

Meters :: struct(v : i32);
impl(Meters, Make(make : (n -> Meters(v : (n * i32(1000))))));

// Called on the type, or on a type parameter in a generic body.
build :: (fn(comptime(T) : Type, n : i32, where(T <: Make)) -> T)(T.make(n));

main :: (fn() -> unit)({
  p := Point.make(i32(3));
  m := build(Meters, i32(2));
  println(`${p.x} ${p.y} ${m.v}`); // 3 3 2000
});
export(main);
```

### Associated types in a trait's `where` clause

A trait declares an associated type before the members that name it (`Item : Type` first, then `next : (fn(...) -> Option(Self.Item))`). Its `where` clause may use its own projections to constrain a DIFFERENT type, as `IntoIterator` does with `where(Self.IntoIter <: Iterator(Item := Self.Item))`. It may not bind an associated type of `Self` itself to one of `Self`'s own projections:

```yo
Source :: trait(Item : Type, pull : (fn(self : &mut Self) -> Option(Self.Item)));

// error: Expected type for associated type constraint "Item", got: (Self.Item)
Peekable :: trait(
  Item : Type,
  peek : (fn(self : Self) -> Option(Self.Item)),
  where(Self <: Source(Item := Self.Item))
);
```

Both of these are accepted:

```yo
Source :: trait(Item : Type, pull : (fn(self : &mut Self) -> Option(Self.Item)));

// Constrain `Self` without binding its associated type...
Rewindable :: trait(
  rewind : (fn(self : &mut Self) -> unit),
  where(Self <: Source)
);

// ...or constrain a different associated type through `Self.Item`.
Pullable :: trait(
  Item : Type,
  Iter : Type,
  source : (fn(self : Self) -> Self.Iter),
  where(Self.Iter <: Source(Item := Self.Item))
);
```

### Coherence: one impl per type and trait

A type implements a trait at most once, in the whole program
(`plans/reference/TRAIT_COHERENCE.md`). Each of these is error E0612:

- a second `impl(P, Summary(...))`, in the same module or another one;
- an impl of a trait that an imported module or the prelude already implements for that type,
  such as `impl(i32, ToString(...))`;
- a blanket impl (`impl(generic(T), where(T <: Bound), T, Summary(...))`) together with a
  concrete impl of `Summary` for a type that satisfies `Bound`, in either order.

Yo has no specialization, so a more specific impl does not override a general one; before this
rule the first impl registered won silently and the other was dead code. Two instantiations of a
generic trait are different traits (`Eq(String)` and `Eq(str)`), and blanket impls whose bounds
do not overlap are fine.

### Trait Method Disambiguation

When a type implements multiple traits that define methods with the same name, `where` clause constraints determine which trait's method is used:

```yo
T1 :: trait(get_number : (fn(self : Self) -> i32));
T2 :: trait(get_number : (fn(self : Self) -> i32));

Point :: struct(x : i32, y : i32);
impl(Point, T1(get_number : (self -> self.x)));
impl(Point, T2(get_number : (self -> self.y)));

// Implicit dispatch — where(T <: T1) constrains self.get_number() to T1's method
use_t1 :: (fn(generic(T : Type), self : T, where(T <: T1)) -> i32)({
  return(self.get_number()); // Returns self.x (10)
});

// Explicit dispatch — (T <: T2).method(self) syntax
use_t2 :: (fn(generic(T : Type), self : T, where(T <: T2)) -> i32)({
  return((T <: T2).get_number(self)); // Returns self.y (20)
});

point := Point(10, 20);
use_t1(point); // 10
use_t2(point); // 20
```

## String

### String literal as `str` or C string pointer

```yo
s := "Hello"; // s : str — a string literal is the builtin static string view `str`.
(s2 : *u8) = "Hi"; // You can explicitly declare a C string pointer (unsafe-capable files only).
s3 := (*u8)("Hi"); // Or use a pointer cast to get a C string pointer.
```

### String (Growable UTF-8 String)

Heap-allocated, growable UTF-8 string — the same shape as Rust's `String`. It is
NOT immutable: `push_str`, `push_string`, `push_byte`, `push_rune`, `reserve`,
`clear`, `truncate`, `insert_str`, `insert`, `remove` and `pop` take
`self : &mut Self` and mutate in place. Operators like `+` still produce a new string.

For incremental assembly use `StringBuilder`, a value that owns its byte
buffer: `b2 := b` moves it, `b.clone()` is the
independent copy, and `into_string()` hands the buffer over as the `String`
without a fresh allocation. A builder several owners share is
`Rc(RefCell(StringBuilder))`.

```yo
s := String.new();
s2 := String.from("Hello World!");
s3 := (s + s2); // Create a new string.
```

#### Writing through a copy of a `String`

`clone()` is the independent copy. It copies the bytes (O(n)), so nothing
done to the clone is visible through the original, and the reverse, whether or
not the original was empty. Every mutator takes `self : &mut Self` and writes in
place, and an empty `String` allocates nothing until its first write.

A `String` owns its bytes uniquely (`newtype(_bytes : ArrayList(u8))`, with
`ArrayList` a value). A plain copy is therefore a move: `t := s`, a struct
built from `s`, or `s` passed by value gives the string away, and a later use
of `s` is E0901, whose help names `s.clone()`. A value read out of a
collection is borrowed in place or cloned (`xs.get_cloned(i)`). Nothing shares
a buffer, so no write can reach a string through another name
(`issues/fixed/a-write-through-a-string-copy-is-lost-when-the-string-was-empty.md`,
fixed by this).

A write lands where it is written:

- **A `&T` parameter** `fn(out : &String)` borrows the caller's value.
  Writing it (`out.push_str("!")`, or passing it to a `&mut T` parameter) is
  E0908. To change the caller's string, take `out : &mut String`; to produce a
  new one, take `out` by value (a plain `out : String` owns its argument and
  may write it) and return it.
- **A `for` or `match` binding** borrows too: `for(xs, s => s.push_str("!"))`
  is E0908. `for(&mut xs, s => s.push_str("!"))` writes each element in
  place, and so does `xs(i).push_str("!")`.
- **A struct field** is written through its place: `p.name.push_str("!")` on a
  `p : &mut T` parameter or a local.

```yo
{ String } :: import("std/string");
{ println } :: import("std/fmt");
{ ArrayList } :: import("std/collections/array-list");

// A `&mut T` parameter passes the caller's variable itself.
append_mut :: (fn(out : &mut String) -> unit)({
  out.push_str("!");
});

// A `&T` parameter is borrowed: write a local clone and return it.
with_bang :: (fn(s : &String) -> String)({
  mut(t) := s.clone();
  t.push_str("!");
  t
});

main :: (fn() -> unit)({
  a := String.from("hi");
  mut(b) := a.clone(); // b has its own copy of the bytes
  b.push_str("?"); // a is untouched
  println(`"${a}" "${b}"`); // "hi" "hi?"

  e := String.new();
  mut(f) := e.clone();
  f.push_str("x"); // empty or not, a clone is independent
  println(`"${e}" "${f}"`); // "" "x"

  mut(c) := String.new();
  append_mut(&mut c);
  d := with_bang(&a);
  println(`"${c}" "${a}" "${d}"`); // "!" "hi" "hi!"

  mut(names) := ArrayList(String).new();
  names.push(String.new());
  names.push(String.from("n"));
  for(&mut names, s => {
    s.push_str("!"); // writes the element in place
  });
  println(`"${names(usize(0))}" "${names(usize(1))}"`); // "!" "n!"
});
export(main);
```

Because nothing outside a `String` may write its buffer, the byte API copies or
moves instead of lending: `to_bytes()` returns an independent `ArrayList(u8)`,
`into_bytes()` consumes the string and moves the buffer out (no copy when no
other copy shares it), and `from_bytes(sink(bytes))` / `from_utf8(sink(bytes))`
take the list over. Bytes are read in place with `len()`, `byte_at(i)`,
`get_byte(i)` and `bytes()`; a runtime `String` has no `s(i)` (see
[STRINGS.md](./STRINGS.md)).

#### Template string interpolation with `${}` syntax:

The template string works similarly to JavaScript's template literals, allowing you to embed expressions inside a string using `${}` syntax. The value inside `${}` must implement the `ToString` trait to be converted to a `String`.

```yo
name := "Alice";
age := 16;
greeting := `Hello, ${name}!, age: ${age}`;
// greeting: String
// value "Hello, Alice!, age: 16"
```

A template of two or more parts builds one `String` and appends its parts to it in order: a literal part with `push_str`, an interpolated one with `ToString.append_to(self, out : &mut String)`. The default `append_to` appends `self.to_string()`; `String` and `str` append their bytes by borrow, so a `String` part is never copied first. A type can override `append_to` to write its text straight into the result. A one-part template (`${s}`) is just `s.to_string()`.

##### Format specifications — `${value:spec}`

An interpolation may carry a format spec after a colon, using Rust's and Python's
grammar (minus dynamic width/precision):

```text
spec  := [[fill]align][+][#][0][width][.precision][kind]
align := "<" | ">" | "^"
kind  := "x" | "X" | "b" | "o"
```

```yo
name := `ada`;
n := i32(255);
pi := f64(3.14159);

`[${name:>8}]`; // "[     ada]"   right-align to width 8
`[${name:<6}]`; // "[ada   ]"     left-align
`[${name:^7}]`; // "[  ada  ]"    center
`[${name:*>6}]`; // "[***ada]"    custom fill character
`${n:x}`; // "ff"           lowercase hex
`${n:#06x}`; // "0x00ff"       alternate form, zero-padded
`${pi:.2}`; // "3.14"         two decimals
`${pi:>8.3}`; // "   3.142"     width applies after precision
```

Width is counted in CHARACTERS, and zero padding on a number goes between the
sign or radix prefix and the digits (`${i32(-(42)):08}` is `-0000042`, not
`000-0042`).

Numbers accept every part: sign, radix and zero-fill as well as width, fill, alignment and
truncation. Text, `bool`, `Option`, `Result`, `ArrayList` and the other std types that implement
`ToString` accept width, fill, alignment and truncation, through `Format`'s default member. A
type of your own opts in with one line, since there is no blanket impl (see Coherence above):

```yo
impl(Point, ToString(to_string : (self -> `(${self.x}, ${self.y})`)));
impl(Point, Format());
`[${Point(x : i32(1), y : i32(2)):>8}]` // "[  (1, 2)]"
```

The spec is separated from the expression by a colon with **no space before it**.
A spaced colon is left alone, so an ordinary colon pair inside an interpolation
keeps its meaning, and a colon inside a call's arguments or inside a string
literal — `${parts.join(":")}` — is never mistaken for a separator.

## Box: the Uniquely Owned Cell

`Box(T)` is a heap cell with exactly one owner and no reference count, like
Rust's `Box<T>`. Use it for a recursive type and for a value that needs a
stable address; use `Rc` when the value is shared.

```yo
Tree :: enum(
  Leaf(v : i32),
  Node(l : Box(Self), r : Box(Self))
);
sum :: (fn(t : &Tree) -> i32)(
  match(
    t,
    .Leaf(v) => v.*,
    .Node(l, r) => (sum(&l.*.*) + sum(&r.*.*))
  )
);
t := Tree.Node(Box.new(Tree.Leaf(1)), Box.new(Tree.Leaf(2)));
assert(sum(&t) == 3);
```

- **`Box.new(v)`** moves `v` into a new cell. `b.*` is the payload place, in safe
  code too: `b.* = v` replaces it, and `b.field` / `b.method()` reach it by
  auto-dereference. A pattern looks through a `Box` payload with `Box(p)`,
  as through an `Rc`'s with `Rc(p)`; for now a `Box` is also looked through
  without it.
- **Explicit copies.** A `Box` is never `Copy`. `c := b` moves `b` when it is
  `b`'s last use; any other copy is E0901. `Box.clone(b)` is a deep copy: a
  new cell holding a clone of the payload (`b.clone()` is E0616, because the
  payload may have a `clone` of its own). `Box(T)` implements `Clone` when `T`
  does, so a `Box` of a move-only value is move-only.
- **One drop.** Dropping a `Box` drops its payload and frees the cell.
  `ref_count(b)` is a compile error: there is no count.
- **Moving the payload out.** `b.into_inner()` consumes the `Box`, frees the
  cell and returns the payload, so a move-only payload leaves the cell without
  a copy (`RefCell.into_inner` and `BufWriter.into_parts` use it).
- **`Eq`, `Hash` and `Default`** compare, hash and build the payload.
  `Box(T)` is `Send`/`Sync` exactly when `T` is.
- **Layout.** The `Box` value is one pointer, and `Option(Box(T))` is one
  pointer too (`NULL` is `.None`). A global cell is the payload alone,
  `size_of(T)` bytes as in Rust, and a zero-sized payload allocates nothing.
  A cell an `alloc` argument placed has a 16-byte owner prefix recording the
  allocator in front of the payload, and the handle says so in bit 0 of its
  pointer (every cell is at least 16-byte aligned, so the bit is free).
  `Box`'s payload may be unsized (`comptime(V) : ?Sized`): the
  handle of a `Box([T])` or `Box(Dyn(T))` is two words.
- **Allocators.** `Box.new(v, alloc : .Some(a))` places the cell in `a`;
  without `alloc`, the cell is on the global allocator. The cell is freed through its owner, and `Box.clone(b)`
  lands where `b` lives (a box placed by an explicit allocator clones into that allocator).
  `Box.allocator(b)` reads the owner back (`.None` for the global allocator).
- **Cycles.** A `Box` is part of its owner's value, so an `Rc` cycle closed
  through a `Box` is a cycle of the `Rc` cells: it leaks like any other
  unless a `Weak` breaks it.

## Rc and Reference-Counted Cells

Yo provides `Rc` (built with `Rc.new`) for heap-allocating value types with automatic reference counting.

### Rc Type

> **⚠️ `Rc` is Rust's `Rc`, not Rust's `Box`.** Rust's `Box<T>` is a unique
> owner — passing it moves, cloning it deep-copies. Yo's `Rc(T)` is a counted
> handle: `Rc.clone(a)` makes **a second handle to one heap value and bumps a
> reference count**, exactly like Rust's `Rc::clone`.
>
> ```yo
> a := Rc.new(i32(42));
> b := Rc.clone(a);          // a second handle, NOT a copy of the value
> assert(ref_count(a) == usize(2), "a and b name the SAME value");
> ```
>
> **A second handle is spelled**:
> a handle is a new owner, so sharing is visible where it is created. A
> handle's last use moves it (`b := a` with no later `a`); an implicit copy
> whose source is used again is E0901, whose note names `Rc.clone(a)`. A
> `&Rc(T)` parameter borrows the handle without a copy. A value holding a
> handle (a struct field, an `Option(Rc(T))`) is copied with `.clone()`,
> which clones each handle; a closure takes a second handle in its capture
> list, `{ a : Rc.clone(a) }() => a.*`. The clone is spelled through the type,
> `Rc.clone(a)`, because `a.clone()` could name the payload's own `clone`. `Rc(T)` and `Arc(T)` are `Clone` for every `T`, and the
> clone is always a second handle; a deep copy is `Rc.new(h.*.clone())`. A generic body is judged at each instantiation, so a copy
> of a `T` that is a handle needs `.clone()` there too (`where(T <: Clone)`).
> std's generic readers are judged the same way: `ArrayList(Rc(T)).get(i)`
> and `HashMap.get` copy their element through `T`, so at a handle element
> the call is E0901, reported at your call with the std location as a note.
> Read handle elements through the accessors that do not copy: `xs(i)` in
> place, `xs.get_cloned(i)` for a second handle, or `xs.with(i, ...)`.
>
> What this means in practice: sharing is silent, an `Rc` cycle leaks unless
> broken (Rust's `Box` cannot form one; a `Weak` back edge breaks it, see
> [Weak: a Handle That Does Not Own](#weak-a-handle-that-does-not-own)), and
> `ref_count(b)` / `Rc.try_unwrap` are how you ask about uniqueness.
>
> `Box` is a different type: the uniquely owned, uncounted cell, like Rust's
> `Box<T>` ([Box: the Uniquely Owned Cell](#box-the-uniquely-owned-cell)).

`Rc(T)` is a generic cell type that wraps any value type:

```yo
// Rc is defined in std/prelude.yo
Rc :: (fn(comptime(V) : ?Sized) -> comptime(Type))(
  newtype(_cell : __yo_cell(V))
);
```

The constructor is `Rc(T).new(value, (alloc : Option(Allocator)) ?= .None)`. It
allocates a fresh cell whose count is 1; the count is read with `ref_count(x)`.
`Rc.new(v)` infers `T` from the argument, as `Box.new(v)` and `Arc.new(v)` do;
write the type, `Rc(T).new(...)`, when the argument does not carry it (an enum
shorthand such as `.None`, a closure literal). `alloc : .Some(a)` places the cell
in the allocator `a`; the default, `.None`, places it on the global allocator
([EXPLICIT_ALLOCATORS.md](./EXPLICIT_ALLOCATORS.md)). `dyn(Rc.new(v))` builds an `Rc(Dyn(Trait))`
over a fresh cell ([DYN_DESIGN.md](./DYN_DESIGN.md)).

### Usage Examples

```yo
// Wrap a primitive value
i := Rc.new(42); // i: Rc(i32)
assert(i.* == 42); // Dereference with .*
// Wrap a struct
Point :: struct(x : i32, y : i32);
p := Rc.new(Point(x : 3, y : 4)); // p: Rc(Point)
assert(p.*.x == 3);

// Rc with explicit type
b := Rc(i32)(100); // Same as Rc.new(100)
// The payload is read-only through the handle (E0919); a door writes it
m := Rc.new(i32(10));
Rc.make_mut(&mut m) = i32(20); // in place: m is the only handle
assert(m.* == 20);
```

### Auto-dereference

The prelude's `Deref` trait names the place `w.*` stands for, and
`DerefMut` is its write half:

```yo ignore
Deref :: trait(Target : Type, deref : (fn(self : &Self) -> &Self.Target));
DerefMut :: trait(Target : Type, deref_mut : (fn(self : &mut Self) -> &mut Self.Target));
```

They are chosen as `Index` and `IndexMut` are: a read of `w.*` calls `deref`,
while a write, a `&mut` lend, a `self : &mut Self` receiver and `addr_of` call
`deref_mut`. A type with `Deref` and no `DerefMut` has a read-only `.*`, and
the two impls share one `Target`.

`Box`, `Rc` and `Arc` are **handles**: `w.*` is the payload their pointer
names, read natively, and their `deref` is `&self.*.*`. `Rc` and `Arc` have
no `DerefMut`, because their payload is read-only through the handle. On a
`Deref` type, a field or method the wrapper does not have is looked up on the
payload: `w.field` means `w.*.field` and `w.method()` means `w.*.method()`.

```yo
Point :: struct(x : i32, y : i32);
impl(Point, norm1 : (fn(self : &Self) -> i32)(self.x + self.y));
p := Rc.new(Point(x : 3, y : 4));
assert(p.x == 3); // p.*.x
assert(p.norm1() == 7); // p.*.norm1()
pp := Rc.new(Rc.new(Point(x : 1, y : 2)));
assert(pp.y == 2); // nested wrappers: pp.*.*.y
mut(b) := Box.new(Point(x : 3, y : 4));
b.x = 5; // a place: writes b.*.x — only Box has DerefMut
assert(b.norm1() == 9);
```

- **A name both have is an error (E0616).** `Point` derives `Clone` and so
  does `Rc`, so `p.clone()` could mean either. Write `Rc.clone(p)` for the
  `Rc`'s own `clone` (a new `Rc`) or `p.*.clone()` for the payload's (a
  `Point`); `yo fix` rewrites the call to `Rc.clone(p)`. A name only one of
  them has needs no choice, and `p.*` is always the payload itself. A call
  inside a generic body, `x.clone()` under `where(T <: Clone)`, is the
  bound's method even when `T` is an `Rc`.
- **Places.** On a `Box`, a forwarded field is a place: `b.x = v` and a
  `&mut self` call such as `b.items.push(v)` write the payload. Through an
  `Rc` the same spellings are E0919 (below): an `Rc` has no `DerefMut`, so
  its payload is read-only through the handle. In a file without
  `pragma(Pragma.AllowUnsafe)`, a write through an `Arc` is likewise
  rejected (`a.n = v`, `a.bump()` with `self : &mut Self`): mutate an
  `Arc`'s payload through a `Mutex` or an atomic.
- **Outside the prelude, `Deref` needs an unsized `Target`.** A `Deref` or
  `DerefMut` impl outside the prelude is accepted when its `Target` is
  `[T]`, `str`, a `Dyn(...)` or a tail-unsized struct. A sized `Target` and
  an open type variable are error E0622: a wrapper over a sized payload
  exposes it through its own fields and methods.
- When neither the wrapper nor its payload has the name, the error says so:
  ``No field "z" on Rc(Point). `p` is a Rc(Point); its payload Point has no
  field "z" either.`` (E0406; E0610 for a method).
- **Callee position.** `p.items(i)` indexes the payload's `items`, and
  `p.f(x)` calls a payload field that holds a function. A wrapper method
  and a payload field of the same name are the same E0616.
- **The whole payload as a reference: `as_ref`.** `Rc`, `Box` and `Arc`
  have `as_ref : (fn(self : &Self) -> &T)`, Rust's name: `h.as_ref()` lends
  the payload where a `&T` is wanted, such as an argument to a `&T`
  parameter (`takes_point(p.as_ref())`), and `Rc.as_ref(h)` is the same call
  through the type. Pass the result straight to a call or bind it first
  (`q := p.as_ref(); q.clone()` is the payload's `clone`).

**Owners.** Every other `Deref` type is an owner of unsized content, whose
`.*` is the place its `deref` projection yields. `Array(T, N)` is one in the
prelude and `ArrayList(T)` one in std, both with `Target : [T]` and
`DerefMut`, so `&list.*` lends a list's elements as a `&[T]`. A user type
over a `[T]` is one too:

```yo
{ assert } :: import("std/assert");
Ring :: struct(items : Array(i32, 3));
impl(Ring, len : (fn(self : &Self) -> usize)(usize(30)));
impl(Ring, Deref(Target : [i32], deref : (fn(self : &Self) -> &Self.Target)(&self.items.*)));
impl(Ring, DerefMut(Target : [i32], deref_mut : (fn(self : &mut Self) -> &mut Self.Target)(&mut self.items.*)));
count :: (fn(xs : &[i32]) -> usize)(xs.len());
main :: (fn() -> unit)({
  mut(r) := Ring(items : Array(i32, 3)(1, 2, 3));
  v := &r.*; // r.deref(): a view rooted at r
  assert(count(v) == usize(3));
  assert(r.len() == usize(30)); // the owner's own len
  assert(r.*.len() == usize(3)); // the view's
  assert(!r.is_empty()); // only the view has it: r.*.is_empty()
  w := &mut r.*; // r.deref_mut(): exclusive while w lives
  assert(count(w) == usize(3));
});
export(main);
```

- `&w.*` is `w.deref()`, `&mut w.*` is `w.deref_mut()`, and anywhere else
  `w.*` is that call's place. The view borrows the owner, so while it is
  live the owner cannot be written, moved or lent `&mut` (E0911).
- **The owner's own member wins.** A member only the view has is reached
  through `.*`; a member the owner has is the owner's, so `r.len()` above is
  `Ring`'s and `r.*.len()` the view's. Adding a member to an owner therefore re-resolves calls that reached
  the view's member of that name.
- **Nothing else dereferences.** A `&Ring` does not fill a `&[i32]`
  parameter: `count(&r)` is E0601, whose help names `count(&r.*)`. An
  operator operand is never dereferenced either.

### Rc with Assignments

A reassignment needs a `mut` binding, and the assignment
expression is the OLD value of the handle:

```yo
{ assert } :: import("std/assert");

test("Rc assignment behavior", {
  mut(x) := Rc.new(1);
  y := (x = Rc.new(2)); // y gets the old value
  assert(x.* == 2); // x now points to the new Rc
  assert(y.* == 1); // y has the old Rc
});
```

### Rc and Reference Counting

`Rc(T)` uses automatic reference counting; a second handle is `Rc.clone`:

```yo
{ assert } :: import("std/assert");

test("Rc reference counting", {
  original := Rc.new(42);
  copy := Rc.clone(original); // RC increment
  another := Rc.clone(copy); // RC increment
  // All three point to the same Rc
  assert(original.* == 42);
  assert(copy.* == 42); // Shared!
  assert(ref_count(another) == usize(3));

  // RC decrements when variables go out of scope
});
```

### Mutating a Shared Payload: `RefCell`, `Rc.get_mut`, `Rc.make_mut`, `Rc.try_unwrap`

An `Rc`'s payload is shared, so it is **read-only through the handle**, as
in Rust.
A write through an `Rc` (`h.n = v`, `h.* = v`, `bump(&mut h.n)`,
`h.items.push(v)`) is error E0919, which names the doors below
(`yo explain E0919`):

- **`RefCell(T)`** (`std/sync/refcell`) is the payload for shared mutation:
  `Rc(RefCell(T))`. Access is scoped to a closure, as `Mutex(T)`'s is:
  `with(v => ...)` lends `v : &T`, `with_mut(v => ...)` lends `v : &mut T`,
  and each returns the closure's result. Rust's value-moving methods lend
  nothing to the caller: `replace(v)` and `take()` (`T <: Default`) store a
  new value and return the old one, `replace_with(v => ...)` stores what
  the closure computes from `v : &T` and returns the old value, and
  `into_inner()` consumes the cell. Unlike Rust's `replace_with`, whose
  closure is an `FnOnce(&mut T) -> T`, the closure is an `Fn` lent `&T`, as
  a `with` body is. Several `with` bodies may run at once;
  a `with_mut` (or `replace_with`'s closure) runs alone, and a conflicting
  access while one runs panics, as Rust's `RefCell::borrow_mut` does. The
  mark is released when the body returns or unwinds. A `RefCell` is `Send` when `T` is and never
  `Sync`, so `Arc(RefCell(T))` is rejected (share an `Arc(Mutex(T))` across
  threads). It may also sit in a plain value, where it makes a write through
  a `&` borrow possible.

  ```yo
  { RefCell } :: import("std/sync/refcell");
  log := Rc.new(RefCell(i32).new(i32(0)));
  other := Rc.clone(log); // a second handle to the same cell
  other.replace_with(n => (n + i32(1)));
  assert(log.with(n => n) == i32(1), "seen through the first handle");
  ```

- **`Rc.make_mut(&mut h)`** (`T <: Clone`) is the payload, written: when
  another handle shares the cell, `h` first moves to a fresh cell holding a
  clone of the payload, so the other handles never see the write. On the
  only handle it writes in place. Rust's `Rc::make_mut`; the clone is in
  the name.

  ```yo
  a := Rc.new(Point(x : 1, y : 2));
  b := Rc.clone(a);
  Rc.make_mut(&mut b).x = 10; // b gets a cell of its own
  assert((a.x == 1) && (b.x == 10), "a is unchanged");
  ```

- **`Rc.try_unwrap(h)`** consumes the handle and returns `.Ok(payload)`
  when it was the only one (the cell is freed), else `.Err(h)`, the handle
  back. It needs no `Clone`.
- **`Rc.get_mut(&mut h)`** is `.Some(&mut T)`, a reference into the cell,
  when no other `Rc` or `Weak` shares it, and `.None` otherwise; it never
  clones, so it needs no `Clone`. Rust's `Rc::get_mut`.

  ```yo
  h := Rc.new(i32(1));
  match(
    Rc.get_mut(&mut h),
    .Some(v) => {
      v.* = i32(2);
    },
    .None => ()
  );
  assert(h.* == i32(2), "the only handle writes in place");
  ```

The doors are called through the type, as in Rust, so a payload method of
the same name stays reachable as `h.name()`. `Arc` has the same
`Arc.get_mut`, `Arc.make_mut` and `Arc.try_unwrap` ([ARC.md](./ARC.md)).

### Weak: a Handle That Does Not Own

`Weak(T)` is Rust's `rc::Weak<T>`: `Rc.downgrade(&h)` makes a handle to the
cell that does not keep the payload alive, and `w.upgrade()` is
`.Some(handle)` while an `Rc` to it exists, `.None` after the last one. The
last `Rc` drops the payload; the last handle of either kind frees the cell.
A `Weak` has no `Deref`, is explicit-copy (`Weak.clone(&w)`), and is not an
edge of the ownership graph, so a parent pointer `Weak(RefCell(Node))`
closes no cycle. See [WEAK.md](./WEAK.md).

```yo
a := Rc.new(i32(7));
w := Rc.downgrade(&a);
assert(w.upgrade().is_some(), "alive while a is");
consume(a);
assert(w.upgrade().is_none(), "the last Rc dropped the payload");
```

### When to Use Rc

- **Heap allocation**: When you need a value type on the heap
- **Shared ownership**: Several handles to one value; shared mutation goes through `Rc(RefCell(T))`
- **Shared dynamic dispatch**: `dyn(Rc.new(v))` builds an `Rc(Dyn(Trait))`, one trait object several handles share; a uniquely owned one is `dyn(Box.new(v))`
- **Recursive types**: only when the nodes are shared; a tree of uniquely owned nodes uses `Box`

```yo
impl(i32, SomeTrait(...));
use_dyn :: (fn(value : &Dyn(SomeTrait)) -> unit)({ ... });

// One i32 behind a shared trait object
(shared : Rc(Dyn(SomeTrait))) = dyn(Rc.new(i32(42)));
use_dyn(&shared.*);
```

## Impl Types

`Impl(TraitName)` creates a type representing any type that implements the specified trait(s). This is similar to `impl Trait` in Rust.

### Basic Usage

```yo
// Define a trait
Id :: trait(
  id : (fn(self : Self) -> Self)
);

// Function accepting any type implementing Id
use_id :: (
  fn(
    generic(T : Type),
    value : T,
    where(T <: Id)
  ) -> T
)({
  return(value.id());
});

// Implement Id for i32
impl(
  i32,
  Id(
    id : (
      self -> {
        printf("i32: %d\n", self);
        return(self);
      }
    )
  )
);

// Use it
result := use_id(42); // Prints "i32: 42", returns 42
```

### Impl as Return Type

`Impl` can be used in return types for static dispatch:

```yo
RetI32 :: trait(
  return_i32 : (fn(self : &mut Self) -> i32)
);

// `Impl(Trait)` is STATIC dispatch: every path must return the SAME concrete
// type, which the compiler infers. Returning `bool` from one arm and `i32` from
// another does not compile.
get_value :: (fn(use_bool : bool) -> Impl(RetI32))({
  cond(
    use_bool => return(i32(1)),
    true => return(i32(42))
  );
});

// To return DIFFERENT concrete types from different arms, erase to `Dyn`:
get_any :: (fn(use_bool : bool) -> Box(Dyn(RetI32)))({
  cond(
    use_bool => return(dyn(Box.new(true))),
    true => return(dyn(Box.new(i32(42))))
  );
});
```

**Important**: Each return path must return a concrete type, not different types that happen to implement the same trait.

### Impl with Multiple Traits

```yo
Speak :: trait(
  speak : (fn(self : Self) -> unit)
);

Run :: trait(
  run : (fn(self : Self) -> unit)
);

// Type must implement both Speak and Run
perform :: (
  fn(
    generic(T : Type),
    actor : T,
    where(T <: (Speak, Run))
  ) -> unit
)({
  actor.speak();
  actor.run();
});
```

## Dynamic Dispatch

See [DYN_DESIGN.md](./DYN_DESIGN.md) for comprehensive documentation on dynamic dispatch with `Dyn` and `dyn`.

### `Dyn` and `dyn`

`Dyn(Trait, ...)` is a trait object: any concrete type implementing the listed traits, erased, with its methods called through a vtable. It is unsized, so it is used behind a pointer, and the pointer decides who owns it: `Box(Dyn(Trait))` owns it, `Rc(Dyn(Trait))` shares it, and `&Dyn(Trait)` borrows it. `dyn(...)` is the only way in: `dyn(Box.new(v))`, `dyn(Rc.new(v))`, `dyn(Arc.new(v))`, `dyn(&v)` and `dyn(&mut v)` erase the pointee of that pointer.

The position of the `dyn(...)` call must say which `Dyn(...)` to build — a parameter, an annotated binding `(x : Box(Dyn(Trait))) = dyn(Box.new(v))`, a declared return type, a struct field, or a collection element slot. A bare `dyn(...)` in a position with no such expected type (for example directly inside `downcast(dyn(...), T)`) is a compile error: `cannot infer the Dyn type of dyn(...) here — annotate the value or bind it first`.

**Key features:**

- Ownership is the pointer's: `Box` unique, `Rc`/`Arc` shared and read-only, `&`/`&mut` borrowed
- `dyn(&v)` allocates nothing
- `downcast` and `upcast` keep the pointer kind
- Several traits in one `Dyn`: `Dyn(Speak, Run)`

A `Dyn` lives behind a pointer: a bare `Dyn(Trait)` value type is E0619, and `dyn(v)` of a plain value is E0620 (`dyn(Box.new(v))` boxes it). See [DYN_DESIGN.md](./DYN_DESIGN.md).

### Examples

```yo
{ println } :: import("std/fmt");
Speak :: trait(speak : (fn(self : &Self) -> i32));
Run :: trait(run : (fn(self : &Self) -> i32));
Dog :: struct(legs : i32);
impl(Dog, Speak(speak : ((self : &Self) -> i32(1))));
impl(Dog, Run(run : ((self : &Self) -> self.legs)));

act :: (fn(s : &Dyn(Speak, Run)) -> i32)(s.speak() + s.run());

main :: (fn() -> unit)({
  dog := Dog(legs : i32(4));
  a := act(dyn(&dog)); // a borrowed trait object: no allocation
  (owned : Box(Dyn(Speak, Run))) = dyn(Box.new(Dog(legs : i32(3)))); // an owned one
  b := act(&owned.*);
  total := (a + b);
  println(&total);
});
export(main);
```

## Existential Types

"Existential type" names a value whose concrete type is hidden behind an
interface: `∃T. (T, operations on T)`. Yo has this in the two forms a
monomorphizing C backend can pay for, and deliberately not in the third.
Which one to reach for:

| You want to... | Use | What is hidden, and how |
| --- | --- | --- |
| store values of **different** concrete types in one variable, field or collection, and call trait methods on them | `Box(Dyn(Trait))` + `dyn(Box.new(v))`, or `&Dyn(Trait)` + `dyn(&v)` | the type is **erased**: a fat pointer `{data, vtable}`; the vtable is the only thing the consumer can use. Recover a concrete type only with `downcast(&d.*, T)`. |
| return **one** concrete type without naming it (a closure, an iterator, a future) | `Impl(Trait)` in result position, `Impl(Fn(...))`, `Impl(Future(T, E))` | the type is **opaque, not erased**: every return path must produce the same concrete type, the compiler monomorphizes the callers, nothing is boxed. |
| hide a **length** or other value the type depends on (`[n:nat] list(a, n)` in ATS / DML) | an ordinary runtime value plus a contract: `ensures(r.len() == ...)`, `requires(i < xs.len())`, `refine(T, p)` | the witness is a **ghost** the verifier reasons about ([FORMAL_VERIFICATION.md](./FORMAL_VERIFICATION.md)); nothing exists at runtime. |

### Packed: `Dyn(Trait)`

```yo
Shape :: trait(area : (fn(self : &Self) -> f64));

// A heterogeneous list: each element's concrete type is gone, only `Shape` remains.
mut(shapes) := ArrayList(Box(Dyn(Shape))).new();
shapes.push(dyn(Box.new(Circle(r : f64(1.0)))));
shapes.push(dyn(Box.new(Square(side : f64(2.0)))));
for(&shapes, s => println(s.area()));
```

The trait must be object-safe (a `&Self` or `&mut Self` receiver, no other
`Self` in the signature, no `generic(...)` parameters), each element owns its
payload through its `Box`, and an upcast to a smaller trait set is explicit:
`upcast(d, Dyn(Sub))`. Details: [DYN_DESIGN.md](./DYN_DESIGN.md).

### Opaque: `Impl(Trait)` and closures

```yo
// The caller cannot spell the closure's type; the compiler knows it exactly.
make_counter :: (fn(start : i32) -> Impl(Fn() -> i32))(() => (start + i32(1)));
```

Each closure is its own type, so one `Impl(Fn(...))` slot holds one closure
and a container of them is `ArrayList(type_of(k))` — two different closures in
one container need `Dyn(Fn(...))` (see [Closure Type Restrictions](./CLOSURES.md#closure-type-restrictions)).
`Impl(Future(T, E))` is the same shape for `async` results.

#### A bare function type never mentions `Impl(Fn(...))`

A `fn(...) -> R` type is one C function pointer, so a slot of that type —
a runtime parameter, a struct/enum/tuple/union field, a function result —
must have one representation. `Impl(Fn(...))` does not: every function
returning `Impl(Fn() -> i32)` returns its own closure struct by value, and a
function taking an `Impl(Fn(...))` parameter is specialized per closure. Such
a slot is rejected at `check`, as Rust rejects `fn(i32) -> impl Fn() -> i32`:

```yo
// error: The function type fn(x : i32) -> Impl(Fn() -> i32) cannot be the
//        type of parameter "mk" ...
use_mk :: (fn(mk : (fn(x : i32) -> Impl(Fn() -> i32)), v : i32) -> i32)(mk(v)());

// OK: a generic `Impl(Fn(...))` parameter is specialized per argument, so the
// inner `Impl` is that argument's own result type (a named function or a closure).
use_mk :: (fn(mk : &Impl(Fn(x : i32) -> Impl(Fn() -> i32)), v : i32) -> i32)(mk(v)());
// OK, the Rust spelling `F: Fn(i32) -> G, G: Fn() -> i32`:
use_mk :: (fn(generic(G : Type), mk : &Impl(Fn(x : i32) -> G), v : i32, where(G <: (Fn() -> i32))) -> i32)(mk(v)());
```

To store functions with different closure results in one slot, return
`Box(Dyn(Fn(...)))` (one boxed representation). Not rejected: `Impl(Future(...))`
(every future is one pointer to a state machine, so
`fn(x : i32, io : Io) -> Impl(Future(i32, Io))` is a valid parameter type); a
`comptime(f)` parameter (specialized per value); a local annotation
`(h : (fn(x : i32) -> Impl(Fn() -> i32))) = mk`, which takes `mk`'s own
function type the way an `Impl(Fn(...))` annotation takes its closure's (a
later `h = other` with a different closure result is E0601).

### Not supported: existential enum constructors

```yo
// NOT supported: `T` is bound by the constructor, not by the enum.
Showable :: enum(
  Wrap(generic(T : Type), value : T, show : (fn(v : T) -> String))
);
```

This is the ML-style `pack`. Its lowering in a compiler that monomorphizes
everything is exactly a `Dyn`: a hidden `T` with no vtable cannot be operated
on, and with one it is a trait object. It stays a non-goal (see
[GADTS.md](./GADTS.md#limitations)); write `Box(Dyn(Show))` instead.

Yo therefore has no `exists` at the type level. The identifier `exists` is the
verifier's ghost quantifier over values, as in
`ensures(exists(k : i32, xs(k) == target))`.

## Impl vs Dyn

- **Impl**: Static dispatch, compile-time polymorphism, no runtime overhead
- **Dyn**: Dynamic dispatch, runtime polymorphism, used behind a pointer (`Box(Dyn(...))`, `&Dyn(...)`)

```yo
// Impl - static dispatch (monomorphization)
use_impl :: (fn(generic(T : Type), value : T, where(T <: SomeTrait)) -> unit)({
  value.method(); // Statically dispatched
});

// Dyn - dynamic dispatch (vtable)
use_dyn :: (fn(value : &Dyn(SomeTrait)) -> unit)({
  value.method(); // Dynamically dispatched
});
```

For more examples, see `tests/impl.test.yo`.

## Algebraic Effects and Handlers

Yo supports **algebraic effects** — one-shot delimited continuations
for control flow. Handlers are values of a dedicated **control
function** type `ctl(args) -> ret` (parallel to `fn(args) -> ret`),
passed as regular function parameters at every call site.

1. **Control function type (`ctl`)**: A handler value has type
   `ctl(args) -> ret`. Its body may use `unwind(value)` to discard the
   continuation, or `return(value)` to resume it. Plain `fn(args) ->
ret` bodies cannot contain `unwind`.
2. **Effect parameters are explicit**: A function that needs an
   effect takes the handler as a regular parameter (`raise : Raise`).
   Callers pass the handler explicitly at every call site.

Effects compose with `async`/`await`: handlers inside `io.async`
tasks work correctly. If `unwind` is called inside an async task, the
Future enters the `Aborted` state: `io.await` on it propagates the abort
to the awaiter, while a spawned task's `JoinHandle.await` returns `.None`.

See [ALGEBRAIC_EFFECTS.md](./ALGEBRAIC_EFFECTS.md) for comprehensive
documentation.

## Error Handling

Yo provides two approaches to error handling:

1. **Result ADT** — explicit `Result(T, E)` values with pattern matching
2. **Exception / ResumableException** — algebraic effects for exception-like control flow

### Result Type

The `Result` type is an algebraic data type for functions that can fail:

```yo
// Define an error type
DivisionError :: enum(
  DivideByZero,
  Overflow
);

// Function that can fail
safe_div :: (fn(a : i32, b : i32) -> Result(i32, DivisionError))(
  cond(
    (b == i32(0)) => .Error(.DivideByZero),
    true => .Ok(a / b)
  )
);

// Handle errors with pattern matching
result := safe_div(10, 2);
match(
  result,
  .Ok(value) => printf("Result: %d\n", value),
  .Error(error) => match(
    error,
    .DivideByZero => printf("Error: Cannot divide by zero\n"),
    .Overflow => printf("Error: Overflow\n")
  )
);
```

### Error Trait and AnyError

The standard library defines an `Error` trait and `AnyError` type for dynamic error handling:

```yo
{ Error, AnyError } :: import("std/error");

// Error trait requires ToString. `derive(Error)` supplies both from one
// message per variant, listed in declaration order:
MathError :: enum(
  DivisionByZero,
  NegativeSqrt
);
derive(
  MathError,
  Error(
    .DivisionByZero => `Division by zero`,
    .NegativeSqrt => `Square root of a negative number`
  )
);
// An AnyError's payload is Clone (see below):
derive(MathError, Clone);

// The message is ordinary Yo, spliced into the arm that binds the payload, so
// a variant's own fields interpolate by name:
//   .NotFound(path : String)  =>  `not found: ${path}`
// Writing the two impls by hand still works, and is the way to go when the
// message is not a simple per-variant string.
// AnyError is Box(Dyn(Error, Clone)) — any type implementing Error and
// Clone can be wrapped with dyn(Box.new(e)). It owns its payload
// uniquely, and `throw` passes the error by value, so a handler keeps a caught
// error by moving it.
(err : AnyError) = dyn(Box.new(MathError.DivisionByZero));

// Downcast back to the concrete type, borrowing it:
match(
  downcast(&err.*, MathError),
  .Some(math_err) => printf("Got MathError\n"),
  .None => printf("Not a MathError\n")
);
```

### Exception (Non-Resumable)

`Exception` is an effect bundle for non-resumable exception handling.
Its `throw` field is a `ctl(...) -> ret` handler — calling
`unwind(...)` inside its body discards the continuation and returns
from the enclosing function:

```yo
{ Exception } :: import("std/error");

safe_divide :: (fn(x : i32, y : i32, exn : Exception) -> i32)(
  cond(
    (y == i32(0)) => exn.throw(dyn(Box.new(MathError.DivisionByZero))),
    true => (x / y)
  )
);

// Install the handler — note the outer parens around the lambda
// (Yo has no operator precedence).
(exn : Exception) = Exception(
  throw : (
    err -> {
      println(`Error: ${err}`); // prints "Error: Division by zero"
      unwind(()); // discard continuation, return from enclosing fn
    }
  )
);

result := safe_divide(6, 3, exn); // result = 2
safe_divide(10, 0, exn); // handler fires, unwinds — code after this is unreached
```

An `Exception` handler cannot resume the throw with a value. `throw`'s
resume type is a type variable that each throw site picks, so a handler
must `unwind`, diverge, or fall through with `()`. A handler that
returns a value of a fixed type, such as `err -> { return(i32(7)); }`,
is a compile error that points at `ResumableException`:

### ResumableException

`ResumableException(ResumeType)` is for resumable exception handling.
When the handler calls `return`, it resumes the continuation with a
recovery value:

```yo
{ ResumableException } :: import("std/error");

safe_divide :: (fn(x : i32, y : i32, exn : ResumableException(i32)) -> i32)(
  cond(
    (y == i32(0)) => exn.throw(dyn(Box.new(`division by zero`))),
    true => (x / y)
  )
);

(exn : ResumableException(i32)) = ResumableException(i32)(
  throw : (
    err -> {
      println(`Error: ${err}`);
      return(i32(0)); // resume with recovery value 0
    }
  )
);

result := safe_divide(6, 3, exn); // result = 2
result2 := safe_divide(10, 0, exn); // handler resumes with 0, result2 = 0
```

For more examples, see `tests/error.test.yo`.

## Async/Await

Yo uses **async/await with state machine transformation** for efficient **single-threaded concurrency**. Async tasks are **lazy** — they don't start until explicitly awaited or joined.

```yo
{ yield } :: import("std/async");

main :: (fn(io : Io) -> unit)({
  task1 := io.async((io : Io) => {
    io.await(yield(io), io);
    return(i32(1));
  });
  task2 := io.async((io : Io) => {
    io.await(yield(io), io);
    return(i32(2));
  });
  handle1 := io.spawn(task1, io); // start task1, returns JoinHandle(i32)
  handle2 := io.spawn(task2, io); // start task2, returns JoinHandle(i32)
  r1 := handle1.await(io); // wait → Option(i32)
  r2 := handle2.await(io);
});
export(main);
```

Key properties:

- `io.async(fn)` creates a **cold Future** — the body does NOT execute until awaited or spawned
- `io.await(future, e)` consumes a future: starts it if cold, runs it to completion and moves its result out; a future is awaited **once** (`e` is the effect record — just `io` for pure-Io tasks)
- `io.spawn(future, e)` consumes a cold future and starts it without waiting, returns `JoinHandle(T)`
- `handle.await(io)` waits for a spawned task, returns `Option(T)` — `.None` on unwind (abort). A `JoinHandle` is move-only: the await consumes it, so a task is awaited once
- All async code runs on the **same thread** (no thread spawning, no data races)

See [ASYNC_AWAIT.md](./ASYNC_AWAIT.md) for comprehensive documentation.

## Parallelism

Please check [PARALLELISM.md](./PARALLELISM.md) for details on parallel programming in Yo.

## Arc Types

`Arc(T)` provides **shared ownership** with atomic reference counting. It is defined in `std/prelude.yo` as a newtype over an atomically
counted cell. `Arc(T)` requires `T <: (Send, Sync)`: `Sync` because every handle reads the payload
from its own thread, and `Send` because the last handle may be dropped (and the payload disposed) on
any thread. So it only wraps thread-shareable values, and `Arc(T)` is itself `Send` and `Sync`
under that bound. As in Rust, the payload need not be `Acyclic`: there is no
cycle collector, so a cycle of `Arc` handles leaks unless a back edge is cleared first or is an
`ArcWeak` (`Arc.downgrade(&h)`, [WEAK.md](./WEAK.md#arcweakt-the-thread-safe-form);
[ARC.md](./ARC.md#cycles)). Use `Arc(T)` when you want to share a single value.
To share your own type, write a plain `struct` and share it as `Arc(YourType)`.

```yo
// Create with Arc.new
shared := Arc.new(i32(42));

// Dereference with .(*)  (borrowed, read-only)
val := shared.*; // val == 42
// Copying increments refcount
copy := shared; // refcount: 1 → 2
// Cross-thread sharing
{ Thread } :: import("std/thread");
shared := Arc.new(i32(42));
t := Thread(unit).spawn(io => {
  assert(shared.* == i32(42), "thread sees shared value");
});
t.join();
assert(shared.* == i32(42), "main still sees shared value");
```

`Arc(T)` implements `Deref`, so a read forwards to the payload
(`shared.field`, `shared.method()`; see [Auto-dereference](#auto-dereference));
a write through it is rejected in safe code.

See [ARC.md](./ARC.md) for full details.

## Module importing and exporting

```yo
// module1.yo
test :: (fn() -> unit)({
  println("Hello, world!");
});
export(test);

// module2.yo
// Export the type
Option :: (fn(comptime(T) : Type) -> comptime(Type))(
  enum(
    Some(value : T),
    None
  )
);
export(Option);
```

```yo
{ ... } :: import("./test.yo"); // Import everything from test.yo
test_module :: import("./test.yo"); // Import everything from test.yo and put it in the Test namespace
{ test } :: import("./test.yo"); // Import test function from test.yo
{ test : test2 } :: import("./test.yo"); // Import test function from test.yo and rename it to test2
{ Option } :: import("./test.yo"); // Import Option type from test.yo
```

#### Importing a name twice

Every imported name is a binding, so the no-shadowing rule applies to imports: binding the same name twice is an error (`Failed to define variable "ArrayList"` … `variable shadowing is not allowed`), whether both lines name it or a `{ ... }` glob already brought it in. Several import lines from one path are fine as long as each binds different names, and a name may be imported again under a new one:

```yo
{ ArrayList } :: import("std/collections/array-list");
{ ArrayListIter } :: import("std/collections/array-list"); // fine: a different name
{ ArrayList : List } :: import("std/collections/array-list"); // fine: bound under a new name
xs := List(i32).new();
```

#### Trait impls are visible through your imports

A method call resolves against the `impl(...)` blocks of the modules your
file can REACH through its imports (transitively) plus the prelude. An impl
that lives in a module nobody on your import path imports is not a
candidate, even if some other file in the same `yo check` or the same
program happens to have loaded it. Integer and `str` `to_string`, for
example, are `std/fmt`'s `ToString` impls, so a module that calls them
imports `std/fmt` (any binding will do: `{ ToString } :: import("std/fmt")`).
This is what makes a file's verdict the same whether it is checked alone or
beside its siblings. `YO_VISIBILITY_REPORT=1` lists, instead of rejecting,
every call that resolves only through an impl outside the caller's imports —
the tool for adding the missing import lines.

### Anonymous module

The anonymous module is defined using `impl` keyword followed by a `begin` block:

```yo
my_module :: impl({
  my_function :: (fn() -> unit)({
    println("Hello from my_module!");
  });
  export(my_function);
});
```

### Module-level mutable variables

Yo supports mutable runtime variables at the top level of a module (file scope). These become C `static` file-scope variables, initialized before `main` runs.

Two syntaxes are supported:

```yo
// := initialization
counter := i32(0);

// Binding pattern initialization
(flag : bool) = false;
```

Functions defined in the same module can read and write these variables:

```yo
inc :: (fn() -> unit)({
  counter = (counter + i32(1));
});
```

**Restrictions:**

- Standalone type annotations without initialization are not allowed at module scope:
  ```yo
  a : i32; // ❌ Error: use `a := i32(0);` or `(a : i32) = i32(0);` instead
  ```
- Mutable runtime variables (`:=` or `(x : T) = val`) are **not allowed inside `impl` blocks**. Use `::` for compile-time definitions:
  ```yo ignore
  m :: impl {
    b := i32(13);  // ❌ Error: not allowed inside impl
    b :: 13;       // ✅ OK: compile-time constant
    export(b);
  };
  ```
- Module-level mutable variables **cannot be exported**. Only compile-time known values can be exported from modules.

## Testing

Yo has a built-in testing framework accessible via the `test` keyword.

### Basic Test Syntax

```yo
test("Test description", {
  // Test code here
  x := (1 + 1);
  assert(x == 2, "x should be 2");
});

// Io is implicitly available via `io` in all test bodies
test("With effects", {
  io.await(sleep(u64(1000)), io);
});
```

### Running Tests

Tests can be run using the Yo CLI:

```bash
# Run all tests in a file
$ yo test path/to/file.test.yo

# Run specific test by pattern
$ yo test path/to/file.test.yo --test-name-pattern "Test addition"

# Stop on first failure
$ yo test path/to/file.test.yo --bail

# Verbose output
$ yo test path/to/file.test.yo -v

# List the tests a path + pattern selects, without compiling anything
$ yo test ./tests --list

# One JSON object per line: a "test" event per test (file, name, status,
# duration_ms; message and captured output on failure), then a "summary" event
$ yo test ./tests --json
```

### Assertions

#### Runtime Assertions

```yo
{ assert } :: import("std/assert");

test("Runtime assertions", {
  x := 42;

  // Basic assertion
  assert(x == 42);

  // Assertion with message
  assert(x > 0, "x should be positive");

  // Complex assertions
  arr := [1, 2, 3];
  assert(arr.len() == 3, "Array should have 3 elements");
});
```

#### Compile-Time Assertions

Use `comptime_assert` for compile-time verification:

```yo
test("Compile-time assertions", {
  // These are checked during compilation
  comptime_assert((2 + 2) == 4);
  comptime_assert(Array(i32, 5).fill(0).len() == 5);
  comptime_assert(f32(3.14) > f32(3.0));

  // Type-level assertions
  T :: i32;
  comptime_assert(Type.to_comptime_string(T) == "i32");
});
```

### Testing Expected Errors

Verify that certain code produces compile-time errors:

```yo
test("Expected compile errors", {
  // Expect an error without specific message
  comptime_expect_error({
    x :: (1 / 0); // Division by zero
  });

  // Expect an error with specific message
  comptime_expect_error({
    arr : Array(i32, _);
    arr = [1, 2, 3];
  }, "Array type with inferred length '_' is not allowed in type annotations");

  // Test that certain patterns are invalid
  comptime_expect_error({
    closure1 := (x => (x + 1));
    closure2 := (x => (x + 1));
    // Each closure has unique type
    (c : type_of(closure1)) = closure2; // Error!
  }, "no two closures have the same type");
});
```

### Test Organization

Organize related tests in the same file:

```yo
// arithmetic.test.yo
test("Addition", {
  assert((1 + 1) == 2);
  assert((5 + 3) == 8);
});

test("Subtraction", {
  assert((5 - 3) == 2);
  assert((10 - 10) == 0);
});

test("Multiplication", {
  assert((2 * 3) == 6);
  assert((7 * 0) == 0);
});

test("Division", {
  assert((10 / 2) == 5);
  assert((9 / 3) == 3);
});
```

### Testing Drop

Test cleanup and disposal:

```yo
{ println } :: import("std/fmt");
{ assert } :: import("std/assert");

MyBox :: struct(value : i32);
impl(
  MyBox,
  Drop(
    drop : (fn(self : &mut Self) -> unit)({
      println(`Disposing MyBox with value: ${self.value}`);
    })
  )
);

test("Object disposal", {
  // MyBox is automatically dropped at end of scope
  mut(b) := MyBox(value : 42);
  assert(b.value == 42);
  b.value = 100;
  assert(b.value == 100);
  // drop runs automatically here; calling it by hand is E0915
});
```

### Test Files

Yo test files typically use the `.test.yo` extension:

- `basic.test.yo` - Basic language features
- `array.test.yo` - Array operations
- `closure.test.yo` - Closure functionality
- `async-await.test.yo` - Async/await features
- `collections/*.test.yo` - Collection types

For comprehensive test examples, see the `tests/` directory.

## Meta-programming

`quote` is similar to the `quasiquote` in Lisp.  
`unquote` can only be used in `quote`.  
`unquote_splicing` can only be used in `quote` to splice the values into the AST.

```yo
x :: quote(2); // comptime(x) : Expr
list :: quote((1, unquote(x), 3)); // tuple (1, 2, 3)
list2 :: quote((1, x, 3)); // tuple (1, x, 3)
quote((0, unquote_splicing(list.get_args()), 4)); // tuple (0, 1, 2, 3, 4)
```

### Macro functions

Macro functions use `quote` and `unquote` for code generation. A macro is
an ordinary comptime function with one or both of two signature flags: a
`quote(name) : Expr` parameter (the caller's raw AST is bound without
being evaluated) and an `-> unquote(Expr)` return type (the returned AST
is spliced into the call site). See `std/prelude.yo` for real examples
like the `if` macro.

- `quote(...)` : Quote an expression
- `unquote(...)` : Unquote within a quoted expression
- `gensym(...)` : Generate unique symbol

`unquote` can only be used within `quote`.

**Defining a macro requires `pragma(Pragma.AllowMacroDef);`** at the top
of the file — like `Pragma.AllowUnsafe` for pointer ops, macro definition
is a per-file opt-in (macros are unhygienic and splice code into their
callers, so the ability to define them is gated; see
`plans/reference/MACRO_POLICY.md`). *Calling* macros (`if`, `for`, collection
literals) never needs the pragma, and neither does working with quoted
`Expr` values in comptime functions (the mechanism `derive_rule` uses).

```yo
pragma(Pragma.AllowMacroDef);

// Custom macro example — a lazy-body `unless`
unless :: (fn(quote(condition) : Expr, quote(do) : Expr) -> unquote(Expr))(
  quote(
    cond(unquote(condition) => (), true => unquote(do))
  )
);
```

The prelude's `if` macro is the canonical example (current compilers
desugar `if(...)` calls to `cond(...)` at parse time, keeping this
definition as the spec/fallback):

```yo
if :: (
  fn(
    quote(condition) : Expr,
    quote(then) : Expr,
    (quote(else) : Expr) ?= quote(())
  ) -> unquote(Expr)
)(
  quote(
    cond(
      unquote(condition) => unquote(then),
      true => unquote(else)
    )
  )
);

// Usage
if(true, {
  println("true");
});
```

> std has no `try` macro: one would hide a caller-frame `return`, which
> collides with algebraic effects. Match on the `Result` instead.

## Derive Traits

Yo supports automatic trait derivation similar to Rust's `#[derive(...)]`, but using function-call syntax. The `derive` function generates `impl` blocks for common traits automatically based on a type's structure.

### Built-in derives

Six traits have built-in derive support: `Eq`, `Hash`, `Clone`, `Ord`, `Default`, and `ToString`. They work for both structs and enums:

```yo
{ assert } :: import("std/assert");
{ ToString } :: import("std/fmt"); // the ToString derive rule lives in std/fmt
Point :: struct(x : i32, y : i32);
derive(Point, Eq(Point), Hash, Clone, Ord(Point), ToString);

// Now Point supports ==, !=, hashing, cloning, comparison, and string conversion
main :: (fn() -> unit)({
  p1 := Point(x : 1, y : 2);
  p2 := Point(x : 1, y : 2);
  assert(p1 == p2, "equal");
  assert(p1.to_string() == `Point(1, 2)`, "to_string");
});
export(main);
```

### User-defined derive rules with `derive_rule`

Trait authors can register custom derive rules using `derive_rule`. A derive rule is **not a macro** — it is a regular comptime function returning `comptime(Expr)` that builds the `impl` block with `quote`/`unquote`; the `derive` builtin evaluates the returned Expr explicitly (so no `Pragma.AllowMacroDef` is needed):

```yo
MyEq :: (fn(comptime(Rhs) : Type) -> comptime(Trait))(
  trait(my_eq : (fn(self : Self, other : Rhs) -> bool))
);

my_derive_eq :: (fn(comptime(T) : Type, comptime(ctx) : DeriveContext, comptime(trait_params) : ComptimeList(Expr)) -> comptime(Expr))({
  eq_body :: Type.join_fields(
    T,
    (fn(comptime(field) : FieldInfo) -> comptime(Expr))(
      quote(self.(unquote(field.name.to_expr())).my_eq(other.(unquote(field.name.to_expr()))))
    ),
    quote(&&)
  );
  ctx.make_impl(
    quote(
      MyEq(unquote_splicing(trait_params))(
        my_eq : ((self, other) -> unquote(eq_body))
      )
    )
  )
});
derive_rule(MyEq, my_derive_eq);

Point :: struct(x : i32, y : i32);
derive(Point, MyEq(Point)); // Uses the registered derive_rule
```

## Type Reflection

Yo provides compile-time type reflection through the `TypeInfo` enum and `Type.get_info()`. Unlike simple type tag systems, `TypeInfo` carries rich structural metadata — struct fields, enum variants, function parameters, and more.

```yo
info :: Type.get_info(i32);
comptime_assert(info.is_primitive(), "i32 is primitive");
comptime_assert(info.is_integer(), "i32 is an integer");

info2 :: Type.get_info(Point);
comptime_assert(info2.is_struct(), "Point is a struct");
```

Compound variants carry metadata that can be extracted via `match`:

```yo
// Extract array element type and length
arr_info :: Type.get_info([i32 ; 3]);
elem :: match(arr_info, .Array(e, _) => e, _ => unit);
len :: match(arr_info, .Array(_, l) => l, _ => 0);
comptime_assert(len == 3, "array length is 3");

// Inspect struct fields
pt_info :: Type.get_info(Point);
field_count :: match(pt_info, .Struct(f, _) => f.len(), _ => usize(0));
comptime_assert(field_count == usize(2), "Point has 2 fields");

// Match dispatch on type info
describe :: (fn(comptime(T) : Type) -> comptime(comptime_str))(
  match(
    Type.get_info(T),
    .I32 => "32-bit signed integer",
    .Struct(_, _) => "struct type",
    .Enum(_) => "enum type",
    _ => "other type"
  )
);
```

Guard methods on `TypeInfo`:

- **Structural**: `is_struct()`, `is_enum()`, `is_union()`, `is_tuple()`, `is_array()`, `is_str()`, `is_function()`, `is_pointer()`, `is_trait()`, `is_void()`
- **Numeric**: `is_primitive()`, `is_integer()`, `is_float()`, `is_numeric()`, `is_comptime()`

For the full TypeInfo enum definition, metadata structs, and detailed usage, see [TYPE_REFLECTION.md](./TYPE_REFLECTION.md).

## Compile-Time Evaluation

Yo has powerful compile-time evaluation capabilities. You can perform computations, type manipulations, and code generation at compile time.

### Compile-Time Variables

Variables declared with `::` are compile-time constants:

```yo
// Compile-time integer
x :: 42; // comptime_int
y :: (x + 10); // comptime_int = 52
// Compile-time type
MyInt :: i32; // comptime(Type)
value := MyInt(100); // Runtime i32
// Compile-time computation
factorial :: (fn(comptime(n) : comptime_int) -> comptime(comptime_int))(
  cond(
    (n <= 1) => 1,
    true => (n * recur(n - 1))
  )
);
result :: factorial(5); // Computed at compile time: 120
```

### Compile-Time Arithmetic

All primitive operations can be performed at compile time:

```yo
// Integer operations
a :: 100;
b :: 25;
sum :: (a + b); // 125
diff :: (a - b); // 75
prod :: (a * b); // 2500
quot :: (a / b); // 4
rem :: (a % b); // 0
// Comparison operations
eq :: (a == b); // false
lt :: (b < a); // true
gte :: (a >= b); // true
// Floating-point operations
pi :: f32(3.14159);
radius :: f32(5.0);
area :: (pi * (radius * radius)); // ~78.54
// Boolean operations
flag1 :: true;
flag2 :: false;
and_result :: (flag1 && flag2); // false
or_result :: (flag1 || flag2); // true
not_result :: not(flag1); // false
```

### Compile-Time Arrays

Arrays with compile-time known lengths:

```yo
// Inferred length
arr :: [1, 2, 3, 4, 5]; // Array(i32, 5)
len := arr.len(); // 5 (runtime read; the length also lives in the type)
// Array.fill takes a comptime value, returns a runtime array
zeros := Array(i32, 10).fill(0); // [0,0,0,0,0,0,0,0,0,0]
// Generic array function
create_array :: (fn(comptime(T) : Type, comptime(n) : usize, value : T) -> [T ; n])(Array(T, n).fill(value));

int_array := create_array(i32, 5, 42); // [42,42,42,42,42]
```

### Compile-Time Assertions

Use `comptime_assert` to verify compile-time conditions:

```yo
test("Compile-time assertions", {
  // These are checked at compile time
  comptime_assert((2 + 2) == 4);
  comptime_assert(f32(100.5) > f32(50.0));
  comptime_assert(Array(i32, 5).fill(0).len() == 5);

  // Compile-time type checks
  T :: i32;
  comptime_assert(Type.to_comptime_string(T) == "i32");
});
```

### Compile-Time Expected Errors

Test that code produces compile-time errors:

```yo
test("Expected compile errors", {
  // Verify that this code produces an error
  comptime_expect_error(
    x :: (1 / 0),
    // Division by zero
    "Division by zero"
  );

  comptime_expect_error({
    arr : Array(i32, _); // Cannot infer length in binding
    arr = [1, 2, 3];
  });
});
```

### Compile-Time vs Runtime

Understanding when things happen:

```yo
// Compile-time: declared with :: or comptime(...)
COMPT_VALUE :: 42; // Computed at compile time
ComptimeType :: i32; // Type selected at compile time
// Runtime: declared with :=
runtime_value := 42; // Computed at runtime
runtime_type := i32(100); // Value created at runtime
// Mixed: compile-time type, runtime value
(x : i32) = 42; // Type known at compile time
// Value computed at runtime
// Compile-time function parameter
array_fn :: (fn(comptime(n) : usize) -> Array(i32, n))(
  Array(i32, n).fill(0)
); // n must be known at compile time
// Runtime function parameter
increment :: (fn(x : i32) -> i32)(
  x + 1
); // x is runtime value
```

### Benefits of Compile-Time Evaluation

1. **Zero runtime cost**: Computations done once at compile time
2. **Type safety**: Catch errors before execution
3. **Generic programming**: Type-level abstraction without runtime overhead
4. **Metaprogramming**: Generate code based on compile-time information

For more examples, see `tests/comptime.test.yo`.

## Inline Assembly

Yo provides `asm()` and `global_asm()` builtins for embedding inline assembly, inspired by Rust's `asm!` macro. Features include:

- **Operand types**: `in`, `out`, `inout`, `lateout`, `inlateout`, `const_val`, `sym`
- **Register constraints**: `reg`, `imm`, `mem`, explicit register names (e.g., `"rax"`)
- **Named operands**: `out("result", reg, i32)` with template references `{result}`
- **Variable-target outputs**: `out(reg, x)` writes directly to a variable, including uninitialized ones
- **Clobbers and options**: `clobber("memory")`, `asm_options(volatile, noreturn)`
- **Multi-architecture**: x86_64 and aarch64 support

```yo
// Simple example: move immediate to register
result := asm(
  "mov {0}, #42",
  out(reg, i32)
);

// Uninitialized variable output
x : i32;
asm("mov {0}, #42", out(reg, x));
```

For the full design, syntax reference, and C codegen details, see [INLINE_ASSEMBLY.md](INLINE_ASSEMBLY.md).

## Index Trait

Yo provides a unified `Index` trait for custom indexing on any type. Types that implement `Index(Idx)` can use function-call syntax `value(index)` for element access, pointer access via `addr_of(value(index))`, and mutation via the call-syntax assignment `value(index) = new_value`.

The standard library implements `Index` for its collection types, including `ArrayList`, `HashMap`, `BTreeMap`, `Deque` and `String`. Fixed-size arrays and `str` use built-in indexing with the same syntax; `..` and `..=` ranges on collections produce owned copies (`slice_copy`), while ranges on `str` are zero-copy static windows.

For the full design, trait definition, and implementation details, see [INDEX_TRAIT.md](./INDEX_TRAIT.md).

## In Design

Please check [IN_DESIGN.md](../../plans/archive/IN_DESIGN.md) for features that are still in design phase.

## References

- [Ocaml Locality](https://blog.janestreet.com/oxidizing-ocaml-locality/)
- [Data race freedom](https://github.com/ocaml-flambda/ocaml-jst/blob/main/jane/doc/proposals/data-race-freedom.md)
- [ICFP'21 Tutorials - Programming with Effect Handlers and FBIP in Koka](https://www.youtube.com/watch?v=6OFhD_mHtKA&ab_channel=ACMSIGPLAN)
- [Simply Easy! An Implementation of a Dependently Typed Lambda Calculus](http://strictlypositive.org/Easy.pdf)
- [Reconstructing TypeScript](https://jaked.org/blog/2021-09-07-Reconstructing-TypeScript-part-0)
- [PureScript Types](https://github.com/purescript/documentation/blob/master/language/Types.md)
- [The Ultimate Conditional Syntax](https://icfp22.sigplan.org/details/mlfamilyworkshop-2022-papers/6/The-Ultimate-Conditional-Syntax)
- [Algebraic Effects for the Rest of Us](https://overreacted.io/algebraic-effects-for-the-rest-of-us/)
- [What Color is Your Function](https://journal.stuffwithstuff.com/2015/02/01/what-color-is-your-function/)
- [Implementing Algebraic Effects in C "Monads for Free in C"](https://www.microsoft.com/en-us/research/wp-content/uploads/2017/06/algeff-in-c-tr.pdf)
- [Efficient Compilation of Algebraic Effect Handlers - Ningning Xie](https://www.youtube.com/watch?v=tWLPrPfb4_U&ab_channel=ETHWSCR)
- [Generalized Evidence Passing for Effect Handlers](https://www.microsoft.com/en-us/research/uploads/prod/2021/03/multip-tr-v4.pdf)
- [Structured Asynchrony with Algebraic Effects](https://www.microsoft.com/en-us/research/wp-content/uploads/2017/05/asynceffects-msr-tr-2017-21.pdf)
- [Effects as Capabilities: Effect Handlers and Lightweight Effect Polymorphism](https://dl.acm.org/doi/pdf/10.1145/3428194)
- [A Typed Continuation-Passing Translation for Lexical Effect Handlers](https://se.cs.uni-tuebingen.de/publications/schuster22typed.pdf)
- [Zero-cost Effect Handlers](https://se.cs.uni-tuebingen.de/publications/schuster19zero.pdf)
- [Why Rust Closures are (Somewhat) Hard](https://stevedonovan.github.io/rustifications/2018/08/18/rust-closures-are-hard.html)
- [Inside Rust's Async Transformation](https://blag.nemo157.com/2018/12/09/inside-rusts-async-transform.html)
- [Coroutines: Suspending State Machines](https://medium.com/google-developer-experts/coroutines-suspending-state-machines-36b189f8aa60)
- [What's the difference between an algebraic effect, a callback function, and a coroutine](https://www.reddit.com/r/ProgrammingLanguages/comments/13v35fk/whats_the_difference_between_an_algebraic_effect/)
- [Revisiting coroutines](https://dl.acm.org/doi/abs/10.1145/1462166.1462167)
- [One-shot Algebraic Effects as Coroutines](http://logic.cs.tsukuba.ac.jp/~sat/pdf/tfp2020.pdf)
- [Implementing Co, a Small Language With Coroutines](https://abhinavsarkar.net/posts/implementing-co-3/)
- [Retrofitting Effect Handlers onto OCaml](https://arxiv.org/pdf/2104.00250.pdf)
- [Do Be Do Be Do](https://arxiv.org/pdf/1611.09259.pdf)
- [Custom Infix Operators in Haskell](<https://bugfactory.io/blog/custom-infix-operators-in-haskell/#:~:text=Precedence%20(aka%20Operator%20Binding)&text=All%20operators%20in%20Haskell%20have,6%20>).)
- [Region-Based Memory Management in Cyclone](https://www.cs.umd.edu/projects/cyclone/papers/cyclone-regions.pdf)
- [Implementation Strategies for Mutable Value Semantics](https://www.jot.fm/issues/issue_2022_02/article2.pdf)
- [Type Classes as Objects and Implicits](https://citeseerx.ist.psu.edu/document?repid=rep1&type=pdf&doi=d30d65ca9ce7891352024a5c71ebe0ae8c41f7ac)
- [Implicit Parameters: Dynamic Scoping with Static Types](https://dl.acm.org/doi/pdf/10.1145/325694.325708)
- [Scrap your type classes](https://www.haskellforall.com/2012/05/scrap-your-type-classes.html)
- [Implicit Parameters in Scala and Haskell](https://trebledj.me/posts/implicit-parameters-in-scala-and-haskell/)
- [High-level effect handlers in C](https://homepages.inf.ed.ac.uk/slindley/papers/libseff-draft-november2023.pdf)
- [Exceptions in C with longjmp and setjmp](https://web.archive.org/web/20091104065428/http://www.di.unipi.it/~nids/docs/longjump_try_trow_catch.html)
- [Continuation Passing for C](https://www.irif.fr/~jch/cpc.pdf)
- [Refinement Types for TypeScript](https://goto.ucsd.edu/~pvekris/docs/pldi16.pdf)
- [Continuations and Delimited Control
  ](https://okmij.org/ftp/continuations/)
- [Custom allocators in Rust](https://nical.github.io/posts/rust-custom-allocators.html)
- [Ownership You Can Count On: A Hybrid Approach to Safe Explicit Memory Management](https://inko-lang.org/papers/ownership.pdf)
