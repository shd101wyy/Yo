# Comptime/Runtime Function Specialization

## Overview

Allow a function name to have **two definitions** in the same scope: one for compile-time arguments and one for runtime arguments. This eliminates the need for naming workarounds like `comptime_unwrap` when a function needs both a comptime and a runtime variant.

This is **not** general function overloading. It is strictly **comptime/runtime specialization** — same name, same parameter types, differing only in `comptime` context.

## Motivation

The `Option` type in `prelude.yo` has an `unwrap` method for runtime `self`. To add a comptime `unwrap` that works on comptime `Option` values, the current workaround is naming it `comptime_unwrap`, which is not ideal. Similarly, `Add` vs `ComptimeAdd` traits exist as separate types solely because of this limitation.

## Design Rules

1. A name may have **at most 2 definitions** in the same scope.
2. Both definitions must have **at least 1 parameter**.
3. Parameters must have the **same types**, differing **only** in `comptime`/runtime context.
4. **At least one parameter** must differ in comptime/runtime context.
5. **Resolution**: Prefer the comptime variant when all differing params are comptime-known; use the runtime variant otherwise.

### Allowed

```yo
// Comptime and runtime variants of the same function
return_self :: (fn(comptime(self) : i32) -> comptime(i32))(self);
return_self :: (fn(self : i32) -> i32)(self);

// Method in impl block
impl(forall(T : Type), Option(T),
  unwrap : (fn(self : Self) -> T)(...),
  unwrap : (fn(comptime(self) : Self) -> comptime(T))(...)
)
```

### Not Allowed

```yo
// No parameters — just a duplicate definition
return_self :: (fn() -> comptime(i32));
return_self :: (fn() -> i32);

// Same parameter context — not a comptime/runtime pair
return_self :: (fn(comptime(self) : i32) -> comptime(i32))(self);
return_self :: (fn(comptime(self) : i32) -> i32)(self);

// Three overloads — max is 2
return_self :: (fn(comptime(self) : i32) -> comptime(i32))(self);
return_self :: (fn(self : i32) -> i32)(self);
return_self :: (fn(self : u32) -> u32)(self);  // ERROR: third overload

// Different number of parameters — not specialization
f :: (fn(self : i32) -> i32)(self);
f :: (fn(comptime(self) : i32, extra : i32) -> i32)(self);
```

## Implementation Status: ✅ Complete

All phases implemented and tested:

### Phase 1: Environment — ✅ Done

- Added `isComptimeRuntimeSpecializationPair()` validation helper in `src/env.ts`
- Modified `addVariableToEnv` and `addVariableToFrame` to allow specialization pairs (max 2)

### Phase 2: Variable lookup — ✅ Done (no changes needed)

- `getVariablesFromEnv` naturally returns both variants

### Phase 3: Function call resolution — ✅ Done

- Added specialization variant detection in `src/evaluator/calls/function.ts`
- Existing comptime priority disambiguation handles selection automatically

### Phase 4: Trait/impl block support — ✅ Done

- Modified trait field duplicate check in `src/evaluator/types/trait.ts` to allow specialization pairs
- Changed all `.find()` → `.filter()` method lookups in `getReceiverMethodsByNameFromEnv`, `checkTrait`, `checkTraitForMethod`, and `getTypeTraitMethodsByNameFromEnv` to return ALL matching methods

### Phase 5: Tests — ✅ Done

- Created `tests/comptime_specialization.test.yo` with 10 passing test cases

### Phase 6: Documentation — ✅ Done

- Updated `.github/instructions/yo-design.instructions.md` with specialization rules

### Phase 7: Module export support — ✅ Done

- Modified `src/evaluator/values/anonymous-module.ts` to export BOTH specialization variants
- Modified `src/evaluator/exprs/property-access.ts` to defer to function.ts for specialization pairs in modules
- Added module field lookup in `src/evaluator/calls/function.ts` for specialization pairs
- Added module specialization pair aliasing in `src/evaluator/exprs/initialization-assignment.ts`

## Key Files Modified

| File                                               | Change                                                                                                                                                     |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/env.ts`                                       | `isComptimeRuntimeSpecializationPair()` helper; allow pairs in `addVariableToEnv`/`addVariableToFrame`; `.find()` → `.filter()` in method lookup functions |
| `src/evaluator/calls/function.ts`                  | Specialization variant detection for normal function calls; module field lookup for specialization pairs                                                   |
| `src/evaluator/types/trait.ts`                     | Allow duplicate trait field labels for specialization pairs                                                                                                |
| `src/evaluator/values/anonymous-module.ts`         | Export both specialization variants from modules                                                                                                           |
| `src/evaluator/exprs/property-access.ts`           | Defer to function.ts for module specialization pairs                                                                                                       |
| `src/evaluator/exprs/initialization-assignment.ts` | Handle aliasing of module specialization pairs                                                                                                             |
| `tests/comptime_specialization.test.yo`            | 10 integration tests                                                                                                                                       |
| `.github/instructions/yo-design.instructions.md`   | Feature documentation                                                                                                                                      |

## Future Work: Migrate Module Call Pattern

After this feature lands, migrate the `(!)`, `(~)`, `(-)` operators in `prelude.yo` from the module `Call :: (tuple)` pattern to direct comptime/runtime specialization. This also requires handling aliasing (`(not) :: (!)`) so that both specialization variants are copied to the alias.

This is a separate follow-up — not part of the initial implementation.

## Design Rationale

- **Not general overloading**: Type-based overloading (different param types) interacts badly with generics, SomeType, and trait resolution. Comptime/runtime specialization is a much simpler, well-scoped feature.
- **Max 2 overloads**: Naturally follows — each parameter is either comptime or runtime, giving exactly 2 possibilities.
- **Compile-time dispatch**: Resolution is trivially determined at compile time by checking if arguments are comptime-known. No runtime cost.
- **Existing infrastructure**: `function.ts` already has comptime priority logic that forms the foundation.
