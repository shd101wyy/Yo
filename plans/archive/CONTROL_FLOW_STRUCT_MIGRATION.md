# Migration: `controlFlow` from String to Struct
> **ARCHIVED 2026-09-04 — TS-ERA MIGRATION DOC.** The TypeScript compiler is
> retired (tag src-attic-final); the structured control-flow info ships as
> ControlFlowKind in src/expr_info.yo.


## Goal

Replace the current `controlFlow?: ControlFlowKind` (a string union `"return" | "break" | "continue" | "escape"`) with a structured object:

```typescript
controlFlow?: {
  return?: boolean;
  escape?: boolean;
  break?: boolean;
  continue?: boolean;
};
```

This explicitly records **all** control flows an expression carries. Currently the string enum can only represent one at a time, which leads to fragile priority logic (e.g., "return takes priority over escape") and loses information about mixed control flows.

## Type Change

### Before (`src/expr.ts`)

```typescript
export type ControlFlowKind = "return" | "break" | "continue" | "escape";

// On EvaluatedExprData:
controlFlow?: ControlFlowKind;
```

### After

```typescript
export type ControlFlowFlags = {
  return?: boolean;
  escape?: boolean;
  break?: boolean;
  continue?: boolean;
};

// On EvaluatedExprData:
controlFlow?: ControlFlowFlags;
```

Truthy check `if (expr.$.controlFlow)` still works since `{}` is truthy, but we must ensure we only set `controlFlow` when at least one flag is true.

### Helper Functions

Add to `src/expr.ts`:

```typescript
/** Create a ControlFlowFlags with a single flag set */
export function controlFlowOf(
  kind: "return" | "escape" | "break" | "continue"
): ControlFlowFlags {
  return { [kind]: true };
}

/** Check if controlFlow has a specific flag */
export function hasControlFlow(
  cf: ControlFlowFlags | undefined,
  kind: "return" | "escape" | "break" | "continue"
): boolean {
  return cf?.[kind] === true;
}

/** Check if controlFlow has any flag set */
export function hasAnyControlFlow(cf: ControlFlowFlags | undefined): boolean {
  return (
    cf !== undefined &&
    (cf.return === true ||
      cf.escape === true ||
      cf.break === true ||
      cf.continue === true)
  );
}

/** Merge multiple ControlFlowFlags into one (union of all flags) */
export function mergeControlFlows(flows: ControlFlowFlags[]): ControlFlowFlags {
  const result: ControlFlowFlags = {};
  for (const cf of flows) {
    if (cf.return) result.return = true;
    if (cf.escape) result.escape = true;
    if (cf.break) result.break = true;
    if (cf.continue) result.continue = true;
  }
  return result;
}

/** Convert ControlFlowFlags to a display string for error messages */
export function controlFlowToString(cf: ControlFlowFlags): string {
  const parts: string[] = [];
  if (cf.return) parts.push("return");
  if (cf.escape) parts.push("escape");
  if (cf.break) parts.push("break");
  if (cf.continue) parts.push("continue");
  return parts.join("+");
}
```

## Migration Order

### Phase 1: `cond.ts`

**File:** `src/evaluator/exprs/cond.ts`

This file has the most complex controlFlow logic.

#### Changes

1. **Import**: Replace `type ControlFlowKind` with `type ControlFlowFlags, controlFlowOf, hasControlFlow, hasAnyControlFlow, mergeControlFlows, controlFlowToString`.

2. **Collecting controlFlows**: Change `controlFlows: ControlFlowKind[]` → `controlFlows: ControlFlowFlags[]`.

3. **Pushing controlFlows**: `controlFlows.push(evaluatedCaseBodyExpr.$.controlFlow)` stays the same (already a `ControlFlowFlags`).

4. **Checking specific flow**: `evaluatedCaseBodyExpr.$.controlFlow === "return"` → `hasControlFlow(evaluatedCaseBodyExpr.$.controlFlow, "return")`.

