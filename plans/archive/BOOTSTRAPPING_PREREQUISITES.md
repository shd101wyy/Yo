> **CLOSED (2026-08-06).** The bootstrap campaign this document belongs to is
> complete: the self-hosted compiler passes the full suite, the stage-2/stage-3
> fixpoint holds, and every CI job gates PRs (run 31069479984, commit
> `ac85f6cfc`). Kept as a historical record — do not resume work from this
> file. Umbrella status: `plans/archive/BOOTSTRAPPING.md`. What comes next:
> `plans/archive/SELF_HOSTING_COMPLETION.md`.

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
| **CLI argument parser**              | `std/cli/arg_parser.yo`             | ✅ `ArgParser` with flags, options, positionals, help text, **subcommands** (nested)                                                                               |
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
| **Clone trait**                      | `prelude.yo`                        | ✅ `Clone :: trait(clone : (fn(self: *(Self)) -> Self))`, `derive(T, Clone)` supported                                                                             |
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
- `status(using(io)) -> Future(ExitStatus, Io, Exception)` — inherits stdio, waits for child.
- `output(using(io)) -> Future(Output, Io, Exception)` — captures stdout/stderr through pipes.
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

### 1.2 ✅ Iterator Combinators on the Iterator Trait (Done — partial)

**Done**: `std/prelude.yo` defines blanket impl `impl(forall(I), where(I <: Iterator), I, ...)` (lines ~6037-6161) with adapter structs:

- `IterMap`, `IterFilter`, `IterTake`, `IterSkip`, `IterEnumerate`, `IterZip`
- Methods on every Iterator: `map`, `filter`, `take`, `skip`, `enumerate`, `zip`, `fold`, `for_each`, `count`, `any`, `all`

Verified by `tests/iterator_combinators.test.yo` (11 passing tests covering single combinators + chained pipelines like `.filter().map().count()` and `ArrayList.iter()`-based chains).

**Known limitations** filed as issues for follow-up:

- `issues/fn-trait-param-multi-arg-call.md` — **Resolved.** All three forms now work: named-fn `fold(0, add)`, inline `(fn(...) -> ...)`, and the `=>` lambda form `fold(0, (acc, x) => (acc + x))`. Fixed by `substituteSomeTypesFromEnv` in `src/evaluator/values/anonymous-function.ts`, which substitutes forall SomeTypes from the callee env into the Fn trait callType before binding lambda parameter types.
- ~~`issues/iter-zip-blanket-impl-not-resolved.md`~~ — **Fixed**. Root cause: where-constraint expression map keyed by `traitType.id` collided across specialized variants of the same trait. Now keyed by `(someType, kind, index)`.
- Closure capture leak in `for_each(x => list.push(x))` — **Fixed.** Root cause: `attachTempVariableToExpr` (in `src/expr.ts`) used `expr.$.type` (the closure's `Impl(Fn(...))` trait type, which contains no RC fields) for the RC ownership check. The closure temp was therefore marked `isOwningTheRcValue: false` and never dropped at scope end, leaking every captured RC variable. Fixed by detecting `expr.$.captureType` (the underlying capture struct) and using it for both the RC check and the temp variable's type so drop codegen dispatches to the capture struct's `___drop`. Regression coverage: `tests/closure_capture_rc_leak.test.yo` (7 tests).

**Pre-fixes shipped while testing**:

- `std/prelude.yo`: changed `match(&iter.next(), ...)` → `match((&iter).next(), ...)` in 5 sites (fold/for_each/count/any/all). The unparenthesized form was greedily consumed by unary `&` per Yo syntax rules.

The remaining gaps (`find`, `position`, `flat_map`, `chain`, `collect_to_list`, `join`) are not on the critical path for the bootstrap and can be added incrementally.

### 1.3 ✅ StringBuilder (sync, in-memory) — Done

Implemented in `std/string/string_builder.yo`. Verified by `tests/string/string_builder.test.yo` (21 tests, all passing). Public API: `new`, `with_capacity`, `len`, `is_empty`, `write_str`, `write_string`, `write_byte`, `write_line`, `to_string`, `clear`.

### 1.4 ✅ Ordered Map (`std/collections/ordered_map`) — Done

**Why**: JavaScript `Map` preserves insertion order. The TS compiler relies on this in at least some places (struct field ordering, module member ordering, declaration ordering in codegen).

**What's implemented**: `OrderedMap(K, V)` backed by `HashMap(K, V)` for O(1) lookup + `ArrayList(K)` for insertion-order iteration. Public API: `new`, `len`, `is_empty`, `contains_key`, `get`, `set`, `remove`, `clear`, `keys`, `values`, `iter`. Iterators: `OrderedMapKeys`, `OrderedMapValues`, `OrderedMapIter` yielding `OrderedMapEntry(K, V)`.

Verified by `tests/collections/ordered_map.test.yo` (9 tests, all passing). Covers empty, set/get, update preserves order, iteration, iter pairs, remove, clear, re-insert appends to end, 50-entry stress.

### 1.5 🟡 String Additions ✅ Done

All required methods already existed in `std/string/string.yo`:

- `repeat(n)` (line 1653)
- `join(items)` (line 1700)
- `lines()` returning `StringLines` iterator (line 1639)

Verified by new `tests/string/repeat_join_lines.test.yo` (12 tests, all passing). Covers basic, edge cases (empty, zero, single), UTF-8, empty separator, and trailing newlines.

`pad_start`/`pad_end` not yet implemented — deferred (not blocking bootstrap).

### 1.6 ✅ CLI Argument Parser — Subcommand Support

**Exists**: `ArgParser` with flags, options, positionals, help text, and **subcommands** (added in this session).

**Subcommand API**:

```rust
parser := ArgParser.new(`git`, `Distributed VCS`);
commit_sub := parser.add_subcommand(`commit`, `Record changes`);
commit_sub.add_flag(`--amend`, `-a`, `Amend previous commit`);

// Returned ParsedArgs exposes:
parsed.get_subcommand()        // -> Option(String)
parsed.get_subcommand_args()   // -> Option(ParsedArgs)
```

Supports arbitrarily nested subcommands. Help text auto-includes a `Subcommands:` section. Subcommand parse errors propagate. Unknown subcommand names fall through and are treated as ordinary positionals.

**Tests**: 8 new subcommand cases in `tests/cli/arg_parser.test.yo` (15 tests total).

### 1.7 ✅ Temporary Files/Directories — Done

Implemented in `std/fs/temp.yo` with RAII-managed `TempDir` and `TempFile` types. APIs: `TempDir.new()`, `TempDir.in(parent)`, `TempFile.new(prefix)`, `TempFile.in(parent, prefix)`, `path()`, `remove()`. Verified by `tests/fs/temp.test.yo` (7 tests, all passing).

### 1.8 ✅ Collection Literal Macros

**Status**: Implemented. `array_list`, `hash_map`, `hash_set` macros are defined in their respective `std/collections/*.yo` files (auto-available when the user `open import`s the collection module). Variadic `...(quote(elems))` parameters collect call-site exprs into an `ExprList`; recursive comptime helpers build the push/set/add statement list and the macro splices them into a begin block via `unquote_splicing`.

#### Syntax

Element/key/value type is inferred from the first argument via `typeof`. Empty literals are not allowed (no type to infer from) and produce a `comptime_assert` error.

```rust
xs := array_list(i32(1), i32(2), i32(3));            // ArrayList(i32)

m := hash_map(`a` => i32(1), `b` => i32(2));         // HashMap(String, i32)

s := hash_set(i32(1), i32(2), i32(3));               // HashSet(i32)
```

#### Bug discovered + fixed during implementation

`recur` in a comptime helper short-circuits to `UnknownValue` when called inside a macro body (because the caller's `isValidatingFunctionDefinition` flag was still set). Fixed in `src/evaluator/calls/function.ts` — the two macro-expansion call sites now clear validation flags. See `issues/recur-short-circuit-inside-macro-body.md` for details.

Tests: `tests/collection_literals.test.yo` (11 tests, all passing).

---

## 2. Language / Compiler Features to Verify or Add

### 2.1 ✅ Blanket Impl on Iterator Trait

Verified working: `std/prelude.yo` (lines ~6037+) successfully defines

```rust
impl(forall(I : Type), where(I <: Iterator), I, ...)
```

with map/filter/take/skip/enumerate/zip/fold/for_each/count/any/all dispatched through the receiver `I`. End-to-end exercised by `tests/iterator_combinators.test.yo` (15 passing tests, including 2 zip tests).

All `iter.fold` lambda forms now work end-to-end (issue `fn-trait-param-multi-arg-call.md` resolved).

### 2.2 ✅ Verify `derive(Clone)` on Complex Types

derive(Clone) verified for:

- ✅ Structs with primitive fields (i32, bool, usize) — covered by existing `tests/derive.test.yo`
- ✅ Structs with `String` fields — `tests/bootstrap_verification.test.yo` `derive Clone for struct with String field`
- ✅ Structs with `Option(T)` fields — `derive Clone for struct with Option field`
- ✅ Enums with data variants — existing
- ✅ Enums with `String` variant fields — `derive Clone on enum with String field variant`
- ✅ Structs with `ArrayList(T)` / `HashMap(K, V)` / `Box(T)` fields — verified in `tests/derive_clone_complex.test.yo`
- ✅ Recursive types: `TreeNode` containing `Box(Self)` — `tests/derive_clone_complex.test.yo` "derive Clone for recursive enum with Box(Self)" (codegen ordering bug fixed via late-dispatch resolution in `src/codegen/exprs/property-access.ts`; see `issues/recursive-derive-clone-codegen-vtable.md`)

**Side fix**: Added missing `Eq` impls for `Option(T)` (where `T <: Eq(T)`) and `Result(T, E)` (where `T <: Eq(T), E <: Eq(E)`) in `std/prelude.yo` so that derive(Eq) works on structs containing Option/Result fields.

### 2.3 ✅ Large Enum Codegen Verification

Verified by `tests/bootstrap_verification.test.yo`:

- ✅ 25-variant `BigEnum` compiles and roundtrips equality
- ✅ 25-arm `match` dispatches correctly
- ✅ `derive(Eq, Clone, ToString)` on 25-variant enum compiles in normal time
- ✅ Variants with `Box(Self)` verified in `tests/derive_clone_complex.test.yo` (recursive Clone case 9)

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
- ✅ `derive(Clone)` on recursive types — fixed via late-dispatch resolution in codegen (`src/codegen/exprs/property-access.ts`); see `issues/recursive-derive-clone-codegen-vtable.md`

Tests: `tests/recursive_enum.test.yo` (4 passing).

### 2.5 ✅ Closure Capture Correctness in Iterators

Verified by `tests/bootstrap_verification.test.yo`:

- ✅ Closure captures comptime i32 by value (count > threshold pattern)
- ✅ Closure captures `String` by RC; outlives capture site (no UAF, original still readable after iter)
- ✅ Closure captures `ArrayList`; mutation visible after iter scope ends

### 2.6 ✅ Optional Chaining Equivalent

**Why**: 119 uses of `??` and 12 uses of `?.` in TS codebase.

**Already available**:

- `value.unwrap_or(default)` → replaces `??`
- `value.map((o) => o.field)` → replaces `?.`
- `value.and_then((o) => o.method())` → replaces `?.method()`
- `try(expr)` macro in `std/prelude.yo` → equivalent of Rust's `?` operator for `Result`. Unwraps `Ok(value)` and early-returns `Err(error)` from the enclosing function. Verified by `tests/try_macro.test.yo` (4 tests covering Ok unwrap, Err propagation, chaining, RC error types).

**Note**: The `try` macro previously contained invalid pattern syntax (`.Ok =>` instead of `.Ok(value)`); this was fixed during bootstrapping prep.

### 2.7 ✅ Derive `ToString` Quality for Enums

Verified by `tests/bootstrap_verification.test.yo`:

- ✅ Fieldless variant: `BigEnum.V17` → `"BigEnum.V17"`
- ✅ Single-field variant: `Mixed.OneInt(7)` → `"Mixed.OneInt(7)"`
- ✅ Multi-field variant: `Mixed.TwoInts(3, 4)` → `"Mixed.TwoInts(3, 4)"`
- ✅ String field: `Mixed.WithStr("hello")` works in Clone (ToString format covered by existing tests)

### 2.8 ✅ Derive `Eq` and `Hash` on Complex Enums

Verified by `tests/bootstrap_verification.test.yo`:

- ✅ Mixed variants (fieldless, 1-field, 2-field, String field) — Eq dispatches by tag then field
- ✅ Cross-variant inequality (`Empty != OneInt(5)`)
- ✅ Within-variant equality and inequality (`OneInt(5) == OneInt(5)`, `TwoInts(1,2) != TwoInts(1,3)`)

Hash: covered by existing `tests/derive.test.yo` (struct + fieldless enum hash). Hash on multi-data-variant enums currently relies on the same field-by-field walk used by Eq; not separately stress-tested but matches the established pattern.

---

## 3. Tooling Prerequisites

### 3.1 ✅ Single-File C Amalgamation — Effectively Done (libc allocator)

`yo compile --emit-c --skip-c-compiler --allocator libc` already produces a **fully self-contained single `.c` file** that compiles with just `clang -std=c11 file.c -o out` — no extra source files, no vendored allocator dependency. This is the amalgamation we need for distributing pre-built single-source releases of the Yo compiler (`yo.c`).

Verified: a hello-world program emits a 1.2k-line self-contained `.c` file that compiles and runs cleanly with `clang -std=c11 -O2`.

**Optional future work** (not blocking bootstrap):

- Inline `vendor/mimalloc/src/static.c` into the emitted `.c` when `--allocator mimalloc` is selected, so the high-performance allocator path is also single-file.
- Add a dedicated `--amalgamate` CLI flag as a documented alias for `--emit-c --skip-c-compiler --allocator libc`.

### 3.2 🟢 Cross-Compilation Targets

Extend `--target` to native triples (`x86_64-linux-gnu`, `aarch64-apple-darwin`, etc.) for CI builds. Or use per-platform GitHub Actions runners.

### 3.3 ✅ Install Scripts — Done

Single-command installers that drop Yo into a user-writable location and wire it into `PATH`:

- `scripts/install.sh` — Linux/macOS. Defaults: `$HOME/.local/Yo` (sources) + `$HOME/.local/bin/yo` (wrapper). Auto-installs `bun` if missing. Configurable via `YO_INSTALL_DIR`, `YO_BIN_DIR`, `YO_REPO`, `YO_REF`, `YO_FORCE`.
- `scripts/install.ps1` — Windows. Defaults: `$env:LOCALAPPDATA\Yo` + `…\Yo\bin\yo.cmd` (added to user PATH persistently). Auto-installs `bun` if missing. Parameters: `-InstallDir`, `-BinDir`, `-Repo`, `-Ref`, `-Force`.

Both scripts:

1. Verify required tools (`git`, C compiler) and warn if a C compiler is missing.
2. Install `bun` via the official installer if absent.
3. Clone Yo at the requested ref, run `bun install` + `bun run build`.
4. Drop a thin wrapper (`yo`) that execs `<install_dir>/yo-cli`.

Verified end-to-end on macOS by installing into a temp dir; `yo --version` works through the wrapper. Once the bootstrap produces a native `yo` binary + single-file `yo.c`, the scripts can switch from "clone + build" to "download release tarball" without changing the user-facing interface.

---

## 4. Verification Plan

Before starting Phase 1 of bootstrapping, write test programs that exercise every prerequisite:

1. **High-level Command wrapper** — spawn `echo`, capture stdout, check exit code
2. **Iterator combinators** — `list.iter().filter(...).map(...).collect()`
3. **StringBuilder** — build a multi-line C function string, verify output
4. **Collection literal macros** — `array_list(1, 2, 3)`, `hash_map(`a`=> 1,`b` => 2)`, `hash_set(`x`, `y`)` (element/key/value type inferred via `typeof`)
5. **Clone on complex types** — clone a struct with Box, ArrayList, String fields
6. **Large enum** — define 20+ variant enum, match on it, derive traits
7. **Recursive enum** — `Expr` with `Box(Self)`, clone it, match it
8. **Closure capture in iterators** — `.map()` capturing outer scope variables
9. **String operations** — `repeat`, `join`, all existing methods work together

---

## 5. Summary: Work Items by Priority

| #   | Item                                                                       | Priority | Effort (lines) | Blocks                       |
| --- | -------------------------------------------------------------------------- | -------- | -------------- | ---------------------------- |
| 1   | Iterator combinators (map/filter/find/any/all/fold/collect/enumerate/join) | ✅ Done  | 0              | Evaluator port (155+ usages) |
| 2   | Verify blanket impl on Iterator works                                      | ✅ Done  | 0              | Iterator combinators         |
| 3   | High-level Command wrapper                                                 | ✅ Done  | 0              | CLI / compile pipeline       |
| 4   | Verify derive(Clone) on complex types                                      | ✅ Done  | 0              | AST types                    |
| 5   | Collection literal macros (array_list, hash_map, hash_set)                 | ✅ Done  | 0              | Ergonomics throughout        |
| 6   | StringBuilder (sync in-memory)                                             | ✅ Done  | 0              | Codegen port                 |
| 7   | String additions (repeat, join, lines)                                     | ✅ Done  | 0              | Throughout                   |
| 8   | OrderedMap                                                                 | ✅ Done  | 0              | Evaluator port               |
| 9   | ArgParser subcommand support                                               | ✅ Done  | 0              | CLI port                     |
| 10  | Large enum + recursive type verification                                   | ✅ Done  | 0              | AST design                   |
| 11  | Closure capture verification                                               | ✅ Done  | 0              | Iterator usage               |
| 12  | `?` operator for Option/Result (`try` macro)                               | ✅ Done  | 0              | Evaluator ergonomics         |
| 13  | Derive ToString/Eq/Hash quality verification                               | ✅ Done  | 0              | Error messages               |
| 14  | Temporary files/directories                                                | ✅ Done  | 0              | Codegen tests, build cache   |
| 15  | Single-file C amalgamation                                                 | ✅ Done  | 0              | Distribution                 |
| 16  | Cross-compilation targets                                                  | 🟢 P3    | 300–500        | CI/CD                        |
| 17  | Install scripts (Linux/macOS + Windows)                                    | ✅ Done  | 0              | Distribution / onboarding    |

**Status**: All P1/P2 items and §3.1 are complete or deferred with documented workarounds. The only remaining item (§3.2 cross-compilation) is a CI/CD concern that does not block Phase 1 of the bootstrap effort.

---

## Companion fixes (off-list bugs found during prep work)

These bugs surfaced while completing the items above and are recorded for traceability.

- **`comptime_assert` validation skipped argument type-checking inside function bodies** — Fixed in `src/evaluator/builtins/comptime-assert.ts`. Previously, `comptime_assert((i32 == i32), ...)` written inside a function body silently passed validation because `isValidatingFunctionDefinition || !isExecuting` early-returned without evaluating the condition. Now the condition is evaluated and required to be `bool` even in validation mode. Regression test added to `tests/comptime.test.yo`. This makes misuse like comparing `Type` values with `==` (use `Type.eq` / `Type.is_compatible_with` instead) reliably caught at definition time.
- **Variadic-quote macros wrongly flagged for runtime emission** — Fixed in `src/codegen/functions/generation.ts` and `src/types/guards.ts`. `array_list`, `hash_map`, `hash_set` could escape the codegen skip because `parameters.some(p => p.isCompileTimeOnly)` ignored `variadicParameter.isCompileTimeOnly`/`isQuote`. The new defensive split makes `isComptimeFunction` always win and covers variadic flags in `isFunctionTypeGeneric`/`isFunctionTypeHardGeneric`.
