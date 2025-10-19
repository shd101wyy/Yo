import { Expr, exprIsAtom, exprIsFunctionCall } from "../../expr";
import { isFunctionType, typeContainsSomeType } from "../../types";
import { isFunctionValue, isTypeValue, ModuleValue } from "../../value";
import { collectType } from "../types";
import { CodeGenContext, sanitizeForCIdentifier } from "../utils";

/**
 * First pass: collect all functions that need to be generated
 */
export function collectRequiredFunctions(
  moduleValue: ModuleValue,
  context: CodeGenContext
): void {
  // Start with exported functions
  for (let i = 0; i < moduleValue.elements.length; i++) {
    const value = moduleValue.elements[i]!;
    const element = moduleValue.type.elements[i]!;

    if (isFunctionValue(value)) {
      const label = element.label;

      // Exported functions keep their original names (except main)
      if (label === "main") {
        // Rename user's main to yo_user_main - we'll wrap it
        context.functions[value.funcId] = {
          value,
          cName: "yo_user_main",
        };
      } else {
        context.functions[value.funcId] = {
          value,
          cName: sanitizeForCIdentifier(value.funcId),
        };
      }

      // Recursively collect functions called by this function
      findFunctionCallsInExpr(value.body, context);
    }
  }
}

/**
 * Find function calls in an expression and collect them
 */
export function findFunctionCallsInExpr(
  expr: Expr,
  context: CodeGenContext
): void {
  // For async expressions, also collect functions from the evaluated closure call
  if (expr.$ && expr.$.evaluatedClosure) {
    findFunctionCallsInExpr(expr.$.evaluatedClosure, context);
  }

  // For closure construction, collect the closure function
  if (expr.$ && expr.$.closureFunctionValue) {
    const closureFunctionValue = expr.$.closureFunctionValue;
    if (!context.functions[closureFunctionValue.funcId]) {
      context.functions[closureFunctionValue.funcId] = {
        value: closureFunctionValue,
        cName: sanitizeForCIdentifier(closureFunctionValue.funcId),
      };
      // Also recursively collect functions called by this closure function
      findFunctionCallsInExpr(closureFunctionValue.body, context);
    }
  }

  if (exprIsFunctionCall(expr)) {
    const functionType = expr.func.$?.type;
    const functionValue = expr.func.$?.value;

    if (expr.func.token.value === "?=") {
      // Skip the default value assignment in a module/function parameter?
      return;
    }

    if (isFunctionType(functionType)) {
      if (isFunctionValue(functionValue)) {
        // Skip collecting functions that have generic types
        if (
          typeContainsSomeType(functionValue.type) &&
          !functionValue.specializedType
        ) {
          return;
        }

        if (context.functions[functionValue.funcId]) {
          // Already collected this function
          // return;
          // NOTE: We shouldn't return here, because it's arguments might be different
        } else {
          // Collect the function if it's not already collected
          context.functions[functionValue.funcId] = {
            value: functionValue,
            cName: sanitizeForCIdentifier(functionValue.funcId), // Use the function id as the C name
          };

          // Recursively collect functions called by this function
          findFunctionCallsInExpr(functionValue.body, context);
        }
      } else if (functionType.isExtern === "c") {
        // Might be the extern functions
        context.externFunctions[functionType.id] = {
          type: functionType,
          cName: exprIsAtom(expr.func)
            ? expr.func.token.value
            : functionType.id, // Use the type id as the C name if the func is not atom
        };
      }
    }

    // Recursively check the function call itself
    findFunctionCallsInExpr(expr.func, context);

    // Recursively check the function call arguments
    for (const arg of expr.args) {
      findFunctionCallsInExpr(arg, context);
    }
  }

  // expr might be anonymous function value
  const functionType = expr.$?.type;
  const functionValue = expr.$?.value;
  if (isFunctionType(functionType)) {
    if (isFunctionValue(functionValue)) {
      // Skip collecting functions that have generic types
      if (
        typeContainsSomeType(functionValue.type) &&
        !functionValue.specializedFunctionCaches
      ) {
        return;
      }

      if (context.functions[functionValue.funcId]) {
        // Already collected this function
        return;
      } else {
        // Collect the function if it's not already collected
        context.functions[functionValue.funcId] = {
          value: functionValue,
          cName: sanitizeForCIdentifier(functionValue.funcId), // Use the function id as the C name
        };

        // Recursively collect functions called by this function
        findFunctionCallsInExpr(functionValue.body, context);
      }
    }
  }
  // Note: Closures are now runtime-only values, so we can't collect their function information at compile time
  // The closure's function will be collected when it's defined (as a FunctionValue)

  // expr might be a compt function call that returns a type
  if (isTypeValue(expr.$?.value)) {
    collectType(expr.$.value.value, context);
  }

  // Check for capturedVariableDupExpressions and collect their functions
  if (expr.$?.capturedVariableDupExpressions) {
    for (const dupExpr of expr.$.capturedVariableDupExpressions) {
      findFunctionCallsInExpr(dupExpr, context);
    }
  }

  // Check for deferredDropExpressions and collect their functions
  if (expr.$?.deferredDropExpressions) {
    for (const dropExpr of expr.$.deferredDropExpressions) {
      findFunctionCallsInExpr(dropExpr, context);
    }
  }

  // Check for dynCallModuleValues and collect their functions
  if (expr.$?.dynCallModuleValues) {
    for (const moduleValue of expr.$.dynCallModuleValues) {
      // Recursively collect functions from the dyn() module values
      collectRequiredFunctions(moduleValue, context);
    }
  }
}
