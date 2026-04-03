import type { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  attachTempVariableToExpr,
  BuiltinFunctions,
  expectExprToBeFunctionCallOf,
  exprToString,
  type FnCallExpr,
} from "../../expr";
import { createPtrType } from "../../types/creators";
import {
  isComptimeFloatType,
  isComptimeIntType,
  isComptimeStringType,
  isPtrType,
} from "../../types/guards";
import { convertComptimeTypeToRuntimeType } from "../../types/utils";
import { createPtrValue, isTypeValue } from "../../value";
import type { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";

/**
 * Evaluate a address call
 * For example:
 *
 * &(x)
 */
export function evaluateAddressCall({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FnCallExpr {
  expectExprToBeFunctionCallOf(expr, BuiltinFunctions.__yo_address_of, 1);

  const argExpr = expr.args[0]!;

  let expectedType = context.expectedType;
  if (expectedType && isPtrType(expectedType.type)) {
    // If the expected type is a pointer type, we need to use the base type
    // for the reference creation.
    expectedType = {
      ...expectedType,
      type: expectedType.type.childType,
    };
  }

  const evaluatedArgExpr = evaluateExpression({
    expr: argExpr,
    env,
    context: {
      ...context,
      expectedType,
    },
  });

  if (!evaluatedArgExpr.$) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Failed to evaluate the argument expression for reference:\n${exprToString(
        argExpr
      )}`,
    });
  }
  env = evaluatedArgExpr.$.env;

  // Check if the argExpr is a type
  if (isTypeValue(evaluatedArgExpr.$.value)) {
    // Throw error. Should use * to create pointer to type
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Cannot create a pointer to a type. Did you mean to use "*"?\n${exprToString(
        argExpr
      )}`,
    });
  }
  // Create pointer value
  else {
    let argType = evaluatedArgExpr.$.type;

    // If the argument is a comptime type, convert it to its runtime equivalent
    // before creating the pointer type. This ensures we get *(str) instead of *(comptime_string).
    if (
      isComptimeIntType(argType) ||
      isComptimeFloatType(argType) ||
      isComptimeStringType(argType)
    ) {
      const runtimeType = convertComptimeTypeToRuntimeType({
        type: argType,
        expectedType: expectedType?.type,
        expr: evaluatedArgExpr,
        env,
      });
      // Update the argument's type and set convertedRuntimeType for codegen
      evaluatedArgExpr.$.type = runtimeType;
      evaluatedArgExpr.$.convertedRuntimeType = runtimeType;
      argType = runtimeType;
    }

    const pointerType = createPtrType(argType);

    // Check if we can create a compile-time pointer first.
    // This requires the source expression to have a sourceVariable with a value array
    // OR an arrayElementRef for array element access like &(arr(0)).
    // We check arrayElementRef BEFORE indexTraitPtrType because comptime arrays
    // set both properties, and arrayElementRef allows creating a comptime pointer
    // whereas indexTraitPtrType would return a runtime-only pointer.
    const sourceVariable = evaluatedArgExpr.$.sourceVariable;
    const arrayElementRef = evaluatedArgExpr.$.arrayElementRef;

    if (arrayElementRef) {
      // Create a compile-time pointer to an array element
      // Store the ArrayValue in targetValue[0], and use targetIndex to specify the element
      const ptrValue = createPtrValue(
        pointerType,
        [arrayElementRef.arrayValue],
        arrayElementRef.index
      );

      expr.$ = {
        env,
        type: pointerType,
        value: ptrValue,
        pathCollection: evaluatedArgExpr.$.pathCollection,
      };
    } else if (sourceVariable && sourceVariable.value) {
      // Create a compile-time pointer value that shares the value array with the source variable
      const ptrValue = createPtrValue(pointerType, sourceVariable.value);

      expr.$ = {
        env,
        type: pointerType,
        value: ptrValue,
        pathCollection: evaluatedArgExpr.$.pathCollection,
      };
    } else {
      // Check if this is &(value(i)) where value(i) was dispatched via Index trait.
      // The Index.index() method returns *(Output), which was auto-dereferenced to Output.
      // For &(value(i)), we skip the auto-deref and return the *(Output) pointer directly.
      const indexTraitPtrType = evaluatedArgExpr.$.indexTraitPtrType;
      if (indexTraitPtrType) {
        expr.$ = {
          env,
          type: indexTraitPtrType,
          value: undefined, // pointer is only available at runtime
          pathCollection: evaluatedArgExpr.$.pathCollection,
          isIndexTraitAddressOf: true,
        };
      } else {
        expr.$ = {
          env,
          type: pointerType,
          value: undefined, // reference is only available for runtime
          pathCollection: evaluatedArgExpr.$.pathCollection,
        };
      }
    }
    attachTempVariableToExpr(expr, false);
    return expr;
  }
}
