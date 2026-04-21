import type { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import { exprToString, type FnCallExpr } from "../../expr";
import { isBooleanType, isUnitType } from "../../types/guards";
import { typeToString } from "../../types/utils";
import { VUnit } from "../../unit-value";
import {
  createUnknownValue,
  isBooleanValue,
  isComptimeStringValue,
  isUnknownValue,
  valueToString,
} from "../../value";
import type { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";

export function evaluateComptimeAssert({
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
  // This allows comptime_assert to type-check correctly in branches that expect a specific type.
  if (context.isValidatingFunctionDefinition || !context.isExecuting) {
    // Still evaluate the condition argument so its type is checked.
    // Without this, malformed expressions like `(i32 == i32)` would silently
    // pass validation inside function bodies and only error when actually executed.
    const argExpr = expr.args[0];
    if (argExpr) {
      const evaluatedArgExpr = evaluateExpression({
        expr: argExpr,
        env,
        context: {
          ...context,
        },
      });
      if (
        evaluatedArgExpr.$ &&
        !isBooleanType(evaluatedArgExpr.$.type) &&
        !isUnknownValue(evaluatedArgExpr.$.value)
      ) {
        throw formatErrorMessage({
          token: argExpr.token,
          errorMessage: `Expected bool expression for "comptime_assert", got:\n${exprToString(argExpr)}\n\nType:\n${typeToString(evaluatedArgExpr.$.type)}`,
          isAssertionError: true,
        });
      }
    }

    const returnType = context.expectedType?.type ?? VUnit.type;
    expr.$ = {
      env,
      type: returnType,
      value: isUnitType(returnType)
        ? VUnit
        : createUnknownValue(returnType, { env, context }),
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
      errorMessage: `Expected bool value for "comptime_assert", got:\n${exprToString(argExpr)}
      
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

          errorMessage: isComptimeStringValue(evaluatedMessageExpr.$.value)
            ? evaluatedMessageExpr.$.value.value
            : valueToString(evaluatedMessageExpr.$.value),

          isAssertionError: true,
        });
      }
    }

    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Assertion failed for "comptime_assert":\n${exprToString(argExpr)}`,
      isAssertionError: true,
    });
  }
}