5. **Truthiness checks**: `if (evaluatedCaseBodyExpr.$?.controlFlow)` → `if (hasAnyControlFlow(evaluatedCaseBodyExpr.$?.controlFlow))`.

6. **Negation checks**: `if (!evaluatedCaseBodyExpr.$.controlFlow)` → `if (!hasAnyControlFlow(evaluatedCaseBodyExpr.$.controlFlow))`.

7. **Determining finalControlFlow**: Replace the `.every()` and `.find()` pattern with `mergeControlFlows(controlFlows)`. The merged result directly gives us the union of all flags.

   **Before:**

   ```typescript
   let finalControlFlow: ControlFlowKind | undefined = undefined;
   if (controlFlows.every((cf) => cf === "return")) {
     finalControlFlow = "return";
   } else if (...) { ... }
   ```

   **After:**

   ```typescript
   const finalControlFlow: ControlFlowFlags | undefined =
     controlFlows.length > 0 ? mergeControlFlows(controlFlows) : undefined;
   ```

   The merged flags naturally capture all combinations — no more priority logic needed at this stage.

8. **Setting controlFlow on result**: `controlFlow: "return"` → `controlFlow: controlFlowOf("return")`.

9. **Filtering non-exit bodies**: `body.$.controlFlow !== "return" && body.$.controlFlow !== "escape"` → `!hasControlFlow(body.$.controlFlow, "return") && !hasControlFlow(body.$.controlFlow, "escape")`.

10. **Compile-time true path (line ~214)**: Same pattern — propagate controlFlow directly from the branch.

11. **Final result classification**: After merging, check the flags:
    ```typescript
    if (hasAnyControlFlow(finalControlFlow)) {
      if (hasControlFlow(finalControlFlow, "return")) {
        // At least some branches return → set return type, etc.
      } else if (
        hasControlFlow(finalControlFlow, "escape") &&
        !hasControlFlow(finalControlFlow, "break") &&
        !hasControlFlow(finalControlFlow, "continue")
      ) {
        // Pure escape
      } else if (hasControlFlow(finalControlFlow, "break")) {
        // ...
      } else if (hasControlFlow(finalControlFlow, "continue")) {
        // ...
      }
    }
    ```
    Key insight: With the struct, `return` priority over `escape` is expressed by checking `return` first. The merged flags tell us exactly what's present.

### Phase 2: `match.ts`

**File:** `src/evaluator/exprs/match.ts`

Same patterns as `cond.ts`, repeated in 3 functions:

- `evaluateMatch` (enum match)
- `evaluatePrimitiveMatch` (integer/bool match)
- The third section for guard patterns

Apply the same transformation as Phase 1 to each of these three sections.

### Phase 3: `while.ts`

**File:** `src/evaluator/exprs/while.ts`

#### Changes

1. **Truthiness check**: `if (evaluatedBodyExpr.$.controlFlow)` → `if (hasAnyControlFlow(evaluatedBodyExpr.$.controlFlow))`.

2. **Specific checks**: `evaluatedBodyExpr.$.controlFlow === "return"` → `hasControlFlow(evaluatedBodyExpr.$.controlFlow, "return")`.

3. **Propagation**: `controlFlow: evaluatedBodyExpr.$.controlFlow` → stays the same (propagating the struct).

4. **Clear break/continue**: After the while loop, strip `break` and `continue` from the propagated controlFlow since they don't escape the loop:
   ```typescript
   // Only propagate return/escape out of the while loop
   const propagated: ControlFlowFlags = {};
   if (hasControlFlow(bodyControlFlow, "return")) propagated.return = true;
   if (hasControlFlow(bodyControlFlow, "escape")) propagated.escape = true;
   // break and continue are consumed by the while loop
   ```

### Phase 4: Remaining Files

#### `src/evaluator/exprs/begin.ts`

