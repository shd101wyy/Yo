# Unified Evidence Passing — Eliminate SM-Inlining for Effects

## Goal

Unify all effect handler code generation to use **evidence passing** (fn ptr params). Eliminate the state machine (SM-inlining) strategy for algebraic effects entirely. SM infrastructure remains for async/await only.

## Current State

Two strategies exist for effect handler codegen:

1. **Evidence Passing** — module-based effects (e.g., `Exception`, `Raise :: module(...)`) pass fn ptrs as extra C params. No SM needed.
2. **SM-Inlining** — bare function effects (e.g., `using(raise : fn(msg : String) -> i32)`) compile the effectful function into a state machine struct with resume function. Handler body is inlined at the call site in a loop.

The SM path exists because bare function effects trigger **per-call-site specialization** in the evaluator — each call site with a different `given` handler creates a different specialized function. Specialization and evidence passing are mutually exclusive: evidence passing needs ONE unspecialized function with fn ptr params.

## Key Insight

A bare function effect `using(raise : fn(msg : String) -> i32)` is semantically identical to a module with one field: `module(raise : fn(msg : String) -> i32)`. There is no reason to differentiate them at the codegen level. Both should pass fn ptrs as C parameters.

## Plan

### Phase 1: Extend evidence passing to bare function effects

#### 1a. `getEvidenceParameters()` — handle bare `FunctionType` implicits

**File**: `src/codegen/functions/declarations.ts` (~L205-225)

Currently only processes `ModuleType` implicit params. Add a branch for `FunctionType`:

```typescript
for (const implicit of allImplicits) {
  if (isModuleType(implicit.type)) {
    collectEvidenceFromModule(implicit.label, implicit.type, [], result);
  } else if (isFunctionType(implicit.type)) {
    // Bare function effect → treat as single-field evidence
    result.push({
      implicitLabel: implicit.label,
      fieldLabel: implicit.label,
      fieldPath: [implicit.label],
      fieldFunctionType: implicit.type,
      cParamName: sanitizeForCIdentifier(`${implicit.label}`),
    });
  }
}
```

#### 1b. Stop specializing implicit-params-only functions

**File**: `src/evaluator/calls/helper.ts` (~L2165)

Change `isFunctionTypeGeneric(functionType)` to `isFunctionTypeHardGeneric(functionType)` in the specialization gate. This prevents the evaluator from creating per-call-site specializations for functions that are generic ONLY because of `using(...)` params. The `isFunctionTypeHardGeneric` function already exists and explicitly excludes implicit-params-only generics.

**Risk**: Functions with BOTH forall/comptime params AND implicit params still need specialization — `isFunctionTypeHardGeneric` returns `true` for those, so they'll still be specialized. But we need their evidence params to also be passed. Need to verify this works correctly.

**Alternative approach**: Instead of changing the specialization gate, add a check: if the ONLY generic parameters are implicit params, skip specialization. This is more surgical:

```typescript
const isGenericOnlyBecauseOfImplicits =
  isFunctionTypeGeneric(functionType) && !isFunctionTypeHardGeneric(functionType);

if (!skipSpecialization && !isGenericOnlyBecauseOfImplicits && ...) {
  specializedFunctionValue = createSpecializedFunctionInline({...});
}
```

#### 1c. Evidence param call interception for bare fns

**File**: `src/codegen/exprs/other-fn-call.ts` (~L577-600)

Already partially implemented — there's a check for bare fn evidence params that intercepts `raise("error")` calls and routes them through `generateEvidenceFnPtrCall`. Verify this works when specialization is disabled.

#### 1d. Evidence argument resolution for bare fns at call sites

**File**: `src/codegen/exprs/other-fn-call.ts`, `resolveEvidenceArgsForCallSite` (~L2167-2310)

Need to handle bare fn evidence params in the resolution logic. For each evidence param:

1. **Transitive forwarding**: if caller has matching evidence param, forward it
2. **From given binding**: look up the `given` variable by name, use its C function name
3. **From handler info**: use the handler's C function name from effect analysis

### Phase 2: Remove SM-inlining code for effects

#### 2a. Remove SM registration in `preRegisterEffectfulFunctions`

**File**: `src/codegen/functions/generation.ts` (~L459-710)

After Phase 1, `getEvidenceParameters()` returns params for ALL effects (module + bare fn). The `continue` early exit will skip SM registration for everything. The remaining SM registration code (directFunctions, transitiveFunctions, second pass, registerEffectfulFunction) becomes dead code for effects. Remove it.

Keep only: the evidence params check + `ensureEvidenceHandlersCollected`.

#### 2b. Remove SM call site dispatch in `other-fn-call.ts`

