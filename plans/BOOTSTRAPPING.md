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

**2b. Remaining type variants** (function types, struct types, enum types, trait types, SomeType, effects) ✅ Done — 116 tests total

- Extended `TypeValue` with compound variants: `Func` (9 fields: forall vars, params, implicit params, where-clauses, result), `TraitT` (4 fields), `ModuleT` (3 fields), `SomeT` (6 fields) (`yo-self/types/type.yo`)
- Constructors: `t_func_simple`, `t_trait`, `t_trait_simple`, `t_module`, `t_module_simple`, `t_some_t`
- Predicates: `is_function_type`, `is_trait_type`, `is_module_type`, `is_some_type`
- Extended `type_to_string` and `are_types_compatible` for all new variants
- `Substitution` engine: parallel-array map; `subst_new`/`subst_add`/`subst_lookup`/`substitute`/`substitute_all` (`yo-self/types/substitution.yo`)
- Validated circular-import mechanism via `yo-self/tests/circular_smoke.test.yo` (3 tests)
- **Total: 116 tests passing** (84 Phase 2a + 29 compound/substitution + 3 circular smoke)

**2c — Integration** ✅ Done — 128 tests total

- `type_of_literal` — literal type-of pass: maps `AstExpr` literal tokens to `TypeValue` (`yo-self/evaluator/type_of.yo`)
- Covers: Bool → BoolT, Integer → ComptimeInt, Float → ComptimeFloat, StringLit/TemplateString → ComptimeString, CharLit → u32 (rune), all others → None
- **Total: 128 tests passing** (116 Phase 2b + 12 Phase 2c)

### Phase 3 — Evaluator

The largest and most complex phase (~56K lines). Break into sub-phases:

**3a. Core evaluation loop** ✅ Done — `evaluate(expr, env)` dispatch on `Expr` tag
**3b. Literal and atom evaluation** ✅ Done — constants, variable references, define `:=`, assign `=`, begin blocks, `cond`
**3c. Arithmetic and logic operators** ✅ Done — `+`, `-`, `*`, `/`, `%`, `==`, `!=`, `<`, `>`, `<=`, `>=`, `&&`, `||`, `!`, unary `-`
**3d. Enum, match, while** ✅ Done — variant construction, `match` pattern matching, `while` loops (compile-time + runtime)
**3e. Function definitions and calls** ✅ Done — `(fn(params) -> T)(body)` → `FuncVal`, named fn calls, `return` propagation via `ReturnVal` signal.
**3f. Type casts and typed arithmetic** ✅ Done — `i32(x)`, `usize(x)`, etc.; typed `+`/`-`/`*`/`/`; `::` constants; typed fibonacci test.
**3g. Typed declarations and string comparison** ✅ Done — `(x : T) = rhs` typed declarations, string `==`/`!=` comparison.
**3h. Struct construction and field access** ✅ Done — `TypeName(field: val…)` → `StructVal`, `obj.field` field access, self-hosted-parser format for enum variants with fields.
**3i. Lexical closure capture** ✅ Done — `FuncVal` now snapshots all visible bindings at definition time; call sites rebuild a fresh env from captures so nested functions see the correct lexical scope.
**3j. impl + method dispatch** ✅ Done — `impl(TypeName, method: fn_def, …)` registers `TypeName.method` qualified bindings; `recv.method(args)` dispatch looks up by qualified name then falls back to bare name. Stack-frame overhead managed via module-level helper functions and a `g_eval_fn` slot to break the forward-reference cycle.
**3k. TypeVal — type names as first-class values** ✅ Done — `TypeVal(ty: Box(TypeValue))` added to `EvalValue`; known primitive type names (`i32`, `bool`, `usize`, etc.) now evaluate to `TypeVal` via the identifier lookup fallback (`type_from_name_opt`). Foundation for `forall(T: Type)` param binding and generic type application in Phase 3l.
**3l. Generic specialization / forall param binding** ✅ Done — `param_type_names` field added to `FuncVal`; forall type params are inferred from argument types at call time and bound as `TypeVal` in the function body; `call_funcval_with_args` refactored to accept `ArrayList(EvalResult)` for type-aware dispatch; `recur` and general fn-call handlers simplified to use the shared helper.
**3m. Module system** ✅ Done — `ModuleVal(names, values)` added to `EvalValue`; `evaluate_module_body` evaluates a list of top-level exprs and collects `export` declarations; `import "path"` dispatches through a pluggable `g_module_loader` callback (registered via `set_module_loader`); `open(module)` brings all module fields into the caller's env; `{ A, B } :: module` anon-struct destructuring binds individual names; `BK_EXPORT`/`BK_OPEN` added to expr.yo constants.
**3n. Compile-time evaluation (CTFE)** ✅ Done — `if(cond, then)` / `if(cond, then, else)` conditional expressions; float arithmetic (`+`, `-`, `*`, `/`) and comparison (`==`, `!=`, `<`, `>`, `<=`, `>=`) constant folding; float unary negation; `comptime(Name)` parameter name extraction in function definitions. All new logic factored into `handle_if_form`, `eval_float_arith`, `eval_float_cmp`, `eval_float_neg`, and `extract_comptime_param_name` helpers to keep `evaluate()`'s ASAN stack frame within the 8 MB limit.
**3o. Effects analysis** ✅ Done — `using(name : Type)` evidence parameters extracted from function definitions into `FuncVal.evidence_params`; `using(name)` at call sites evaluates to the named value from the caller's environment; `call_funcval_with_args` binds evidence params from args at indices `[n_params .. n_params + n_evidence]`; new helpers `extract_evidence_param_name` and `handle_using_call` keep `evaluate()`'s ASAN stack frame within the 8 MB limit. 5 new tests for evidence extraction, `using(name)` evaluation, evidence in function body, mixed regular+evidence params, and evidence-only functions.

