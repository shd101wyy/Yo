# yo-self — Self-Hosted Yo Compiler

This directory holds the **Yo-in-Yo** port of the compiler. The goal is to replace
the TypeScript implementation in `src/` with a Yo implementation that compiles to
a single C file, which can be redistributed as `yo.c` plus a small driver.

## Status

✅ **Phase 1 complete.** Lexer and parser are ported and tested.
✅ **Phase 2a complete.** Type system foundations and environment are ported and tested.
✅ **Phase 2b complete.** Compound types (Func, TraitT, ModuleT, SomeT), substitution engine, and extended compatibility/stringification are ported and tested.

- **Lexer** (`yo-self/lexer/`) — fully ported from `src/lexer.ts`; 33 tests passing
- **Parser** (`yo-self/parser/`) — fully ported from `src/parser.ts`; 36 tests passing
- **AST node types** (`yo-self/expr/`) — core `Expr` variants used by parser are defined
- **Types** (`yo-self/types/`) — `TypeTag`, `TypeValue` (all variants including compound), `type_to_string`, `are_types_compatible`, `Substitution`/`substitute`; 38 tests passing
- **Environment** (`yo-self/env/`) — `Variable`, `Frame`, `Environment` with `define`/`lookup`/`push_frame`/`pop_frame`; 3 tests passing
- **Circular imports** — validated via smoke test (`yo-self/tests/circular_smoke.test.yo`)
- **Total: 116 tests passing** under `yo-self/tests/`

Run tests:

```bash
./yo-cli test ./yo-self/tests/
```

All prerequisites from [`../plans/BOOTSTRAPPING_PREREQUISITES.md`](../plans/BOOTSTRAPPING_PREREQUISITES.md)
are complete. See [`../plans/BOOTSTRAPPING.md`](../plans/BOOTSTRAPPING.md) for the overall plan.

## Layout (mirrors `src/`)

```
yo-self/
  build.yo            -- top-level build script (registers steps)
  main.yo             -- CLI entry point  (mirrors src/yo-cli.ts)
  expr/
    expr.yo           -- core AST node types (mirrors src/expr.ts)
  lexer/
    lexer.yo          -- tokeniser (mirrors src/lexer.ts)
    token.yo          -- Token type and helpers
  parser/
    parser.yo         -- recursive-descent parser (mirrors src/parser.ts)
  types/
    tags.yo           -- TypeTag enum (mirrors src/types/tags.ts)
    type.yo           -- TypeValue enum + constructors (mirrors src/types/*.ts)
    string.yo         -- type_to_string (mirrors src/types/strings.ts)
    compatibility.yo  -- are_types_compatible (mirrors src/types/compatibility.ts)
    substitution.yo   -- Substitution engine (subst_new/add/lookup/substitute)
  env/
    env.yo            -- Variable, Frame, Environment (mirrors src/env.ts)
  evaluator/          -- (Phase 2b+)
    ...
  codegen/            -- (Phase 4+)
    ...
  tests/
    lexer.test.yo     -- 33 lexer tests
    parser.test.yo    -- 36 parser tests
    types_string_compat.test.yo  -- 6 type system foundation tests
    types_compound.test.yo       -- 29 compound type + substitution tests
    env.test.yo       -- 3 environment tests
    circular_smoke.test.yo       -- 3 circular-import validation tests
```

## Phases

Each phase ends with a working binary that passes a target subset of the existing
`tests/` suite when invoked through the new compiler.

| Phase | Scope                                           | TS source size    | Status         |
| ----- | ----------------------------------------------- | ----------------- | -------------- |
| 1     | Lexer + Token types + Parser + AST node types   | ~4 800 lines      | ✅ Done        |
| 2     | Evaluator core (begin/cond/match, types, env)   | partial of ~50 k  | 🔨 In progress |
| 3     | Evaluator: traits, impls, generics, effects     | rest of evaluator | 🔲 Planned     |
| 4     | C Codegen                                       | ~46 k lines       | 🔲 Planned     |
| 5     | CLI, build runner, dependency management        | smaller modules   | 🔲 Planned     |
| 6     | Self-hosting bootstrap: `yo-self` builds itself |                   | 🔲 Planned     |

(The 50 k / 46 k figures are TS line counts under `src/evaluator` and
`src/codegen` respectively. The Yo port is expected to be smaller per file due
to fewer ceremony lines, but comparable in total LOC.)

## Translation conventions

- **One-to-one TS → Yo translation** wherever feasible. Preserve file names,
  function names, and module boundaries to keep `git blame` traceability with
  the TS source.
- **TS classes → Yo `object(...)` types** with method `impl` blocks.
- **TS enums / discriminated unions → Yo `enum(...)`** (use GADTs for typed
  variants).
- **TS `Map` / `Set` → `std/collections/hash_map` / `hash_set`** (or
  `ordered_map` when iteration order matters).
- **Algebraic effects** for IO, fs, and error propagation — replace ad-hoc
  Result threading from TS where it matches.
- **`derive(Clone, Eq, Hash, ToString)`** on AST/value types instead of manual
  implementations.
- Keep the TS source as the reference until Phase 7 lands. After self-hosting,
  the TS tree is removed.

## Running

```bash
# Run all yo-self tests
./yo-cli test ./yo-self/tests/

# Run individual test files
./yo-cli test ./yo-self/tests/lexer.test.yo
./yo-cli test ./yo-self/tests/parser.test.yo
./yo-cli test ./yo-self/tests/env.test.yo
```

Once Phase 4+ lands and a full compiler binary exists:

```bash
yo build              # build yo-self via the current TS yo
./yo-out/yo-self ...  # invoke the new binary
```

A `tests/yo-self/` mirror will run the same `*.test.yo` files through the new
compiler so we can detect regressions per phase.
