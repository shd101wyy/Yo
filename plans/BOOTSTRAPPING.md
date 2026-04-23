# Bootstrapping the Yo Compiler

## Goal

Rewrite the Yo compiler in Yo itself, achieving full self-hosting. The TypeScript codebase is eliminated entirely. The compiler ships as:

1. **Pre-built binaries** — per-platform native executables on GitHub Releases.
2. **Single-file C source** — an amalgamated `yo.c` that any C11 compiler can build, enabling bootstrapping on any platform without pre-built binaries.
3. **Simple install scripts** — `install.sh` (Linux/macOS) and `install.ps1` (Windows) that download the correct binary into `~/.cache/yo` (or `%LOCALAPPDATA%\yo` on Windows) and add it to `PATH`. This is consistent with where `yo cache path` already stores deps and cached versions.

Along the way, enrich the Yo standard library and fix any bugs discovered.

---

## Feasibility Assessment

### Codebase size

| Subsystem                             | TS lines     | Priority     | Notes                             |
| ------------------------------------- | ------------ | ------------ | --------------------------------- |
| Lexer                                 | 733          | P0 — Phase 1 | Self-contained, easiest to port   |
| Parser                                | 1,536        | P0 — Phase 1 | Class-based → struct + methods    |
| AST (expr.ts)                         | 2,564        | P0 — Phase 1 | Discriminated union → Yo enum     |
| Type system                           | 6,297        | P0 — Phase 2 | Heavy use of optional fields      |
| Evaluator                             | 56,188       | P0 — Phase 3 | Largest subsystem, mutation-heavy |
| Codegen                               | 39,948       | P0 — Phase 4 | Platform-specific I/O runtimes    |
| Environment (env.ts)                  | 2,232        | P0 — Phase 2 | Frame-based scoping               |
| CLI (yo-cli.ts)                       | 1,048        | P1 — Phase 5 | yargs → Yo CLI parsing            |
| Build runner                          | 1,994        | P1 — Phase 6 | DAG scheduler                     |
| Doc generation                        | 7,864        | P2 — Phase 6 | Can stay TS longer                |
| LSP                                   | ~8,000       | P2 — Phase 6 | Can stay TS longer                |
| Misc (fetch, cache, init, version, …) | ~1,600       | P1 — Phase 6 | Small utilities                   |
| **Core compiler total**               | **~109,500** |              | Lexer → Codegen                   |
| **Full project total**                | **~136,800** |              | Everything in src/                |

**Estimated Yo output**: 90–120K lines (Yo is slightly more verbose for types, but has less boilerplate than TS for pattern matching and trait dispatch).

### Language readiness

| Requirement           | Status       | Notes                                                                                                 |
| --------------------- | ------------ | ----------------------------------------------------------------------------------------------------- |
| String manipulation   | ✅ Excellent | `String`, `str`, template strings, split/find/replace/trim                                            |
| Collections           | ✅ Excellent | HashMap, ArrayList, BTreeMap, HashSet, LinkedList, Deque                                              |
| Immutable collections | ✅ Excellent | imm/Map (HAMT), imm/Vec, imm/List, imm/SortedMap                                                      |
| File I/O              | ✅ Excellent | Async file/dir ops, metadata, temp files                                                              |
| Pattern matching      | ✅ Excellent | Exhaustive match on enums, GADTs                                                                      |
| Generics + HKT        | ✅ Excellent | Full parametric generics, where clauses, HKT                                                          |
| Traits + dyn dispatch | ✅ Excellent | Trait objects via `Dyn(T)`, dyn dispatch                                                              |
| Error handling        | ✅ Excellent | Result/Option with combinators, algebraic effects                                                     |
| Closures              | ✅ Good      | First-class, but handlers are standalone (no closure capture)                                         |
| Metaprogramming       | ✅ Good      | quote/unquote, type reflection, derive                                                                |
| JSON                  | ✅ Good      | Parse/stringify available                                                                             |
| Regex                 | ✅ Good      | Full NFA engine in std                                                                                |
| CLI argument parsing  | ✅ Good      | `std/cli/arg_parser` exists (may need subcommand support)                                             |
| Process spawning      | ✅ Good      | `std/sys/process.yo` (low-level); need high-level Command wrapper                                     |
| Buffered I/O          | ✅ Good      | `std/sys/bufio/buf_writer.yo`, `buf_reader.yo` exist                                                  |
| Writer/Reader traits  | ✅ Good      | `std/io/writer.yo`, `std/io/reader.yo` exist                                                          |
| Environment variables | ✅ Good      | `std/process.yo` has `env.get/set`, `cwd`, `platform`                                                 |
| StringBuilder (sync)  | ✅ Done      | `std/string/string_builder.yo` — 21 tests pass                                                        |
| Iterator combinators  | ✅ Done      | Blanket `impl` in prelude: `map`, `filter`, `fold`, `take`, `skip`, `enumerate`, etc. — 19 tests pass |

