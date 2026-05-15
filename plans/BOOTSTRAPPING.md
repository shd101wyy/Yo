# Bootstrapping the Yo Compiler

> **Detailed phase-by-phase history of this project lives in git** (`git log
--oneline plans/BOOTSTRAPPING.md`). This document is a concise plan
> and current-state record, intentionally rewritten in May 2026 to
> replace a 9789-line phase log that had become hard to navigate.

## Goal

A self-hosted Yo compiler written in Yo (under `yo-self/`) that is a
faithful 1-to-1 port of the TypeScript reference compiler (under `src/`)
and can compile and pass the full `./tests/` integration suite.

The success criterion is:

```bash
# Step 1: Build the self-hosted compiler with the TS-built yo-cli.
./yo-cli compile yo-self/main.yo --release -o yo-self/yo-self-bin

# Step 2: Run the full integration test suite using yo-self-bin as the
# compiler under test, instead of the TS-built yo-cli.
./yo-self/yo-self-bin test ./tests --parallel 0
```

The current state passes a strict subset of `./tests/` (see [Current
status](#current-status)). Closing the gap is the remaining work.

## Strategy

**Structural 1-to-1 port from TypeScript to Yo.** Each TypeScript file
in `src/` has a same-named Yo file in `yo-self/` (with `-` ↔ `_`). Each
TypeScript exported function has a same-named Yo function with
equivalent body. Bootstrap-only files that have no TS counterpart are
treated as divergences and are eliminated where possible.

Yo identifier rules differ from TypeScript:

| TypeScript          | Yo                  |
| ------------------- | ------------------- |
| `binding.ts`        | `binding.yo`        |
| `await-analysis.ts` | `await_analysis.yo` |
| `camelCase`         | `snake_case`        |

These naming differences are mechanical and not divergences.

## Architecture

```
Yo source → Lexer → Parser → AST  (yo-self/lexer.yo, yo-self/parser.yo, yo-self/expr.yo)
                              ↓
                         Evaluator   (yo-self/evaluator/)
                              ↓
                         ExprInfoTable    (typed AST metadata; see Phase 13at)
                              ↓
                         Codegen     (yo-self/codegen/)
                              ↓
                         C compiler (clang / gcc / zig)
```

The evaluator attaches per-expression metadata (`ExprInfo` — type,
compile-time value, runtime destructurings, etc.) to a side-table keyed
by `ExprId`. Codegen reads from this table to produce well-typed C.

## Current status

### Components, with port progress

| Component                  | TS lines | Yo status                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lexer                      | ~600     | ✅ ported (`yo-self/lexer.yo`, `yo-self/token.yo`)                                                                                                                                                                                                                                                                                                                                                                                       |
| Parser                     | ~3500    | ✅ ported (`yo-self/parser.yo`)                                                                                                                                                                                                                                                                                                                                                                                                          |
| AST + ExprInfo             | ~1500    | ✅ ported (`yo-self/expr.yo`, `yo-self/expr_info.yo`)                                                                                                                                                                                                                                                                                                                                                                                    |
| Environment                | ~250     | ✅ ported (`yo-self/env.yo`)                                                                                                                                                                                                                                                                                                                                                                                                             |
| Types                      | ~6500    | ⚠️ mostly ported (`yo-self/types/`, `yo-self/evaluator/types/`)                                                                                                                                                                                                                                                                                                                                                                          |
| Evaluator — proper port    | ~35,000  | ⚠️ partial (`yo-self/evaluator/exprs/_expr.yo` + per-handler files)                                                                                                                                                                                                                                                                                                                                                                      |
| Evaluator — proto (legacy) | n/a      | bootstrap-only `yo-self/evaluator/eval.yo` (8258 lines) — to be retired                                                                                                                                                                                                                                                                                                                                                                  |
| Codegen handlers (37 TS)   | ~16,000  | 33 of 37 ported as `yo-self/codegen/exprs/<name>.yo` (16 ✅ full, 17 ⚠️ partial — see handler table below). 4 remaining ❌ (async, atom, await, generation) are all blocked on the async-runtime port. The 33 ported files coexist with the monolithic bootstrap `yo-self/codegen/exprs.yo`; the dispatcher tries the proper handler first, falls back to bootstrap when metadata is missing.                                            |
| Codegen — async runtime    | ~15,500  | ❌ not ported — blocks all async / effect tests                                                                                                                                                                                                                                                                                                                                                                                          |
| Codegen — functions        | ~4500    | ⚠️ partial (`yo-self/codegen/functions/`)                                                                                                                                                                                                                                                                                                                                                                                                |
| Codegen — utils            | ~1100    | ⚠️ `yo-self/codegen/utils/{index,fixup}.yo` + `codegen/constants.yo` cover 12/16 TS exports from `src/codegen/utils/index.ts` + the full `constants.ts` and `fixup.ts` files. Still pending (4): `findReturnedAsyncBlock` (async-runtime traversal), `getRuntimeStructFields` / `isComptimeOnlyStructField` (blocked on per-field `isCompileTimeOnly` flag on Struct), `isComptimeFunction` (blocked on `Func.return.isCompileTimeOnly`) |
| Codegen — types            | ~2100    | ⚠️ `yo-self/codegen/types/generation.yo` covers struct / enum (simple + data) decls + per-type RC helper fns (`___dispose` / `___drop` / `___dup` for non-RC fields). Not yet covering iso/dyn/some/forall lowering or `src/codegen/types/{collection,dyn}.ts` (the multi-file split in TS).                                                                                                                                             |
| Doc system                 | ~1500    | ✅ ported (`yo-self/doc/`)                                                                                                                                                                                                                                                                                                                                                                                                               |
| Build system               | ~1500    | ✅ ported (`yo-self/build_runner.yo` + `yo-self/evaluator/builtins/build.yo` types & `BuildRegistry`)                                                                                                                                                                                                                                                                                                                                    |
| Dependency / cache         | ~800     | ✅ ported (`yo-self/cache.yo`, `yo-self/fetch.yo`, `yo-self/lock_file.yo`)                                                                                                                                                                                                                                                                                                                                                               |
| CLI                        | ~600     | ✅ ported (`yo-self/main.yo`)                                                                                                                                                                                                                                                                                                                                                                                                            |

### `./tests/` pass rate under `yo-self/yo-self-bin`

| Status             | Test files (representative)                                                                                                                                                                                                       |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| All pass           | basic, array, closure, comptime, comptime_option_result, control_fn_as_regular_call, derive (21/30), forward_ref_self_method, index, match_curly, option_result_combinators, process, ptr, recur_inline_arg, str, type_reflection |
| Partial pass       | fn (13/25), module (7/12), rc (7/15), higher_kinded_types (1/20)                                                                                                                                                                  |
| Mostly skipped     | impl (0/4), iso (0/3), dyn (0/8), error (0/7), imm_list (1/16), try_macro (0/4)                                                                                                                                                   |
| Whole-file blocked | async_await (1/121, async runtime not ported), algebraic_effects (0/61, effects runtime not ported)                                                                                                                               |

The blocked test files require codegen subsystems that are not yet
ported (async runtime, effects runtime, dyn closures, generic
functions, RC machinery beyond bootstrap stubs).

### Codegen handler port status (per TS file in `src/codegen/exprs/`)

| TS file                        | TS lines | Yo port                                                                                                                                                                                                                                                                                               | Test coverage                                               |
| ------------------------------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `expr.ts`                      | 25       | ✅ `expr.yo`                                                                                                                                                                                                                                                                                          | indirect (used everywhere)                                  |
| `gc.ts`                        | 16       | ✅ `gc.yo`                                                                                                                                                                                                                                                                                            | `codegen_exprs_gc.test.yo`                                  |
| `sizeof.ts`                    | 17       | ✅ `sizeof.yo`                                                                                                                                                                                                                                                                                        | `codegen_exprs_sizeof.test.yo`                              |
| `consume.ts`                   | 27       | ✅ `consume.yo`                                                                                                                                                                                                                                                                                       | `codegen_exprs_consume.test.yo`                             |
| `typeid.ts`                    | 45       | ✅ `typeid.yo`                                                                                                                                                                                                                                                                                        | `codegen_exprs_typeid.test.yo` (7 tests)                    |
| `open.ts`                      | 50       | ✅ `open.yo`                                                                                                                                                                                                                                                                                          | `codegen_exprs_open.test.yo` (5 tests)                      |
| `binding.ts`                   | 60       | ✅ `binding.yo`                                                                                                                                                                                                                                                                                       | `codegen_exprs_binding.test.yo` (8 tests)                   |
| `panic.ts`                     | 62       | ✅ `panic.yo`                                                                                                                                                                                                                                                                                         | `codegen_exprs_panic.test.yo` (8 tests)                     |
| `recur.ts`                     | 99       | ✅ `recur.yo`                                                                                                                                                                                                                                                                                         | dedicated test file                                         |
| `tuple-fn.ts`                  | 101      | ✅ `tuple_fn.yo`                                                                                                                                                                                                                                                                                      | dedicated test file                                         |
| `array-fns.ts`                 | 118      | ✅ `array_fns.yo`                                                                                                                                                                                                                                                                                     | dedicated test file                                         |
| `iso.ts`                       | 123      | ✅ `iso.yo`                                                                                                                                                                                                                                                                                           | dedicated test file                                         |
| `async-completion.ts`          | 124      | ✅ `async_completion.yo`                                                                                                                                                                                                                                                                              | `codegen_exprs_async_completion.test.yo`                    |
| `inline-fns.ts`                | 277      | ✅ `inline_fns.yo`                                                                                                                                                                                                                                                                                    | `codegen_exprs_inline_fns.test.yo`                          |
| `parallelism.ts`               | 294      | ⚠️ `parallelism.yo` — `generate_yo_thread_set_maximum_threads` (full) + 3 pure spawn formatters (`format_thread_spawn_call`, `format_worker_spawn_call`, `format_spawn_heap_alloc`). Full `generateThreadSpawnCall` / `generateWorkerSpawnCall` ports wait on the closure heap-alloc + RC-dup chain.  | `codegen_exprs_parallelism.test.yo`                         |
| `begin.ts`                     | 248      | ✅ `begin.yo`                                                                                                                                                                                                                                                                                         | dedicated test file                                         |
| `and-or.ts`                    | 310      | ✅ `and_or.yo`                                                                                                                                                                                                                                                                                        | dedicated test file                                         |
| `cond.ts`                      | 466      | ✅ `cond.yo`                                                                                                                                                                                                                                                                                          | dedicated test file                                         |
| `while.ts`                     | 237      | ✅ `while.yo`                                                                                                                                                                                                                                                                                         | dedicated test file                                         |
| `comptime-value.ts`            | 345      | ⚠️ `comptime_value.yo` — numbers / bool / strings + `FuncVal` (via functions registry) + `TypeVal` (via types registry) + 3 construction formatters (`format_enum_tag_construction` / `format_enum_data_construction` / `format_tuple_construction`)                                                  | `codegen_exprs_comptime_value.test.yo` (16 tests)           |
| `closures.ts`                  | 320      | ⚠️ `closures.yo` — `check_variable_is_closure_captured`, `is_closure_construction`, `resolve_some_type_to_concrete` (stub) + 5 construction formatters (`format_closure_constructor_name` / `…dispose_name` / `format_dyn_closure_construction` / `format_closure_capture_temp_var` / `…stack_alloc`) | `codegen_exprs_closures.test.yo` (14 tests)                 |
| `drop-dup.ts`                  | 370      | ⚠️ `drop_dup.yo` (leaf drop + dup emit for Dyn/Object/AtomicObject/Iso)                                                                                                                                                                                                                               | `codegen_exprs_drop_dup.test.yo` (15 tests)                 |
| `rc-fns.ts`                    | 556      | ⚠️ `rc_fns.yo` — 11 pure RC-builtin formatters: `format_decr_rc_call` / `…incr_rc_call` / `…rc_own` / atomic variants / `format_dyn_drop_call` / `…dup_call` / `format_rc_count_non_atomic` / `…atomic` / `format_null_checked_decr_rc` / `…incr_rc`                                                  | `codegen_exprs_rc_fns.test.yo` (18 tests)                   |
| `return.ts`                    | 705      | ⚠️ `return.yo` (4 pure Token/AstExpr helpers)                                                                                                                                                                                                                                                         | `codegen_exprs_return.test.yo` (13 tests)                   |
| `downcast.ts`                  | 176      | ⚠️ `downcast.yo` (non-boxed-object leaf path) + 2 box/cast formatters (`format_box_extract`, `format_typed_incr_rc_cast`) + c_includes wiring                                                                                                                                                         | `codegen_exprs_downcast.test.yo` (9 tests)                  |
| `match.ts`                     | 1182     | ⚠️ `match.yo` — 4 pure helpers (control-flow / or-pattern / c-literal) + 10 switch-emitter functions / 3 arm structs (DataBinding / SimpleArm / DataArm / emit*switch_open / emit_case*\* / generate_match_simple / generate_match_data) folded in from the former `codegen/match.yo`                 | `codegen_exprs_match.test.yo` (16 tests)                    |
| `assignment.ts`                | 359      | ⚠️ `assignment.yo` — 3 pure-AST predicates (`is_initialization_assignment_lhs`, `unwrap_initialization_lhs`, `is_skipped_assignment_lhs`)                                                                                                                                                             | `codegen_exprs_assignment.test.yo` (11 tests)               |
| `initialization-assignment.ts` | 534      | ⚠️ `initialization_assignment.yo` — `is_skipped_init_lhs` + `destructuring_field_name` (tuple-vs-named field resolution)                                                                                                                                                                              | `codegen_exprs_initialization_assignment.test.yo` (9 tests) |
| `atom.ts`                      | 545      | ❌                                                                                                                                                                                                                                                                                                    |                                                             |
| `dyn.ts`                       | 171      | ⚠️ `dyn.yo` (object/iso underlying-type leaf path + impl registration) + 2 formatters (`format_dyn_vtable_name`, `format_dyn_compound_literal`)                                                                                                                                                       | `codegen_exprs_dyn.test.yo` (10 tests)                      |
| `asm.ts`                       | 757      | ⚠️ `asm.yo` (`is_register_class`, `resolve_constraint`, `transform_template`)                                                                                                                                                                                                                         | `codegen_exprs_asm.test.yo` (15 tests)                      |
| `property-access.ts`           | 416      | ⚠️ `property_access.yo` — `generate_newtype_field_access` (leaf) + `generate_method_field_access` (via functions registry) + `format_ptr_deref` + `format_ptr_to_slice_field_access`                                                                                                                  | `codegen_exprs_property_access.test.yo` (10 tests)          |
| `ptr-fns.ts`                   | 225      | ⚠️ `ptr_fns.yo` — `format_address_of`, `format_address_of_compound_literal`, `format_slice_index_range`                                                                                                                                                                                               | `codegen_exprs_ptr_fns.test.yo` (9 tests)                   |
| `await.ts`                     | 829      | ❌                                                                                                                                                                                                                                                                                                    |                                                             |
| `async.ts`                     | 1820     | ❌                                                                                                                                                                                                                                                                                                    |                                                             |
| `other-fn-call.ts`             | 2882     | ❌                                                                                                                                                                                                                                                                                                    |                                                             |
| `generation.ts`                | 1272     | ❌ (the main per-function emitter; large refactor target)                                                                                                                                                                                                                                             |                                                             |

Partial-port handlers (⚠️) export pure helpers extracted from the TS file
that do not depend on the type-name registry, deferred-dup/drop machinery,
or async state-machine context. The full handlers stay in the bootstrap
codegen until those shared infrastructure pieces land.

### Evaluator structural status

Directory tree of `yo-self/evaluator/` mirrors `src/evaluator/` 1-to-1
modulo `-` ↔ `_` renames, after the May 2026 alignment phase
(Phase 13as). One TS-side filename divergence remains: TS's
`exprs/identifer-and-operator.ts` is misspelled — yo-self uses
`exprs/identifier_and_operator.yo` (the correct spelling), to be fixed
on the TS side separately.

Bootstrap-only files in `yo-self/evaluator/` that have no TS counterpart
and are intentionally retained as scaffolding:

| File                                                         | Lines | Purpose                                                                                                                                                                              |
| ------------------------------------------------------------ | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `eval.yo`                                                    | 8258  | Proto-evaluator interpreter. Backend for `evaluator/index.yo` and macro/reflection tests. Replaced piecemeal as per-handler proper-evaluator ports land.                             |
| `type_of.yo`                                                 | 37    | Literal-type inference helper.                                                                                                                                                       |
| `types/{control_fn,definition_site,macro,trait}_registry.yo` | ~250  | Global registries that mirror class-field mutability TS uses on `FunctionValue` / `TypeValue`. Eliminating them requires adding mutable fields to yo-self's `TypeValue` definitions. |
| `values/generic_impl_registry.yo`                            | 439   | Auto-derive impl registration that belongs in `values/impl.yo`.                                                                                                                      |

The proper evaluator entry points live in:

- `yo-self/evaluator/exprs/_expr.yo` — main dispatcher
  (`_evaluate_expression`).
- `yo-self/evaluator/exprs/<name>.yo` — per-builtin / per-form handlers.
- `yo-self/evaluator/calls/<name>.yo` — typed call evaluators.
- `yo-self/evaluator/types/<name>.yo` — type-construction evaluators.
- `yo-self/evaluator/context.yo` — `EvalContext` (carries the
  `ExprInfoTable`).

## Path forward

Three concurrent workstreams. Order is not strict — pieces can land in
parallel as their dependencies allow.

### Stream A — Wire the proper evaluator into the main pipeline

Today, `yo-self/main.yo` parses → codegen, with no evaluator step.
Codegen falls back to AST-only heuristics in the monolithic
`yo-self/codegen/exprs.yo`. The metadata-aware per-handler ports are
plumbed (`CodegenContext.expr_info_table`) but the table is never
populated.

**Typed-AST infrastructure that's been added (Phase 13at, May 2026):**

The `CodegenContext` now exposes the same registry surface as TS
`CodeGenContext` / `FunctionGenerationContext`:

- `types` — populated by `generate_type_decl` for every struct /
  enum it emits. `get_type_c_name(type_id) -> Option(String)`.
- `functions` — register/get for `FuncVal.func_id` → C name. Read
  by `generate_comptime_value` for `FuncVal` lowering.
- `dyn_impls` — populated by `generate_dyn_for_resolved_inputs`.
- `iso_types` — populated by `generate_yo_iso_create`.
- `slice_struct_types` / `array_struct_types` — for lazy slice/array
  struct emission.
- `extern_functions` — extern-C declarations (matches the
  pre-existing `ExternFunctionEntry` shape from
  `functions/context.yo`).
- `c_includes` — set of header `#include`s. Populated by
  `register_typeid_static`.
- `impl_closure_call_map` — `Impl(Fn(...))` static-dispatch entries.
- `closure_capture_map` — closure-to-capture mapping.
- Scalar state: `current_function_type`, `in_async_state_machine`,
  `in_effect_state_machine`, `inside_match`, `needs_cycle_gc`,
  `is_library`, `current_module_id`.

All registries have canonical register/get helpers and are exported.
`codegen_context.test.yo` (29 tests) pins each registry's contract.

The remaining work in this stream:

1. **Run `evaluate_module_body` on parsed top-level exprs in
   `yo-self/main.yo`'s compile flow.** Wrap with try/catch — when the
   evaluator throws (due to gaps in `_evaluate_expression`'s coverage),
   record the error and continue with an empty `ExprInfoTable` so
   compilation still falls back to bootstrap heuristics.
2. **Move from the proto-evaluator to the proper evaluator.** Once
   `_evaluate_expression` handles all top-level shapes that real
   `./tests/` programs use, retire `yo-self/evaluator/eval.yo`. The
   macro/reflection test scaffolding that currently depends on it
   migrates to the proper evaluator.
3. **Fill the evaluator coverage gaps** discovered by running step 1
   over `./tests/` files. Each gap is a missing or partial
   `_evaluate_expression` sub-handler. Use git log on
   `yo-self/evaluator/exprs/` to see which forms are covered today.

### Stream B — Complete the partial codegen handlers + port the 4 missing

17 of the 37 TS codegen-expr handlers are partial-ported (only their
pure helpers / non-metadata-dependent code paths). Completing them
to full ports — and porting the 4 remaining ❌ (`atom`, `async`,
`await`, `generation`) — is Stream B's scope. Rows below list both
sets; `atom`, `async`, `await`, `generation` are the new-file ports.

| Priority | TS file                        | Approx. effort            | Unblocks                                  |
| -------- | ------------------------------ | ------------------------- | ----------------------------------------- |
| 1        | `assignment.ts`                | medium (~360 lines)       | Many tests; assignment is everywhere      |
| 1        | `initialization-assignment.ts` | medium (~535 lines)       | `:=` declarations                         |
| 1        | `atom.ts`                      | medium (~545 lines)       | Identifier / literal codegen via metadata |
| 1        | `return.ts`                    | medium-large (~705 lines) | Function bodies                           |
| 1        | `match.ts`                     | large (~1180 lines)       | All `match` expressions                   |
| 2        | `property-access.ts`           | medium (~415 lines)       | `obj.field`, methods                      |
| 2        | `comptime-value.ts`            | medium (~345 lines)       | Comptime constant lowering                |
| 2        | `closures.ts`                  | medium (~320 lines)       | Closure environments                      |
| 2        | `drop-dup.ts`                  | medium (~370 lines)       | RC cleanup expressions                    |
| 2        | `dyn.ts` + `downcast.ts`       | medium (~170 + ~175)      | Dyn dispatch + downcast                   |
| 2        | `rc-fns.ts`                    | medium (~555 lines)       | `rc(x)`, RC builtins                      |
| 2        | `ptr-fns.ts`                   | small (~225 lines)        | Pointer builtins                          |
| 3        | `asm.ts`                       | medium (~755 lines)       | Inline assembly                           |
| 3        | `other-fn-call.ts`             | very large (~2880 lines)  | The generic function-call fallback        |
| 3        | `await.ts` + `async.ts`        | huge (~830 + ~1820)       | All async / await — blocks 121 tests      |
| 3        | `generation.ts`                | very large (~1270 lines)  | The main per-function body emitter        |

Each port follows the same pattern as `typeid.yo`, `binding.yo`,
`panic.yo`, `open.yo`:

1. Add the file in `yo-self/codegen/exprs/<name>.yo`.
2. Mirror the TS exports with `_`-snake-cased names.
3. Read `ctx.get_expr_info(ast_expr_id(expr))` for typed metadata.
4. Return `Option(String).None` when required metadata is missing so
   the dispatcher can fall back to the bootstrap heuristic for now.
5. Wire into `yo-self/codegen/exprs.yo` next to the existing builtin
   dispatch, in `match`-with-fallback form:
   ```yo
   match(
     generate_<name>(...),
     .Some(c_expr) => Option(String).Some(c_expr),
     .None => handle_<existing_bootstrap>(...)
   )
   ```
6. Add a `yo-self/tests/codegen_exprs_<name>.test.yo` covering at
   minimum: missing-metadata-None fallback, the happy path, and one
   edge case per TS branch.

### Stream C — Port the async / effects runtimes

The largest blocker. `src/codegen/async/` is ~15,500 lines across:

| TS file                                           | TS lines | Notes                                                    |
| ------------------------------------------------- | -------- | -------------------------------------------------------- |
| `runtime.ts`                                      | ~2300    | Core scheduler / future / waker types                    |
| `runtime-core.ts`                                 | ~1500    | Platform-agnostic state-machine glue                     |
| `runtime-io-{common,linux,macos,windows,wasm}.ts` | ~6500    | Per-platform I/O backends (kqueue / epoll / IOCP / wasi) |
| `state-machine.ts`                                | ~2200    | The async state-machine codegen                          |
| `state-code-gen.ts`                               | ~2700    | The state-machine emitter                                |

Until this lands, `tests/async_await.test.yo` (121 tests),
`tests/algebraic_effects.test.yo` (61 tests), and any other tests using
`async` / `await` / handlers stay on the "blocked" list.

This stream is **mostly orthogonal** to Streams A and B — it can be
worked on independently once the codegen API stabilizes.

## Running the bootstrap

```bash
# Build the TS-built yo-cli (always before yo-self commands).
bun run build

# Build the self-hosted compiler.
./yo-cli compile yo-self/main.yo --release -o yo-self/yo-self-bin

# Run the yo-self test suites (unit / per-handler tests).
./yo-cli test ./yo-self/tests --parallel 0

# Run integration tests against the self-hosted compiler.
./yo-self/yo-self-bin test tests/basic.test.yo --disable-sanitize --parallel 1
./yo-self/yo-self-bin test tests/ --disable-sanitize --parallel 0
```

## Operating principles

1. **Strict 1-to-1.** Each TS file in `src/` has a same-named Yo file
   in `yo-self/`. Each TS exported function has a same-named Yo
   function. Bootstrap-only divergences (proto-evaluator, monolithic
   `exprs.yo`, etc.) are retired piecewise.
2. **No silent fallback.** A ported handler that lacks the metadata
   it needs returns `Option(String).None`, never an "approximate"
   answer that produces incorrect C. The dispatcher decides whether
   to fall back to a bootstrap heuristic or panic.
3. **One handler, one test file.** Each `yo-self/codegen/exprs/<name>.yo`
   has a matching `yo-self/tests/codegen_exprs_<name>.test.yo` that
   exercises every branch of the TS handler.
4. **Eliminate proto- and bootstrap-only files as their replacements
   land.** The proto-evaluator `eval.yo`, the monolithic
   `codegen/exprs.yo`, the registries in `evaluator/types/`, and
   bootstrap heuristics get deleted as their proper replacements
   prove out — no parallel-implementation drift.
