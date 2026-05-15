# Port Gap Audit: `src/` (TypeScript) → `yo-self/` (Yo)

Date: 2026-05-15. Snapshot of compiler-core porting status. Goal: drive
`yo-self/` to a strict 1-to-1 port of `src/` so it can build itself and
eventually pass `./tests/`.

CLI/infrastructure (`build-runner`, `fetch*`, `install-command`, `cache`,
`lock-file`, `init`, `version*`, `pkg-config`, `doc/`, `yo-cli`,
`skills-command`) is in scope — `yo-self/` already has partial ports for
each. They're tracked separately in §5.

## 1. Strict 1-to-1 violations (must restructure)

These `yo-self/` files have **no `src/` counterpart** and consolidate
logic that belongs in per-file modules per the strict-1-to-1 rule
([[bootstrap-strict-1to1]]):

| yo-self/ monolith                             | lines | absorbs (src/)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `codegen/exprs.yo`                            | 13135 | `codegen/exprs/*.ts` (37 files, ~10K lines) + much of `codegen/exprs/generation.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `codegen/driver.yo`                           | 5130  | `codegen/index.ts` (775) + parts of `codegen/codegen-c.ts` (311), top-level orchestration                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `codegen/context.yo`                          | 1720  | **acceptable divergence (Yo idiom + bootstrap-specific)** — CodegenContext struct + 9 entry types (~390 lines) + impl block of ~60 helper methods (~1300 lines). In src/ the analog (`FunctionGenerationContext` in `src/codegen/functions/context.ts`) is data-only; operations are scattered functions. yo-self's idiom bundles them in `impl(...)`. Most helpers (`register_box_var`, `register_const_var`, `register_generic_struct_template`, etc.) are bootstrap-only heuristics that don't exist in src/'s typed-AST codegen at all.                       |
| `evaluator/eval.yo`                           | 8258  | parts of `evaluator/index.ts` (239) + per-handler dispatch logic that should live in `evaluator/exprs/*.yo`                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `evaluator/utils.yo`                          | 1235  | **acceptable divergence (cycle-forced)** — after Phase A.4.1 the residual content ports helpers whose src/ homes are split across `src/evaluator/utils.ts` (3 funcs), `src/expr.ts` (7 funcs incl. the 397-line `merge_and_check_envs`), and `src/value.ts` (`are_values_equal`). Splitting back into those three files creates `expr.yo` ↔ `env.yo` ↔ `value.yo` import cycles which yo-self's eager destructuring import cannot tolerate. TypeScript only avoids the cycle because module loading is lazy. The full mapping is documented in the file header. |
| `evaluator/types/trait_registry.yo`           | 59    | fold into `evaluator/trait_checking.yo` — primary consumer, and utils.yo (where `register_type_trait` is called) already imports trait_checking.yo, so no new import cycle. (src/ sets trait info on TypeValue directly during construction; yo-self needs a side-table because TypeValue can't carry the field cleanly yet)                                                                                                                                                                                                                                      |
| `evaluator/types/control_fn_registry.yo`      | 33    | fold into new `yo-self/function_value.yo` (mirrors `isControlFunction` field on FunctionValue in `src/function-value.ts`)                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `evaluator/types/definition_site_registry.yo` | 46    | fold into new `yo-self/function_value.yo` (mirrors `definitionSiteEnclosingFunctionType` field on FunctionValue in `src/function-value.ts`)                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `evaluator/types/macro_registry.yo`           | 114   | fold into `yo-self/evaluator/types/function.yo` (mirrors `parameter.isQuote` / `returnType.isUnquote` fields on FunctionType in `src/evaluator/types/function.ts`)                                                                                                                                                                                                                                                                                                                                                                                                |
| `evaluator/values/generic_impl_registry.yo`   | 439   | identify src/ counterpart (likely `src/evaluator/values/` or `src/evaluator/calls/helper.ts`) and fold; largest of the five, schedule last                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `types/substitution.yo`                       | 324   | **acceptable divergence**: yo-self-only substitution engine (`Substitution` data structure + walker). No direct src/ counterpart — TS uses `getValueOfSomeTypeFromEnv` + `substituteSomeTypesFromEnv` (in `src/evaluator/values/anonymous-function.ts:112`) without an explicit substitution map.                                                                                                                                                                                                                                                                 |
| `types/string.yo`                             | 279   | **acceptable divergence**: holds `type_to_string` (mirrors `typeToString` at `src/types/utils.ts:773`). Cannot be folded into yo-self's `types/utils.yo` because that would create an import cycle (`value.yo` → `utils.yo` → `env.yo` → `value.yo`). TypeScript tolerates the same shape because module loading is lazy.                                                                                                                                                                                                                                         |

**Action**: progressively decompose the monoliths so each function lives
in the file that mirrors its `src/` location. Start with the smallest
(`evaluator/types/*registry.yo`) and work toward `codegen/exprs.yo`.

### Phase A.5 — `codegen/context.yo` reclassification (**COMPLETED** 2026-05-15)

Investigated `codegen/context.yo` (1720 lines). Structure breakdown:

- Lines 1-390: CodegenContext struct + 9 entry struct types.
- Lines 392-1707: `impl(CodegenContext, ...)` block with ~60 helper
  methods (e.g. `register_fn`, `register_array_var`, `is_box_var`,
  `register_const_var`, `register_generic_struct_template`, etc.).

In src/, the analog (`FunctionGenerationContext` in
`src/codegen/functions/context.ts`) is a data-only TS interface;
operations on it are scattered standalone functions across many src/
files. yo-self's idiom is to bundle struct methods inside an `impl()`
block — there is no language-level alternative.

Most of the ~60 methods are **bootstrap-specific heuristics** that have
no src/ counterpart at all (they track things like "this variable was
declared as a C array" or "this name was emitted as a `__auto_type`
constant" which exist only because the bootstrap codegen runs
AST-only and lacks full type info). Once the typed-AST pivot lands
those heuristics disappear.

Decision: reclassify `codegen/context.yo` as an **acceptable divergence
(Yo idiom + bootstrap-specific)**. Splitting would require either
breaking the Yo idiom (scatter methods as standalone fns, fight the
language) or completing the typed-AST pivot (~13at on the roadmap) —
neither in scope today. File header updated to document the rationale.

Net result of Phase A.5: §1 active-decomposition list drops to 3
entries:

- `codegen/exprs.yo` (13135)
- `evaluator/eval.yo` (8147)
- `codegen/driver.yo` (5130)

### Phase A.4 — `evaluator/utils.yo` decomposition (**PARTIAL** 2026-05-15)

- **A.4.1** (commit cff4e1f7): extracted top-level utilities into new
  `yo-self/utils.yo` mirroring `src/utils.ts`. Moved
  `generate_temp_variable_name_prefix`,
  `generate_new_temp_variable_name`, `is_temp_variable_name`, `random_id`.
  20 importers updated. File shrunk 1300 → 1235 lines.
- **A.4.2**: investigated the residual ~1100 lines. Reached the same
  conclusion as `types/string.yo` in Phase A.3.1: the natural src/
  destinations (`expr.ts`, `value.ts`) are blocked by import cycles
  between `expr.yo`, `env.yo`, and `value.yo`. Documented the full
  mapping in `evaluator/utils.yo`'s file header and reclassified the
  file as an **acceptable divergence (cycle-forced)** in §1.

Net result of Phase A.4: §1 violations decrease by one (counting
acceptable divergences as resolved). Active monoliths requiring real
decomposition are now:

- `codegen/exprs.yo` (13135 lines)
- `evaluator/eval.yo` (8258 lines)
- `codegen/driver.yo` (5130 lines)
- `codegen/context.yo` (1720 lines)

### Phase A.3 — `types/` decomposition (**PARTIAL** 2026-05-15)

Investigated three yo-self-only files under `types/`:

- **`types/string.yo`** — attempt to fold into `types/utils.yo` was reverted:
  the merge created an import cycle (`value.yo` → `utils.yo` → `env.yo` →
  `value.yo`) because `utils.yo` legitimately depends on `env.yo` for
  several functions, and `value.yo` needs `type_to_string` from this file.
  TypeScript tolerates this same shape because module loading is lazy;
  yo-self's eager destructuring imports do not. **Decision**: leave
  `string.yo` as a standalone file and document it as an acceptable
  divergence in §1. A future refactor could move the env-dependent
  helpers out of `utils.yo` first, then fold `string.yo` in safely.
- **`types/substitution.yo`** — yo-self-only Substitution data-structure +
  walker. No direct src/ counterpart (TS uses `substituteSomeTypesFromEnv`
  in `src/evaluator/values/anonymous-function.ts:112` without an explicit
  map). **Decision**: acceptable divergence.
- **`types/type.yo`** — split (Phase A.3.3, commit c3a3bb8f):
  - `definitions.yo` (new file, mirrors `src/types/definitions.ts`) — TypeValue enum, `derive(Clone)`.
  - `creators.yo` (renamed from `type.yo`, mirrors `src/types/creators.ts`) — `g_some_type_id_counter`, `generate_some_type_id`, 51 `t_*` constructors, `type_value_tag`.
  - 205 importer files updated to pull from the right split target.
  - No env-cycle risk because both files only depend on leaf modules
    (`tags.yo` for TypeTag, std/collections, std/string).

Net result of Phase A.3: all three yo-self-only `types/*.yo` files
have been addressed. `string.yo` and `substitution.yo` are documented
acceptable divergences; `type.yo` is now properly split into the two
src/-mirroring files.

### Phase A.2 — `codegen/program.yo` → `codegen/codegen_c.yo` (**COMPLETED** 2026-05-15)

Renamed `yo-self/codegen/program.yo` (229 lines) to
`yo-self/codegen/codegen_c.yo` so the file structurally mirrors
`src/codegen/codegen-c.ts`. Updated 8 importers (1 production:
`codegen/driver.yo`; 7 codegen test files). No behavior change. The new
file covers ~26% of `codegen-c.ts` — the rest (function/type-decl
generation, deferred async, library-init, dyn box plumbing) is currently
in `codegen/driver.yo` and per-handler files; it will migrate here as
the dependent src/ files (`functions/generation.ts`,
`types/generation.ts`, `c/collection.ts`) gain yo-self counterparts.

This means `codegen_c.yo` moves from §1 (1-to-1 violation) to §3
(partial port).

### Phase A.1 — registry decomposition (**COMPLETED** 2026-05-15)

All five registry files have been folded into their src/-mirroring
homes. The yo-self/ tree no longer has any `*registry.yo` files that
lack a src/ counterpart:

- trait_registry → `evaluator/trait_checking.yo` (commit 8866e02a)
- control_fn_registry → `function_value.yo` (new file, commit 19401cda)
- definition_site_registry → `function_value.yo` (commit 19401cda)
- macro_registry → `evaluator/types/function.yo` (commit 6af5f276)
- generic_impl_registry → `evaluator/values/impl.yo` (commit 2307d8b1)

### Original Phase A.1 plan (historical reference)

Each of the five registry files is a side-table that emulates a field on
a value type which exists in `src/` but couldn't be added directly to
yo-self's value records. Folding each registry into the file that holds
its primary caller (or into the new file that should mirror the
field-bearing TS file) brings us closer to 1-to-1 without requiring a
deep refactor of the value-type machinery.

Order (smallest first; each step verified by rebuilding `bun run build`
and confirming `./yo-cli compile yo-self/main.yo --release` succeeds):

1. **`trait_registry.yo` → `evaluator/trait_checking.yo`** (59 lines).
   No new file. Safe: `utils.yo` already imports `trait_checking.yo`, and
   `trait_checking.yo` does not import `utils.yo`, so moving the registry
   into `trait_checking.yo` and having utils.yo import `register_type_trait`
   from there introduces no cycle.
2. **`control_fn_registry.yo` + `definition_site_registry.yo` → new
   `yo-self/function_value.yo`** (33+46=79 lines). Creates a new top-level
   file that mirrors `src/function-value.ts` — also closes a §2 gap.
3. **`macro_registry.yo` → `evaluator/types/function.yo`** (114 lines).
4. **`generic_impl_registry.yo` → TBD** (439 lines, requires its own
   investigation).

## 2. Compiler-core: missing files (no yo-self counterpart at all)

| `src/` file                            | lines | notes                                     |
| -------------------------------------- | ----- | ----------------------------------------- |
| `codegen/async/runtime-io-windows.ts`  | 4228  | Windows IOCP backend                      |
| `codegen/async/state-machine.ts`       | 2651  | CPS state-machine codegen                 |
| `codegen/async/state-code-gen.ts`      | 2136  | async state emitter                       |
| `codegen/async/runtime-io-macos.ts`    | 1779  | kqueue backend                            |
| `codegen/async/runtime-io-common.ts`   | 1717  | shared async IO                           |
| `codegen/async/runtime-io-linux.ts`    | 1696  | io_uring backend                          |
| `codegen/async/runtime-io-wasm.ts`     | 797   | wasm backend                              |
| `codegen/async/runtime-core.ts`        | 382   | runtime startup                           |
| `codegen/async/runtime.ts`             | 69    | runtime entry                             |
| `codegen/exprs/async.ts`               | 1820  | async-fn lowering                         |
| `codegen/exprs/await.ts`               | 829   | await lowering                            |
| `codegen/exprs/atom.ts`                | 545   | atom emitter                              |
| `codegen/exprs/generation.ts`          | 1286  | top-level codegen entry                   |
| `codegen/functions/collection.ts`      | 692   | collection types codegen                  |
| `codegen/functions/dyn.ts`             | 536   | dyn dispatch codegen                      |
| `codegen/functions/generation.ts`      | 2339  | function codegen entry                    |
| `codegen/types/collection.ts`          | 556   | collection type emit                      |
| `codegen/types/dyn.ts`                 | 238   | dyn type emit                             |
| `codegen/parallelism/runtime.ts`       | 466   | parallelism runtime                       |
| `codegen/shared/suspension-codegen.ts` | 199   | shared suspension                         |
| `codegen/c/collection.ts`              | 142   | C collection helpers                      |
| `codegen/index.ts`                     | 775   | codegen entry point                       |
| `codegen/codegen-c.ts`                 | 311   | C codegen orchestrator                    |
| `formatter.ts`                         | 1334  | source formatter                          |
| `test-runner.ts`                       | 1529  | `yo test` runner                          |
| `function-value.ts`                    | 195   | runtime function value                    |
| `module-manager.ts`                    | 447   | partially in `main.yo`                    |
| `value-tag.ts`                         | 32    | value tag enum                            |
| `type-value.ts`                        | 23    | type-as-value                             |
| `unit-value.ts`                        | 13    | unit                                      |
| `utils.ts`                             | 96    | top-level utils                           |
| `expr-traversal.ts`                    | 336   | likely absorbed into `evaluator/utils.yo` |

Async (`codegen/async/`, `codegen/exprs/{async,await}`) is the single
largest unported subsystem — ~17K TS lines. It can be deferred until
after the synchronous codegen pipeline is fully ported, because nothing
in the bootstrap compile pipeline needs to emit async code yet.

## 3. Compiler-core: partial ports (significant line gap)

Files that exist but are far shorter than their `src/` counterpart —
function-for-function porting needed. Lines = yo-self / src.

| File                                         | yo-self / src | gap notes                                                                                         |
| -------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------- |
| `env.yo`                                     | 693 / 2232    | **major** — ~31% complete; type & symbol environment                                              |
| `expr.yo` + `expr_info.yo`                   | 1493 / 2582   | ~58%; missing many `Expr` constructors / helpers                                                  |
| `evaluator/values/`                          | 3707 / 7100   | ~52%; value-system gap                                                                            |
| `codegen/exprs/other_fn_call.yo`             | 110 / 2882    | ~4%; (most logic in `exprs.yo` monolith)                                                          |
| `codegen/exprs/match.yo`                     | 495 / 1182    | ~42%; (rest in monolith)                                                                          |
| `codegen/exprs/return.yo`                    | 101 / 705     | ~14%                                                                                              |
| `codegen/exprs/rc_fns.yo`                    | 137 / 556     | ~25%                                                                                              |
| `codegen/exprs/initialization_assignment.yo` | 79 / 534      | ~15%                                                                                              |
| `codegen/exprs/cond.yo`                      | 552 / 466     | over (likely covers more than ts file)                                                            |
| `codegen/exprs/closures.yo`                  | 166 / 320     | ~52%                                                                                              |
| `codegen/exprs/drop_dup.yo`                  | 157 / 370     | ~42%                                                                                              |
| `codegen/exprs/asm.yo`                       | 348 / 757     | ~46%                                                                                              |
| `codegen/exprs/assignment.yo`                | 83 / 359      | ~23%                                                                                              |
| `codegen/functions/declarations.yo`          | 1030 / 788    | over                                                                                              |
| `codegen/functions/generation.yo`            | 220 / 2339    | ~9% (most in monolith)                                                                            |
| `codegen/types/generation.yo`                | 719 / 1303    | ~55%                                                                                              |
| `codegen/codegen-c → constants.yo`           | 132 / 100     | unclear mapping                                                                                   |
| `codegen/codegen_c.yo`                       | 229 / 311     | ~74%; covers preamble + main wrapper + output-print only (renamed from `program.yo` in Phase A.2) |
| `lexer.yo`                                   | 585 / 738     | ~79%                                                                                              |
| `parser.yo`                                  | 1448 / 1569   | ~92%                                                                                              |
| `token.yo`                                   | 124 / 195     | ~63%                                                                                              |
| `compiler_utils.yo`                          | 235 / 322     | ~73%                                                                                              |
| `evaluator/ctfe/ctfe_analysis.yo`            | **17** / 194  | **stub**                                                                                          |

The codegen-exprs "very short" files (e.g. `other_fn_call.yo` at 110
lines vs 2882) reflect logic still living in the
`codegen/exprs.yo` monolith. Migrating function-by-function out of
that monolith into the per-file homes is the main mechanical task.

## 4. Already complete (no action needed)

- `error.yo`, `logger.yo`, `emitter.yo`, `target.yo`, `value.yo`,
  `naming_checker.yo`
- `evaluator/{index,context,trait_checking}.yo` (within 5% of src/)
- `evaluator/exprs/` — all 23 files present
- `evaluator/calls/` — all 15 files present
- `evaluator/builtins/` — all 38 files (12148 / 12863 lines = ~94%)
- `evaluator/types/` — all src files + 4 yo-self extras (registries)
- `evaluator/effects/` — both files larger than src/
- `evaluator/shared/`, `evaluator/utils/closure`, `evaluator/async/` — present, larger or equal
- `types/{compatibility,env_lookup,guards,hierarchy,tags,utils}.yo`

## 5. CLI/infra (deferred but partially ported)

| `src/` file          | lines | `yo-self/`           | lines | status                                   |
| -------------------- | ----- | -------------------- | ----- | ---------------------------------------- |
| `build-runner.ts`    | 1994  | `build_runner.yo`    | 953   | partial (~48%)                           |
| `test-runner.ts`     | 1529  | —                    | —     | **missing**                              |
| `yo-cli.ts`          | 1121  | `main.yo`            | 482   | partial (entry only)                     |
| `fetch.ts`           | 543   | `fetch.yo`           | 907   | over — likely consolidates fetch-command |
| `pkg-config.ts`      | 522   | `pkg_config.yo`      | 326   | partial                                  |
| `install-command.ts` | 507   | `install_command.yo` | 763   | over                                     |
| `version-cache.ts`   | 404   | `version_cache.yo`   | 627   | over                                     |
| `doc-command.ts`     | 352   | —                    | —     | missing (entire `src/doc/` tree too)     |
| `init.ts`            | 237   | `init.yo`            | 235   | complete                                 |
| `lock-file.ts`       | 188   | `lock_file.yo`       | 269   | over                                     |
| `skills-command.ts`  | 142   | —                    | —     | missing                                  |
| `version.ts`         | 110   | `version.yo`         | 194   | complete                                 |
| `fetch-command.ts`   | 103   | (in `fetch.yo`?)     | —     | merged                                   |
| `cache.ts`           | 75    | `cache.yo`           | 93    | complete                                 |
| `dag.ts`             | ?     | —                    | —     | missing                                  |

`test-runner.ts` (1529 lines) is the single biggest CLI gap and is the
one CLI module that actually matters for "passing `./tests/`" — without
it, yo-self has no way to drive the integration tests.

## 6. Recommended porting order

Phase A — **decompose monoliths** (no new code, just relocation):

1. `evaluator/types/*registry.yo` → fold into `env.yo` / appropriate files
2. `codegen/program.yo` → fold into `codegen/index.yo` (new file)
3. `codegen/context.yo` → split between `codegen/functions/context.yo`
   and the relevant per-handler files
4. `codegen/driver.yo` → split into `codegen/index.yo` + `codegen/codegen-c.yo`
5. `codegen/exprs.yo` → distribute functions back to
   `codegen/exprs/*.yo` per their `src/` home (largest task here)
6. `evaluator/eval.yo` → distribute to `evaluator/exprs/*.yo` +
   `evaluator/index.yo`

Phase B — **fill partial ports** (function-by-function from src/):

1. `env.yo` (biggest evaluator gap)
2. `expr.yo` + `expr_info.yo`
3. `evaluator/values/` (52% gap)
4. `evaluator/ctfe/ctfe_analysis.yo` (currently a stub)
5. `lexer.yo`, `token.yo`, `parser.yo` (small finishing touches)

Phase C — **add missing files** (synchronous codegen first):

1. `codegen/functions/generation.yo` (entry for fn codegen)
2. `codegen/exprs/generation.yo` (entry for expr codegen)
3. `codegen/exprs/atom.yo`
4. `codegen/functions/{collection,dyn}.yo`
5. `codegen/types/{collection,dyn}.yo`
6. `codegen/c/collection.yo`
7. `codegen/{shared/suspension-codegen,parallelism/runtime}.yo`
8. Top-level `formatter.yo`, `function_value.yo`, `module_manager.yo`,
   `value_tag.yo`, `type_value.yo`, `unit_value.yo`, `utils.yo`,
   `expr_traversal.yo`

Phase D — **async subsystem** (~17K lines):

1. `codegen/exprs/{async,await}.yo`
2. `codegen/async/state-machine.yo` + `state-code-gen.yo`
3. `codegen/async/runtime-core.yo` + `runtime.yo`
4. `codegen/async/runtime-io-{common,linux,macos,wasm,windows}.yo`

Phase E — **CLI/test-runner**:

1. `test_runner.yo` (1529 lines — needed for running `./tests/`)
2. Fill `build_runner.yo` gap
3. `doc_command.yo` + `doc/` tree
4. `skills_command.yo`, `dag.yo`

## 7. Out of scope for this audit

- Behavioural equivalence (do same inputs produce same C?). Audit is
  structural only — line counts and file presence. Once Phase A+B+C is
  done, we'll need a behavioural diff pass.
- The `yo-self-bin` segfault blocker (see
  `issues/yo-self-bin-rebuild-segfaults-after-may14-src-codegen-changes.md`).
  That blocker prevents _running_ yo-self end-to-end, but doesn't block
  the porting work catalogued here — porting can proceed against
  the TS compiler.
