import { getVariablesFromEnv } from "../../env";
import { AtomExpr } from "../../expr";
import { isFunctionType, isUnitType } from "../../types";
import { isFunctionValue, isUnknownValue } from "../../value";
import { FunctionGenerationContext } from "../functions/context";
import { CodeGenContext, getVariableNameForCodegen } from "../utils";
import { checkVariableIsClosureCaptured } from "./closures";
import { generateComptValue } from "./compt_value";

/**
 * Generate C code for an atom expression - extracted from original codegen-c.ts
 */
export function generateAtom(expr: AtomExpr, context: CodeGenContext): string {
  const functionContext = context as FunctionGenerationContext;

  // Handle control flow atoms first (before checking unit type or other values)
  // These need to return the keyword string even though they have unit type

  // Handle control flow atoms first (before checking computed values or variable names)
  if (expr.token.value === "continue") {
    // For 3-argument while loops, continue should jump to the continue label
    // which is before the step expression
    if (functionContext.currentContinueLabel) {
      return `goto ${functionContext.currentContinueLabel}`;
    }
    return "continue";
  }

  if (expr.token.value === "break") {
    return "break";
  }

  if (expr.token.value === "return") {
    return "return";
  }

  // For unit-typed expressions (excluding control flow which was handled above), return empty string
  if (expr.$?.type && isUnitType(expr.$.type)) {
    return "";
  }

  // Check if we're in a closure function and this variable is captured
  // Type assertion to access function-specific context

  // Check if we're in a state machine and this is a captured variable
  if (functionContext.inStateMachine && functionContext.stateMachineVariables) {
    const varName = expr.token.value;

    // Check if this variable is locally shadowed (e.g., in match destructuring)
    // If so, use the local C variable instead of the state machine field
    if (functionContext.localShadowedVariables?.has(varName)) {
      return varName;
    }

    // Check if this variable is in the state machine
    // IMPORTANT: Look up by variable ID from environment, not by name!
    // This handles variable shadowing correctly - shadowed variables have the same name but different IDs
    let foundInStateMachine = false;
    if (expr.$?.env) {
      const variables = getVariablesFromEnv(expr.$.env, varName);
      if (variables.length > 0) {
        const variable = variables[variables.length - 1]!; // Most recent scope
        const varId = variable.isOwningTheSameRcValueAs
          ? variable.isOwningTheSameRcValueAs.id
          : variable.id;

        // Check if this variable ID is in the state machine
        const capturedVar = functionContext.stateMachineVariables.get(varId);
        if (capturedVar) {
          // This is a state machine variable - access it through sm->
          // Use kind to determine field name:
          // - "outer": Use __capture.varName (sm->__capture.varName)
          // - "local": Use var_{varId} (sm->var_{varId})
          const fieldName =
            capturedVar.kind === "outer"
              ? `__capture.${varName}`
              : `var_${varId}`;
          foundInStateMachine = true;
          return `sm->${fieldName}`;
        }
      }
    }

    // Fallback: if we don't have env info or didn't find it by ID, search by name
    // This handles captured variables from outer scopes (capture struct) where we might not have env
    if (!foundInStateMachine) {
      for (const [
        varId,
        capturedVar,
      ] of functionContext.stateMachineVariables) {
        if (capturedVar.name === varName) {
          // Found by name - this should only happen for outer captured variables
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

    // Variable not in stateMachineVariables - it's a local C variable in the resume function
    // Just use the variable name (don't regenerate its value)
    if (expr.$?.variableName) {
      return getVariableNameForCodegen(expr.$.variableName, expr.$.env);
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
        return generateComptValue(expr.$.value, context, expr);
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
      return getVariableNameForCodegen(expr.$.variableName, expr.$?.env);
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
      return generateComptValue(expr.$.value, context, expr);
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

  // Check if this is a function variable - if so, use its C function name
  // This handles mutually recursive functions where the value might be UnknownValue
  if (expr.$?.env) {
    const variables = getVariablesFromEnv(expr.$.env, expr.token.value);
    if (variables.length > 0) {
      const variable = variables[variables.length - 1]!;

      // Check if the variable has a function value (or UnknownValue with function type)
      if (variable.value && isFunctionValue(variable.value)) {
        // Look up the C function name
        const cFuncName = context.functions[variable.value.funcId]?.cName;
        if (cFuncName) {
          return cFuncName;
        }
      } else if (
        isFunctionType(variable.type) &&
        (isUnknownValue(variable.value) || variable.value === undefined)
      ) {
        // For UnknownValue or undefined with function type (mutual recursion case),
        // we need to find the function ID another way.
        // The function should have been registered in context.functions
        // Try to find it by matching the variable name
        const functionEntry = Object.entries(context.functions).find(
          ([_funcId, entry]) => {
            // Check if this function's definition matches our variable
            // This is a heuristic - we match by checking if any specialization
            // of the function has a matching variable name
            return entry.value.funcName === expr.token.value;
          }
        );

        if (functionEntry) {
          return functionEntry[1].cName;
        }
      }
    }
  }

  // Check if this variable has a parameterAlias (used in anonymous functions
  // where the actual parameter name differs from the expected interface parameter name)
  const varNameToUse = getVariableNameForCodegen(expr.token.value, expr.$?.env);
  return varNameToUse;
}
