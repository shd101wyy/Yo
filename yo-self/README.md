# yo-self — Self-Hosted Yo Compiler

This directory holds the **Yo-in-Yo** port of the compiler. The goal is to replace
the TypeScript implementation in `src/` with a Yo implementation that compiles to
a single C file, which can be redistributed as `yo.c` plus a small driver.

## Status

🔨 **Phase 1 in progress.** Lexer and parser are ported and tested.

- **Lexer** (`yo-self/lexer/`) — fully ported from `src/lexer.ts`; 33 tests passing
- **Parser** (`yo-self/parser/`) — fully ported from `src/parser.ts`; 36 tests passing
- **AST node types** (`yo-self/expr/`) — core `Expr` variants used by parser are defined
- **Total: 69 tests passing** under `yo-self/tests/`

Run tests:

```bash
./yo-cli test ./yo-self/tests/ --parallel 1
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
  evaluator/          -- (Phase 2+)
    ...
  codegen/            -- (Phase 4+)
    ...
  tests/
    lexer.test.yo     -- 33 lexer tests
    parser.test.yo    -- 36 parser tests
```

## Phases

Each phase ends with a working binary that passes a target subset of the existing
`tests/` suite when invoked through the new compiler.

| Phase | Scope                                           | TS source size    | Status     |
| ----- | ----------------------------------------------- | ----------------- | ---------- |
| 1     | Lexer + Token types + Parser + AST node types   | ~4 800 lines      | ✅ Done    |
| 2     | Evaluator core (begin/cond/match, types)        | partial of ~50 k  | 🔲 Planned |
| 3     | Evaluator: traits, impls, generics, effects     | rest of evaluator | 🔲 Planned |
| 4     | C Codegen                                       | ~46 k lines       | 🔲 Planned |
| 5     | CLI, build runner, dependency management        | smaller modules   | 🔲 Planned |
| 6     | Self-hosting bootstrap: `yo-self` builds itself |                   | 🔲 Planned |

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
./yo-cli test ./yo-self/tests/ --parallel 1

# Run individual test files
./yo-cli test ./yo-self/tests/lexer.test.yo --parallel 1
./yo-cli test ./yo-self/tests/parser.test.yo --parallel 1
```

Once Phase 4+ lands and a full compiler binary exists:

```bash
yo build              # build yo-self via the current TS yo
./yo-out/yo-self ...  # invoke the new binary
```

A `tests/yo-self/` mirror will run the same `*.test.yo` files through the new
compiler so we can detect regressions per phase.