### Translation challenges

| Challenge                                                                 | Severity | Strategy                                                                             |
| ------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------ |
| **Mutation pattern** (`expr.$ = {...}`)                                   | High     | Redesign: return new AST nodes with attached data, or use mutable struct fields      |
| **Discriminated unions** (TypeScript tagged unions with optional fields)  | High     | Map to Yo enum with per-variant data structs                                         |
| **Map/Set/Array functional methods** (.map, .filter, .reduce — ~845 uses) | High     | ✅ Iterator combinators implemented; ArrayList has full blanket impl support         |
| **Named parameter destructuring**                                         | Medium   | Use explicit struct types or positional params                                       |
| **Class-based Parser**                                                    | Medium   | Convert to struct + impl block with mutable `*(Self)` methods                        |
| **Closures capturing outer scope**                                        | Medium   | Pass captured variables explicitly; Yo closures do capture but effect handlers don't |
| **Optional fields on interfaces** (~50+ fields on Type)                   | Medium   | Use `Option(T)` for each field, or split into per-variant structs                    |
| **Exception-based error reporting** (~1,200 throws)                       | Low      | Use Yo's algebraic effects (`Exception` / `Raise`)                                   |
| **Template string diagnostics**                                           | Low      | Yo template strings support `${}` interpolation                                      |

---

## Architecture Decisions

### 1. AST representation

TypeScript uses a tagged-union approach with a shared `$` evaluation cache:

```typescript
type Expr = AtomExpr | FnCallExpr;
interface AtomExpr {
  tag: "Atom";
  token: Token;
  $?: EvaluatedData;
}
```

**Yo approach**: A proper enum with per-variant data. Evaluation results stored alongside or in a separate `ExprInfo` map keyed by node ID:

```rust
Expr :: enum(
  Atom(token : Token, info : Option(ExprInfo)),
  FnCall(func : Box(Self), args : ArrayList(Self), token : Token, info : Option(ExprInfo))
);
```

Or, for better cache locality and to avoid mutating the AST, use a side-table:

```rust
// AST is immutable after parsing
Expr :: enum(
  Atom(id : ExprId, token : Token),
  FnCall(id : ExprId, func : Box(Self), args : ArrayList(Self), token : Token)
);

// Evaluation results stored separately
ExprInfoTable :: newtype(data : HashMap(ExprId, ExprInfo));
```

The side-table approach is cleaner for a functional style and avoids the mutation pattern entirely. Each evaluator pass produces a new or updated `ExprInfoTable`.

### 2. Type representation

TypeScript uses a single `Type` interface with ~50 optional fields and a tag enum. This is a classic "fat node" pattern.

**Yo approach**: Use an enum of type variants, each carrying only their relevant data:

```rust
TypeValue :: enum(
  IntType(bits : u8, signed : bool),
  FloatType(bits : u8),
  BoolType,
  StringType,
  PointerType(pointee : Box(Self)),
  ArrayType(element : Box(Self), length : usize),
  SliceType(element : Box(Self)),
  FunctionType(params : ArrayList(Parameter), ret : Box(Self), effects : ArrayList(Effect)),
  StructType(name : String, fields : ArrayList(Field), ...),
  EnumType(name : String, variants : ArrayList(Variant), ...),
  TraitType(name : String, methods : ArrayList(TraitMethod), ...),
  SomeType(id : u32, constraints : ArrayList(TraitConstraint)),
  // ... more variants
);
```

### 3. Environment / scoping

The TypeScript evaluator uses a mutable frame-stack `Environment`. For Yo, two options:

- **Option A**: Mutable struct with `*(Self)` methods (closer to 1:1 translation).
- **Option B**: Persistent/immutable environment using `imm/Map` — each scope produces a new env sharing structure with the parent.

Option A is simpler for initial porting. Option B is more idiomatic and enables easier parallelism later.

### 4. Error reporting

Replace `throw formatErrorMessage(...)` with Yo's algebraic effect system:

```rust
CompilerError :: object(
  message : String,
  location : SourceLocation,
  notes : ArrayList(String)
);

impl(CompilerError, Error(
  message : (self -> self.message)
));

// Evaluator functions use the effect
evaluate :: (fn(expr : Expr, env : *(Env), using(raise : Raise)) -> EvalResult)(
  // ...
  raise(`Type mismatch: expected ${expected}, got ${actual}`);
);
```

### 5. C code emission

The codegen currently uses string concatenation via an `Emitter` class. In Yo, use a `StringBuilder`-like writer:

```rust
Emitter :: object(
  buffer : ArrayList(u8),
  indent : u32
);

impl(Emitter,
  emit_line : (fn(self : *(Self), line : str) -> unit)({
    // write indent + line + newline
  }),
  emit_fmt : (fn(self : *(Self), tmpl : String) -> unit)({
    // template string interpolation
  })
);
```

This is efficient (contiguous buffer) and straightforward to implement.

---

## Bootstrapping Phases

### Phase 0 — Preparation (std library enrichment)

Before porting any compiler code, fill the remaining gaps in the standard library. Many modules already exist (see BOOTSTRAPPING_PREREQUISITES.md for full inventory):

- **Iterator combinators** (✅ Done) — Blanket `impl` in prelude.yo: `map`, `filter`, `fold`, `find`, `any`, `all`, `collect`, `enumerate`, `take`, `skip`, `zip`, `flat_map` — 19 tests pass.
- **Verify blanket impl** (✅ Done) — Confirmed working.
- **`std/process/command`** — High-level `Command` wrapper around the existing `std/sys/process.yo` low-level spawn. For invoking `cc`, `clang`, `zig`.
- **`StringBuilder`** (✅ Done) — `std/string/string_builder.yo` — 21 tests pass.
- **`std/collections/ordered_map`** — Insertion-ordered map (evaluator uses Map iteration order).
- **String additions** — `repeat(n)`, `join(separator, items)`, `lines()` iterator.
- Verify `derive(Clone)` on complex types (recursive enums, Box fields, ArrayList fields).
- Verify large enum codegen performance (20+ variant enums with derive).

### Phase 1 — Frontend (Lexer + AST + Parser) ✅ Done

Port the frontend first because it's the smallest (~4.8K lines), has no dependencies on the evaluator/codegen, and provides immediate validation that Yo can express compiler data structures.

**1a. Token types and AST** (~2,564 lines → ~2,000–3,000 Yo lines) ✅ Done

- Define `Token`, `TokenKind`, `SourceLocation` types
- Define `Expr` enum and all variant data types
- Define `ExprId` and `ExprInfoTable`

**1b. Lexer** (~733 lines → ~600–900 Yo lines) ✅ Done — 33 tests

