# Bootstrapping Prerequisites

Features, standard library modules, and language improvements needed **before** starting the compiler port. Organized by priority.

---

## Priority Legend

- 🔴 **P1 — Critical**: Needed early in Phase 1 (frontend port). Without it, code is unacceptably verbose or incorrect.
- 🟡 **P2 — Important**: Needed by Phase 2–3 (type system / evaluator). Can work around temporarily.
- 🟢 **P3 — Nice to have**: Improves ergonomics but not strictly required. Can add during bootstrapping.

---

## Existing Modules Inventory

Before listing gaps, here is what **already exists** and is usable:

| Capability                           | Module                              | Status                                                                                                                                                             |
| ------------------------------------ | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Process spawn** (low-level)        | `std/sys/process.yo`                | ✅ `spawn(file, argv, envp, stdin_fd, stdout_fd, stderr_fd)`, `waitpid`, `kill`, `exit_status`, `term_signal`                                                      |
| **CLI argument parser**              | `std/cli/arg_parser.yo`             | ✅ `ArgParser` with flags, options, positionals, help text                                                                                                         |
| **Environment variables**            | `std/env`                           | ✅ `env.get(name)`, `env.set(name, value, overwrite?)`                                                                                                             |
| **Platform detection**               | `std/process`                       | ✅ `platform`, `Platform`, `arch`, `Arch`                                                                                                                          |
| **CWD / chdir**                      | `std/env`                           | ✅ `cwd()`, `chdir(path)`                                                                                                                                          |
| **Command-line args**                | `std/env`                           | ✅ `args()` → `ArrayList(String)`, `raw_args()`                                                                                                                    |
| **Child process spawn (high-level)** | `std/process/command`               | ✅ `Command.new(prog).arg(a).status() / .output()` — captures stdout/stderr through pipes                                                                          |
| **Buffered writer**                  | `std/sys/bufio/buf_writer.yo`       | ✅ `BufWriter` with fd-based async writes + flush                                                                                                                  |
| **Buffered reader**                  | `std/sys/bufio/buf_reader.yo`       | ✅ `BufReader` with fd-based async reads                                                                                                                           |
| **Writer trait**                     | `std/io/writer.yo`                  | ✅ `Writer` trait with `write` + `flush`                                                                                                                           |
| **Reader trait**                     | `std/io/reader.yo`                  | ✅ `Reader` trait with `read`                                                                                                                                      |
| **File I/O**                         | `std/fs/file.yo`                    | ✅ Async open, read, write, seek, metadata                                                                                                                         |
| **Path manipulation**                | `std/path.yo`                       | ✅ `Path` with join, extension, parent, etc.                                                                                                                       |
| **Derive system**                    | `derive(Type, Trait1, Trait2, ...)` | ✅ Phase 1+2 complete: Eq, Hash, Clone, Ord, ToString + user-defined `derive_rule`                                                                                 |
| **Clone trait**                      | `prelude.yo`                        | ✅ `Clone :: trait(clone : fn(self: *(Self)) -> Self)`, `derive(T, Clone)` supported                                                                               |
| **String methods**                   | `std/string/string.yo`              | ✅ `starts_with`, `ends_with`, `contains`, `split`, `replace`, `replace_all`, `trim`, `trim_start`, `trim_end`, `to_uppercase`, `to_lowercase`, `chars()` iterator |
| **HashMap**                          | `std/collections/hash_map.yo`       | ✅ SwissTable impl with `contains_key`, `keys()`, `values()`, `iter()`, `into_iter()`                                                                              |
| **ArrayList**                        | `std/collections/array_list.yo`     | ✅ `into_iter()`, `iter()`, `contains()`, `sort()`, `extend_from_ptr()`, `clear()`, `slice()`                                                                      |
| **Iterator trait**                   | `prelude.yo`                        | ✅ `Iterator(Item, next)` + `IntoIterator` + Array/Slice/ArrayList/HashMap iterators                                                                               |
| **Regex**                            | `std/regex/`                        | ✅ Full NFA engine                                                                                                                                                 |
| **JSON**                             | `std/encoding/json.yo`              | ✅ `json_parse`, `json_stringify`                                                                                                                                  |
| **Error handling**                   | prelude                             | ✅ `Result(T, E)`, `Option(T)` with combinators, `Exception` effect                                                                                                |
| **Type reflection**                  | builtins                            | ✅ `Type.get_info`, `Type.get_struct_fields`, `Type.get_enum_variants`, etc.                                                                                       |

---

## 1. Standard Library Gaps

