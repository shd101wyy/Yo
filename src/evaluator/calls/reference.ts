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
import { createMutRefType, createRefType, TypeTag } from "../../type-checker";
import { createTypeValue, isTypeValue } from "../../value";
import { EvaluatorContext } from "../context";

/**
 * Evaluate a reference call
 * For example:
 *
 * &(i32)
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
  const referenceTypeKind: TypeTag.Ref | TypeTag.MutRef = exprIsFunctionCallOf(
    expr,
    BuiltinKeywords.Ref
  )
    ? TypeTag.Ref
    : TypeTag.MutRef;

  const argExpr = expr.args[0]!;
  const evaluatedArgExpr = context.evaluateExpression({
    expr: argExpr,
    env,
    context: {
      ...context,
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
    const typeValue = evaluatedArgExpr.$.value;
    const baseType = typeValue.value;
    // Create the pointer type
    const referenceType =
      referenceTypeKind === TypeTag.Ref
        ? createRefType(baseType)
        : createMutRefType(baseType);
    const typeValueForPointer = createTypeValue(referenceType);
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
    const referenceType =
      referenceTypeKind === TypeTag.Ref
        ? createRefType(argType)
        : createMutRefType(argType);

    // Check if we are creating a mutable pointer to an immutable value
    if (referenceTypeKind === TypeTag.MutRef && !evaluatedArgExpr.$.isMutable) {
      throw formatErrorMessage({
        token: argExpr.token,
        errorMessage: `Cannot create a mutable reference to the immutable:\n${exprToString(
          argExpr
        )}`,
      });
    }

    expr.$ = {
      env,
      type: referenceType,
      value: undefined, // reference is only available for runtime
      isMutable: referenceTypeKind === TypeTag.MutRef,
      pathCollection: evaluatedArgExpr.$.pathCollection,
    };
    attachTempVariableToExpr(expr);
    return expr;
  }
}
