# Circular Module Dependencies

## Problem

Yo currently does **not** support circular imports between modules. When module A imports B and B imports A, the compiler enters infinite recursion and crashes with a stack overflow — no error message is shown.

**Root cause**: `ModuleManager.loadModule()` evaluated modules eagerly. The imported namespace `StructValue` was only created and cached **after** the entire module body had been evaluated. If B imported A while A was still evaluating, A was not yet in the cache, so a fresh evaluation of A started — causing infinite recursion.

## Goals

- Allow mutually-referencing modules (e.g., `a.yo` imports `b.yo` and vice versa)
- Support circular type references (e.g., `struct Node` referencing `struct Tree` and vice versa)
- Support circular function references (e.g., `a.process()` calling `b.handle()` and vice versa)
- Detect and report genuinely unresolvable circular value dependencies (e.g., `a.x = b.y + 1` and `b.y = a.x + 1`)
- Emit clear error messages when a field is accessed before it's been exported
- No changes to Yo language syntax

## Prior Art

### Zig

Zig allows circular `@import` between files. `@import()` returns a **namespace object** immediately — before type validation. Types are resolved lazily on first access. This means both modules can reference each other's namespaces, and types only need to exist when actually used.

### Rust

Rust allows circular type references **within a crate** (not between crates). It uses **multi-pass name resolution**: Pass 1 collects all declaration names, Pass 2 resolves `use` imports, Pass 3 validates types. Because all names are known before type checking, circular references resolve naturally.

### Key Insight

Both languages separate **module/name registration** from **type/value validation**. The module is "known" before its contents are fully evaluated.

## Proposed Approach: Two-Phase Module Loading

Adapt Yo's existing architecture with minimal refactoring by splitting module loading into two phases:

**Phase 1 — Registration**: Create an empty namespace `StructValue` placeholder and cache it _before_ evaluation begins. Mark the module as "loading".

**Phase 2 — Evaluation**: Evaluate the module body. As `export` statements are processed, populate the placeholder `StructValue` incrementally (not all at once at the end).

When a circular import is encountered:

1. Module A starts Phase 1 (placeholder cached), then Phase 2 (body evaluation)
2. A's body hits `import "b.yo"` — B starts Phase 1+2
3. B's body hits `import "a.yo"` — **A is found in cache** (placeholder). Return it.
4. B accesses `A.field` — if field was exported before A's import of B, it works. If not, a clear error is raised.

### Why This Approach

- **Minimal refactoring**: The evaluator still works sequentially — no multi-pass or lazy evaluation needed.
- **User control**: The developer controls what's available across the cycle by ordering exports before imports.
- **Clear semantics**: Fields exported before the circular import are visible; fields exported after are not (yet).
- **Zig-like ergonomics**: Cyclic file references "just work" for common patterns.

## Supported Patterns

### Circular type references

```rust
// a.yo
{ ArrayList } :: import "std/collections/array_list";

NodeKind :: enum(Leaf, Branch);
export NodeKind;

{ Tree } :: import "./b.yo";  // Tree is available because b.yo exports it before importing a.yo
make_leaf :: (fn() -> Tree)(
  Tree(kind: .Leaf, children: ArrayList(Tree).new())
);
export make_leaf;

// b.yo
{ ArrayList } :: import "std/collections/array_list";
{ NodeKind } :: import "./a.yo";  // Works: NodeKind exported before a.yo's import of b.yo
Tree :: struct(kind: NodeKind, children: ArrayList(Tree));
export Tree;
```

### Circular function references

```rust
// parser.yo
{ ArrayList } :: import "std/collections/array_list";

parse_expr :: import "./expr_parser.yo";
parse_stmt :: (fn(tokens: ArrayList(Token)) -> Stmt)({
  // ...can call parse_expr.parse(...)
});
export parse_stmt;

// expr_parser.yo
{ ArrayList } :: import "std/collections/array_list";

parser :: import "./parser.yo";
parse :: (fn(tokens: ArrayList(Token)) -> Expr)({
  // ...can call parser.parse_stmt(...)
});
export parse;
```

## Unsupported Patterns (Detected with Clear Errors)

### Circular value dependencies

