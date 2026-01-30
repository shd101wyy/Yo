import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import { exprToString, FnCallExpr } from "../../expr";
import { isUnitType } from "../../types";
import { VUnit } from "../../unit-value";
import {
  createUnknownValue,
  isBooleanValue,
  isComptStringValue,
  valueToString,
} from "../../value";
import { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";

export function evaluateComptAssert({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FnCallExpr {
  // Do nothing if we are not really executing.
  // Use expectedType if available (for match branches), otherwise use unit.
  // This allows compt_assert to type-check correctly in branches that expect a specific type.
  if (context.isValidatingFunctionDefinition || !context.isExecuting) {
    const returnType = context.expectedType?.type ?? VUnit.type;
    expr.$ = {
      env,
      type: returnType,
      value: isUnitType(returnType) ? VUnit : createUnknownValue(returnType),
      pathCollection: [],
    };
    return expr;
  }

  const argExpr = expr.args[0]!;
  const messageExpr = expr.args[1];

  // Evaluate the expression
  const evaluatedArgExpr = evaluateExpression({
    expr: argExpr,
    env,
    context: {
      ...context,
    },
  });
  if (!evaluatedArgExpr.$ || !isBooleanValue(evaluatedArgExpr.$.value)) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Expected bool value for "compt_assert", got:\n${exprToString(argExpr)}
      
Value:
${valueToString(evaluatedArgExpr.$?.value)}`,
      isAssertionError: true,
    });
  }
  const booleanValue = evaluatedArgExpr.$.value;
  if (booleanValue.value) {
    // The assertion passed, return unit
    expr.$ = {
      env,
      type: VUnit.type,
      value: VUnit,
      pathCollection: [],
    };
    return expr;
  } else {
    if (messageExpr) {
      const evaluatedMessageExpr = evaluateExpression({
        expr: messageExpr,
        env,
        context: {
          ...context,
        },
      });
      if (evaluatedMessageExpr.$?.value) {
        throw formatErrorMessage({
          token: expr.token,

          errorMessage: isComptStringValue(evaluatedMessageExpr.$.value)
            ? evaluatedMessageExpr.$.value.value
            : valueToString(evaluatedMessageExpr.$.value),

          isAssertionError: true,
        });
      }
    }

    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Assertion failed for "compt_assert":\n${exprToString(argExpr)}`,
      isAssertionError: true,
    });
  }
}