### 1.1 🔴 High-Level Command Wrapper (`std/process/command`) ✅ Done

Implemented in `std/process/command.yo`:

- `Command :: object(_program, _args, _stdin_fd, _stdout_fd, _stderr_fd)` with builder methods `Command.new(prog)`, `arg(s)`, `args(list)`.
- `status(using(io)) -> Future(ExitStatus, IO, Exception)` — inherits stdio, waits for child.
- `output(using(io)) -> Future(Output, IO, Exception)` — captures stdout/stderr through pipes.
- `ExitStatus :: struct(raw)` with `success()`, `code()`, `signal()` helpers.
- `Output :: object(status, stdout, stderr)`.

Tests in `tests/process/command.test.yo` (3 tests passing).

**Std module reorg done at the same time** to better match Rust conventions:

- `std/process` now contains only platform/arch detection, `exit`, and the `Command` API.
- `std/env` (new) holds `args`, `raw_args`, `argc`, `argv`, the `env` submodule (`get`/`set`), `cwd`, `chdir`.

Deferred follow-ups (separate items, not blocking bootstrapping):

- `Command.env(k, v)` / `current_dir(dir)` — not yet implemented.
- `Command.spawn` returning a `Child` handle — not yet implemented.
- `JoinHandle.await` leaks RC-typed result values — see `issues/joinhandle-await-arraylist-result-leak.md`. Worked around in `output()` by draining sequentially via `io.await`.

### 1.2 🔴 Iterator Combinators on the Iterator Trait

**Exists**: `Iterator` trait with `Item` type and `next()` method. ArrayList/HashMap/Array/Slice all have iterators.

**What's missing**: There are **no combinator methods** on Iterator itself — no `map`, `filter`, `fold`, `find`, `any`, `all`, `collect`, `enumerate`, `join`. The TS evaluator uses these in **155+ places** across 34+ files.

Currently, all iteration must be done with manual `while` + `next()` loops. This is the single biggest ergonomic gap for bootstrapping.

**What's needed** — adapter types + methods on Iterator:

```rust
// Lazy adapters (each is a struct implementing Iterator)
IterMap(I, B) :: struct(inner : I, f : Impl(Fn(I.Item) -> B));
IterFilter(I) :: struct(inner : I, predicate : Impl(Fn(I.Item) -> bool));
IterEnumerate(I) :: struct(inner : I, index : usize);
IterTake(I) :: struct(inner : I, remaining : usize);
IterSkip(I) :: struct(inner : I, remaining : usize);
IterChain(A, B) :: struct(first : A, second : B, first_done : bool);
IterZip(A, B) :: struct(a : A, b : B);
IterFlatMap(I, B, F) :: struct(inner : I, f : F, current : Option(B));

// Methods on any Iterator implementor
impl(forall(I : Type), where(I <: Iterator), I,
  map : ...,
  filter : ...,
  enumerate : ...,
  take : ...,
  skip : ...,
  chain : ...,
  zip : ...,
  flat_map : ...,

  // Terminal operations (consume the iterator)
  fold : (fn(forall(Acc : Type), self : Self, init : Acc, f : Impl(Fn(acc : Acc, item : Self.Item) -> Acc)) -> Acc)(...),
  for_each : (fn(self : Self, f : Impl(Fn(item : Self.Item) -> unit)) -> unit)(...),
  find : (fn(self : Self, predicate : Impl(Fn(item : Self.Item) -> bool)) -> Option(Self.Item))(...),
  any : (fn(self : Self, predicate : Impl(Fn(item : Self.Item) -> bool)) -> bool)(...),
  all : (fn(self : Self, predicate : Impl(Fn(item : Self.Item) -> bool)) -> bool)(...),
  count : (fn(self : Self) -> usize)(...),
  position : (fn(self : Self, predicate : Impl(Fn(item : Self.Item) -> bool)) -> Option(usize))(...),
  collect_to_list : (fn(self : Self) -> ArrayList(Self.Item))(...),
);

// String-specific: join with separator
impl(forall(I : Type), where(I <: Iterator(Item := String)), I,
  join : (fn(self : Self, separator : String) -> String)(...)
);
```

**Estimated effort**: ~600–900 lines (adapter structs + Iterator impls + methods).

**Note**: This may require enhancements to the type system if `impl(forall(I), where(I <: Iterator), I, ...)` doesn't work for adding methods to all Iterator implementors. If not, the alternative is to add methods directly to each collection type (ArrayList, HashMap, etc.).

### 1.3 🟡 StringBuilder (sync, in-memory)