- Tokenize Yo source into `ArrayList(Token)`
- Handle string literals, template strings, comments, operators
- Track source locations

**1c. Parser** (~1,536 lines → ~1,500–2,000 Yo lines) ✅ Done — 36 tests

- Recursive descent parser producing `Expr` tree
- Convert class-based design to struct + `*(Self)` methods
- Error recovery with `raise` effect

**Validation milestone**: Parse a simple Yo program and pretty-print the AST. ✅ Done (69 tests total)

### Phase 2 — Type System + Environment

**2a. Type representation + Environment** ✅ Done — 9 tests

- Defined `TypeTag` enum (`yo-self/types/tags.yo`)
- Defined `TypeValue` enum with primitive, pointer, slice, array, and tuple variants (`yo-self/types/type.yo`)
- `type_to_string` stringification (`yo-self/types/string.yo`)
- `are_types_compatible` with comptime widening rules (`yo-self/types/compatibility.yo`)
- `Variable`, `Frame`, `Environment` with `define`/`lookup`/`push_frame`/`pop_frame` (`yo-self/env/env.yo`)
- **Total: 84 tests passing** (69 Phase 1 + 9 Phase 2a + 6 carry-over type tests)

**2b. Remaining type variants** (function types, struct types, enum types, trait types, SomeType, effects) — 🔲 Planned

- Extend `TypeValue` with all remaining variants from `src/types/*.ts`
- Full `areTypesCompatible` covering function signatures, trait constraints, generics
- Type substitution and normalization utilities

**Validation milestone**: Resolve types for simple Yo programs (literal types, function types, struct types).

### Phase 3 — Evaluator

The largest and most complex phase (~56K lines). Break into sub-phases:

**3a. Core evaluation loop** — `evaluate(expr, env)` dispatch on `Expr` tag
**3b. Literal and atom evaluation** — constants, variable references
**3c. Function calls** — argument binding, overload resolution
**3d. Control flow** — `cond`, `match`, `while`, `begin` blocks
**3e. Type checking** — type inference, unification, constraint solving
**3f. Trait resolution** — impl lookup, method dispatch, where-clause matching
**3g. Generic specialization** — monomorphization, SomeType resolution
**3h. Compile-time evaluation (CTFE)** — constant folding, comptime execution
**3i. Module system** — imports, exports, open imports
**3j. Effects analysis** — algebraic effects, evidence passing analysis

**Validation milestone**: Evaluate `hello_world.yo` through the full pipeline (without codegen — just verify types and values are correct by comparing with TS evaluator output).

### Phase 4 — C Code Generation

Second largest subsystem (~40K lines). Break into sub-phases:

**4a. Core emission framework** — `Emitter`, `CodegenContext`, declaration ordering
**4b. Expression codegen** — literals, variables, function calls, operators
**4c. Control flow codegen** — cond, match, while, begin blocks
**4d. Function codegen** — function definitions, closures, generic specialization
**4e. Type codegen** — struct/enum/union layouts, RC headers, type declarations
**4f. Async/await state machines** — Future types, SM generation, event loop
**4g. Platform I/O runtimes** — io_uring (Linux), kqueue (macOS), IOCP (Windows)
**4h. Effects codegen** — evidence passing, escape detection, handler installation
**4i. RC/GC codegen** — reference counting, cycle collection, drop generation

**Validation milestone**: Compile and run `hello_world.yo` using the Yo-written compiler. Compare C output with the TS compiler's output.

### Phase 5 — CLI + Integration

**5a. CLI entry point** — argument parsing, subcommands (`compile`, `test`, `build`, `init`, …)
**5b. Test runner** — `yo test` with filtering, parallel execution, output formatting
**5c. Error formatting** — colored terminal output, source location display, error notes

**Validation milestone**: `yo-self compile hello.yo -o hello && ./hello` works.

### Phase 6 — Ancillary systems

