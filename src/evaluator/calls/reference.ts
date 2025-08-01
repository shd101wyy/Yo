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
import { isTypeValue } from "../../value";
import { EvaluatorContext } from "../context";

/**
 * Evaluate a reference call
 * Create pointer value
 * For example:
 *
 * swap(&!(x), &!(y));
 */
export function evaluateReferenceCall({
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
    BuiltinKeywords.Ref
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
      errorMessage: `Failed to evaluate the argument expression for reference:\n${exprToString(
        argExpr
      )}`,
    });
  }
  env = evaluatedArgExpr.$.env;

  // Check if the argExpr is a type
  if (isTypeValue(evaluatedArgExpr.$.value)) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Cannot create a pointer to a type value:\n${exprToString(
        argExpr
      )}`,
    });
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
      value: undefined, // reference is only available for runtime
      isMutable: pointerTypeKind === TypeTag.MutPtr,
    };
    attachTempVariableToExpr(expr);
    return expr;
  }
}