**Exists**: `BufWriter` in `std/sys/bufio/` operates on file descriptors with async I/O.

**What's missing**: A simple **synchronous** in-memory string builder for constructing C code output. The codegen builds strings of C code that are later written to a file. We don't want async I/O for every `emitLine` call.

**What's needed**:

```rust
StringBuilder :: object(
  _buf : ArrayList(u8)
);

impl(StringBuilder,
  new : (fn() -> Self)(...),
  with_capacity : (fn(cap : usize) -> Self)(...),
  write_str : (fn(self : Self, s : str) -> unit)(...),
  write_string : (fn(self : Self, s : String) -> unit)(...),
  write_byte : (fn(self : Self, b : u8) -> unit)(...),
  write_line : (fn(self : Self, s : str) -> unit)(...),  // appends + '\n'
  to_string : (fn(self : Self) -> String)(...),
  len : (fn(self : Self) -> usize)(...),
  clear : (fn(self : Self) -> unit)(...)
);
```

**Estimated effort**: ~100–150 lines. Trivial wrapper around `ArrayList(u8)`.

### 1.4 🟡 Ordered Map (`std/collections/ordered_map`)

**Why**: JavaScript `Map` preserves insertion order. The TS compiler relies on this in at least some places (struct field ordering, module member ordering, declaration ordering in codegen).

**What's needed**: `OrderedMap(K, V)` using HashMap + ArrayList for O(1) lookup + insertion-order iteration.

**Estimated effort**: ~300–400 lines.

### 1.5 🟡 String Additions ✅ Done

All required methods already existed in `std/string/string.yo`:

- `repeat(n)` (line 1653)
- `join(items)` (line 1700)
- `lines()` returning `StringLines` iterator (line 1639)

Verified by new `tests/string/repeat_join_lines.test.yo` (12 tests, all passing). Covers basic, edge cases (empty, zero, single), UTF-8, empty separator, and trailing newlines.

`pad_start`/`pad_end` not yet implemented — deferred (not blocking bootstrap).

### 1.6 🟡 CLI Argument Parser — Subcommand Support

**Exists**: `ArgParser` with flags, options, positionals.

**What may be missing**: Subcommand support (`yo compile`, `yo test`, `yo build`, `yo init`, etc.). The current ArgParser appears to be flat (no nested subcommands).

**Verify**: Check if `ArgParser` supports subcommands. If not, add:

```rust
impl(ArgParser,
  subcommand : (fn(self : Self, name : String, description : String) -> ArgParser)(...),
  // parse() returns which subcommand was selected + its args
);
```

**Estimated effort**: ~100–200 lines if needed.

### 1.7 🟢 Temporary Files/Directories

**May exist** in `std/fs/`. Verify and fill gaps: `temp_dir()`, `create_temp_file(prefix)`, `create_temp_dir(prefix)`.

**Estimated effort**: ~50–80 lines.

### 1.8 🟡 Collection Literal Macros

**Why**: The TS evaluator constructs arrays and maps with literal values everywhere. Without macros, each requires 4+ lines of boilerplate.

**What's needed** — three builtin comptime macros:

#### `array_list(elem1, elem2, ...)`

Creates an ArrayList with the given elements. Type is inferred from the first element.

```rust
// Usage:
names := array_list(`Alice`, `Bob`, `Charlie`);
// Expands to:
{
  __val_0 := `Alice`;
  __arr := ArrayList(typeof(__val_0)).with_capacity(usize(3));
  __arr.push(__val_0);
  __arr.push(`Bob`);
  __arr.push(`Charlie`);
  __arr
}
```

- Type inferred from first element (`typeof(first)`)
- Pre-allocates with `with_capacity(N)` since count is comptime-known
- Cannot create empty lists — use `ArrayList(T).new()` for that
- All elements must be compatible with the inferred type

#### `hash_map(key1 => val1, key2 => val2, ...)`

Creates a HashMap with the given key-value pairs. Types inferred from the first pair.

```rust
// Usage:
config := hash_map(`name` => `Yo`, `version` => `0.2.0`);
// Expands to:
{
  __key_0 := `name`;
  __val_0 := `Yo`;
  __map := HashMap(typeof(__key_0), typeof(__val_0)).with_capacity(usize(2));
  __map.put(__key_0, __val_0);
  __map.put(`version`, `0.2.0`);
  __map
}
```

- Uses `=>` syntax to separate keys from values (consistent with match/cond branch syntax)
- Type inferred from first key-value pair
- Cannot create empty maps — use `HashMap(K, V).new()` for that

