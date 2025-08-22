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
import { RegionValue } from "../../region-value";
import {
  createMutRefType,
  createRefType,
  isMutRefType,
  isRefType,
  isRegionType,
  isSomeRegion,
  TypeTag,
} from "../../types";
import { TypeValue } from "../../type-value";
import { createTypeValue, isRegionValue, isTypeValue } from "../../value";
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

  // Handle both &(type) and &(type, region) syntax
  if (expr.args.length !== 1 && expr.args.length !== 2) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Reference type expects 1 or 2 arguments, got ${expr.args.length}`,
    });
  }

  const argExpr = expr.args[0]!;
  const regionExpr = expr.args[1]; // Optional region argument

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

  // Evaluate the region expression if provided
  let regionValue: RegionValue | TypeValue | undefined;
  if (regionExpr) {
    const evaluatedRegionExpr = context.evaluateExpression({
      expr: regionExpr,
      env,
      context: {
        ...context,
        expectedType: undefined,
      },
    });

    if (!evaluatedRegionExpr.$) {
      throw formatErrorMessage({
        token: regionExpr.token,
        errorMessage: `Failed to evaluate the region expression:\n${exprToString(
          regionExpr
        )}`,
      });
    }
    env = evaluatedRegionExpr.$.env;

    if (
      !isRegionType(evaluatedRegionExpr.$.type) ||
      !evaluatedRegionExpr.$.value
    ) {
      throw formatErrorMessage({
        token: regionExpr.token,
        errorMessage: `Expected region type for reference region parameter, got:\n${exprToString(
          regionExpr
        )}`,
      });
    }

    // Handle both RegionValue (runtime regions) and TypeValue containing SomeRegion (type parameters)
    if (isRegionValue(evaluatedRegionExpr.$.value)) {
      // Compile-time region value (e.g., r1 :: region())
      regionValue = evaluatedRegionExpr.$.value;
    } else if (
      isTypeValue(evaluatedRegionExpr.$.value) &&
      isSomeRegion(evaluatedRegionExpr.$.value.value)
    ) {
      // Region type parameter (forall context, e.g., forall(r1 : Region))
      regionValue = evaluatedRegionExpr.$.value;
    } else {
      throw formatErrorMessage({
        token: regionExpr.token,
        errorMessage: `Expected region value or region type parameter for reference region parameter, got:\n${exprToString(
          regionExpr
        )}`,
      });
    }
  }

  // Check if the argExpr is a type
  if (isTypeValue(evaluatedArgExpr.$.value)) {
    const typeValue = evaluatedArgExpr.$.value;
    const baseType = typeValue.value;
    // Create the reference type with optional region
    const referenceType =
      referenceTypeKind === TypeTag.Ref
        ? createRefType(baseType, regionValue)
        : createMutRefType(baseType, regionValue);
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
    // The arg cannot be consumed.
    requireExprNotConsumed(evaluatedArgExpr, env);

    const argType = evaluatedArgExpr.$.type;
    const referenceType =
      referenceTypeKind === TypeTag.Ref
        ? createRefType(argType, regionValue)
        : createMutRefType(argType, regionValue);

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