**6a. Build system** — `build.yo` runner, DAG scheduler, artifact compilation
**6b. Dependency management** — `yo fetch`, `yo install`, lock file, git integration
**6c. Version management** — `.yo-version` pinning, version cache
**6d. Documentation** — `yo doc` generator (can be lower priority)
**6e. LSP server** — Language server (can be lowest priority or kept as a separate tool)

### Phase 7 — Self-hosting verification

1. Use the TS-compiled Yo compiler (Stage 0) to compile the Yo-written compiler source → produce `yo-stage1` binary.
2. Use `yo-stage1` to compile the same Yo-written compiler source → produce `yo-stage2` binary.
3. **Verify**: `yo-stage1` and `yo-stage2` produce identical C output for any input. This proves the compiler is faithfully self-hosting.
4. Run the full test suite with `yo-stage1` and verify all tests pass.
5. Retire the TypeScript codebase. `yo-stage1` becomes the new bootstrap compiler.

---

## Distribution Strategy

### Pre-built binaries

Provide native binaries on GitHub Releases for:

- `linux-x86_64`
- `linux-aarch64`
- `darwin-x86_64` (Intel Mac)
- `darwin-aarch64` (Apple Silicon)
- `windows-x86_64`
- `wasm32-wasi` (optional — for browser/cloud environments)

Each release includes:

- `yo-{version}-{platform}.tar.gz` (or `.zip` for Windows)
- `yo-{version}.c` — single-file amalgamated C source
- `SHA256SUMS.txt`

Build the binaries in CI using GitHub Actions with cross-compilation or per-platform runners.

### Single-file C source (`yo.c`)

Concatenate all generated C code into a single `yo.c` file. Anyone with a C11 compiler can bootstrap:

```bash
cc -O2 -o yo yo.c -lm
```

This is the ultimate portability guarantee — similar to how SQLite ships `sqlite3.c`.

The amalgamation process:

1. Compile the Yo compiler source with `--emit-c --single-file` to produce one C file.
2. Include the mimalloc allocator source inline (or make it optional with libc malloc fallback).
3. Strip debug info for release, keep it for debug builds.

### Install scripts

**`install.sh`** (Linux/macOS):

```bash
#!/bin/sh
set -e
YO_HOME="${YO_HOME:-$HOME/.cache/yo}"

# Detect platform
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)
case "$ARCH" in
  x86_64|amd64) ARCH="x86_64" ;;
  arm64|aarch64) ARCH="aarch64" ;;
  *) echo "Unsupported architecture: $ARCH"; exit 1 ;;
esac

# Download latest release
VERSION=$(curl -sfL https://api.github.com/repos/YoLang/Yo/releases/latest | grep tag_name | cut -d'"' -f4)
URL="https://github.com/YoLang/Yo/releases/download/${VERSION}/yo-${VERSION}-${OS}-${ARCH}.tar.gz"

mkdir -p "$YO_HOME/bin"
curl -sfL "$URL" | tar xz -C "$YO_HOME/bin"

# Add to PATH
echo "export PATH=\"$YO_HOME/bin:\$PATH\"" >> "${SHELL_RC:-$HOME/.profile}"
echo "Yo ${VERSION} installed to $YO_HOME/bin/yo"
echo "Restart your shell or run: export PATH=\"$YO_HOME/bin:\$PATH\""
```

**`install.ps1`** (Windows):

```powershell
$YoHome = "$env:LOCALAPPDATA\yo"
# ... similar logic with Invoke-WebRequest and .zip extraction
# Add to user PATH via [Environment]::SetEnvironmentVariable
```

### Installation directory layout

```
~/.cache/yo/
├── bin/
│   └── yo                    # Main compiler binary
├── lib/
│   └── std/                  # Standard library .yo files
├── versions/                 # Cached compiler versions (for yo version)
│   ├── 0.2.0/
│   └── 0.2.1/
└── deps/                     # Dependency cache (already used by yo cache path)
```