#### `hash_set(elem1, elem2, ...)`

Creates a HashSet with the given elements. Type inferred from the first element.

```rust
// Usage:
keywords := hash_set(`fn`, `let`, `if`, `match`);
// Expands to:
{
  __val_0 := `fn`;
  __set := HashSet(typeof(__val_0)).with_capacity(usize(4));
  __set.insert(__val_0);
  __set.insert(`let`);
  __set.insert(`if`);
  __set.insert(`match`);
  __set
}
```

**Implementation**: These would be builtin comptime macros in the evaluator (similar to `derive`), since they need variadic arguments and comptime type inference.

**Estimated effort**: ~200–400 lines in the evaluator (one handler per macro, shared expansion logic).

---

## 2. Language / Compiler Features to Verify or Add

### 2.1 🔴 Blanket Impl on Iterator Trait

The iterator combinators (§1.2) require adding methods to **all types that implement Iterator**. This needs:

```rust
impl(forall(I : Type), where(I <: Iterator), I,
  map : ...,
  filter : ...,
  ...
);
```

**Verify**: Does the Yo evaluator/codegen support blanket impls like this? If type `T` implements `Iterator`, can we add methods to `T` via a blanket `impl(forall(T), where(T <: Iterator), T, ...)`?

**If not supported**: This is the #1 language feature gap. Without it, we'd need to add combinators to each collection type individually (ArrayList, HashMap, Array, etc.) — feasible but much more code and less composable.

### 2.2 🔴 Verify `derive(Clone)` on Complex Types

derive(Clone) is documented as Phase 1 complete. Verify it works for:

- [ ] Structs with primitive fields (i32, bool, usize)
- [ ] Structs with `String` fields (RC type — clone increments RC)
- [ ] Structs with `ArrayList(T)` fields
- [ ] Structs with `HashMap(K, V)` fields
- [ ] Structs with `Option(T)` fields
- [ ] Structs with `Box(T)` fields (deep clone the box contents)
- [ ] Enums with data variants
- [ ] Enums with Box/String/ArrayList variant fields
- [ ] Recursive types: `Expr` containing `Box(Self)`
- [ ] Large enums with 20+ variants

If any of these fail, fix before bootstrapping.

### 2.3 🟡 Large Enum Codegen Performance

The AST `Expr` enum will have 20+ variants, some containing `Box(Self)`, `ArrayList(Self)`, `String`, etc.

**Verify**:

- Enum size doesn't explode (variants with large data should use Box/pointer)
- `match` on 20+ variant enum generates efficient C (jump table, not linear if-else chain)
- `derive(Clone, Eq, Hash, ToString)` on 20+ variant enum compiles in reasonable time
- Nested match (match inside match branch) doesn't cause exponential codegen

### 2.4 ✅ Recursive Enum Types

```rust
Expr :: enum(
  Atom(id : ExprId, token : Token),
  FnCall(id : ExprId, func : Box(Self), args : ArrayList(Self), token : Token)
);
```

**Verify**:

- ✅ `Box(Self)` in enum definitions compiles
- ✅ Single-level Box(Self) drop works correctly
- ✅ `ArrayList(Self)` variant drops correctly (per-element drop iterates)
- ✅ Nested Box(Self) trees drop correctly (fixed in `evaluator/types/utils.ts` via post-pass `regenerateRcFunctionsForRecursiveStructs`)
- ✅ Deeply nested Box(Self) spines (50+ levels) drop without leaks
- ❌ `derive(Clone)` on recursive types — see `issues/recursive-derive-clone-codegen-vtable.md` (separate codegen ordering bug; deferred)

Tests: `tests/recursive_enum.test.yo` (4 passing).

### 2.5 🟡 Closure Capture Correctness in Iterators

The `.map((x) => ...)` pattern creates closures that capture variables from the enclosing scope. With 155+ such usages, correctness here is critical.

**Verify**:

- Captured RC variables are properly dup'd when the closure is created
- No use-after-free when the iterator outlives the captured variable's scope
- Performance is acceptable (no excessive heap allocation per closure creation)

### 2.6 🟡 Optional Chaining Equivalent

**Why**: 119 uses of `??` and 12 uses of `?.` in TS codebase.

**Already available**:

- `value.unwrap_or(default)` → replaces `??`
- `value.map((o) => o.field)` → replaces `?.`
- `value.and_then((o) => o.method())` → replaces `?.method()`

**Consider adding**: A `?` postfix operator for early return with `Option`/`Result` (like Rust). This would dramatically reduce boilerplate in the evaluator where many functions return `Option(T)` or `Result(T, E)`.

