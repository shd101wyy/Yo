import { getVariablesFromEnv } from "../../env";
import { extractFutureTraitFromType } from "../../evaluator/trait-checking";
import type { AtomExpr, Expr } from "../../expr";
import { isFunctionType, isUnitType } from "../../types/guards";
import { isUnknownValue } from "../../value";
import type { FunctionGenerationContext } from "../functions/context";
import {
  type CodeGenContext,
  getDeferredDropTargetAtomName,
  getTypeString,
  getVariableNameForCodegen,
  sanitizeForCIdentifier,
} from "../utils";
import { emitAsyncFutureCompletion } from "./async-completion";
import { checkVariableIsClosureCaptured } from "./closures";
import { generateComptimeValue } from "./comptime-value";
import { generateExpr } from "./expr";

function emitLoopBodyDropsBeforeExit(
  functionContext: FunctionGenerationContext,
  indent: string,
  context: CodeGenContext,
  expr?: Expr
): void {
  if (
    functionContext.pendingDeferredDrops &&
    functionContext.loopBodyDropsBaselineCount !== undefined
  ) {
    const baselineCount = functionContext.loopBodyDropsBaselineCount;
    const totalCount = functionContext.pendingDeferredDrops.length;
    const dropsToEmit = functionContext.pendingDeferredDrops.slice(
      0,
      totalCount - baselineCount
    );
    const exitToken = expr?.token;
    const exitEnv = expr?.$?.env;
    for (const dropExpr of dropsToEmit) {
      // Skip drops for variables not yet in scope at the break/continue point.
      //
      // When the exit expression's env is available, use it for precise
      // liveness checking (same approach as generatePendingDeferredDrops for
      // return). A variable not found in the exit env hasn't been declared
      // yet, so its C declaration comes after this exit point.
      //
      // This correctly handles the pattern:
      //   while ..., {
      //     x := match(..., .None => { break; }, .Some(v) => v);
      //     use(x);  // x is declared *after* the match switch in C
      //   }
      // At the break point, `x` is not yet in scope (the match is still
      // being evaluated), so we must not emit a drop for it.
      if (exitEnv) {
        const varName = getDeferredDropTargetAtomName(dropExpr);
        if (varName) {
          const variables = getVariablesFromEnv(exitEnv, varName);
          if (variables.length === 0) continue; // not in scope at exit
          const latestVar = variables[variables.length - 1]!;
          if (!latestVar.initializedAtToken) continue; // declared but not yet initialized in C
        }
      } else if (exitToken && exitToken.modulePath) {
        // Fallback: position-based filter when no env info is available.
        // The enclosing begin block populates pendingDeferredDrops up-front,
        // but C declarations are emitted statement-by-statement. Comparing
        // the variable's initializedAtToken position against the exit token
        // tells us (roughly) whether the C declaration has been emitted.
        //
        // NOTE: don't use `consumedAtToken` — the deferred drop synthesis
        // itself marks variables as consumed when generating ___drop()
        // expressions. The consumed token is a sentinel, not a reliable
        // liveness signal.
        const varName = getDeferredDropTargetAtomName(dropExpr);
        const dropEnv = dropExpr.$?.env;
        if (varName && dropEnv) {
          const variables = getVariablesFromEnv(dropEnv, varName);
          if (variables.length > 0) {
            const latestVar = variables[variables.length - 1]!;
            const initTok = latestVar.initializedAtToken;
            if (!initTok) continue;
            if (
              initTok.modulePath === exitToken.modulePath &&
              initTok.position.character > exitToken.position.character
            ) {
              continue;
            }
          }
        }
      }
      const dropCode = generateExpr(dropExpr, indent, context);
      if (dropCode) {
        context.emitter.emitLine(`${indent}${dropCode};`);
      }
    }
  }
}

/**
 * Generate C code for an atom expression - extracted from original codegen-c.ts
 */
