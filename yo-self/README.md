# yo-self — Self-Hosted Yo Compiler

This directory holds the **Yo-in-Yo** port of the compiler. The goal is to replace
the TypeScript implementation in `src/` with a Yo implementation that compiles to
a single C file, which can be redistributed as `yo.c` plus a small driver.

## Status

✅ **Phase 1 complete.** Lexer and parser are ported and tested.
✅ **Phase 2 complete.** Type system (all variants), environment, substitution engine, and literal type-of pass are ported and tested.
✅ **Phase 3a/3b/3c complete.** Evaluator core dispatch + literal/identifier evaluation + arithmetic/comparison/boolean operators implemented and tested.
✅ **Phase 3d complete.** Enum variant construction, `match` pattern matching, and `while` loops implemented and tested.
✅ **Phase 3e complete.** Function definitions and calls, `return` propagation, named constants (`::`) implemented and tested.
✅ **Phase 3f complete.** Type casts and typed arithmetic (`i32(x)`, `usize(x)`, etc.) implemented and tested.
✅ **Phase 3h complete.** Struct value construction (`TypeName(field: val…)`) and field access (`obj.field`) implemented and tested.
✅ **Phase 3i complete.** Lexical closure capture — function bodies now execute in a fresh env rebuilt from a snapshot of the definition-time bindings.
✅ **Phase 3j complete.** `impl(TypeName, method: fn_def, …)` block support and struct method dispatch (`recv.method(args)`) implemented and tested.

- **Lexer** (`yo-self/lexer/`) — fully ported from `src/lexer.ts`; 33 tests passing
- **Parser** (`yo-self/parser/`) — fully ported from `src/parser.ts`; 36 tests passing
- **AST node types** (`yo-self/expr/`) — core `Expr` variants used by parser are defined
- **Types** (`yo-self/types/`) — `TypeTag`, `TypeValue` (all variants including compound), `type_to_string`, `are_types_compatible`, `Substitution`/`substitute`; 38 tests passing
- **Environment** (`yo-self/env/`) — `Variable`, `Frame`, `Environment` with `define`/`lookup`/`push_frame`/`pop_frame`; 3 tests passing
- **Evaluator** (`yo-self/evaluator/`) — `type_of_literal` literal type-of pass (Phase 2c); `EvalValue`/`EvalResult` value types with manual `Eq` impl; `evaluate` core dispatch (literals, identifiers, begin/cond/define/assign, arithmetic, comparison, boolean, enum variants, match, while, fn defs/calls, return, recur, `::`, type casts, typed declarations, string comparison, struct construction, field access, lexical closure capture, impl blocks, method dispatch) (Phases 3a–3j); 64 tests passing
- **Circular imports** — validated via smoke test (`yo-self/tests/circular_smoke.test.yo`)
- **Total: 193 tests passing** under `yo-self/tests/`

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
  evaluator/
    type_of.yo        -- literal type-of pass (mirrors src/evaluator/exprs/atoms.ts)
    value.yo          -- EvalValue enum + EvalResult object (Phase 3a)
    eval.yo           -- evaluate() dispatch: literals + identifier lookup (Phase 3b)
    ...
  codegen/            -- (Phase 4+)
    ...
  tests/
    lexer.test.yo     -- 33 lexer tests
    parser.test.yo    -- 36 parser tests
    types_string_compat.test.yo  -- 6 type system foundation tests
    types_compound.test.yo       -- 29 compound type + substitution tests
    env.test.yo       -- 3 environment tests
    type_of.test.yo   -- 12 literal type-of tests
    eval.test.yo      -- 64 evaluator tests (Phases 3a–3j)
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
