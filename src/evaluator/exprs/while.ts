import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import { Expr, exprToString, FuncCallExpr } from "../../expr";
import { isBooleanType, isUnitType, typeToString } from "../../types";
import { VUnit } from "../../unit-value";
import { isBooleanValue } from "../../value";
import { EvaluatorContext } from "../context";
import { evaluateBeginExpression } from "./begin";

/**
 * While loop
 *
 * while condition, body
 * while condition, step, body
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
  // Support both 2-argument (while condition, body) and 3-argument (while condition, step, body) forms
  if (expr.args.length !== 2 && expr.args.length !== 3) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expected 2 or 3 arguments for while loop, got ${expr.args.length}`,
    });
  }

  const conditionExpr: Expr = expr.args[0]!;
  let stepExpr: Expr | undefined = undefined;
  let bodyExpr: Expr;

  if (expr.args.length === 3) {
    // 3-argument form: while condition, step, body
    stepExpr = expr.args[1]!;
    bodyExpr = expr.args[2]!;
  } else {
    // 2-argument form: while condition, body
    bodyExpr = expr.args[1]!;
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

  const conditionValue = evaluatedConditionExpr.$.value;
  const isCompileTime = conditionValue !== undefined;

  if (isBooleanValue(conditionValue) && conditionValue.value === false) {
    // Stop the evaluation
    // return the expr
    expr.$ = {
      env: env,
      pathCollection: [],
      type: VUnit.type,
      value: isCompileTime ? VUnit : undefined, // Only set value for compile-time
    };
    return expr;
  } else {
    // Evaluate the body
    const evaluatedBodyExpr = evaluateBeginExpression({
      expr: bodyExpr,
      env,
      context: {
        ...context,
        isEvaluatingLoopBody: { kind: "while", env }, // Indicate that we are evaluating a while loop
      },
      variablesToAdd: [],
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
            pathCollection: evaluatedBodyExpr.$.pathCollection,
            type: evaluatedBodyExpr.$.type,
            value: evaluatedBodyExpr.$.value,
            controlFlow: evaluatedBodyExpr.$.controlFlow,
          };
        } else {
          // We might not even enter the while loop body
          expr.$ = {
            env: env,
            pathCollection: [],
            type: VUnit.type,
            value: isCompileTime ? VUnit : undefined, // Only set value for compile-time
          };
        }
      } else if (evaluatedBodyExpr.$.controlFlow === "break") {
        // Break exits the loop, return unit
        expr.$ = {
          env: evaluatedBodyExpr.$.env,
          pathCollection: [],
          type: VUnit.type,
          value: isCompileTime ? VUnit : undefined, // Only set value for compile-time
        };
      } else if (evaluatedBodyExpr.$.controlFlow === "continue") {
        // Continue goes to next iteration
        // Execute step expression if provided before continuing
        let updatedEnv = evaluatedBodyExpr.$.env;
        if (stepExpr) {
          const evaluatedStepExpr = context.evaluateExpression({
            expr: stepExpr,
            env: updatedEnv,
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
          updatedEnv = evaluatedStepExpr.$.env;
        }

        // If condition has a compile-time known value, we need to re-evaluate the entire loop
        // If condition is runtime, we treat continue as returning unit for this evaluation
        if (isBooleanValue(conditionValue)) {
          // Compile-time known condition - re-evaluate the loop
          return evaluateWhile({
            expr: expr,
            env: updatedEnv,
            context: {
              ...context,
            },
          });
        } else {
          // Runtime condition - treat as unit for this evaluation
          expr.$ = {
            env: updatedEnv,
            pathCollection: [],
            type: VUnit.type,
            value: isCompileTime ? VUnit : undefined, // Only set value for compile-time
          };
        }
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

    // Check if the body contains runtime values (e.g., from select statements)
    // If so, we should not continue evaluating the loop at compile-time
    const bodyHasRuntimeValue = evaluatedBodyExpr.$.value === undefined;

    // update the env
    env = evaluatedBodyExpr.$.env;

    // Execute step expression if provided (3-argument form)
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
      // Update environment with step evaluation
      env = evaluatedStepExpr.$.env;
    }

    // If the condition is compile-time true AND the body has runtime values,
    // we should stop compile-time evaluation to avoid infinite loops
    if (
      isBooleanValue(conditionValue) &&
      conditionValue.value === true &&
      bodyHasRuntimeValue
    ) {
      // The loop will run at runtime, but we can't evaluate it at compile-time
      expr.$ = {
        env: env,
        pathCollection: [],
        type: VUnit.type,
        value: undefined, // Runtime value
      };
      return expr;
    }

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
        pathCollection: [],
        type: VUnit.type,
        value: isCompileTime ? VUnit : undefined, // Only set value for compile-time
      };
      return expr;
    }
  }
}
