import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinKeywords,
  expectExprToBeFunctionCallOf,
  Expr,
  exprToString,
  FuncCallExpr,
} from "../../expr";
import { isBooleanType, isUnitType, typeToString } from "../../types";
import { VUnit } from "../../unit-value";
import { isBooleanValue } from "../../value";
import { EvaluatorContext } from "../context";
import { evaluateBeginExpression } from "./begin";

/**
 * While loop
 *
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
  expectExprToBeFunctionCallOf(expr, BuiltinKeywords.while, 2);
  const conditionExpr: Expr = expr.args[0]!;
  const bodyExpr: Expr = expr.args[1]!;

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

  const conditionValue = evaluatedConditionExpr.$.value;
  if (isBooleanValue(conditionValue) && conditionValue.value === false) {
    // Stop the evaluation
    // return the expr
    expr.$ = {
      env: env,
      isMutable: false,
      pathCollection: [],
      type: VUnit.type,
      value: VUnit,
    };
    return expr;
  } else {
    // Evaluate the body
    const evaluatedBodyExpr = evaluateBeginExpression({
      expr: bodyExpr,
      env,
      context: {
        ...context,
        isEvaluatingLoopBody: env, // Indicate that we are evaluating a while loop
      },
    });
    if (!evaluatedBodyExpr.$) {
      throw formatErrorMessage({
        token: bodyExpr.token,
        errorMessage: `Failed to evaluate the body expression:\n${exprToString(bodyExpr)}`,
      });
    }

    // Check if it has control flow (return, break, continue)
    // NOTE: In reality, we might not even enter the while loop body.
    if (evaluatedBodyExpr.$.controlFlow) {
      // Handle different control flow types
      if (evaluatedBodyExpr.$.controlFlow === "return") {
        // Guaranteed that we meet "return"
        // If the body has a return value, we should return it
        if (isBooleanValue(conditionValue) && conditionValue.value === true) {
          expr.$ = {
            env: evaluatedBodyExpr.$.env,
            isMutable: evaluatedBodyExpr.$.isMutable,
            pathCollection: evaluatedBodyExpr.$.pathCollection,
            type: evaluatedBodyExpr.$.type,
            value: evaluatedBodyExpr.$.value,
            controlFlow: evaluatedBodyExpr.$.controlFlow,
          };
        } else {
          // We might not even enter the while loop body
          expr.$ = {
            env: env,
            isMutable: false,
            pathCollection: [],
            type: VUnit.type,
            value: VUnit,
          };
        }
      } else if (evaluatedBodyExpr.$.controlFlow === "break") {
        // Break exits the loop, return unit
        expr.$ = {
          env: evaluatedBodyExpr.$.env,
          isMutable: false,
          pathCollection: [],
          type: VUnit.type,
          value: VUnit,
        };
      } else if (evaluatedBodyExpr.$.controlFlow === "continue") {
        // Continue goes to next iteration, treat as unit for this evaluation
        expr.$ = {
          env: evaluatedBodyExpr.$.env,
          isMutable: false,
          pathCollection: [],
          type: VUnit.type,
          value: VUnit,
        };
      }
      return expr;
    }

    // The while loop body should return unit
    if (!isUnitType(evaluatedBodyExpr.$.type)) {
      throw formatErrorMessage({
        token: bodyExpr.token,
        errorMessage: `Expected the while loop body to return unit, but got:\n${typeToString(evaluatedBodyExpr.$.type)}`,
      });
    }

    // update the env
    env = evaluatedBodyExpr.$.env;

    if (isBooleanValue(conditionValue) && conditionValue.value === true) {
      // Evaluate the condition again
      return evaluateWhile({
        expr: expr,
        env: env,
        context: {
          ...context,
        },
      });
    } else {
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
  }
}
