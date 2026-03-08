import { type Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  attachTempVariableToExpr,
  exprToString,
  type FnCallExpr,
  setExprAsConsumed,
} from "../../expr";
import { createArcType } from "../../types/creators";
import type { ArcType } from "../../types/definitions";
import { createTypeValue, isTypeValue } from "../../value";
import type { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";
import { addRcFunctionsToArcType } from "../types/utils";

/**
 * Evaluate Arc type constructor call
 * For example:
 *
 * ArcChannelI32 :: Arc(Channel(i32));
 */
export function evaluateArcTypeCall({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FnCallExpr {
  const argExpr = expr.args[0]!;

  const evaluatedArgExpr = evaluateExpression({
    expr: argExpr,
    env,
    context: {
      ...context,
    },
  });

  if (!evaluatedArgExpr.$) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Failed to evaluate the argument expression for Arc:\n${exprToString(argExpr)}`,
    });
  }
  env = evaluatedArgExpr.$.env;

  // Check if the argExpr is a type
  if (!isTypeValue(evaluatedArgExpr.$.value)) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Arc expects a type as argument, but got:\n${exprToString(argExpr)}`,
    });
  }

  const typeValue = evaluatedArgExpr.$.value;
  const childType = typeValue.value;

  // Create the Arc type
  const arcType = createArcType(childType, env);

  // Add atomic ARC functions to the Arc type
  env = addRcFunctionsToArcType({
    arcType,
    env,
    context,
  });

  const typeValueForArc = createTypeValue(arcType);

  expr.$ = {
    env,
    type: typeValueForArc.type,
    value: typeValueForArc,
    pathCollection: [],
  };

  return expr;
}

/**
 * Evaluate Arc value constructor call
 * For example:
 *
 * ch := Channel(i32).new(usize(10));
 * arc_ch := Arc(Channel(i32))(ch);  // Consumes ch
 *
 * Unlike Iso, Arc does NOT require unique ownership — any value can be wrapped.
 * The value is consumed (moved) into the Arc.
 */
export function evaluateArcValueCall({
  expr,
  env,
  context,
  arcType,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
  arcType: ArcType;
}): FnCallExpr {
  const argExpr = expr.args[0]!;

  const evaluatedArgExpr = evaluateExpression({
    expr: argExpr,
    env,
    context: {
      ...context,
      expectedType: { type: arcType.childType, env },
    },
  });

  if (!evaluatedArgExpr.$) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Failed to evaluate the argument expression for Arc value constructor:\n${exprToString(
        argExpr
      )}`,
    });
  }

  env = evaluatedArgExpr.$.env;

  // Consume the variable (mark it as moved)
  env = setExprAsConsumed(evaluatedArgExpr, env);

  // Wrap the value in Arc type with atomic RC
  expr.$ = {
    env,
    type: arcType,
    value: undefined, // arc value should be runtime only
    pathCollection: evaluatedArgExpr.$.pathCollection || [],
  };

  attachTempVariableToExpr(expr, true);

  return expr;
}
