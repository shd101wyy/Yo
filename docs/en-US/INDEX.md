# Yo manuals

The map of the Yo manuals: which page covers what, the order to read them in,
and which tool answers a question no page does. `yo context --doc NAME` prints
any page named here; `yo context --docs` lists them.

## Where to start

1. [INSTALL](./INSTALL.md): the compiler and its C toolchain.
2. `yo context`: the language pack, a compact guide to writing Yo with the
   installed compiler ([CONTEXT](./CONTEXT.md)).
3. [SYNTAX](./SYNTAX.md), [DATA_TYPES](./DATA_TYPES.md),
   [FUNCTIONS](./FUNCTIONS.md), [CLOSURES](./CLOSURES.md) and
   [PATTERN_MATCHING](./PATTERN_MATCHING.md): the core language.
4. [OWNERSHIP_AND_BORROWING](./OWNERSHIP_AND_BORROWING.md): moves, clones and
   references, the rules most first programs trip on.
5. The rest by topic, below.

## Which tool answers what

| Question                                       | Ask                                                       |
| ---------------------------------------------- | --------------------------------------------------------- |
| How do I write Yo? (syntax, idioms, pitfalls)  | `yo context` (the pack)                                   |
| What does this std module or function offer?   | `yo context <module>`, `yo context --search <query>`, the [std reference](https://shd101wyy.github.io/Yo/std) |
| How does a language feature work in depth?     | `yo context --doc NAME` (these manuals)                   |
| What does error `E0xxx` mean, and how to fix it? | `yo explain E0xxx`                                      |
| Which flags does a command take?               | `yo <command> --help`                                     |
| What is my own package's API?                  | `yo doc`                                                  |

## The language

- [SYNTAX](./SYNTAX.md): calls and operators (no precedence), bindings and
  `mut`, literals, control flow, arithmetic failure, naming and `yo fmt`.
- [DATA_TYPES](./DATA_TYPES.md): primitive types, structs, tuples, arrays and
  ranges, enums and ADTs, unions, newtypes, private members and collections.
- [FUNCTIONS](./FUNCTIONS.md): declarations, parameter modes and references,
  named and default arguments, generics, partial application, type methods.
- [CLOSURES](./CLOSURES.md): captures, capture lists, `FnOnce`/`FnMut`,
  `Impl(Fn(...))` and `Dyn(Fn(...))`.
- [PATTERN_MATCHING](./PATTERN_MATCHING.md): `match`, pattern forms, guards and
  exhaustiveness.
- [TRAITS](./TRAITS.md): traits and `impl`, static methods, associated types,
  coherence, `Impl(Trait)`, `Index`/`IndexMut` and `Deref`.
- [TRAIT_OBJECTS](./TRAIT_OBJECTS.md): `Dyn` trait objects, `dyn(...)`, object
  safety, `downcast`/`upcast` and existential types.
- [ADVANCED_TYPES](./ADVANCED_TYPES.md): higher-kinded types, GADTs and
  typestate.
- [ERROR_HANDLING](./ERROR_HANDLING.md): `Result`, `Error`/`AnyError`,
  `Exception` and `ResumableException`.
- [MODULES](./MODULES.md): `import`/`export`, module-level bindings and
  order-independent definitions.
- [TESTING](./TESTING.md): `test(...)`, assertions, expected compile errors and
  test files.
- [STRINGS](./STRINGS.md): UTF-8 strings with byte-offset indexing, `str`,
  `String` and template strings.
- [CTFE](./CTFE.md): compile-time function evaluation, `comptime` values and
  meta-programming.
- [DERIVE_TRAITS](./DERIVE_TRAITS.md): `derive(...)` and the self-hosted
  `derive_rule` mechanism.
- [TYPE_REFLECTION](./TYPE_REFLECTION.md): `TypeInfo` and `Type.get_info()`.

## Memory and concurrency

- [OWNERSHIP_AND_BORROWING](./OWNERSHIP_AND_BORROWING.md): one owner per value,
  moves, `.clone()`, `&T`/`&mut T` references and their origins.
- [SHARED_OWNERSHIP](./SHARED_OWNERSHIP.md): `Rc`, `Box`, `RefCell`, `Weak`,
  `Copy`, move-only values and `Drop`.
- [MEMORY_SAFETY](./MEMORY_SAFETY.md): the safe/unsafe contract,
  `pragma(Pragma.AllowUnsafe)` and `yo unsafe-report`.
- [ARC](./ARC.md): `Arc(T)`, atomically counted shared ownership.
- [WEAK](./WEAK.md): `Weak(T)` and `ArcWeak(T)`, non-owning handles that break
  cycles.
- [EXPLICIT_ALLOCATORS](./EXPLICIT_ALLOCATORS.md): choosing where an object's
  bytes live with an `alloc :` argument.
- [ALGEBRAIC_EFFECTS](./ALGEBRAIC_EFFECTS.md): effects, handlers, `return`
  (resume) and `unwind` (discard).
- [ASYNC_AWAIT](./ASYNC_AWAIT.md): `io.async`/`io.await` on a single-threaded
  event loop.
- [STD_SYS_MODULE](./STD_SYS_MODULE.md): the platform async-I/O backends behind
  the event loop.
- [PARALLELISM](./PARALLELISM.md): `Thread(T)` and `ThreadPool`.
- [THREAD_SAFETY](./THREAD_SAFETY.md): `Send`/`Sync`, atomics and `std/sync`.

## Toolchain

- [CONTEXT](./CONTEXT.md): `yo context`, the pack and the API index for agents.
- [BUILD_SYSTEM](./BUILD_SYSTEM.md): `build.yo`, steps, cross-compilation,
  `yo.toml` dependencies and workspaces.
- [ERROR_DIAGNOSTICS](./ERROR_DIAGNOSTICS.md): diagnostic codes, output
  formats, `yo explain` and `yo fix`.
- [FORMAL_VERIFICATION](./FORMAL_VERIFICATION.md): `requires`/`ensures`
  contracts and refinement types proved by Z3 (`yo verify`).
- [LSP](./LSP.md): `yo lsp` and editor setup.
- [VERSION_MANAGEMENT](./VERSION_MANAGEMENT.md): `.yo-version` and
  `yo version`.

## Interop and targets

- [FFI](./FFI.md): `c_include(...)` and `extern(...)` bindings to C, raw
  pointers and `unsafe(...)`.
- [INLINE_ASSEMBLY](./INLINE_ASSEMBLY.md): the `asm(...)` builtin.
- [WASM](./WASM.md): compiling to WebAssembly and shipping a Yo library to
  JavaScript.

## Reference

- [GRAMMAR](./GRAMMAR.md): the formal grammar, the brace rule and the operator
  set.

## Commands

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