```rust
// a.yo — ERROR: "Field 'y' is not yet available from module 'b.yo' (circular import)"
{ y } :: import "./b.yo";
x :: (y + 1);
export x;

// b.yo
{ x } :: import "./a.yo";
y :: (x + 1);
export y;
```

### Accessing a field exported after the cycle point

```rust
// a.yo
{ late_field } :: import "./b.yo";  // ERROR: late_field not yet exported when a.yo is imported by b.yo

// b.yo
{ something } :: import "./a.yo";
late_field :: 42;
export late_field;  // This export comes AFTER b.yo imports a.yo, so a.yo can't see it
```

## Implementation Plan — ✅ Complete

All steps are implemented and tested (6 tests passing).

### 1. Add loading state tracking to ModuleManager

**File**: `src/module-manager.ts`

- Add a `loadingModules: Set<string>` to track modules currently being evaluated.
- Before calling `new Evaluator(...)`, add the module path to `loadingModules` and store a placeholder `StructValue` in the cache.
- After evaluation completes, remove from `loadingModules`.
- When `loadModule()` finds a module in `loadingModules`, return the placeholder (partial module) instead of recursing.

### 2. Incremental StructValue population

**File**: `src/evaluator/values/anonymous-module.ts`

- Accept an optional pre-created `StructValue` reference.
- When processing `export` statements, immediately push fields into the shared `StructValue` (not just into a local `moduleElementValues` array).
- This makes exports visible to other modules that hold a reference to the same `StructValue` object.

### 3. Field access validation for loading modules

**File**: `src/evaluator/exprs/property-access.ts`

- When accessing a field on a module that is still in "loading" state:
  - If the field exists in `ModuleType.fields` and has a value in `StructValue.fields`, allow it.
  - If the field does not exist yet, throw a descriptive error:
    `"Field 'X' is not yet available from module 'Y'. In a circular import, only fields exported before the import statement are accessible. Move 'export X' before the import of the current module."`

### 4. Cycle detection for error reporting

**File**: `src/module-manager.ts`

- Maintain an import stack (e.g., `importStack: string[]`) to track the chain of imports.
- When a cycle is detected (module found in `loadingModules`), record the cycle path for use in error messages.
- Distinguish between:
  - **Resolvable cycle**: The accessed fields are already available → proceed normally
  - **Unresolvable cycle**: A needed field isn't available → error with the cycle path

### 5. ModuleType incremental field registration

**File**: `src/evaluator/values/anonymous-module.ts` or `src/types/`

- Currently `ModuleType.fields` is populated during evaluation and finalized at the end.
- Change to push fields to `ModuleType` immediately when `export` is processed.
- Ensure `ModuleType` is the same object reference as what's stored in the cached placeholder.

### 6. C codegen — declaration ordering with cycles

**File**: `src/codegen/codegen-c.ts`, `src/codegen/types/generation.ts`

- The C codegen already emits forward declarations for all types before definitions. This naturally handles circular type references in the generated C code.
- Verify that cross-module function forward declarations work correctly when both modules reference each other's functions.
- May need to ensure struct/enum forward declarations cover types from all modules in the cycle.

### 7. Tests

**File**: `tests/circular_deps.test.yo` (or multiple files in `tests/circular_deps/`)

- Test circular type references between two files
- Test circular function references between two files
- Test that accessing an "not yet exported" field produces a clear error
- Test three-way circular dependencies (A→B→C→A)
- Test that non-circular imports are unaffected (regression)
- Test `export ...()` spread with circular imports

## Design Decisions

1. **`open import` with circular modules** — **Allowed with partial fields.** `open import` on a loading module injects only the fields exported so far. The user manages export ordering. This is more flexible and consistent with the overall approach.

2. **Compile-time function evaluation across cycles** — **Specific error message.** When a field access fails on a loading module, the error should say: _"Field 'X' from module 'Y' is not yet available. In a circular import, only fields exported before the import of the current module are accessible. Reorder your exports or break the cycle."_ This is more actionable than a generic "field not found" error.

3. **Performance** — The incremental export approach adds a small overhead (pushing to a shared array during evaluation). This should be negligible.

4. **Module-level `:=` init expressions** — Keep current depth-first import-discovery ordering. With circular imports this naturally gives: A's pre-import inits → B's inits → A's post-import inits, which is correct.