**Decision**: Not strictly required — `match`/combinators/effects work. But worth considering if it's low-effort to implement.

### 2.7 🟢 Derive `ToString` Quality for Enums

Verify `derive(ToString)` produces useful output for data enums:

- `Color.Red` → `"Red"` ✓
- `Option.Some(42)` → `"Some(42)"` — does it recursively call `.to_string()` on fields?
- `Expr.FnCall(...)` → should show variant name at minimum

### 2.8 🟢 Derive `Eq` and `Hash` on Complex Enums

Verify these work on enums with:

- Multiple data variants with different field counts
- Fields that are themselves enums
- Box fields (equality/hash should go through the Box)

---

## 3. Tooling Prerequisites

### 3.1 🟡 Single-File C Amalgamation (`--amalgamate`)

**What's needed**: A flag for `yo compile` that produces a single `.c` file containing all generated code + runtime. Needed for distributing `yo.c`.

**Estimated effort**: ~200 lines. Mostly a build system / codegen concern.

### 3.2 🟢 Cross-Compilation Targets

Extend `--target` to native triples (`x86_64-linux-gnu`, `aarch64-apple-darwin`, etc.) for CI builds. Or use per-platform GitHub Actions runners.

---

## 4. Verification Plan

Before starting Phase 1 of bootstrapping, write test programs that exercise every prerequisite:

1. **High-level Command wrapper** — spawn `echo`, capture stdout, check exit code
2. **Iterator combinators** — `list.iter().filter(...).map(...).collect()`
3. **StringBuilder** — build a multi-line C function string, verify output
4. **Collection literal macros** — `array_list(1, 2, 3)`, `hash_map(`a`=> 1,`b` => 2)`, `hash_set(`x`, `y`)`
5. **Clone on complex types** — clone a struct with Box, ArrayList, String fields
6. **Large enum** — define 20+ variant enum, match on it, derive traits
7. **Recursive enum** — `Expr` with `Box(Self)`, clone it, match it
8. **Closure capture in iterators** — `.map()` capturing outer scope variables
9. **String operations** — `repeat`, `join`, all existing methods work together

---

## 5. Summary: Work Items by Priority

| #   | Item                                                                       | Priority | Effort (lines)        | Blocks                       |
| --- | -------------------------------------------------------------------------- | -------- | --------------------- | ---------------------------- |
| 1   | Iterator combinators (map/filter/find/any/all/fold/collect/enumerate/join) | 🔴 P1    | 600–900               | Evaluator port (155+ usages) |
| 2   | Verify blanket impl on Iterator works                                      | 🔴 P1    | 0–500 (if fix needed) | Iterator combinators         |
| 3   | High-level Command wrapper                                                 | 🔴 P1    | 300–500               | CLI / compile pipeline       |
| 4   | Verify derive(Clone) on complex types                                      | 🔴 P1    | 0–200 (if fix needed) | AST types                    |
| 5   | Collection literal macros (array_list, hash_map, hash_set)                 | 🟡 P2    | 200–400               | Ergonomics throughout        |
| 6   | StringBuilder (sync in-memory)                                             | 🟡 P2    | 100–150               | Codegen port                 |
| 7   | String additions (repeat, join, lines)                                     | 🟡 P2    | 60–100                | Throughout                   |
| 8   | OrderedMap                                                                 | 🟡 P2    | 300–400               | Evaluator port               |
| 9   | ArgParser subcommand support (verify/add)                                  | 🟡 P2    | 0–200                 | CLI port                     |
| 10  | Large enum + recursive type verification                                   | 🟡 P2    | 0–300 (if fix needed) | AST design                   |
| 11  | Closure capture verification                                               | 🟡 P2    | 0–200 (if fix needed) | Iterator usage               |
| 12  | `?` operator for Option/Result                                             | 🟡 P2    | 200–400 (new feature) | Evaluator ergonomics         |
| 13  | Derive ToString/Eq/Hash quality verification                               | 🟢 P3    | 0–100 (if fix needed) | Error messages               |
| 14  | Single-file C amalgamation                                                 | 🟢 P3    | 200                   | Distribution                 |
| 15  | Cross-compilation targets                                                  | 🟢 P3    | 300–500               | CI/CD                        |

**Total estimated effort for P1**: ~900–2,100 lines of new code + verification
**Total estimated effort for all**: ~2,260–4,850 lines

These investments enrich the Yo standard library for **all** users, not just the compiler bootstrap.
