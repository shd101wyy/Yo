import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import { Expr, exprToString, FuncCallExpr } from "../../expr";
import { isBooleanType, isUnitType, typeToString } from "../../types";
import { VUnit } from "../../unit-value";
import { EvaluatorContext } from "../context";

/**
 * While loop
 *
 * while condition, step, body
 * while condition, body
 */
export function evaluateWhile({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  let conditionExpr: Expr | undefined;
  let stepExpr: Expr | undefined;
  let bodyExpr: Expr | undefined;

  if (expr.args.length === 2) {
    // while condition, body
    conditionExpr = expr.args[0]!;
    bodyExpr = expr.args[1]!;
  } else if (expr.args.length === 3) {
    // while condition, step, body
    conditionExpr = expr.args[0]!;
    stepExpr = expr.args[1]!;
    bodyExpr = expr.args[2]!;
  } else {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expected "while" with 2 or 3 arguments, got:\n${exprToString(expr)}`,
    });
  }

  // Evaluate the condition expression
  const evaluatedConditionExpr = context.evaluateExpression({
    expr: conditionExpr,
    env,
    context: {
      ...context,
    },
  });
  if (!evaluatedConditionExpr.$) {
    throw formatErrorMessage({
      token: conditionExpr.token,
      errorMessage: `Failed to evaluate the condition expression:\n${exprToString(conditionExpr)}`,
    });
  }
  if (!isBooleanType(evaluatedConditionExpr.$.type)) {
    throw formatErrorMessage({
      token: conditionExpr.token,
      errorMessage: `Expected boolean type for condition expression, got:\n${exprToString(
        conditionExpr
      )}`,
    });
  }

  // Evaluate the body
  const evaluatedBodyExpr = context.evaluateExpression({
    expr: bodyExpr,
    env,
    context: {
      ...context,
    },
  });
  if (!evaluatedBodyExpr.$) {
    throw formatErrorMessage({
      token: bodyExpr.token,
      errorMessage: `Failed to evaluate the body expression:\n${exprToString(bodyExpr)}`,
    });
  }
  if (!isUnitType(evaluatedBodyExpr.$.type)) {
    throw formatErrorMessage({
      token: bodyExpr.token,
      errorMessage: `Expected the while loop body to return unit, but got:\n${typeToString(evaluatedBodyExpr.$.type)}`,
    });
  }

  // Evaluate the step
  if (stepExpr) {
    const evaluatedStepExpr = context.evaluateExpression({
      expr: stepExpr,
      env,
      context: {
        ...context,
      },
    });
    if (!evaluatedStepExpr.$) {
      throw formatErrorMessage({
        token: stepExpr.token,
        errorMessage: `Failed to evaluate the step expression:\n${exprToString(stepExpr)}`,
      });
    }
  }

  // return the expr
  expr.$ = {
    env: env,
    isMutable: false,
    pathCollection: [],
    type: VUnit.type,
    value: VUnit,
  };
  return expr;
}