export function generateAtom(
  expr: AtomExpr,
  context: CodeGenContext,
  indent: string = ""
): string {
  const functionContext = context as FunctionGenerationContext;

  // Handle control flow atoms first (before checking unit type or other values)
  // These need to return the keyword string even though they have unit type

  // Handle control flow atoms first (before checking computed values or variable names)
  if (expr.token.value === "continue") {
    // If we're inside a regular generated loop, use regular continue behavior.
    // This must take precedence over async pseudo-loop handling.
    if (functionContext.currentContinueLabel) {
      emitLoopBodyDropsBeforeExit(functionContext, indent, context, expr);
      return `goto ${functionContext.currentContinueLabel}`;
    }
    if (functionContext.currentLoopLabel) {
      emitLoopBodyDropsBeforeExit(functionContext, indent, context, expr);
      return "continue";
    }

    // In state machine while loop body, continue must jump to the loop label via goto
    // (plain "continue" doesn't work inside a switch or goto-based loop)
    if (functionContext.smWhileContinueInfo) {
      if (functionContext.smWhileContinueInfo.emitDropsBeforeGoto) {
        if (
          functionContext.smWhileBodyDrops &&
          functionContext.smWhileBodyDrops.length > 0
        ) {
          const emitter = context.emitter;
          for (const dropExpr of functionContext.smWhileBodyDrops) {
            const dropCode = generateExpr(dropExpr, indent, context);
            if (dropCode && dropCode.includes("sm->")) {
              emitter.emitLine(`${indent}${dropCode};`);
            }
          }
        }
      }
      if (functionContext.smWhileContinueInfo.stepExpr) {
        const emitter = context.emitter;
        const stepCode = generateExpr(
          functionContext.smWhileContinueInfo.stepExpr,
          indent,
          context
        );
        if (stepCode) {
          emitter.emitLine(`${indent}${stepCode};`);
        }
      }
      return `goto ${functionContext.smWhileContinueInfo.label}`;
    }
    return "continue";
  }

  if (expr.token.value === "break") {
    // If we're inside a regular generated loop, use regular break behavior.
    // This must take precedence over async pseudo-loop handling.
    if (functionContext.currentLoopLabel) {
      emitLoopBodyDropsBeforeExit(functionContext, indent, context, expr);
      if (functionContext.insideMatch) {
        return `goto ${functionContext.currentLoopLabel}`;
      }
      return "break";
    }

    // In state machine while loop body, break must emit body drops + goto the after-loop label
    // (plain "break" only exits a C switch, not the state machine's goto-based loop)
    if (functionContext.smWhileBreakInfo) {
      const { label, activeIndex } = functionContext.smWhileBreakInfo;
      if (
        functionContext.smWhileBodyDrops &&
        functionContext.smWhileBodyDrops.length > 0
      ) {
        const emitter = context.emitter;
        for (const dropExpr of functionContext.smWhileBodyDrops) {
          const dropCode = generateExpr(dropExpr, indent, context);
          if (dropCode && dropCode.includes("sm->")) {
            emitter.emitLine(`${indent}${dropCode};`);
          }
        }
      }
      if (activeIndex !== undefined) {
        // Emit the active flag reset as a side effect, then return a simple goto.
        // This ensures cond.ts and other callers that check for control flow via
        // startsWith("goto") can properly detect and emit this break.
        const emitter = context.emitter;
        emitter.emitLine(
          `${indent}sm->while_loop_${activeIndex}_active = false;`
        );
        return `goto ${label}`;
      }
      return `goto ${label}`;
    }
    return "break";
  }

  if (expr.token.value === "return") {
    if (functionContext.inAsyncStateMachine) {
      const emitter = context.emitter;
      const futureType = functionContext.inAsyncStateMachine.futureType;
      const futureTraitType = extractFutureTraitFromType(futureType)!;
      const childType = futureTraitType.isFuture.outputType;
      const isUnitResult = isUnitType(childType);

      // Generate deferred drops, but only those that resolve to state machine fields
      if (expr.$?.deferredDropExpressions) {
        for (const dropExpr of expr.$.deferredDropExpressions) {
          const dropCode = generateExpr(dropExpr, indent, context);
          if (dropCode && dropCode.includes("sm->")) {
            emitter.emitLine(`${indent}${dropCode};`);
          }
        }
      }

      // Generate pending deferred drops from enclosing scopes (only state machine fields)
      if (
        functionContext.pendingDeferredDrops &&
        functionContext.pendingDeferredDrops.length > 0
      ) {
        emitter.emitLine(
          `${indent}// Drop local variables before early completion`
        );
        for (const dropExpr of functionContext.pendingDeferredDrops) {
          const dropCode = generateExpr(dropExpr, indent, context);
          if (dropCode && dropCode.includes("sm->")) {
            emitter.emitLine(`${indent}${dropCode};`);
          }
        }
      }

      emitter.emitLine(`${indent}// Early return - complete the result Future`);

      const resultCode = !isUnitResult
        ? `(${getTypeString(childType, context)}){0}`
        : undefined;

      emitAsyncFutureCompletion({
        emitter,
        indent,
        resultCode,
        debugLabel: context.currentFunctionName,
      });
      return ``;
    }
    return "return";
  }

  // For unit-typed expressions (excluding control flow which was handled above), return empty string
  if (expr.$?.type && isUnitType(expr.$.type)) {
    return "";
  }

  // Check if we're in a closure function and this variable is captured
  // Type assertion to access function-specific context

  // Check if we're in a state machine and this is a captured variable
  if (
    (functionContext.inAsyncStateMachine ||
      functionContext.inEffectStateMachine) &&
    functionContext.stateMachineVariables
  ) {
    const varName = expr.token.value;

    // Check if this variable is locally shadowed (e.g., in match destructuring)
    // If so, use the local C variable instead of the state machine field
    if (functionContext.localShadowedVariables?.has(varName)) {
      return sanitizeForCIdentifier(varName);
    }

    // Check if this variable is in the state machine
    // IMPORTANT: Look up by variable ID from environment, not by name!
    // This handles variable shadowing correctly - shadowed variables have the same name but different IDs
    let foundInStateMachine = false;
    /**
     * The env DID resolve this name, and that variable's ID is NOT a
     * state-machine field. It is a segment-local: defined and consumed without
     * crossing a state boundary, so the SM optimizer deliberately left it out
     * of the struct and its definition emitted a plain C local. The by-name
     * fallback below must not then hand back some OTHER same-named variable's
     * field — two locals called `sub` in different branches get distinct IDs
     * (`…_sub`, `…_sub_1`) but share the name, and redirecting one to the
     * other's field reads a value that path never wrote. See
     * issues/fixed/async-sibling-arm-same-named-locals.md.
     */
    let idResolvedButNotInStateMachine = false;
    if (expr.$?.env) {
      const variables = getVariablesFromEnv(expr.$.env, varName);
      if (variables.length > 0) {
        const variable = variables[variables.length - 1]!; // Most recent scope
        let varId = variable.isOwningTheSameRcValueAs
          ? variable.isOwningTheSameRcValueAs.id
          : variable.id;

        // Resolve SSA-renamed variable IDs to their original/canonical IDs.
        // When a variable is reassigned in a loop, the evaluator creates a new SSA ID
        // (e.g., "offset" -> "offset_1"), but both must map to the same struct field.
        if (functionContext.variableIdRemapping?.has(varId)) {
          varId = functionContext.variableIdRemapping.get(varId)!;
        }

        // Check if this variable ID is in the state machine
        const capturedVar = functionContext.stateMachineVariables.get(varId);
        if (capturedVar) {
          // Phase 1b: Check if this variable is aliased to an await_future_N field
          const aliasedField =
            functionContext.stateMachineFieldAliases?.get(varId);
          if (aliasedField) {
            foundInStateMachine = true;
            return `sm->${aliasedField}`;
          }
          // Closure-param coordination: when the env binds varName to a
          // local SM var without an alias, but another SM var with the same
          // name DOES have an alias (i.e., a synthetic __closure_param_<i>
          // slot for the same bundle), prefer the aliased entry. The
          // aliased slot is where set_effect writes the bundle; the
          // unaliased var_<id> would stay zero-initialized.
          // See [[yo-anon-closure-param-name-extraction]].
          if (functionContext.stateMachineFieldAliases) {
            for (const [
              otherVarId,
              otherVar,
            ] of functionContext.stateMachineVariables) {
              if (otherVarId === varId) continue;
              if (otherVar.name !== varName) continue;
              const otherAlias =
                functionContext.stateMachineFieldAliases.get(otherVarId);
              if (otherAlias) {
                foundInStateMachine = true;
                return `sm->${otherAlias}`;
              }
            }
          }
          // This is a state machine variable - access it through sm->
          // Use kind to determine field name:
          // - "outer": Use __capture.varName (sm->__capture.varName)
          // - "local": Use var_{varId} (sm->var_{varId})
          const fieldName =
            capturedVar.kind === "outer"
              ? `__capture.${varName}`
              : `var_${capturedVar.id}`;
          foundInStateMachine = true;
          return `sm->${fieldName}`;
        }
        idResolvedButNotInStateMachine = true;
      }
    }

    // Fallback: if we don't have env info or didn't find it by ID, search by name
    // This handles captured variables from outer scopes (capture struct) where we might not have env
    // Prefer entries that have an alias (e.g., closure-param __yo_param_<i>
    // slots) when multiple entries share the same name — the synthetic slot
    // is where set_effect writes the bundle, so the body must read from it.
    if (!foundInStateMachine) {
      let nameMatchFallback:
        | [
            string,
            import("../../evaluator/async/await-analysis-types").CapturedVariable,
          ]
        | undefined;
      for (const [
        varId,
        capturedVar,
      ] of functionContext.stateMachineVariables) {
        if (
          capturedVar.name === varName &&
          functionContext.stateMachineFieldAliases?.has(varId)
        ) {
          const aliasedField =
            functionContext.stateMachineFieldAliases.get(varId)!;
          return `sm->${aliasedField}`;
        }
        if (
          capturedVar.name === varName &&
          !nameMatchFallback &&
          !idResolvedButNotInStateMachine
        ) {
          nameMatchFallback = [varId, capturedVar];
        }
      }
      if (nameMatchFallback) {
        const [varId, capturedVar] = nameMatchFallback;
        const fieldName =
          capturedVar.kind === "outer"
            ? `__capture.${varName}`
            : `var_${varId}`;
        foundInStateMachine = true;
        return `sm->${fieldName}`;
      }
      for (const [
        varId,
        capturedVar,
      ] of functionContext.stateMachineVariables) {
        if (capturedVar.name === varName) {
          // Phase 1b: Check alias before generating field name
          const aliasedField =
            functionContext.stateMachineFieldAliases?.get(varId);
          if (aliasedField) {
            foundInStateMachine = true;
            return `sm->${aliasedField}`;
          }
          if (idResolvedButNotInStateMachine) {
            // A segment-local of this SM that merely shares a name — see above.
            continue;
          }
          const fieldName =
            capturedVar.kind === "outer"
              ? `__capture.${varName}`
              : `var_${varId}`;
          foundInStateMachine = true;
          return `sm->${fieldName}`;
        }
      }
    }

    // Variable not found directly - check if it's borrowing from a captured variable
    // This handles the case where we reference `future1` but only `temp_2198` (its owner) is captured
    if (expr.$?.env) {
      const variables = getVariablesFromEnv(expr.$.env, varName);
      if (variables.length > 0) {
        const variable = variables[variables.length - 1]!;
        if (variable.isOwningTheSameRcValueAs) {
          // This variable is borrowing - try to find the owner in state machine
          const ownerName = variable.isOwningTheSameRcValueAs.name;
          const ownerId = variable.isOwningTheSameRcValueAs.id;

          for (const [
            varId,
            capturedVar,
          ] of functionContext.stateMachineVariables) {
            if (capturedVar.name === ownerName || varId === ownerId) {
              const fieldName =
                capturedVar.kind === "outer"
                  ? `__capture.${ownerName}`
                  : `var_${varId}`;
              return `sm->${fieldName}`;
            }
          }
        }
      }
    }

    // Variable not in stateMachineVariables - check if it's a closure-captured variable.
    // For closure+effect SM, captured variables are accessed through closure_context, not SM struct.
    if (
      functionContext.currentClosureCaptures &&
      functionContext.currentClosureCaptures.includes(varName) &&
      functionContext.currentClosureCaptureFrameLevel !== undefined
    ) {
      const captureTypeCName = functionContext.currentClosureCaptureTypeCName;
      if (captureTypeCName) {
        return `((${captureTypeCName}*)closure_context)->${getVariableNameForCodegen(varName, expr.$?.env)}`;
      }
      return `closure_context->${getVariableNameForCodegen(varName, expr.$?.env)}`;
    }

    // It's a local C variable in the resume function.
    // But first check if it's a compile-time only constant - if so, inline its value
    // (compile-time constants like STATX_BASIC_STATS are not captured in the state machine,
    // but their names may not exist as C identifiers on all platforms)
    if (expr.$?.variableName) {
      if (expr.$?.env && expr.$?.value && !isUnknownValue(expr.$.value)) {
        const variables = getVariablesFromEnv(expr.$.env, expr.$.variableName);
        if (
          variables.length > 0 &&
          variables[variables.length - 1]!.isCompileTimeOnly
        ) {
          return generateComptimeValue(expr.$.value, context, expr);
        }
      }
      const name = getVariableNameForCodegen(expr.$.variableName, expr.$.env);
      // inout(name) : T parameter — at the C level, name is T*; reads
      // become (*name). See plans/MEMORY_SAFETY.md Phase B.
      if (expr.$?.env) {
        const vars = getVariablesFromEnv(expr.$.env, expr.$.variableName);
        if (vars.length > 0 && vars[vars.length - 1]!.isRef) {
          return `(*${name})`;
        }
      }
      return name;
    }
  }

  // If this atom has a temp variable name (e.g., for Rc values), use that instead of regenerating code
  // This prevents regenerating constructor calls for temp variables that should just use their variable names
  // BUT: if this is a captured variable in a closure, we should use closure access instead
  // ALSO: if this is a compile-time only variable with a value, inline it instead
  if (expr.$?.variableName) {
    // Check if this is a compile-time only variable - if so, inline the value
    if (expr.$?.env && expr.$?.value && !isUnknownValue(expr.$.value)) {
      const variables = getVariablesFromEnv(expr.$.env, expr.$.variableName);
      if (
        variables.length > 0 &&
        variables[variables.length - 1]!.isCompileTimeOnly
      ) {
        return generateComptimeValue(expr.$.value, context, expr);
      }
    }

    // Check if this is a captured variable in a closure - if so, don't use temp variable name
    if (
      functionContext.currentClosureCaptures &&
      functionContext.currentClosureCaptures.includes(expr.token.value) &&
      expr.$?.env &&
      functionContext.currentClosureCaptureFrameLevel !== undefined &&
      checkVariableIsClosureCaptured(
        expr.token.value,
        expr.$.env,
        functionContext.currentClosureCaptureFrameLevel
      )
    ) {
      // Don't return early - let it fall through to closure capture logic
    } else {
      // Otherwise check if this variable has a parameterAlias in the environment
      const name = getVariableNameForCodegen(expr.$.variableName, expr.$?.env);
      if (expr.$?.env) {
        const vars = getVariablesFromEnv(expr.$.env, expr.$.variableName);
        if (vars.length > 0 && vars[vars.length - 1]!.isRef) {
          return `(*${name})`;
        }
      }
      return name;
    }
  }

  // Check if this atom has a compile-time value
  // This is only reached for closure-captured variables (non-closure variables return early above)
  // For closure-captured variables, we should NOT inline their values - we access them via closure context
  // So this code path should never actually inline a value for variables
  if (expr.$?.value) {
    if (isUnknownValue(expr.$.value)) {
      // For unknown values (like mutually recursive function references), we should NOT inline
      // Instead, fall through to use the variable name from the token
      // This handles cases like is_even referencing is_odd before is_odd is defined
    } else {
      // Only inline if this is NOT a variable (e.g., it's a literal constant without a variable name)
      // But all variables should have been handled above, so this is just for safety
      return generateComptimeValue(expr.$.value, context, expr);
    }
  }

  const isClosureCaptured =
    expr.$?.env && functionContext.currentClosureCaptureFrameLevel !== undefined
      ? checkVariableIsClosureCaptured(
          expr.token.value,
          expr.$.env,
          functionContext.currentClosureCaptureFrameLevel
        )
      : false;

  if (
    functionContext.currentClosureCaptures &&
    functionContext.currentClosureCaptures.includes(expr.token.value) &&
    functionContext.currentClosureCaptureFrameLevel !== undefined &&
    (expr.$?.env ? isClosureCaptured : true) // If no env info, trust currentClosureCaptures
  ) {
    // We're accessing a captured variable in a closure function
    // The closure_context parameter is a void* that points directly to the capture struct
    // Need to cast it to the appropriate capture struct type

    const captureTypeCName = functionContext.currentClosureCaptureTypeCName;
    if (captureTypeCName) {
      // Cast void* closure_context directly to the capture struct pointer
      return `((${captureTypeCName}*)closure_context)->${getVariableNameForCodegen(expr.token.value, expr.$?.env)}`;
    }
    // Fallback to old approach if we can't determine the type (should not happen)
    return `closure_context->${getVariableNameForCodegen(expr.token.value, expr.$?.env)}`;
  }

  // Fallback: Check if this is a closure function by looking at the current function name and finding its type
  if (
    functionContext.currentFunctionName &&
    !functionContext.currentClosureCaptures
  ) {
    // Find the function value being generated
    const currentFunctionEntry = Object.values(functionContext.functions).find(
      (entry) => entry.cName === functionContext.currentFunctionName
    );

    if (currentFunctionEntry && currentFunctionEntry.value.type.isClosure) {
      // This is a closure function, find its closure type
      const closureTypeEntry = Object.values(functionContext.types).find(
        (t) =>
          isFunctionType(t.type) &&
          t.type.isClosure &&
          t.type === currentFunctionEntry.value.type
      );

      if (closureTypeEntry) {
        // Note: captureType is no longer on ClosureType, use naming convention
        const captureStructName = `${closureTypeEntry.cName}_capture`;
        return `((${captureStructName}*)closure_context->data)->${getVariableNameForCodegen(expr.token.value, expr.$?.env)}`;
      }
    }
  }

  // Check if this variable has a parameterAlias (used in anonymous functions
  // where the actual parameter name differs from the expected interface parameter name)
  const varNameToUse = getVariableNameForCodegen(expr.token.value, expr.$?.env);
  // inout(name) : T parameter — at the C level, name is T*; reads
  // become (*name) and writes become (*name) = v. See
  // plans/MEMORY_SAFETY.md Phase B.
  if (expr.$?.env) {
    const vars = getVariablesFromEnv(expr.$.env, expr.token.value);
    if (vars.length > 0 && vars[vars.length - 1]!.isRef) {
      return `(*${varNameToUse})`;
    }
  }
  return varNameToUse;
}