- **Line ~585, 680**: `controlFlow: "return"` → `controlFlow: controlFlowOf("return")`
- **Line ~721**: `controlFlow: "break"` → `controlFlow: controlFlowOf("break")`
- **Line ~761**: `controlFlow: "continue"` → `controlFlow: controlFlowOf("continue")`
- **Line ~846**: `controlFlow: "escape"` → `controlFlow: controlFlowOf("escape")`
- **Line ~1245**: `controlFlow: lastExpr.$.controlFlow` → stays the same (propagation)
- **Truthiness checks** (~210, 219, 866): Use `hasAnyControlFlow()`
- **Equality checks** (~882): `lastExpr.$.controlFlow === "return"` → `hasControlFlow(lastExpr.$.controlFlow, "return")`

#### `src/evaluator/exprs/escape.ts`

- **Line ~91**: `controlFlow: "escape"` → `controlFlow: controlFlowOf("escape")`

#### `src/evaluator/exprs/assignment.ts`

- **Import**: Replace `ControlFlowKind` with `ControlFlowFlags`
- **Function signature**: `controlFlow: ControlFlowKind` → `controlFlow: ControlFlowFlags`
- **Error message**: `"${controlFlow}"` → `"${controlFlowToString(controlFlow)}"`
- **Truthiness check** (~252): `if (rhs.$?.controlFlow)` → `if (hasAnyControlFlow(rhs.$?.controlFlow))`

#### `src/evaluator/exprs/initialization-assignment.ts`

- **Truthiness check** (~139): `if (rhs.$?.controlFlow)` → `if (hasAnyControlFlow(rhs.$?.controlFlow))`

#### `src/evaluator/calls/function-type.ts`

- **Line ~89**: `trialBody.$?.controlFlow === "escape"` →
  Check if the body's control flow is purely escape (no return):
  `hasControlFlow(trialBody.$?.controlFlow, "escape") && !hasControlFlow(trialBody.$?.controlFlow, "return")`

#### `src/codegen/exprs/generation.ts`

- **Line ~642**: `!expr.$?.controlFlow` → `!hasAnyControlFlow(expr.$?.controlFlow)`

#### `src/codegen/exprs/begin.ts`

- **Lines ~27, 49, 129**: `!expr.$?.controlFlow` → `!hasAnyControlFlow(expr.$?.controlFlow)`
- **Line ~129**: `expr.$?.controlFlow` → `hasAnyControlFlow(expr.$?.controlFlow)`

#### `src/codegen/functions/generation.ts`

- **Lines ~986, 995**: `lastExpr.$?.controlFlow` / `prevExpr?.$?.controlFlow` → `hasAnyControlFlow(...)` for truthiness checks.

#### `src/codegen/async/state-code-gen.ts`

- **Lines ~512, 543, 667, 704**: These check generated C code strings ("break", "continue", "return"), NOT the `controlFlow` property. They compare against `argCode`, not `$.controlFlow`. **No changes needed** for these lines.

## Testing Strategy

After each phase, run:

```bash
bun run build
bun test src/tests/fixme.test.ts --timeout 10000
```

After all phases:

```bash
bun run build
./yo-cli test ./tests/algebraic_effects.test.yo --bail
./yo-cli test ./tests/async_await.test.yo --bail
./yo-cli test ./tests/fn.test.yo --bail
./yo-cli test ./tests/basic.test.yo --bail
./yo-cli test ./tests/closure.test.yo --bail
./yo-cli test ./tests/while.test.yo --bail
./yo-cli test ./tests/match.test.yo --bail
./yo-cli test ./tests/comptime.test.yo --bail
```

## Key Semantic Change

With the old string enum, a cond/match with mixed `return` + `escape` branches had to pick one. The convention was: `return` wins over `escape`. The struct approach eliminates this: the merged result is `{ return: true, escape: true }` and consumers decide what matters.

The `while` loop must clear `break` and `continue` from the propagated controlFlow, since those are consumed by the loop itself. Only `return` and `escape` escape past the while boundary.
