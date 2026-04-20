# yo-self — Self-Hosted Yo Compiler

This directory holds the **Yo-in-Yo** port of the compiler. The goal is to replace
the TypeScript implementation in `src/` with a Yo implementation that compiles to
a single C file, which can be redistributed as `yo.c` plus a small driver.

## Status

🚧 **Pre-Phase-1.** The directory exists; no source has been ported yet. All
prerequisites in [`../plans/BOOTSTRAPPING_PREREQUISITES.md`](../plans/BOOTSTRAPPING_PREREQUISITES.md)
are complete or have documented workarounds.

## Layout (planned, mirrors `src/`)

```
yo-self/
  build.yo            -- top-level build script (registers steps)
  main.yo             -- CLI entry point  (mirrors src/yo-cli.ts)
  lexer/
    lexer.yo
    token.yo
  parser/
    parser.yo
  ast/
    expr.yo           -- core AST node types (mirrors src/expr.ts)
  evaluator/
    ...
  codegen/
    ...
  tests/
    lexer.test.yo
    parser.test.yo
    ...
```

## Phases

Each phase ends with a working binary that passes a target subset of the existing
`tests/` suite when invoked through the new compiler.

| Phase | Scope                                           | TS source size    |
| ----- | ----------------------------------------------- | ----------------- |
| 1     | Lexer + Token types                             | ~733 lines        |
| 2     | AST (`expr.yo`) + Parser                        | ~4 100 lines      |
| 3     | Evaluator core (begin/cond/match, types)        | partial of ~50 k  |
| 4     | Evaluator: traits, impls, generics, effects     | rest of evaluator |
| 5     | C Codegen                                       | ~46 k lines       |
| 6     | CLI, build runner, dependency management        | smaller modules   |
| 7     | Self-hosting bootstrap: `yo-self` builds itself |                   |

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

## Running (once Phase 1 lands)

```bash
yo build              # build yo-self via the current TS yo
./yo-out/yo-self ...  # invoke the new binary
```

A `tests/yo-self/` mirror will run the same `*.test.yo` files through the new
compiler so we can detect regressions per phase.