---

## Standard Library Enrichment Needed

Many modules already exist. See `plans/BOOTSTRAPPING_PREREQUISITES.md` for the complete inventory. Below lists only what's **still missing or needs enhancement**:

| Module / Feature                    | Status     | What's needed                                                                                                                                  |
| ----------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Iterator trait combinators          | ✅ Done    | Blanket `impl` in prelude: `map`, `filter`, `fold`, `find`, `any`, `all`, `enumerate`, `take`, `skip`, `zip`, `flat_map`, `collect` — 19 tests |
| `std/process/command`               | 🆕 New     | High-level `Command.new("cc").arg("-o").arg("out").output()` wrapping existing low-level spawn                                                 |
| `StringBuilder`                     | ✅ Done    | `std/string/string_builder.yo` — wraps `ArrayList(u8)`, 21 tests pass                                                                          |
| `std/collections/ordered_map`       | 🆕 New     | Insertion-ordered HashMap (like JS Map)                                                                                                        |
| `std/string` (enrich)               | 🔧 Enhance | `repeat(n)`, `lines()` iterator, `pad_start`/`pad_end`                                                                                         |
| `std/cli/arg_parser` (enrich)       | 🔧 Verify  | May need subcommand support for `yo compile`, `yo test`, `yo build`, etc.                                                                      |
| `std/collections/hash_map` (enrich) | 🔧 Enhance | `.entry()` API for insert-or-update pattern                                                                                                    |

---

## Risk Assessment

| Risk                                            | Likelihood | Impact | Mitigation                                               |
| ----------------------------------------------- | ---------- | ------ | -------------------------------------------------------- |
| Evaluator too complex to port                   | Medium     | High   | Port incrementally; use side-by-side TS/Yo testing       |
| Bugs in Yo discovered during porting            | High       | Medium | Fix as we go; this is a benefit of bootstrapping         |
| Circular dependency in self-hosting             | Low        | High   | Always maintain a working Stage 0 binary in releases     |
| C output divergence between TS and Yo compilers | Medium     | Medium | Diff-test: both compilers emit C for same input, compare |
| Performance regression                          | Medium     | Low    | Profile after Phase 4; optimize hot paths                |
| Platform-specific codegen issues                | Medium     | Medium | Test on all 3 platforms throughout; CI matrix            |

---

## Open Questions

1. **Immutable vs mutable AST?** Side-table approach is cleaner but the TS codebase is deeply tied to mutation. Initial port might use mutable ASTs for pragmatism, then refactor.

2. **How to handle the evaluator's ~56K lines?** Options:

   - (a) Faithful 1:1 port (fastest to complete, easiest to verify correctness)
   - (b) Redesign with cleaner architecture (slower, but better long-term)
   - Recommend: (a) first, (b) after self-hosting is achieved.

3. **Should the LSP be ported or kept as a separate TS project?** The LSP can remain TS for now since it only analyzes code, doesn't compile it. Port later.

4. **WASM target for the compiler itself?** A `yo.wasm` compiler running in browser/Node would enable playground/online compiler. Low priority but interesting.

5. **Incremental compilation?** The current compiler recompiles everything. Bootstrapping is a good time to design incremental compilation, but it adds scope. Defer to post-self-hosting.

---

## Success Criteria

1. ✅ `yo-stage1` (compiled by TS compiler) passes the full test suite.
2. ✅ `yo-stage2` (compiled by `yo-stage1`) produces byte-identical C output as `yo-stage1` for all test inputs.
3. ✅ `yo.c` single-file builds with `cc -O2 -o yo yo.c` on Linux, macOS, Windows.
4. ✅ Install scripts work on fresh machines (Linux, macOS, Windows).
5. ✅ All existing tests pass with the Yo-written compiler.
6. ✅ TypeScript source can be archived/removed.