**File**: `src/codegen/exprs/other-fn-call.ts` (~L620-710)

The `effectSmInfo` check and `generateEffectCallSite` / `generateMultiEffectCallSite` call site code becomes dead for effects. Remove the effect SM dispatch path.

#### 2c. Remove `generateDirectCtlCall`

**File**: `src/codegen/exprs/other-fn-call.ts` (~L1923-2075)

With evidence passing, direct ctl calls go through fn ptr params instead of handler body inlining. Remove `generateDirectCtlCall`.

#### 2d. Remove or pare down `effect-state-machine.ts`

**File**: `src/codegen/effects/effect-state-machine.ts` (1721 lines)

This entire file is effect-SM-specific. If no effects use SM anymore, the following exports become dead:

- `generateEffectStateMachineStruct`
- `generateEffectResumeFunctionDeclaration`
- `generateEffectResumeFunction`
- `generateEffectCallSite`
- `generateMultiEffectCallSite`
- `EffectCallSiteHandler`
- `EffectStateMachineInfo` (possibly still used by async — check)
- `handlerBodyContainsExplicitReturn`

Check if async/await uses any of these. If not, delete the entire file.

#### 2e. Clean up imports

Remove dead imports from:

- `src/codegen/functions/generation.ts`
- `src/codegen/functions/context.ts`
- `src/codegen/exprs/other-fn-call.ts`
- `src/codegen/exprs/async.ts`
- `src/codegen/exprs/return.ts`

### Phase 3: Update documentation

- Update `docs/ALGEBRAIC_EFFECTS.md` — remove "Two Strategies" section, document unified evidence passing
- Update this plan as completed

## Test Strategy

- After Phase 1: All 46 AE tests must pass (bare fn effects now use evidence passing)
- After Phase 2: All 46 AE tests must still pass (dead code removed)
- Run FS tests (44/44) to verify async/await not broken
- Run encoding tests after resuming migration

## Files Modified

| File                                          | Change                                               |
| --------------------------------------------- | ---------------------------------------------------- |
| `src/codegen/functions/declarations.ts`       | Extend `getEvidenceParameters` for bare fn           |
| `src/evaluator/calls/helper.ts`               | Skip specialization for implicit-only generics       |
| `src/codegen/exprs/other-fn-call.ts`          | Evidence resolution for bare fns, remove SM dispatch |
| `src/codegen/functions/generation.ts`         | Remove SM registration code                          |
| `src/codegen/effects/effect-state-machine.ts` | Delete or reduce                                     |
| `src/codegen/functions/context.ts`            | Clean up imports                                     |
| `src/codegen/exprs/async.ts`                  | Clean up imports                                     |
| `src/codegen/exprs/return.ts`                 | Clean up imports                                     |
| `docs/ALGEBRAIC_EFFECTS.md`                   | Update to single strategy                            |

## Risk Assessment

- **Medium**: Changing specialization gate may affect non-effect implicit params (e.g., `using(io : IO)`). IO doesn't trigger specialization already (it's UnknownValue at call time), so this should be safe. Verify with FS tests.
- **Medium**: Transitive effect propagation (function calls another effectful function) — evidence params must be forwarded correctly through the call chain. Already works for module effects; need to verify for bare fn effects.
- **Low**: Closure effects — closures capture the fn ptr evidence param. Already works for module effects.

---

## Implementation Attempt #1 — Findings (Session 2025-01)

### What Was Implemented & Verified

All 4 Phase 1 changes were applied and individually verified in generated C:

1. **`getEvidenceParameters()` extension** (declarations.ts): Works. Creates `EvidenceParameter` with `implicitLabel=fieldLabel=implicit.label` for bare `FunctionType` implicits.

2. **Specialization skip** (helper.ts): Works. `isGenericOnlyBecauseOfImplicits` correctly identifies functions that are generic only due to `using(...)` params. `specializedFunctionCaches` stays empty, `specializedType` stays undefined.

3. **Generation filter fix** (generation.ts): Required TWO fixes:

   - In `preRegisterEffectfulFunctions`: adding `evidenceParams.length > 0` → `continue` correctly skips SM registration.
   - In generation loop: `hasUnresolvedFunctionImplicitParams` guard must include `getEvidenceParameters(value.specializedType ?? value.type).length === 0` — otherwise bare fn evidence functions are wrongly skipped as "unresolved".

4. **Evidence fn ptr call interception** (other-fn-call.ts): **CRITICAL DISCOVERY** — the check must be placed **BEFORE** the `isFunctionValue(functionValue)` block, NOT inside it. Reason: inside the function body, the implicit param `raise` evaluates to `UnknownValue` (tag=Unknown, variableName=raise) because the body is annotated at definition time when the implicit param isn't bound yet. `isFunctionValue(UnknownValue)` = false, so any check inside the block is never reached.