**Validation milestone** ✅ Done: Evaluate `hello_world.yo` through the full pipeline — constructs the AST for `main :: (fn(using(io : IO)) -> unit)({ io; }); export main;`, calls `evaluate_module_body`, and verifies the result is a `ModuleVal` that exports `main` as a `FuncVal` with `evidence_params=["io"]` and no regular params.

### Phase 4 — C Code Generation

Second largest subsystem (~40K lines). Break into sub-phases:

**4a. Core emission framework** — `Emitter`, `CodegenContext`, declaration ordering ✅ Done
**4b. Expression codegen** — literals, variables, function calls, operators ✅ Done
**4c. Control flow codegen** — cond, while, begin blocks ✅ Done
**4d. Match codegen** — switch statements for simple and data enums (`generate_match_simple`, `generate_match_data`) ✅ Done
**4e. Function codegen** — function definitions, closures, generic specialization ✅ Done
**4f. Type codegen** — struct/enum/union layouts, RC headers, type declarations ✅ Done. Extended in Phase 5b/5c: `compile_module_to_c` in `driver.yo` now also processes `Name :: struct(field : Type, ...)` top-level definitions (emitted as `typedef struct { ... } Name;`) and `impl(TypeName, { methods... })` blocks (methods extracted as `TypeName_method` C functions). `extract_struct_def`, `emit_struct_to_c`, and `extract_impl_fns` added to driver.yo.
**4g. Async/await state machines** — Future types, SM generation, event loop
**4h. Platform I/O runtimes** — io_uring (Linux), kqueue (macOS), IOCP (Windows)
**4k. Effects codegen** — evidence passing, escape detection, handler installation
**4i. RC/GC codegen** — reference counting, cycle collection, drop generation ✅ Done (simplified: trivial dispose/drop/dup for primitive-field types)
**4j. Program emission** — assemble complete C file (preamble + types + RC + functions + main wrapper) ✅ Done

**Validation milestone** ✅ Done: `compile_module_to_c` (`yo-self/codegen/driver.yo`) walks a parsed module body, extracts `name :: (fn(params) -> T)(body)` function definitions, maps Yo type annotations to C types, and assembles a compilable C11 file. Two parser-integrated end-to-end tests verify that parsing real Yo source (`"main :: (fn() -> unit)({ });"`) and calling `compile_module_to_c` produces valid C containing the expected static function, `int main(void)` wrapper, and C11 preamble.

**Integration milestone** ✅ Done: Two end-to-end tests (`yo-self/tests/integration.test.yo`) exercise the full pipeline: parse Yo source with the self-hosted parser → `compile_module_to_c` → write C to a temp file → `cc` compile → run binary → assert exit code 0. Discovered and fixed two bugs:

- **Compiler bug (declarations.ts + generation.ts):** Unspecialized `isModuleEffectMember` forall effect handlers were silently skipped when specializations existed, causing `cc` link errors because the async capture struct (from `emitModuleEffectInjection`) stored the unspecialized function pointer by name. Fixed by: (a) keeping the forward declaration, and (b) emitting a minimal escape-only stub (sets `__yo_effect_escaped = 1`, returns zero value) instead of the full generic body (which lacks sub-expression type annotations).
- **Self-hosted codegen bug (yo-self/codegen/exprs.yo):** Empty `{ }` blocks are parsed as zero-arg anonymous structs (`FnCall(Atom("_"), [], false)`) because the separator is `None` (empty, no commas or semicolons seen), which defaults to the comma branch. The `generate_expr` function had no case for zero-arg `BK_ANON_STRUCT` or `BK_TUPLE`, so it fell through to the regular function-call emitter and generated `_()` in C. Fixed by returning `Some("0")` (the unit sentinel) for zero-arg anonymous struct or tuple expressions.

### Phase 5 — CLI + Integration

**5a. CLI entry point** ✅ Done — `yo-self/main.yo` wires argument parsing, the `compile` subcommand, the self-hosted parser, `compile_module_to_c`, temp-file C output, and `cc` invocation into a working binary (`yo-self/yo-self-bin`). Also fixed three underlying compiler bugs exposed by this phase:

- _Phantom RC-owning temp for forall escape handlers_: `tryToCallFunctionWithArguments` in `src/evaluator/calls/helper.ts` now uses the specialized return type from `evaluateCtlFunctionBodyInline` directly rather than the `context.expectedType`-overridden type, preventing a type mismatch that generated an undeclared C temp var.
- _Escape control flow not propagated for forall `isControlFunction` calls_: `src/evaluator/calls/function.ts` now sets `expr.$.controlFlow = escape` for `isControlFunction` calls when forall specialization ran (`specializedFunctionValue !== undefined`), so match arms treat the call as never-type.
- _Dead-code after escape handler not guarded in codegen_: `src/codegen/exprs/begin.ts` and `src/codegen/exprs/cond.ts` now skip unevaluated expressions (`expr.$ === undefined`) that follow an escape call in the same begin block. Additionally, `src/codegen/exprs/return.ts` skips uninitialized variables (not yet past their binding RHS) when generating consumed-var drops for an escape site.

**5b. Test runner** ✅ Done — `yo-self/main.yo` extended with a `test` subcommand. `yo-self test <file.test.yo> [--test-name-pattern <pattern>]` parses a `.test.yo` file, finds all `test "name", { body }` declarations, compiles each body to a standalone C program via `compile_test_body_to_c`, runs it, and reports pass/fail/skipped. Tests that fail to compile (due to unsupported features like structs or IO in Phase 5b) are marked "skipped". Exit code 0 when all pass, 1 when any fail. Also fixed three self-hosted codegen gaps exposed by this phase:

- _`:=` define not emitted_: `handle_define` now emits `__auto_type name = val;` for `:=` expressions.
- _Type casts emitted as C function calls_: `handle_type_cast` now emits `(int32_t)(x)` for `i32(x)` style casts.
- _`assert`/`comptime_assert` not handled_: now handled as `if (!(cond)) { exit(1); }` in generated C.

**5c. Cross-function calls + struct constructors** ✅ Done (partial — error formatting still pending):

- _Struct constructors_ (`TypeName(field: val, ...)`): `handle_struct_constructor` in `exprs.yo` emits C compound literals `(TypeName){.field = val}`. Detection heuristic: non-infix call with uppercase-start name and all args labeled. New helpers: `is_labeled_arg`, `all_labeled_args`, `is_uppercase_start`.

- _Cross-function call `fn_`prefix_:`CodegenContext` now tracks registered function names (`defined*fns: ArrayList(String)`, `register_fn`, `is_defined_fn`). `compile_module_to_c`does a two-pass approach — Pass 1 registers all top-level function names, Pass 2 emits code.`handle_regular_call`checks`is_defined_fn`: registered user-defined functions get `fn*` prefix; stdlib/extern calls (`exit`, `printf`, etc.) are unchanged.

- _Test bodies can call module-level helpers_: `compile_test_body_to_c` now accepts `module_exprs`. It registers all function names (Pass 1), emits helper function bodies and struct typedefs (Pass 2), then emits the test body. Test files with `helper :: (fn(...) -> T)(...)` definitions can be called from test bodies.

**5d. Error formatting** — colored terminal output, source location display, error notes

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
