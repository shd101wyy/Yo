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
 * Evaluate an address-of operator call
 * For example:
 *
 * &(x) -> creates pointer value to x
 * &!(x) -> creates mutable pointer value to x
 *
 * Note: &(type) and &!(type) are not supported - use *(type) and *!(type) for pointer types
 */
export function evaluateAddressOperatorCall({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  if (
    !exprIsFunctionCallOf(expr, BuiltinKeywords.Ref) &&
    !exprIsFunctionCallOf(expr, BuiltinKeywords.MutRef)
  ) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `evaluateAddressOperatorCall can only handle & or &! expressions`,
    });
  }

  const pointerTypeKind: TypeTag.Ptr | TypeTag.MutPtr = exprIsFunctionCallOf(
    expr,
    BuiltinKeywords.Ref
  )
    ? TypeTag.Ptr
    : TypeTag.MutPtr;

  // Simplified: only accept one argument
  if (expr.args.length !== 1) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Address operator expects exactly 1 argument, got ${expr.args.length}`,
    });
  }

  const argExpr = expr.args[0]!;

  let expectedType = context.expectedType;
  if (
    expectedType &&
    (isPtrType(expectedType.type) || isMutPtrType(expectedType.type))
  ) {
    // If the expected type is a pointer type, we need to use the base type
    // for the pointer creation.
    expectedType = {
      ...expectedType,
      type: expectedType.type.type,
    };
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
      errorMessage: `Failed to evaluate the argument expression for address operator:\n${exprToString(
        argExpr
      )}`,
    });
  }
  env = evaluatedArgExpr.$.env;

  // Check if the argExpr is a type
  if (isTypeValue(evaluatedArgExpr.$.value)) {
    // For types, user should use *(type) or *!(type) instead
    const suggestion = pointerTypeKind === TypeTag.Ptr ? "*(type)" : "*!(type)";
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Cannot create pointer type with &() or &!(). Use ${suggestion} instead for pointer types:\n${exprToString(
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
      value: undefined, // pointer is only available for runtime
      isMutable: pointerTypeKind === TypeTag.MutPtr,
      pathCollection: evaluatedArgExpr.$.pathCollection,
    };
    attachTempVariableToExpr(expr);
    return expr;
  }
}
