# Unify `Module` and `Struct` Types

## Motivation

Yo currently has two record-shaped types:

- **Legacy `Module`** — structural, comptime-only. Historically produced by
  `import "..."` and the `module(...)` type expression. This surface syntax is
  now removed; imports are source-namespace structs.
- **`Struct`** — nominal, available at both comptime and runtime. Produced by
  `struct(...)`, `object(...)`, `newtype(...)` and carries a `TraitType` for
  methods.

Two record types add accidental complexity:

1. Field access, type checking, codegen, doc generation, and the bootstrap
   `yo-self` evaluator all carry parallel branches for `ModuleType` and
   `StructType`.
2. `given`/`using` is currently restricted to comptime because its evidence
   carrier (a module value) cannot exist at runtime. The compiler already
   lowers effect dispatch via _evidence passing_ at runtime — the comptime
   restriction is an artificial limitation imposed by the type, not by the
   lowering strategy.
3. Modules cannot participate in trait-based generic code (no `trait` field),
   so reusable utilities cannot abstract over module-shaped values.

Unifying both into a single nominal `Struct` type that can be either comptime
or runtime (per-field, like today's struct) removes a whole class of
asymmetries and unblocks **runtime `given`/`using`**, which is the primary
forcing function for this change.

## Design Decisions (confirmed)

| Decision                            | Choice                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity model                      | **Fully nominal**, Zig-style. Every `struct(...)` literal produces a fresh type id. Effect record types must be named (e.g. `Raise := struct(raise: ctl(...))`) and matched by identity.                                                                                                                                                                                                                                                                                                                                                                 |
| Comptime/runtime stance of `import` | **`import` requires a comptime struct.** Structs themselves are not "comptime by default" — they are whatever their fields make them, exactly like today. The rule is _on `import`_: the result of `import "..."` must be a comptime-known struct value. A file whose top-level shape would contain runtime-only fields is not importable (compile-time error). Field-level classification (`fn`, `type`, generics, constants → comptime; nested runtime-capable structs containing runtime values → runtime) is unchanged from today's struct behavior. |
| `module(...)` surface syntax        | **Removed.** A one-time migration pass rewrites `module(...)` → `struct(...)` across `std/`, `tests/`, `yo-self/`, docs, and bootstrap fixtures.                                                                                                                                                                                                                                                                                                                                                                                                         |
| `given`/`using` semantics           | Become **runtime constructs**: `using(e : E)` is a hidden runtime parameter; effect records are runtime struct values; resolution is still compile-time but the value passed is a runtime evidence pointer/struct.                                                                                                                                                                                                                                                                                                                                       |

## Feasibility Analysis

### Why it is feasible

- **Codegen already handles structs as runtime records.** No new C emission
  scheme is required; we reuse `generateStructDeclaration` and friends.
- **Effect dispatch already uses evidence passing at the C level.** The
  `effectFieldPath: string[]` mechanism in
  `src/evaluator/effects/effect-analysis-types.ts` walks a module shape that
  is structurally identical to a struct. Lowering does not need to change
  shape, only the _type_ it walks.
- **Modules have a strict subset of struct features**: fields with labels and
  values, no methods, no generics-on-the-record-type. Every `Module` use case
  is expressible as a `Struct` with all-comptime fields and no trait methods
  (or with trait methods in the new world — that becomes a feature gain, not
  a regression).
- **Imports can keep their current semantics.** The constraint we enforce is
  on `import`: the imported file must produce a comptime-known struct.
  This matches today's restriction that modules are comptime-only, just
  expressed as a check on the import operation rather than a property baked
  into the type system.

### Risks and how we mitigate them

| Risk                                                                                                                                                                                                                 | Mitigation                                                                                                                                                                                                          |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Loss of structural compatibility for effect record types.** Today `Raise = module(raise: ctl(...))` written in two places is one type. With nominal identity, two `struct(raise: ctl(...))` literals are distinct. | All effect types in `std/` and tests must be **named once** and **imported** at use sites. Add a migration step + a clear evaluator error message when an unnamed `struct(...)` is used in a `using(...)` position. |
| **Runtime layout for `using`/`given`** must be defined for evidence carriers (continuations, captured envs).                                                                                                         | Reuse the existing `ctl` lowering. The struct simply becomes the runtime carrier of these already-runtime function pointers/closures. No new ABI needed.                                                            |
| **Comptime-only fields inside an otherwise runtime struct.** Imports contain `fn`, `type`, generics — none of which have a runtime layout.                                                                           | Per-field classification already exists for structs. Comptime-only fields are skipped during C struct emission (they live in the type's metadata, not in the C layout). Codify this in `generateStructDeclaration`. |
| **Bootstrap (`yo-self`) duplicates the type system.** Any change here must be mirrored.                                                                                                                              | `yo-self` is in Phase 1; ModuleType is already minimally implemented. Land the unification in TS first, ship & test, then port.                                                                                     |
| **Two record types are referenced from ~100 call sites** across evaluator, codegen, LSP, doc generator.                                                                                                              | Phased rollout (see below). Keep `ModuleType` as a deprecated internal alias of `StructType` during phase 1 so each site can be migrated incrementally.                                                             |
| **Effect-handler analysis assumes `effectFieldPath`** rooted in a module.                                                                                                                                            | Rename internally to "effect path" rooted in a struct. Behavior is unchanged.                                                                                                                                       |
| **`using` and `given` were comptime-resolved.** Making them runtime changes function signatures (extra hidden arg) and changes ABI.                                                                                  | Hidden parameters are already used for closures and effect handlers under the hood. Add an explicit "evidence parameter" signature transform in the call-site lowering.                                             |

### Out of scope (explicitly)

- Adding methods/traits to module-shaped types in std (a follow-up enabled
  by this change, not part of it).
- Changing the import resolution algorithm.
- First-class runtime modules (loading `.yo` files at runtime).
- Reworking the parser for `struct {}` block syntax — keep `struct(...)`.

## Implementation Phases

Each phase is independently shippable and leaves the test suite green.

### Phase 0 — Inventory & test scaffolding

- Add a `tests/module_struct_unification.test.yo` baseline that exercises:
  - `import "..."` field access
  - `module(...)` literal (will be migrated later)
  - `given`/`using` of a comptime effect record
  - Trait-method-bearing struct as effect record (currently impossible — add as `comptime_expect_error` to flip later)
- Run `./yo-cli test --bail` and record current pass/fail state.

### Phase 1 — Unify the type representation (no surface changes)

- In `src/types/definitions.ts`: extend `StructType` with optional fields needed
  by the module use-case:
  - `isStructuralLegacy?: boolean` — temporary, set on values created from
    `module(...)` or `import` until phase 4 removes structural compat.
  - Allow `trait?: TraitType | undefined` (already optional in spirit for
    record-only structs).
- In `src/types/creators.ts`: implement `createStructType` so it can be called
  with the module shape (no trait, no reference semantics).
- Mark `ModuleType` as `@deprecated`. Make it a structural alias:
  ```ts
  export type ModuleType = StructType & { tag: TypeTag.Struct };
  export const isModuleType = (t: Type): t is StructType =>
    t.tag === TypeTag.Struct && t.isStructuralLegacy === true;
  ```
- Update `TypeTag` so `Module` is removed (or aliased to `Struct`). Keep one
  pass of TS errors and fix call sites mechanically — they all funnel through
  `isModuleType` / `isStructType`.
- Codegen: in `generateStructDeclaration`, skip fields explicitly marked
  compile-time-only by field syntax (`name :: value` or
  `comptime(name) : Type`). Add a unit test.

**Status: DONE.** Runtime C layouts now ignore explicit comptime-only struct
fields consistently across:

- struct/object declaration emission,
- object constructor signatures and field initialization,
- regular struct/object constructor call lowering,
- compile-time value lowering, and
- recursive type collection.

The evaluator now stores `TypeField.isCompileTimeOnly` so codegen can make this
layout decision from syntax instead of unstable trait availability. This
preserves the existing rule that an ordinary field typed as `comptime_int` is a
comptime-only data field, while a static/method-like `::` field has no runtime
layout. Regression coverage lives in
`tests/module_struct_unification.test.yo`.

Verification: `bun run build`, `bun run lint`, `git diff --check`,
`tests/module_struct_unification.test.yo`, `tests/basic.test.yo` type
auto-derive tests, and `tests/algebraic_effects.test.yo` pass with
`--disable-sanitize`.

**Exit criteria:** all existing tests pass; no surface-language change.

### Phase 2 — Migrate `import` to produce a `Struct`

- `src/evaluator/values/anonymous-module.ts`: produce a `StructType` (with
  `isStructuralLegacy = true` for now) instead of a `ModuleType`.
- `src/evaluator/exprs/import.ts`: same. Add an explicit check after the
  imported file is evaluated: the resulting struct must be comptime-known
  (every field's type implements `Comptime`). Emit a clear error otherwise:
  _"`import` requires a comptime struct; field `x` has runtime type `T`."_
- `src/evaluator/exprs/property-access.ts`: collapse the `isModuleType` and
  `isStructType` branches for field access into one path. Keep two helpers
  only if their behavior genuinely differs (it should not after this phase).
- Update LSP and doc generator (`src/doc/`) to walk the unified shape.

**Exit criteria:** `./yo-cli test --bail` green; `./yo-cli doc ./std` green.

### Phase 3 — Migrate `module(...)` syntax to `struct(...)`

**Status: DONE for production `std/` and `tests/`.** `yo-self` keeps a
compatibility `module(...)` path for now (see Phase 5), and build-system
APIs such as `build.module()` are project-module APIs rather than the old
`ModuleType` surface syntax.

What's done (committed `7a2e31b4`, `f13dee48`, `9c5b14a6`):

- `src/evaluator/calls/helper.ts`: Added `EffectRecordValue =
StructValue` plus `isEffectRecordValue` /
  `isEffectRecordType` helpers. All effect-dispatch checks
  (`hasControlFunctionImplicitParams`, ctl-field discovery,
  given-resolution path walking) now accept both module and struct
  records.
- `src/codegen/exprs/other-fn-call.ts`: Evidence parameter lookup
  handles `StructValue` evidence records.
- `src/evaluator/exprs/initialization-assignment.ts`: typeName
  tracking for given bindings recognizes `StructValue`.
- `src/evaluator/calls/type.ts` (commit `9c5b14a6`): Propagate
  `ioBuiltin` markers from extern function types to struct field
  types. **This resolves the original "forall on struct field"
  blocker** — see `issues/fixed/forall-loses-freshness-on-struct-field-call.md`
  for details. Root cause was actually `ioBuiltin` propagation (not
  forall freshness); without the marker Io builtin calls fall back
  to generic specialization that can't infer T from arg types alone.
- `tests/algebraic_effects.test.yo`: 2 new tests prove `struct(...)`
  works for both escape and resume effect handlers (60 / 60 pass).

The earlier async/Future codegen blocker was resolved in Phase 4c by emitting
a generic `FutureTraitType` C interface plus concrete future effect setters.
`std/prelude.yo` now defines `Io :: struct(...)`, and `std/error.yo` defines
`Exception` / `ResumableException` as struct effect records.

Tracked todos: `p3-forall-struct-field` — DONE (resolved by `9c5b14a6`);
`p3-yo-files-migrate` — DONE for production `std/`, `tests/`, and docs.

**Exit criteria:** no old `module(...)` effect-record examples remain in
`std/`, `tests/`, or `docs/`; `yo-self` compatibility is tracked separately.

### Phase 4 — Make `given`/`using` runtime

This is the payoff phase. It is itself broken into sub-steps because it
touches the call-site lowering.

**Status: Phase 4 DONE (4a + 4b + 4c end-to-end).**

#### Phase 4a — Pin current behavior, identify the precise gap (DONE)

Existing evaluator/codegen already supports `given`/`using` with struct
effect records, including:

- `given(t) : Tag = Tag(...)` inside an `if` branch.
- `given(c) : Counter = Counter(...)` inside a `while` loop, re-bound per
  iteration.

In all cases the struct's field values (functions, etc.) are
comptime-known, so the `using` parameter is **fully specialized away** —
the C signature for `step :: (fn(using(c : Counter)) -> i32)` is emitted
as `int32_t step()` and the field call inlined as a direct call to the
field's C function.

Tests pinning this baseline live in
`tests/module_struct_unification.test.yo` (Phase 4a tests).

#### Phase 4b — Runtime evidence parameter lowering (DONE)

The runtime case

```rust
make_counter :: (fn(use_a : bool) -> Counter)(...);
(given(c) : Counter) = make_counter(true);
step();   // step :: (fn(using(c : Counter)) -> i32)
```

now compiles to:

```c
__yo_struct_..._Counter c = make_counter(true);
int32_t v = step(c.next);   // evidence passed via runtime field access
```

Implemented across 6 commits on `unify-module-and-struct`:

- `435cb7a9` — `getEvidenceParameters` / `collectEvidenceFromModule`
  walk struct types in addition to module types.
- `b8106074` — `assignment.ts` stores `UnknownValue` for runtime
  `given(struct)` bindings instead of `undefined`.
- `4d14b26b` — end-to-end runtime path:
  - `evaluator/exprs/binding.ts`: don't force `isCompileTimeOnly` for
    struct-typed `given` bindings (module ones stay comptime).
  - `evaluator/calls/helper.ts`: relax the given-variable filter to
    accept runtime struct bindings; synthesize an `UnknownValue` when
    the given binding lacks a comptime value.
  - `codegen/exprs/binding.ts`: emit a real C variable declaration for
    runtime struct given bindings.
  - `codegen/exprs/assignment.ts`: emit a real C assignment by peeling
    `given()` to the inner variable.
  - `codegen/exprs/other-fn-call.ts`: new resolution branch emits
    `${cName}.${fieldPath}` as the C evidence argument when the given
    variable carries no comptime Module/Function value.

Specialization notes: function specialization is unaffected because
the evidence is now passed as runtime C parameters; only one
non-specialized variant is emitted per `using(struct)` callee.

Verification: full test suite **2434/2434 passing** (commit `4d14b26b`).
New regression test
`Phase 4b: given(struct) bound to runtime function-returned value`
in `tests/module_struct_unification.test.yo`.

#### Phase 4c — Drop `isStructuralLegacy`, finalize semantics

Once 4b lands and is green:

- All effect records must be named nominal types. Drop the
  `isStructuralLegacy` escape hatch in `helper.ts`.
- Add an evaluator error pointing users at named-struct migration when
  they try to pass an anonymous module-typed value to `using(...)`.

**Status: DONE.** Phase 4c migrated standard effect records to nominal
struct types and removed the FutureTraitType blocker:

- `Io :: struct(...)` in `std/prelude.yo`.
- `Exception :: struct(...)` and `ResumableException(...) -> comptime(Type)`
  in `std/error.yo`.
- FutureTraitType now has a generic C interface layout and concrete futures
  carry a `__yo_set_effect_fn` setter so generic `Impl(Future(...))`
  consumers can inject effect evidence without knowing the concrete capture
  struct layout.
- Evaluator/codegen effect-record paths accept struct evidence in effect-row
  resolution, `StructValue` evidence extraction, async await/spawn injection,
  and forall-return handler prechecking.

Verification: `bun run build`, `tests/module_struct_unification.test.yo`,
`tests/async_await.test.yo`, `tests/algebraic_effects.test.yo`, and
`yo-self/tests/install_command.test.yo` pass with `--disable-sanitize`.
The full `./yo-cli test --bail --disable-sanitize` run reached 487 passing
tests before several long-running yo-self files hit the isolated runner's
1800s timeout; no Phase 4c compile/runtime assertion failure remained in the
log.

**Exit criteria (full Phase 4):**

- `make_counter`-style runtime evidence test passes (see
  `tmp/p4_returned.yo` for the failing case).
- New tests in `tests/algebraic_effects.test.yo` exercising
  `given`/`using` with effect records constructed by non-comptime
  functions.
- `./yo-cli test --bail` green on native + WASM (with existing `--target
wasm-wasi` and `--cc emcc` runs).

### Phase 5 — Bootstrap (`yo-self`) port — assessed follow-up, non-gating

`yo-self` is still WIP and is **not** a gating criterion for this rollout.

- Mirror the unification in `yo-self/types/`, `yo-self/evaluator/types/`
  on a best-effort basis so the bootstrap stays roughly in sync.
- Remove `Module` from the `yo-self` `TypeTag` enum if reachable.
- Update `plans/archive/BOOTSTRAPPING.md` to note the simplified type system.
- `./yo-cli test ./yo-self/tests/` is informational only — known failures
  there do not block landing the change.

**Status: ASSESSED, non-gating follow-up.** The self-hosted compiler still has
a distinct `TypeValue.ModuleT`/`TypeTag.TModule` variant and broad `ModuleVal`
test coverage. A targeted audit for `SelfModule`, `ModuleVal`, `ModuleT`,
`TModule`, `ModuleType`, and related helpers shows this is a large bootstrap
port rather than a safe cleanup: hits span `yo-self/types/`, evaluator call/type
helpers, effect analysis, and many evaluator regression splits. The production
TypeScript compiler no longer depends on these bootstrap-only representations.

The Phase 1/4 runtime semantics have still been mirrored where they are
low-risk:

- `yo-self/evaluator/types/struct.yo` now feeds only explicit runtime fields
  into struct auto-derive checks, while the `TypeValue.Struct` still records
  all fields and `TypeField.is_comptime` remains the source of truth.
- `yo-self/codegen/types.yo` skips fields marked `is_comptime` in the
  registered `TypeField` metadata when emitting C struct declarations.
- `yo-self/evaluator/effects/effect_analysis.yo` accepts struct-typed effect
  records in effect rows and transitive-effect detection instead of requiring
  module evidence.
- Added self-hosted regressions in `yo-self/tests/codegen.test.yo` and
  `yo-self/tests/effect_analysis.test.yo`.

Verification from the partial bootstrap mirror: `bun run build`,
`yo-self/tests/codegen.test.yo`,
`yo-self/tests/effect_analysis.test.yo`,
`yo-self/tests/types_compound.test.yo`, and
`yo-self/tests/types_guards.test.yo` pass with `--disable-sanitize`.

### Phase 6 — Documentation & cleanup

- Update `.github/instructions/yo-design.instructions.md` and
  `.github/skills/yo-core-patterns/core-patterns-cheatsheet.md`:
  remove all references to `Module` as a distinct type.
- Update `docs/en-US/` and `docs/zh-CN/` chapters that mention `module(...)`.
- Update `plans/ALGEBRAIC_EFFECTS.md` to describe the runtime evidence model.
- Delete or archive `module.ts` evaluator/codegen leftovers.
- Final `git grep -i "ModuleType\|moduleType\|module("` audit, excluding
  real source/build-module APIs.

**Status: COMPLETE for the production compiler.** User-facing docs and
instructions now describe struct-based effect records and runtime evidence
passing. Source cleanup has also moved evaluator/codegen terminology away from
"module" for generic record/impl/effect handling:

- `docs/en-US/ALGEBRAIC_EFFECTS.md` and `docs/zh-CN/ALGEBRAIC_EFFECTS.md`
  use `struct(...)` effect records, explain nominal struct evidence, and
  replace module-effect terminology.
- `docs/en-US/ASYNC_AWAIT.md` and `docs/zh-CN/ASYNC_AWAIT.md` show
  `Io :: struct(...)`.
- `docs/*/TYPE_REFLECTION.md` and `docs/*/DESIGN.md` no longer document a
  distinct `Module`/`is_module()` type reflection variant.
- `.github/instructions/c-codegen.instructions.md` describes struct-record
  evidence.
- `.github/skills/yo-async-effects/async-effects-recipes.md` now uses
  struct-record effect examples and terminology.
- Internal evaluator helpers now use record-oriented names
  (`evaluateRecordField`, `evaluateImplBlock`) while preserving compatibility
  for the remaining source-module implementation. The old `module(...)`
  `evaluateRecordType` dispatch and `SelfModule`/`SelfRecordType` plumbing have
  been deleted.
- The evaluator helper files have been renamed from `types/module.ts` and
  `calls/module-type.ts` to `types/record.ts` and `calls/record-type.ts`; the
  internal call-result discriminant is now `record-type`.
- `TypeTag.Module` has been removed from the TypeScript compiler.
- Import/source-module namespaces are represented by `StructValue` with
  optional namespace-only metadata. This preserves the import-only state that
  made a naive replacement unsafe: partial fields during loading, `isLoading`
  for circular imports, and `moduleLevelInitExprs` for module-level `:=`
  codegen.
- `ValueTag.Module`/`ValueTag.SourceModule`, `ModuleValue`, and the interim
  `SourceModuleValue` have been removed. `StructValue` now represents both
  ordinary struct values and source-module namespace values.
- `module`, `Module`, and `SelfModule` have been removed from
  `src/expr.ts`, VS Code TextMate highlighting, Vim highlighting, and the
  evaluator's bare-identifier fallback. `TypeInfo.Module`/`is_module()` is also
  removed; source-module namespaces reflect as `TypeInfo.Struct(...)`.
- `tests/algebraic_effects.test.yo` now labels the migrated effect-record
  regressions as struct-record tests instead of module-effect tests.
- `tests/module_struct_unification.test.yo` includes a Phase 6 regression that
  asserts both `module(...)` and bare `Module` are compile-time errors.
- Internal compatibility names have been removed from `src/**/*.ts`:
  `ModuleType`, `isModuleType`, `createModuleType`, `ModuleField`,
  `moduleType`, `ConcreteModuleType`, `futureModuleType`, Fn-module variable
  names, and `isModuleEffectMember` are gone. The remaining `module(...)`
  matches in `src/` are build-system/source-module APIs such as
  `build.module()` and `dep.module()`, not the removed type syntax.

## Files Most Affected (per phase)

| Phase | Hot files                                                                                                                                     |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | `src/types/definitions.ts`, `src/types/creators.ts`, `src/codegen/types/generation.ts`                                                        |
| 2     | `src/evaluator/exprs/import.ts`, `src/evaluator/values/anonymous-module.ts`, `src/evaluator/exprs/property-access.ts`, `src/doc/extractor.ts` |
| 3     | `src/evaluator/types/module.ts` (delete), `src/evaluator/calls/module-type.ts` (delete), `std/**/*.yo`, `tests/**/*.yo`                       |
| 4     | `src/evaluator/calls/helper.ts`, `src/evaluator/effects/*.ts`, `src/codegen/effects/*.ts`, `src/evaluator/exprs/binding.ts`                   |
| 5     | `yo-self/types/`, `yo-self/evaluator/types/`, `yo-self/tests/`                                                                                |
| 6     | `docs/`, `.github/instructions/`, `.github/skills/`, `plans/ALGEBRAIC_EFFECTS.md`                                                             |

## Open Questions

1. **Naming the structural-legacy flag** — `isStructuralLegacy` is intentionally
   ugly so we delete it in Phase 4. If we discover a real long-term need for
   structural records (e.g. row-typed effects), revisit before phase 4.
2. **Hashing/equality of nominal effect types across re-imports.** Confirm
   that `import` caching gives a single `StructType` identity per file,
   otherwise the same effect type imported twice would compare unequal.
   (Believed already true via `src/cache.ts` + import memoization — verify.)
3. **WASM ABI for the extra evidence parameter** — needs a quick check that
   the Emscripten and WASI codepaths agree on parameter passing for the new
   hidden args.

## Inventory Snapshot (Phase 0)

Recorded at the start of work, to track migration progress:

| Surface                                     | Count    |
| ------------------------------------------- | -------- |
| `src/**` files referencing `ModuleType`     | 19       |
| `src/**` files referencing `isModuleType`   | 31       |
| `src/**` files referencing `TypeTag.Module` | 6        |
| `src/**` files referencing `ModuleField`    | 10       |
| `.yo` files using `module(...)` syntax      | 23 total |
| └─ `docs/en-US`                             | 5        |
| └─ `docs/zh-CN`                             | 5        |
| └─ `tests`                                  | 3        |
| └─ `std`                                    | 3        |
| └─ `yo-self/**` (best-effort, non-gating)   | 7        |

Baseline test file: `tests/module_struct_unification.test.yo` (2 tests
passing on pre-change compiler).

## Success Criteria

- `TypeTag.Module` is gone from `src/types/tags.ts`.
- `ValueTag.Module`/`ValueTag.SourceModule` and separate module value types are
  gone; imported source namespaces use `StructValue`.
- `module`, `Module`, and `SelfModule` no longer appear in compiler/highlighter
  keyword tables or evaluator identifier fallback.
- No `.yo` file under `std/`, `tests/`, `docs/` uses `module(...)`.
  (`yo-self/` is best-effort; remaining references there do not block.)
- A test demonstrates `given`/`using` working with a runtime-constructed
  evidence value (impossible today).
- `./yo-cli test --bail` green on native, `--cc emcc`, and `--target
wasm-wasi`.
- `./yo-cli doc ./std` produces docs identical-or-better to baseline.
- `./yo-cli test ./yo-self/tests/` is run for visibility only; failures
  there do not block landing.
