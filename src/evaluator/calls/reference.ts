import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  attachTempVariableToExpr,
  BuiltinKeywords,
  exprIsFunctionCallOf,
  exprToString,
  FuncCallExpr,
} from "../../expr";
import {
  createMutRefType,
  createRefType,
  isMutRefType,
  isRefType,
  TypeTag,
} from "../../types";
import { createTypeValue, isTypeValue } from "../../value";
import { EvaluatorContext } from "../context";

/**
 * Evaluate a reference call
 * For example:
 *
 * &(i32)
 * &!(x)
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
  if (
    !exprIsFunctionCallOf(expr, BuiltinKeywords.Ref) &&
    !exprIsFunctionCallOf(expr, BuiltinKeywords.MutRef)
  ) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `evaluateReferenceCall can only handle & or &! expressions`,
    });
  }

  const referenceTypeKind: TypeTag.Ref | TypeTag.MutRef = exprIsFunctionCallOf(
    expr,
    BuiltinKeywords.Ref
  )
    ? TypeTag.Ref
    : TypeTag.MutRef;

  // Simplified: only accept one argument (no regions)
  if (expr.args.length !== 1) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Reference type expects exactly 1 argument, got ${expr.args.length}`,
    });
  }

  const argExpr = expr.args[0]!;

  let expectedType = context.expectedType;
  if (
    expectedType &&
    (isRefType(expectedType.type) || isMutRefType(expectedType.type))
  ) {
    // If the expected type is a reference type, we need to use the base type
    // for the reference creation.
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
    // Create the reference type without region
    const referenceType =
      referenceTypeKind === TypeTag.Ref
        ? createRefType(baseType)
        : createMutRefType(baseType);
    const typeValueForReference = createTypeValue(referenceType);
    expr.$ = {
      env,
      type: typeValueForReference.type,
      value: typeValueForReference,
      isMutable: false,
      pathCollection: [],
    };
    return expr;
  } else {
    const argType = evaluatedArgExpr.$.type;
    const referenceType =
      referenceTypeKind === TypeTag.Ref
        ? createRefType(argType)
        : createMutRefType(argType);

    // Check if we are creating a mutable reference to an immutable value
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
