import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  attachTempVariableToExpr,
  BuiltinKeywords,
  exprIsFunctionCallOf,
  exprToString,
  FuncCallExpr,
  requireExprNotConsumed,
} from "../../expr";
import {
  createMutPtrType,
  createPtrType,
  isMutPtrType,
  isPtrType,
  TypeTag,
} from "../../types";
import { createTypeValue, isTypeValue } from "../../value";
import { EvaluatorContext } from "../context";

/**
 * Evaluate a raw pointer call
 * For example:
 *
 * I32Ptr :: *(i32);
 * x := 1;
 * p := *(x); // p: *(i32)
 */
export function evaluateRawPointerCall({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  const pointerTypeKind: TypeTag.Ptr | TypeTag.MutPtr = exprIsFunctionCallOf(
    expr,
    BuiltinKeywords.Ptr
  )
    ? TypeTag.Ptr
    : TypeTag.MutPtr;

  const argExpr = expr.args[0]!;

  let expectedType = context.expectedType;
  if (
    expectedType &&
    (isPtrType(expectedType.type) || isMutPtrType(expectedType.type))
  ) {
    // If the expected type is a reference type, we need to use the base type
    // for the reference creation.
    expectedType = {
      ...expectedType,
      type: expectedType.type.type,
    };
  } else {
    // QUESTION: Should we set expectedType to undefined?
  }

  const evaluatedArgExpr = context.evaluateExpression({
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
      errorMessage: `Failed to evaluate the argument expression for pointer:\n${exprToString(
        argExpr
      )}`,
    });
  }
  env = evaluatedArgExpr.$.env;

  // Check if the argExpr is a type
  if (isTypeValue(evaluatedArgExpr.$.value)) {
    const typeValue = evaluatedArgExpr.$.value;
    const baseType = typeValue.value;
    // Create the pointer type
    const pointerType =
      pointerTypeKind === TypeTag.Ptr
        ? createPtrType(baseType)
        : createMutPtrType(baseType);
    const typeValueForPointer = createTypeValue(pointerType);
    expr.$ = {
      env,
      type: typeValueForPointer.type,
      value: typeValueForPointer,
      isMutable: false,
      pathCollection: [],
    };
    return expr;
  } else {
    // The arg cannot be consumed.
    requireExprNotConsumed(evaluatedArgExpr, env);

    const argType = evaluatedArgExpr.$.type;
    const pointerType =
      pointerTypeKind === TypeTag.Ptr
        ? createPtrType(argType)
        : createMutPtrType(argType);

    // Check if we are creating a mutable pointer to an immutable value
    if (pointerTypeKind === TypeTag.MutPtr && !evaluatedArgExpr.$.isMutable) {
      throw formatErrorMessage({
        token: argExpr.token,
        errorMessage: `Cannot create a mutable pointer to the immutable:\n${exprToString(
          argExpr
        )}`,
      });
    }

    expr.$ = {
      env,
      type: pointerType,
      value: undefined, // pointer is only available for runtime
      isMutable: pointerTypeKind === TypeTag.MutPtr,
      pathCollection: [],
    };
    attachTempVariableToExpr(expr);
    return expr;
  }
}
