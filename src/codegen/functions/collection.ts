import {
  BuiltinKeywords,
  Expr,
  exprIsAtom,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
} from "../../expr";
import {
  isBoxedType,
  isDynType,
  isFunctionSpecializable,
  isFunctionType,
  isObjectType,
  isSomeType,
  isUnitType,
  Type,
  typeImplementsFuture,
} from "../../types";
import {
  isFunctionValue,
  isTypeValue,
  isUnknownValue,
  ModuleValue,
  TraitValue,
} from "../../value";
import { collectType } from "../types";
import { CodeGenContext, sanitizeForCIdentifier } from "../utils";

/**
 * Check if an expression tree contains any UnknownValue.
 * This indicates that the expression was not fully evaluated, which usually means
 * it's part of a generic function that wasn't fully specialized.
 */
function exprContainsUnknownValue(expr: Expr): boolean {
  // Check if this expression has an unknown value
  if (expr.$ && expr.$.value && isUnknownValue(expr.$.value)) {
    // If the expression has a function type that is extern, it's not truly unknown
    // External functions (like printf, gc_collect) are known at codegen time
    if (isFunctionType(expr.$.type) && expr.$.type.isExtern) {
      // return false; // Continue to check args
    } else if (isUnitType(expr.$.type)) {
      // Continue to check args
    } else {
      return true;
    }
  }

  // Recursively check function calls
  if (exprIsFunctionCall(expr)) {
    if (exprContainsUnknownValue(expr.func)) {
      return true;
    }
    for (const arg of expr.args) {
      if (arg.$?.type && isUnitType(arg.$.type)) {
        continue;
      }

      if (exprContainsUnknownValue(arg)) {
        return true;
      }
    }
  }

  // Check macro expansions
  if (expr.$ && expr.$.macroExpansion) {
    if (expr.$.type && isUnitType(expr.$.type)) {
      return false;
    }

    if (exprContainsUnknownValue(expr.$.macroExpansion)) {
      return true;
    }
  }

  // Check deferred expressions
  if (expr.$?.deferredDupExpressions) {
    for (const dupExpr of expr.$.deferredDupExpressions) {
      if (exprContainsUnknownValue(dupExpr)) {
        return true;
      }
    }
  }

  if (expr.$?.deferredDropExpressions) {
    for (const dropExpr of expr.$.deferredDropExpressions) {
      if (exprContainsUnknownValue(dropExpr)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * First pass: collect all functions that need to be generated
 */
export function collectRequiredFunctions(
  moduleValue: ModuleValue | TraitValue,
  context: CodeGenContext
): void {
  // Start with exported functions
  for (let i = 0; i < moduleValue.fields.length; i++) {
    const value = moduleValue.fields[i]!;
    const field = moduleValue.type.fields[i]!;

    if (isFunctionValue(value)) {
      const label = field.label;

      // Exported functions keep their original names (except main)
      if (label === "main") {
        // Rename user's main to __yo_user_main - we'll wrap it
        context.functions[value.funcId] = {
          value,
          cName: "__yo_user_main",
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
  // Skip test blocks - they should not generate code
  if (
    exprIsFunctionCall(expr) &&
    exprIsFunctionCallOf(expr, BuiltinKeywords.test)
  ) {
    return;
  }

  // If this is a macro expansion, recursively collect from the expanded expression
  if (expr.$ && expr.$.macroExpansion) {
    findFunctionCallsInExpr(expr.$.macroExpansion, context);
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

  // Check for dyn() calls to collect impls
  if (
    exprIsFunctionCall(expr) &&
    expr.$ &&
    expr.$.dynCallTraitValues &&
    expr.$.dynCallTraitValues.length > 0
  ) {
    const dynType = expr.$.type;
    const valueExpr = expr.args[0];

    if (isDynType(dynType) && valueExpr && valueExpr.$?.type) {
      const valueType = valueExpr.$.type;
      const traitValues = expr.$.dynCallTraitValues;

      if (
        traitValues.length > 0 &&
        (isObjectType(valueType) || isBoxedType(valueType))
      ) {
        const concreteType: Type = isBoxedType(valueType)
          ? valueType.fields[0]!.type
          : valueType;

        // Store all module values in order
        // We don't merge them anymore since we need to match module types with their values
        // during wrapper function generation

        // Use ID-based key for now, will be fixed up later
        const implKey = `${concreteType.id}_${dynType.id}`;

        context.dynImpls.set(implKey, {
          dynType,
          concreteType,
          dataType: valueType,
          traitValues,
        });
      }
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
        // Skip collecting functions that are generic and haven't been specialized.
        // A function is generic if it has forallParameters or compile-time only parameters.
        // Note: typeContainsSomeType is too broad - it would skip functions with Impl(Module)
        // return types even though they don't need specialization.
        if (
          isFunctionSpecializable(functionValue.type) &&
          !functionValue.specializedType
        ) {
          // This is a generic function that hasn't been specialized - skip it
          return;
        }

        // Also skip if the specialized type still has unresolved type parameters
        // This can happen when type substitution is incomplete
        if (
          functionValue.specializedType &&
          isFunctionSpecializable(functionValue.specializedType)
        ) {
          return;
        }

        if (context.functions[functionValue.funcId]) {
          // Already collected this function
          // return;
          // NOTE: We shouldn't return here, because it's arguments might be different
        } else {
          // Skip collecting functions whose body contains UnknownValue
          // This means the function wasn't fully evaluated (e.g., nested function in an unspecialized generic)
          if (exprContainsUnknownValue(functionValue.body)) {
            return;
          }

          // DEBUG: Check if this is a SomeType ARC function without resolvedConcreteType
          const paramTypes = functionValue.type.parameters.map((p) => p.type);
          const hasSomeTypeWithoutResolved = paramTypes.some(
            (t) =>
              isSomeType(t) &&
              typeImplementsFuture(t) &&
              !t.resolvedConcreteType
          );
          if (hasSomeTypeWithoutResolved) {
            // Skip collecting SomeType's ARC functions (___drop, ___dup) that have generic
            // Impl(Future) parameters without resolvedConcreteType. These are just wrapper
            // functions that call builtins like __yo_sometype_drop. The codegen will handle
            // dispatching to the concrete type's functions directly.
            //
            // These functions shouldn't be codegen'd because:
            // 1. Their 'self' parameter type (SomeType) doesn't have a C representation
            // 2. The codegen for ___drop already handles SomeType by dispatching to concrete type
            // 3. The actual ARC operations are done via __yo_sometype_drop/__yo_sometype_dup builtins
            return;
          }

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
        // Use externName if available (set during c_include evaluation)
        // This ensures we use the original C function name even if it was imported with a rename
        const cName = functionType.externName
          ? functionType.externName
          : exprIsAtom(expr.func)
            ? expr.func.token.value
            : functionType.id;
        context.externFunctions[functionType.id] = {
          type: functionType,
          cName,
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
      // Skip collecting generic functions that haven't been specialized
      if (
        isFunctionSpecializable(functionValue.type) &&
        !functionValue.specializedFunctionCaches
      ) {
        return;
      }

      if (context.functions[functionValue.funcId]) {
        // Already collected this function
        return;
      } else {
        // Skip collecting functions whose body contains UnknownValue
        // This means the function wasn't fully evaluated (e.g., nested function in an unspecialized generic)
        if (exprContainsUnknownValue(functionValue.body)) {
          return;
        }

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

  // Check for deferredDupExpressions and collect their functions
  if (expr.$?.deferredDupExpressions) {
    for (const dupExpr of expr.$.deferredDupExpressions) {
      findFunctionCallsInExpr(dupExpr, context);
    }
  }

  // Check for deferredDropExpressions and collect their functions
  if (expr.$?.deferredDropExpressions) {
    for (const dropExpr of expr.$.deferredDropExpressions) {
      findFunctionCallsInExpr(dropExpr, context);
    }
  }

  // Check for dynCallTraitValues and collect their functions
  if (expr.$?.dynCallTraitValues) {
    for (const traitValue of expr.$.dynCallTraitValues) {
      // Recursively collect functions from the dyn() module values
      collectRequiredFunctions(traitValue, context);
    }
  }
}
