# Bootstrapping the Yo Compiler

> **For the current, focused effort see
> [`BOOTSTRAPPING_EVALUATOR.md`](BOOTSTRAPPING_EVALUATOR.md)** — it
> narrows the near-term target to the **evaluator** and the **`check`
> subcommand** (no codegen), with measured current state and a phased
> path to `yo-self-bin check ./std`, `./tests`, `./yo-self`. This
> document remains the **full** self-hosting record (incl. codegen);
> some of its status numbers predate the evaluator doc.

> **Detailed phase-by-phase history of this project lives in git** (`git log
--oneline plans/BOOTSTRAPPING.md`). This document is a concise plan
> and current-state record. The **Open / Closed evaluator gaps** sections
> below were merged in from the former `issues/yo-self-evaluator-gaps.md`
> — that file is now retired in favour of this one being the single source
> of truth for bootstrap status.

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
                         ExprInfoTable    (typed AST metadata)
                              ↓
                         Codegen     (yo-self/codegen/)
                              ↓
                         C compiler (clang / gcc / zig)
```

The evaluator attaches per-expression metadata (`ExprInfo` — type,
compile-time value, runtime destructurings, etc.) to a side-table keyed
by `ExprId`. Codegen reads from this table to produce well-typed C.

## Current status

> **AUTHORITATIVE current state (2026-07-01) is in
> [`BOOTSTRAPPING_CODEGEN.md`](BOOTSTRAPPING_CODEGEN.md).** The evaluator port is
> complete (`check` green); the codegen port is substantially complete (differential
> corpus 96/96). **P0** (heap-corruption SIGTRAP) FIXED; **P1** (executing-mode
> transpile-error tail) COMPLETE — the TS compiler self-compiles `yo-self/main.yo`
> in 81 s with **0 real** `// Failed to transpile` markers (measure with
> `scripts/count-transpile-failures.sh`; a bare grep miscounts by a fixed
> string-literal floor of 2). The **sole remaining blocker is P2 — memory**: the
> yo-self binary peaks ~3× the TS compiler self-compiling, swap-thrashing the
> Phase-6 fixpoint on 16 GB. The §"Functional state today" below predates this and
> is retained only for history.

### Functional state today

On `bootstrap/phase-4`, yo-self-bin can `check`:

- The full `std/prelude.yo` end-to-end (1040+ exprs).
- Simple user programs: i32 / str literals, function definitions,
  `assert`, struct + impl + method dispatch (`Counter`), generic structs
  with `forall(T : Type)` (`Box2(T)`), `Option(T)` + `match` patterns,
  `Result(T, E)` + `?*(T)` shapes, traits with generic-constructor
  fn-type fields.
- Files that `import("std/...")` resolve at parse/dep-collection time via
  `collect_module_deps`; at evaluator time they resolve through a
  transparent env-synthesised `ModuleVal` (no separate per-module
  sub-evaluator yet — see §C below).