5. **Call site evidence resolution** (other-fn-call.ts `resolveEvidenceArgsForCallSite`): Works for resume handlers (FunctionValues found in `context.functions`). Fails for escape handlers (ctl functions not collected as standalone C functions).

### Generated C Code Verified

With all changes applied, the generated C for `safe_divide` was:

```c
int32_t fn_..._safe_divide(int32_t x, int32_t y, int32_t (*raise)(String msg, String msg2)) {
  // ...
  if (y == 0) {
    int32_t _temp = raise(_temp_msg, _temp_msg2);  // ✓ calls through evidence fn ptr
    if (__yo_effect_escaped) {                       // ✓ escape flag check
      drop(_temp_msg); drop(_temp_msg2);
      return (int32_t){0};
    }
  } else {
    return x / y;
  }
}
```

The resume handler call site generated correctly:

```c
int32_t result = fn_..._safe_divide(1, 0, fn_..._raise);  // ✓ evidence arg passed
```

### Blocking Issue: Escape Handlers

Three interconnected problems prevent escape handlers from working with evidence passing:

#### Problem 1: Escape handler not a standalone C function

The escape handler `(msg, msg2) -> { escape i64(42); }` has `isControlFunction=true`. Ctl functions are typically **inlined** at call sites using `generateDirectCtlCall`, not compiled as standalone C functions. Evidence passing needs them as callable fn ptrs → they must be collected and compiled as standalone functions with escape semantics.

**Required**: The escape handler must be compiled as:

```c
int32_t escape_handler(String msg, String msg2) {
  __yo_effect_escaped = true;
  __yo_effect_escape_value = /* encode i64(42) */;
  return (int32_t){0}; // dummy return
}
```

#### Problem 2: No escape propagation in intermediate functions

Functions like `raise_const` that call effectful functions (`safe_divide`) through the normal call path don't add `__yo_effect_escaped` checks after the call. The SM approach handles propagation automatically via the state machine loop. With evidence passing, **every function in the call chain** between the escape handler and the outer scope needs escape flag checks.

`generateEvidenceFnPtrCall` already emits escape checks, but this only covers the innermost call (inside `safe_divide`). The call to `safe_divide` inside `raise_const` goes through the normal function call path.

**Required**: Either:

- Mark functions that transitively call evidence-param functions as "effectful" so their call sites add escape checks
- Or use `setjmp` at the handler installation point so escape can jump directly back

#### Problem 3: Escape value storage & retrieval

When the escape handler fires, it needs to store `i64(42)` somewhere accessible to the outer scope. The function return types differ: handler returns `i32` (dummy), but the outer function (`raise_const`) must return `i64(42)`.

**Options**:

- Thread-local `__yo_effect_escape_value` (like `__yo_effect_escaped`)
- `setjmp`/`longjmp` at handler installation point (Koka-style)
- Stack-allocated struct passed through call chain

### Forward Declaration Issue

`safe_divide` is defined AFTER its first call site in generated C → forward reference error. Need to emit forward declarations for evidence-param functions, or reorder function emission.

### Recommended Approach for Next Attempt

**Option A — setjmp/longjmp (full Koka-style)**:

- At handler installation point (where `given(raise) = handler`), use `setjmp`
- Escape handler uses `longjmp` to jump directly back, skipping all intermediate functions
- Requires escape handler to be a closure (needs access to `jmp_buf`)
- Most correct, but significant new infrastructure

**Option B — Hybrid (incremental)**:

- Keep SM for escape handlers, use evidence passing only for resume handlers
- Problem: `safe_divide` doesn't know at compile time which handler it'll get
- Would require two versions of the function (one SM, one evidence) per call site
- Defeats the purpose of unification

**Option C — Flag propagation (simpler)**:

- Compile escape handlers as standalone functions that set `__yo_effect_escaped`
- Add escape checks after ALL calls to evidence-param functions (not just inside them)
- Store escape value in thread-local `__yo_effect_escape_value`
- Simpler than setjmp but requires escape check insertion at every call site level

**Recommendation**: Option C is the most pragmatic. It extends the existing `__yo_effect_escaped` mechanism and doesn't require `setjmp`/`longjmp`. The main work is:

1. Compile ctl functions as standalone C functions when used as evidence args
2. Add a global `__yo_effect_escape_value` for escape value storage
3. Mark call sites to evidence-param functions as needing escape checks
4. Emit forward declarations for evidence-param functions