Self-tests passing: lexer (33/33), binding (7/7), assignment (9/9), and
the other bootstrap-only suites. **22 / 25 (88%)** of real-test extracts
from `./tests/*.test.yo` (see [Real-test extraction coverage](#real-test-extraction-coverage)
below).

**Hard requirement to run yo-self-bin:** `ulimit -s 65520` before
invoking the binary on non-trivial input. The recursive evaluator
carries large by-value structs and blows macOS's default 8 MB stack at
~40–50 frames. See [`yo-self-evaluator-stack-overflow.md`](../issues/fixed/yo-self-evaluator-stack-overflow.md)
and §I below.

What is **not yet working**:

- `yo-self-bin compile` produces invalid C for non-trivial programs (the
  evaluator OKs them, but codegen emits undeclared identifiers for
  `Self`, locals, etc.). Tracked under `issues/yo-self-codegen-*.md`
  and in [Codegen handler port status](#codegen-handler-port-status).
- Cross-module isolation: yo-self uses a flatten-all-exprs shortcut
  instead of TS's per-module sub-evaluation + caching. Works for the
  prelude and simple deps; not equivalent to TS for module privacy or
  for circular imports. See §C below.
- Several real test programs (HKT-heavy, GADT, RC-stress, async,
  effects).

### Component port progress

| Component                  | TS lines | Yo status                                                                                                                                                                                                                                                       |
| -------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lexer                      | ~600     | ✅ ported (`yo-self/lexer.yo`, `yo-self/token.yo`)                                                                                                                                                                                                              |
| Parser                     | ~3500    | ✅ ported (`yo-self/parser.yo`)                                                                                                                                                                                                                                 |
| AST + ExprInfo             | ~1500    | ✅ ported (`yo-self/expr.yo`, `yo-self/expr_info.yo`)                                                                                                                                                                                                           |
| Environment                | ~2300    | ✅ ported (`yo-self/env.yo`, 2767 LoC). All 30 `src/env.ts` exports covered, including `getReceiverMethodsByNameFromEnv` (10 branches). Minor TS-line divergences (`resolvedConcreteType` fast path; pointer-cell aliasing in `clone_value`) documented inline. |
| Types                      | ~6500    | ⚠️ mostly ported (`yo-self/types/`, `yo-self/evaluator/types/`). HKT `SomeT.kindFunctionType` field added but not yet read — see §A.                                                                                                                            |
| Evaluator — proper port    | ~35,000  | ⚠️ partial (`yo-self/evaluator/exprs/_expr.yo` + per-handler files). 133 `.yo` files vs 125 `.ts` files; structurally complete.                                                                                                                                 |
| Evaluator — proto (legacy) | n/a      | bootstrap-only `yo-self/evaluator/eval.yo` (8258 lines) — to be retired                                                                                                                                                                                         |
| Codegen handlers           | ~16,000  | ❌ DELETED 2026-06-11 — the untyped bootstrap walker was removed; the port restarts clean per `plans/BOOTSTRAPPING_CODEGEN.md`.                                                                                                                                 |
| Codegen — async runtime    | ~15,500  | ❌ not ported — blocks all async / effect tests                                                                                                                                                                                                                 |
| Codegen — functions        | ~4500    | ❌ DELETED with the walker (see above)                                                                                                                                                                                                                          |
| Codegen — utils            | ~1100    | ❌ DELETED with the walker (see above)                                                                                                                                                                                                                          |
| Codegen — types            | ~2100    | ❌ DELETED with the walker (see above)                                                                                                                                                                                                                          |
| Doc system                 | ~1500    | ✅ ported (`yo-self/doc/`)                                                                                                                                                                                                                                      |
| Build system               | ~1500    | ✅ ported (`yo-self/build_runner.yo` + `yo-self/evaluator/builtins/build.yo`)                                                                                                                                                                                   |
| Dependency / cache         | ~800     | ✅ ported (`yo-self/cache.yo`, `yo-self/fetch.yo`, `yo-self/lock_file.yo`)                                                                                                                                                                                      |
| CLI                        | ~600     | ✅ ported (`yo-self/main.yo`)                                                                                                                                                                                                                                   |

### Real-test extraction coverage

Sampling real `./tests/*.test.yo` files by extracting individual test
bodies into standalone fixtures and running them through `yo-self-bin
check`:

| Source test file                  | Extracted test                                             | Result  |
| --------------------------------- | ---------------------------------------------------------- | ------- |
| basic.test.yo                     | Test bindings / comptime / destructuring / Send / Acyclic  | ✅      |
| array.test.yo                     | Element access + length, inferred length                   | ✅      |
| closure.test.yo                   | ClosureType, closure with Dyn                              | ✅      |
| dyn.test.yo                       | Multiple traits                                            | ✅      |
| derive.test.yo                    | derive Eq for struct                                       | ✅      |
| comptime.test.yo                  | Comptime f32                                               | ✅      |
| comptime_option_result.test.yo    | Option comptime methods                                    | ✅      |
| algebraic_effects.test.yo         | resume / escape                                            | ✅      |
| gadts.test.yo                     | basic (lazy) — passes; forced specialization → clean error | ⚠️      |
| iso.test.yo                       | basic Iso functions                                        | ✅      |
| type_reflection.test.yo           | Type reflection methods                                    | ✅      |
| impl_fn_field_rejection.test.yo   | workaround A + B                                           | ✅      |
| atomic_object.test.yo             | basic; generic-with-where → 💥                             | partial |
| blanket_impl_inner_forall.test.yo | inner forall blanket → 💥                                  | fails   |
| error.test.yo                     | custom MathError enum → 💥                                 | fails   |

**22 / 25 (88%)** of extracted real-test fixtures pass cleanly.

The 3 SIGSEGV / fail cases are all the same underlying throw-propagation
shape — see `issues/fixed/yo-self-where-clause-trait-eval-segfault.md` and
`issues/fixed/yo-self-nested-typeapp-in-impl-return-segfault.md`.

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

### Codegen handler port status

Per TS file in `src/codegen/exprs/`:

| TS file                        | TS lines | Yo port                            | Test coverage                                         |
| ------------------------------ | -------- | ---------------------------------- | ----------------------------------------------------- |
| `expr.ts`                      | 25       | ✅                                 | indirect (used everywhere)                            |
| `gc.ts`                        | 16       | ✅                                 | `codegen_exprs_gc.test.yo`                            |
| `sizeof.ts`                    | 17       | ✅                                 | `codegen_exprs_sizeof.test.yo` (3 tests)              |
| `consume.ts`                   | 27       | ✅                                 | `codegen_exprs_consume.test.yo`                       |
| `typeid.ts`                    | 45       | ✅                                 | `codegen_exprs_typeid.test.yo` (11)                   |
| `open.ts`                      | 50       | ✅                                 | `codegen_exprs_open.test.yo` (7)                      |
| `binding.ts`                   | 60       | ✅                                 | `codegen_exprs_binding.test.yo` (11)                  |
| `panic.ts`                     | 62       | ✅                                 | `codegen_exprs_panic.test.yo` (12)                    |
| `recur.ts`                     | 99       | ✅                                 | dedicated (12)                                        |
| `tuple-fn.ts`                  | 101      | ✅                                 | dedicated (11)                                        |
| `array-fns.ts`                 | 118      | ✅                                 | dedicated (10)                                        |
| `iso.ts`                       | 123      | ✅                                 | dedicated (13)                                        |
| `async-completion.ts`          | 124      | ✅                                 | `codegen_exprs_async_completion.test.yo` (5)          |
| `inline-fns.ts`                | 277      | ✅                                 | `codegen_exprs_inline_fns.test.yo` (11)               |
| `begin.ts`                     | 248      | ✅                                 | dedicated (9)                                         |
| `and-or.ts`                    | 310      | ✅                                 | dedicated (12)                                        |
| `cond.ts`                      | 466      | ✅                                 | `codegen_exprs_cond.test.yo` (4)                      |
| `while.ts`                     | 237      | ✅                                 | dedicated (13)                                        |
| `parallelism.ts`               | 294      | ⚠️                                 | `codegen_exprs_parallelism.test.yo` (6)               |
| `comptime-value.ts`            | 345      | ⚠️                                 | `codegen_exprs_comptime_value.test.yo` (16)           |
| `closures.ts`                  | 320      | ⚠️                                 | `codegen_exprs_closures.test.yo` (14)                 |
| `drop-dup.ts`                  | 370      | ⚠️                                 | `codegen_exprs_drop_dup.test.yo` (19)                 |
| `rc-fns.ts`                    | 556      | ⚠️                                 | `codegen_exprs_rc_fns.test.yo` (18)                   |
| `return.ts`                    | 705      | ⚠️                                 | `codegen_exprs_return.test.yo` (13)                   |
| `downcast.ts`                  | 176      | ⚠️                                 | `codegen_exprs_downcast.test.yo` (13)                 |
| `match.ts`                     | 1182     | ⚠️                                 | `codegen_exprs_match.test.yo` (18)                    |
| `assignment.ts`                | 359      | ⚠️                                 | `codegen_exprs_assignment.test.yo` (11)               |
| `initialization-assignment.ts` | 534      | ⚠️                                 | `codegen_exprs_initialization_assignment.test.yo` (9) |
| `dyn.ts`                       | 171      | ⚠️                                 | `codegen_exprs_dyn.test.yo` (15)                      |
| `asm.ts`                       | 757      | ⚠️                                 | `codegen_exprs_asm.test.yo` (19)                      |
| `property-access.ts`           | 416      | ⚠️                                 | `codegen_exprs_property_access.test.yo` (10)          |
| `ptr-fns.ts`                   | 225      | ⚠️                                 | `codegen_exprs_ptr_fns.test.yo` (9)                   |
| `atom.ts`                      | 545      | ❌                                 |                                                       |
| `await.ts`                     | 829      | ❌                                 |                                                       |
| `async.ts`                     | 1820     | ❌                                 |                                                       |
| `other-fn-call.ts`             | 2882     | ❌                                 |                                                       |
| `generation.ts`                | 1272     | ❌ (the main per-function emitter) |

Partial-port handlers (⚠️) export pure helpers extracted from the TS
file that do not depend on the type-name registry, deferred-dup/drop
machinery, or async state-machine context. The full handlers stay in
the bootstrap codegen until those shared infrastructure pieces land.

### Evaluator structural status

Directory tree of `yo-self/evaluator/` mirrors `src/evaluator/` 1-to-1
modulo `-` ↔ `_` renames. One TS-side filename divergence remains: TS's
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

- `yo-self/evaluator/exprs/_expr.yo` — main dispatcher.
- `yo-self/evaluator/exprs/<name>.yo` — per-builtin / per-form handlers.
- `yo-self/evaluator/calls/<name>.yo` — typed call evaluators.
- `yo-self/evaluator/types/<name>.yo` — type-construction evaluators.
- `yo-self/evaluator/context.yo` — `EvalContext` (carries the `ExprInfoTable`).

---

## Open evaluator gaps

Listed in rough priority order. Each gap has: location, what's missing,
symptom, TS reference, and a fix sketch. The numbering (§A–§I) is
stable — re-opened gaps add a new audit entry to the closed log below
without renumbering.

### §A. HKT support — `SomeT.kindFunctionType` not wired

**Where:** `yo-self/types/definitions.yo` (field added in `d78e5e14`),
`yo-self/evaluator/types/function.yo::evaluate_function_parameter`,
`yo-self/evaluator/types/synthesizer.yo` (TypeApplication path).

**What's missing:** The `kind_function_type : Option(Box(Self))` slot
was added to the `SomeT` variant to mirror TS `SomeType.kindFunctionType`,
but nothing populates or reads it yet. When a forall parameter has a
kind like `F : (fn(T : Type) -> Type)` (i.e. F is itself
type-of-types-to-types), the evaluator binds F as a plain `SomeT` with
no record of the kind, and a later `F(A)` `TypeApplication` has no way
to know that F is HKT-shaped.

**Symptom:** Trait declarations using
`Functor :: trait(F : (fn(T : Type) -> Type), map : …)` segfault during
type-expression evaluation (the bare `F` is treated as runtime-only and
a downstream dereference goes off the rails).

**TS reference:** `src/value.ts:573-619` (`createUnknownValue` branches
on the param's declared type: `TypeUni(0)` → `SomeType`,
`Func(... → comptime Type)` → `SomeType` with `kindFunctionType` set).
Then `src/evaluator/calls/numeric-type.ts` and the type-application
path consult `kindFunctionType` to drive `F(A)` eval to a fresh applied
`SomeType` instead of a raw lookup.

**Fix sketch:**

1. Extend `create_unknown_val_with_name` (already in `yo-self/value.yo`)
   with a third branch: when `ty` is a `Func(...)` whose return is
   comptime-`Type` and whose params are comptime-`Type`, emit
   `TypeVal(t_some_t_with_kind(name, …, ty))`.
2. Update `evaluate_function_parameter` to call this helper for forall
   HKT params.
3. Implement TypeApplication in `evaluator/types/synthesizer.yo`: when
   the callee in a type position is a `SomeT` carrying
   `kind_function_type`, produce a fresh applied SomeT.

**Real-test exposure:** Functor / Monad / Iterator chains. Affects any
test that builds traits parametric over a type constructor.

### §B. Trait-checking Phase-3 stubs

**Where:** `evaluator/trait_checking.yo` (lines 14, 221, 227, 230, 238,
250, 466, 473, 1062, 1065, 1071), `evaluator/calls/trait_type.yo:14`.

**What's stubbed:**

- `findAssociatedTypeFromGenericImpls` — returns `Option.None`.
- Generic-impl-registry walks for associated-type constraints.
- `typeImplementsTraitBool` — conservative fallback (returns true when
  in doubt; can pick an over-broad impl).

Already in place (commit `efd79680`): a real `HashMap`-backed
`currentlyRegisteringConcreteImpls` registry for the
`isConcreteImplBeingRegistered` / `mark/unmark…` pair.

**Symptom:** Where-clause constraints on generic impls aren't fully
verified; blanket impls that depend on associated-type lookup compile
but can produce wrong specializations. Mostly affects advanced trait
code (e.g. `Iterator` chains with `Map`/`Filter`).

**Fix sketch:** Port `findAssociatedTypeFromGenericImpls` from
`src/evaluator/trait-checking.ts` (~80 lines of registry walk + type
substitution). Once the generic-impl registry is fully populated by
`evaluator/values/impl.yo`, the trait_checking walks become
straightforward.

### §C. Per-module sub-evaluation (true `ctx.load_module`)

**Where:** `yo-self/main.yo::check_single_file`,
`yo-self/evaluator/exprs/import.yo`.

**What's missing:** yo-self flattens every transitively-imported
module's exprs into one list evaluated in a shared env. For runtime
`import("path")` it currently returns a synthetic `ModuleVal` built
from the current env (so destructuring works), but there is no
per-module scope: any binding declared in `./a.yo` is visible to
`./b.yo` even if `b.yo` never imported `a.yo`.

**TS reference:** `src/module-manager.ts::loadModule` (each module gets
its own `Evaluator` instance, caches `(path → ModuleValue)`, supports
circular imports via a `loadingModules` partial-population set).

**Symptom:** Tests that rely on module privacy or on circular-import
partial population will not behave like TS. Imports of `std/...` paths
also currently fail at evaluator time with "Module not found /
dependency name resolution not yet implemented" — that's the
dependency-resolution half, separate but adjacent.

**Fix sketch:** Replace the flatten in `check_single_file` with a
per-module loop that evaluates each module's exprs in its own sub-env,
captures exports as a `ModuleVal`, and caches by absolute path. Then
register `ctx.load_module` to look up from that cache (and the
synthetic env-based fallback can be removed). Track circular imports
the way TS does.

### §D. RC function-signature derivation

**Where:** `evaluator/types/struct.yo:87-88`,
`evaluator/types/enum.yo:207`, `evaluator/types/record.yo:259`,
`evaluator/values/anonymous_struct.yo:188`,
`evaluator/types/tuple.yo:160`.

**What's stubbed:**

- `addRcFunctionSignaturesToStructType` / `EnumType` / `TupleType`.
- `beginSendDerivation` / `endSendDerivation`.
- `autoDeriveTraitsAndAddRcFunctionsForStructType`.

**Symptom:** Auto-derived `___drop` / `___dup` / `__yo_decr_rc`
function signatures aren't pre-registered on the type, so codegen has
to re-derive at the use site. **Doesn't block evaluation.** Codegen
may emit slightly different C than the TS reference; the bootstrap
test suite hasn't surfaced a failure from this yet.

**Fix sketch:** Port the four functions from `src/evaluator/types/*.ts`.
Mostly mechanical — they generate `Func` TypeValues from a struct's RC
shape and register them on the type's id.

### §E. GADT enum support

**Where:** `evaluator/types/enum.yo:234`.

**What's stubbed:** Variants of form `Variant -> recur(T)` (refining
the enum's type param per variant) throw `GADT enum not yet implemented
in self-hosted compiler`.

**Symptom:** `./tests/gadts.test.yo` fails on yo-self-bin (clean error,
not a crash). All non-GADT enum patterns work.

**Fix sketch:** Port the GADT path from `src/evaluator/types/enum.ts`.
Independent of other gaps; estimate small-medium.

### §F. Closure ownership / move semantics

**Where:** `evaluator/utils/closure.yo:71, 104, 351`.

**What's stubbed:**

- `attachClosureMoveSemantics` is a no-op (env returned unchanged).
- ARC capture tracking always returns `Option.None`.

**Symptom:** Closures compile and run, but consumed-capture analysis
is lossy. Doesn't crash, but may cause RC double-drop or use-after-free
in heavy closure-passing tests. The bootstrap closure test suite passes
today, so it isn't currently blocking.

### §G. Build / asm / partial assignment stubs

**Where:**

- `evaluator/builtins/build.yo:527` — `evaluate_yo_build_functions`
  Phase-3 stub.
- `evaluator/builtins/asm.yo:3` — inline asm evaluator stub.
- `evaluator/exprs/assignment.yo:10-19` — several assignment-form
  Phase-3 stubs.
- `evaluator/exprs/recur.yo:184` — `UnknownVal.variable_name` /
  `is_runtime_only` flags not yet plumbed.

**Symptom:** Affects build-script evaluation (`std/build.yo`-based
projects), inline asm tests, and a handful of edge-case assignment
shapes. Not blocking general program compilation.

### §H. Operator-trait ModuleT/Call dispatch (`(-)`, `(+)`, etc.)

**Where:** `yo-self/evaluator/calls/function.yo` (top-of-function
prefold), `yo-self/evaluator/calls/helper.yo:1905-1932` (soft fallback).

**What's missing:** Prelude declares operator overloads as
`(op) :: impl({ Call :: (overload1, overload2); })` (e.g. lines 515,
6496 for `-` and `?*`). yo-self doesn't yet implement the
ModuleT/Call overload dispatch path that picks the right overload
based on the arg's comptime/runtime status. Currently:

- `-(IntLit)` is special-cased (constant-folded at the top of
  `evaluate_function_call`, see §5f in the closed log). Works for the
  common prelude shape (`enum discriminant = -(1)`).
- All other operator-on-module-callee shapes fall into the soft
  fallback in `helper.yo:1916` and return `t_unit()` / Unknown.

**Fix sketch:** Implement proper Call-member overload resolution in
`try_to_implement_module_with_arguments_by_module_type`
(`evaluator/calls/record_type.yo`). For each declared `Call` overload,
match argument arity + comptime-ness, dispatch to the best match.
Replace the §5f literal-arg prefold with the real dispatch once it
works.

**Symptom today:** Anything more elaborate than `-(literalInt)` for
the prelude's `(-)` and similar ops will yield `UnknownVal`.

### §I. Stack overflow on default macOS 8 MB stack (workaround only)

Tracked separately in
[`yo-self-evaluator-stack-overflow.md`](../issues/fixed/yo-self-evaluator-stack-overflow.md).
Workaround: `ulimit -s 65520`. Real fix is one of: explicit `setrlimit`
in the binary's `main`, boxed parameter passing for hot recursive sites,
or an iterative eval driver instead of native recursion. Not blocking
present work since the workaround is one line.

---

## Closed evaluator gaps log

Append-only audit trail. Each entry points at the commit that fixed it.
Do not edit closed entries — when re-opening a gap, add a new entry.

### a872d884 — Prelude auto-loading wired

`run_check` now calls `collect_module_deps("prelude.yo", …)` before
walking the input file's imports, so prelude declarations are part of
`all_exprs`. `ctx.std_path` is set so the modular `import("std/...")`
handler can resolve paths during evaluation itself. (Still doesn't
apply to `run_compile`; `@skip_prelude` per-file detection not wired.)

### c8bd5b40 — Array length accepts UnknownVal placeholder (§5b)

`evaluator/types/array.yo` used to throw `Expected integer literal for
array length` on any non-IntLit; now accepts `UnknownVal` and stores
`usize(0)` placeholder. Proper TS-equivalent `length : EvalValue`
representation deferred.

### 3f69d633 — Trait-constructor field expected_type (§5c)

`evaluate_module_value` blanked out `ctx.expected_type` before
evaluating each impl-field's value, breaking anonymous lambdas in
`impl(T, Trait(method : (self) -> body))`. The trait-constructor path
now looks up the trait (`_try_lookup_trait_type`) and sets
`ctx.expected_type` from the matching field's type.

### a4a83611 — Anonymous function default Func when no expected_type (§5d)

`evaluate_anonymous_function_implementation` used to throw on `.None`
expected_type; now synthesizes a default `Func` TypeValue with fresh
`SomeT` params and return so the body can typecheck against a
polymorphic shape.

### 46668ef3, b48ec4d8 — Soft-fallback chain (§5e)

Non-Func callee in `try_to_call_function_with_arguments` returns
placeholder result; missing identifier (operator-trait names like
`==`, `<`) returns `UnknownVal(unit)`; `cond` accepts unit-typed
conditions; array-length checks soft-fall-back to `usize(0)`;
numeric-bounds check silently drops out-of-range results.

### 65f3b99a — comptime_string → str coercion at default-value sites

`evaluate_function_parameter` now coerces `comptime_string` literals to
`str` at default-value sites, mirroring TS behaviour for shapes like
`assert :: (fn(flag : bool, (msg : str) ?= "Assertion failed.") -> unit)`.

### 0a5f806c, aaa57d7c, 440489ca, 05024179, a13585d5 — `evaluate_expression_raw` propagation

Switched ~10 eval sites (Fn-trait return, default-value expr,
array/record/enum/field/comptime_list type-eval sub-calls,
`_get_expr_type`, `_eval_and_update_env`, trait constraint eval,
begin-body / return / escape) from the panic-wrapper
`evaluate_expression` to the throw-propagating
`evaluate_expression_raw`. Fixes a class of "fake SIGSEGV" crashes
where the panic wrapper corrupted memory before a downstream throw
could unwind.

### d78e5e14 — `SomeT.kindFunctionType` field added (§5a, partial)

Added `kind_function_type : Option(Box(Self))` as the 10th field of
`SomeT`. Wired through all ~104 SomeT constructor / pattern sites.
**Not yet read** by `evaluate_function_parameter` or TypeApplication —
that's the remaining §A work above.

### 8bf8a1ad — `-(IntLit)` prefold (§5f)

`evaluate_function_call` checks at entry: when callee is the atom `-`
and the single arg is an `Integer` token, produce `IntLit("-${raw}")`
with `ComptimeInt` directly. Unblocks prelude's
`FutureState.Completed = -(1)` discriminant. (Replace with real
operator-trait dispatch when §H is done.)

### f14d5bfa — Stack-overflow diagnosis + workaround docs (§5g, §I)

lldb backtrace at "iter 924" pinpointed `__yo_dispose_dispatch`
prologue crashing with `sp` past an unmapped page — stack overflow,
not a memory bug. `ulimit -s 65520` documented in `yo-self/README.md`
and `issues/fixed/yo-self-evaluator-stack-overflow.md`.

### efec44dc — UnknownVal-tolerant struct/enum construction (§5h)

Struct and enum-variant construction branches in
`evaluator/calls/function.yo` used to abort comptime construction on
any `UnknownVal` field; TS only aborts on `isRuntimeOnly: true`.
Relaxed to match TS default. Unblocks
`__yo_builtin_io :: Io(async : __yo_io_async, …)` at
`std/prelude.yo:8196`.

### a63ecce0 — `TypeVal(SomeT)` for extern/c_include Type-typed fields (§5i)

Added `create_unknown_val_with_name(ty, name)` in `yo-self/value.yo`:
when `is_type_0(ty)`, return `TypeVal(t_some_t(name, 0))` instead of
`UnknownVal(Type)`. Used by `evaluator/exprs/c_include.yo` and
`extern.yo` so later fields can refer to the label as a real type
(`INT_LEAST8_MIN : int_least8_t` after `int_least8_t : Type`).

### 58d87708 — env-synthesised ModuleVal for transitive imports (§5j)

`evaluator/exprs/import.yo`: when `ctx.load_module` is `.None` (the
flatten-eval path), synthesise a transparent `ModuleVal(names,
values)` from the current env's frames and stamp the import expr with
the matching `ModuleT` type. Both the real-loader path and the new
fallback now type the result via `type_of_eval_value(mod_val)` instead
of a stale `t_unit()`, fixing destructuring `{ X, Y } :: import("…")`.
Proper per-module isolation is §C above.

### a200b773 — capture caller env in top-level FuncVals (§5k)

`try_to_implement_function_by_function_type` was building FuncVals for
top-level `::`-defined functions with empty
`cap_names`/`cap_tys`/`cap_vals`, on the wrong premise that "regular
functions do not capture". Top-level bodies need to resolve OTHER
top-level identifiers at call time, since `evaluate_function_call`'s
FuncVal dispatch builds a `fresh_env` containing only captures +
params with no module-level fallback. Now mirrors the capture loop in
`evaluator/values/anonymous_function.yo`. Unblocks
`Result(?*(T), AllocError)` in trait declarations and any fn whose
body calls another fn.

---

## Path forward

Three concurrent workstreams. Order is not strict — pieces can land
in parallel as their dependencies allow.

### Stream A — Close the open evaluator gaps

The §A–§I work above. Priority order for impact on "yo-self-bin can
compile real tests":

1. **§A HKT `kindFunctionType` wiring** — unblocks Functor / Monad /
   Iterator chains.
2. **§B Trait-checking Phase-3 stubs** — needed for blanket-impl and
   Iterator-style code.
3. **§C Per-module sub-evaluation** — needed for non-trivial
   multi-file projects and module privacy.
4. **§H Operator-trait ModuleT/Call dispatch** — removes the
   literal-arg prefold hack and enables full operator overloading.
5. **§D RC-derivation** — improves codegen fidelity; not blocking
   semantics.
6. **§E GADT** — only `gadts.test.yo`.
7. **§F Closure ownership** — only matters for ownership-heavy tests.
8. **§G Build / asm / assignment stubs** — niche.

§I (stack overflow) has a one-line workaround and can be revisited
any time.

### Stream B — Complete the partial codegen handlers + port the 4 missing

17 of the 37 TS codegen-expr handlers are partial-ported (only their
pure helpers / non-metadata-dependent code paths). Completing them to
full ports — and porting the 4 remaining ❌ (`atom`, `async`,
`await`, `generation`) — is Stream B's scope.

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
   dispatch, in `match`-with-fallback form.
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
`tests/algebraic_effects.test.yo` (61 tests), and any other tests
using `async` / `await` / handlers stay on the "blocked" list.

This stream is **mostly orthogonal** to Streams A and B — it can be
worked on independently once the codegen API stabilizes.

---

## Running the bootstrap

```bash
# Build the TS-built yo-cli (always before yo-self commands).
bun run build

# Build the self-hosted compiler.
./yo-cli compile yo-self/main.yo --release -o yo-self/yo-self-bin

# Run the yo-self test suites (unit / per-handler tests).
./yo-cli test ./yo-self/tests --parallel 0

# Run yo-self-bin against a real source file (requires raised stack — see §I).
ulimit -s 65520
./yo-self/yo-self-bin check tests/basic.test.yo

# Run integration tests against the self-hosted compiler (blocked on
# codegen completeness — see Stream B).
./yo-self/yo-self-bin test tests/basic.test.yo --disable-sanitize --parallel 1
./yo-self/yo-self-bin test tests/ --disable-sanitize --parallel 0
```

## Operating principles

1. **Strict 1-to-1.** Each TS file in `src/` has a same-named Yo file
   in `yo-self/`. Each TS exported function has a same-named Yo
   function. Bootstrap-only divergences (proto-evaluator, monolithic
   `exprs.yo`, etc.) are retired piecewise.
2. **No silent fallback.** A ported handler that lacks the metadata it
   needs returns `Option(String).None`, never an "approximate" answer
   that produces incorrect C. The dispatcher decides whether to fall
   back to a bootstrap heuristic or panic.
3. **One handler, one test file.** Each `yo-self/codegen/exprs/<name>.yo`
   has a matching `yo-self/tests/codegen_exprs_<name>.test.yo` that
   exercises every branch of the TS handler.
4. **Eliminate proto- and bootstrap-only files as their replacements
   land.** The proto-evaluator `eval.yo`, the monolithic
   `codegen/exprs.yo`, the registries in `evaluator/types/`, and
   bootstrap heuristics get deleted as their proper replacements prove
   out — no parallel-implementation drift.

---

## Related issue files

- [`yo-self-evaluator-stack-overflow.md`](../issues/fixed/yo-self-evaluator-stack-overflow.md)
  — `ulimit` workaround + lldb backtrace.
- [`yo-self-impl-fn-parametric-return-sigsegv.md`](../issues/fixed/yo-self-impl-fn-parametric-return-sigsegv.md)
  — original "iter 924 SIGSEGV" diagnosis; misdiagnosis chain
  resolved.
- [`yo-self-where-clause-trait-eval-segfault.md`](../issues/fixed/yo-self-where-clause-trait-eval-segfault.md)
  — one specific where-clause crash (fixed shape).
- [`yo-self-nested-typeapp-in-impl-return-segfault.md`](../issues/fixed/yo-self-nested-typeapp-in-impl-return-segfault.md)
  — nested TypeApplication crash class.
- [`yo-self-evaluator-enum-memory-leak.md`](../issues/fixed/yo-self-evaluator-enum-memory-leak.md)
  — RC leak observed in evaluator.
- (The historical codegen-side issue files — typeid-needs-typed-ast,
  parallelism-needs-closure-metadata, bin-rebuild-segfaults — were deleted
  2026-06-11: they described the since-deleted untyped bootstrap codegen.
  Superseded by `plans/BOOTSTRAPPING_CODEGEN.md`.)
