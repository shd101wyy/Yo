import type { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  cloneExpr,
  type Expr,
  exprIsAtomOf,
  exprIsFunctionCallOf,
  exprToString,
  type FnCallExpr,
  hasAnyControlFlow,
  hasControlFlow,
} from "../../expr";
import { exprContainsLoopTerminator } from "../../expr-traversal";
import { isBooleanType, isUnitType } from "../../types/guards";
import { typeToString } from "../../types/utils";
import { VUnit } from "../../unit-value";
import { isBooleanValue } from "../../value";
import type { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";
import { evaluateBeginExpression } from "./begin";

/**
 * Maximum number of compile-time while loop iterations before the evaluator
 * bails out. Configurable via the YO_MAX_COMPTIME_LOOP_ITERATIONS env variable.
 * This is a safety net for non-literal conditions (e.g., `while (1 == 1)`)
 * that the static analysis for literal `while true` doesn't catch.
 */
const MAX_COMPTIME_LOOP_ITERATIONS = (() => {
  const envVal = process.env["YO_MAX_COMPTIME_LOOP_ITERATIONS"];
  if (envVal !== undefined) {
    const parsed = parseInt(envVal, 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  return 10000;
})();

/**
 * Check if the body has any terminator (break/return/escape) either via
 * guaranteed controlFlow flags or via AST walking.
 */
function bodyHasAnyTerminator(
  bodyExpr: Expr,
  bodyControlFlow: Record<string, boolean> | undefined
): { guaranteed: boolean; possible: boolean } {
  const guaranteed =
    hasControlFlow(bodyControlFlow, "break") ||
    hasControlFlow(bodyControlFlow, "return") ||
    hasControlFlow(bodyControlFlow, "escape");
  const possible = guaranteed || exprContainsLoopTerminator(bodyExpr);
  return { guaranteed, possible };
}

/**
 * Throw an error for a compile-time while loop that exceeded the max iteration
 * count without terminating.
 */
function throwMaxIterationsError(
  expr: FnCallExpr,
  bodyExpr: Expr,
  bodyControlFlow: Record<string, boolean> | undefined
): never {
  const { possible } = bodyHasAnyTerminator(bodyExpr, bodyControlFlow);
  if (possible) {
    // Body has a conditional terminator, but iterations exceeded the limit.
    throw formatErrorMessage({
      token: expr.token,
      errorMessage:
        `Compile-time while loop exceeded the maximum iteration count (${MAX_COMPTIME_LOOP_ITERATIONS}). ` +
        `The loop body contains a conditional \`break\`, \`return\`, or \`escape\`, but the loop did not terminate within the limit.\n` +
        `If this is an infinite runtime loop, use \`while runtime(true), { ... }\` instead.\n` +
        `To increase the limit, set the YO_MAX_COMPTIME_LOOP_ITERATIONS environment variable.`,
    });
  } else {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage:
        `Infinite compile-time while loop detected. ` +
        `The condition is compile-time \`true\` but the loop body has no \`break\`, \`return\`, or \`escape\` to terminate it.\n` +
        `If you need an infinite runtime loop, use \`while runtime(true), { ... }\` instead of \`while true, { ... }\`.\n` +
        `To increase the limit, set the YO_MAX_COMPTIME_LOOP_ITERATIONS environment variable.`,
    });
  }
}

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
  _comptimeIterationCount = 0,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
  _comptimeIterationCount?: number;
}): FnCallExpr {
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

  // NOTE: It's necessary to use evaluateBeginExpression here,
  // because the condition might contain Rc values that need to be properly managed by `begin` block.
  // Evaluate the condition expression
  const evaluatedConditionExpr = evaluateBeginExpression({
    expr: conditionExpr,
    env,
    context: {
      ...context,
    },
    variablesToAdd: [],
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
      errorMessage: `Expected bool type for condition expression, got:\n${exprToString(
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
    if (hasAnyControlFlow(evaluatedBodyExpr.$.controlFlow)) {
      // Handle different control flow types
      if (
        hasControlFlow(evaluatedBodyExpr.$.controlFlow, "return") ||
        hasControlFlow(evaluatedBodyExpr.$.controlFlow, "escape")
      ) {
        // Guaranteed that we meet "return" or "escape"
        // If the body has a return value, we should return it
        if (isBooleanValue(conditionValue) && conditionValue.value === true) {
          // Only propagate return/escape out of while — clear break/continue
          const propagated: { return?: boolean; escape?: boolean } = {};
          if (hasControlFlow(evaluatedBodyExpr.$.controlFlow, "return"))
            propagated.return = true;
          if (hasControlFlow(evaluatedBodyExpr.$.controlFlow, "escape"))
            propagated.escape = true;
          expr.$ = {
            env: evaluatedBodyExpr.$.env,
            pathCollection: evaluatedBodyExpr.$.pathCollection,
            type: evaluatedBodyExpr.$.type,
            value: evaluatedBodyExpr.$.value,
            controlFlow: propagated,
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
      } else if (hasControlFlow(evaluatedBodyExpr.$.controlFlow, "break")) {
        // Break exits the loop, return unit
        expr.$ = {
          env: evaluatedBodyExpr.$.env,
          pathCollection: [],
          type: VUnit.type,
          value: isCompileTime ? VUnit : undefined, // Only set value for compile-time
        };
      } else if (hasControlFlow(evaluatedBodyExpr.$.controlFlow, "continue")) {
        // Continue goes to next iteration
        // Execute step expression if provided before continuing
        let updatedEnv = evaluatedBodyExpr.$.env;
        if (stepExpr) {
          const evaluatedStepExpr = evaluateExpression({
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
            _comptimeIterationCount: _comptimeIterationCount + 1,
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

    // --- Static analysis for infinite compile-time while loops ---
    // Only applies when the condition is a LITERAL `true` atom (not an expression
    // like `i < 10` that happens to evaluate to true on the first iteration).
    // A literal `while true` will never have its condition change, so we check
    // whether the body can terminate via break/return/escape.
    //
    // We walk the body AST instead of checking `controlFlow` flags because
    // controlFlow only reflects *guaranteed* control flow. A `break` inside
    // one branch of `cond` means the loop *may* terminate at runtime, but
    // `controlFlow.break` won't be set on the cond expression.
    //
    // The conditionExpr may be wrapped in a begin() block by evaluateBeginExpression,
    // so we check the inner expression for literal `true`.
    const isCondLiteralTrue = (() => {
      if (!isBooleanValue(conditionValue) || conditionValue.value !== true)
        return false;
      // Direct atom: `true`
      if (exprIsAtomOf(conditionExpr, "true")) return true;
      // Wrapped in begin: `begin(true)` — check first arg
      if (
        exprIsFunctionCallOf(conditionExpr, "begin") &&
        (conditionExpr as FnCallExpr).args.length === 1 &&
        exprIsAtomOf((conditionExpr as FnCallExpr).args[0]!, "true")
      ) {
        return true;
      }
      return false;
    })();

    if (isCondLiteralTrue) {
      const { guaranteed, possible } = bodyHasAnyTerminator(
        bodyExpr,
        evaluatedBodyExpr.$.controlFlow
      );

      if (!guaranteed && !possible) {
        // No terminator at all — this loop can never end
        throwMaxIterationsError(
          expr,
          bodyExpr,
          evaluatedBodyExpr.$.controlFlow
        );
      }

      if (!guaranteed && possible) {
        // A terminator exists but is conditional (e.g., break inside one cond branch).
        // The loop cannot be fully unrolled at compile time — emit as runtime loop.
        expr.$ = {
          env: evaluatedBodyExpr.$.env,
          pathCollection: [],
          type: VUnit.type,
          value: undefined, // Runtime value
        };
        return expr;
      }
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
      const evaluatedStepExpr = evaluateExpression({
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
    // try to unroll the loop by re-evaluating the condition with the updated env.
    // If the condition eventually becomes false, we can unroll completely.
    // Otherwise, fall back to a runtime loop.
    if (
      isBooleanValue(conditionValue) &&
      conditionValue.value === true &&
      bodyHasRuntimeValue
    ) {
      // Re-evaluate the condition with the updated env to check if it will terminate
      const checkCondClone = cloneExpr(conditionExpr);
      const checkCondResult = evaluateBeginExpression({
        expr: checkCondClone,
        env,
        context: { ...context },
        variablesToAdd: [],
      });
      const nextCondValue = checkCondResult.$?.value;

      if (isBooleanValue(nextCondValue)) {
        // Condition is still comptime-known — we can try to unroll
        const unrolledBodies: Expr[] = [bodyExpr]; // First iteration already evaluated

        let currentEnv = env;
        let condStillTrue = nextCondValue.value;

        for (
          let iter = 1;
          condStillTrue && iter < MAX_COMPTIME_LOOP_ITERATIONS;
          iter++
        ) {
          // Clone and evaluate the body for this iteration
          const clonedBody = cloneExpr(bodyExpr);
          const evalBody = evaluateBeginExpression({
            expr: clonedBody,
            env: currentEnv,
            context: {
              ...context,
              isEvaluatingLoopBody: { kind: "while", env: currentEnv },
            },
            variablesToAdd: [],
          });
          if (!evalBody.$) break;

          unrolledBodies.push(clonedBody);
          currentEnv = evalBody.$.env;

          // Execute step if provided (3-argument form)
          if (stepExpr) {
            const clonedStep = cloneExpr(stepExpr);
            const evalStep = evaluateExpression({
              expr: clonedStep,
              env: currentEnv,
              context: { ...context },
            });
            if (!evalStep.$) break;
            currentEnv = evalStep.$.env;
          }

          // Re-evaluate the condition with the updated env
          const condClone = cloneExpr(conditionExpr);
          const condResult = evaluateBeginExpression({
            expr: condClone,
            env: currentEnv,
            context: { ...context },
            variablesToAdd: [],
          });
          const condVal = condResult.$?.value;

          if (isBooleanValue(condVal) && condVal.value === false) {
            condStillTrue = false;
          } else if (isBooleanValue(condVal) && condVal.value === true) {
            condStillTrue = true;
          } else {
            // Condition became runtime — can't unroll further, fall back to runtime loop
            expr.$ = {
              env: currentEnv,
              pathCollection: [],
              type: VUnit.type,
              value: undefined,
              comptimeUnrolledBodies: unrolledBodies,
            };
            return expr;
          }
        }

        if (!condStillTrue) {
          // Loop terminates — store unrolled bodies
          expr.$ = {
            env: currentEnv,
            pathCollection: [],
            type: VUnit.type,
            value: undefined,
            comptimeUnrolledBodies: unrolledBodies,
          };
          return expr;
        }
      }

      // Unrolling failed: condition stayed comptime true and hit max iterations.
      // Throw an error with helpful diagnostic.
      throwMaxIterationsError(expr, bodyExpr, evaluatedBodyExpr.$.controlFlow);
    }

    if (isBooleanValue(conditionValue) && conditionValue.value === true) {
      // Safety net: check iteration count for non-literal `true` conditions
      const nextCount = _comptimeIterationCount + 1;
      if (nextCount >= MAX_COMPTIME_LOOP_ITERATIONS) {
        throwMaxIterationsError(
          expr,
          bodyExpr,
          evaluatedBodyExpr.$.controlFlow
        );
      }
      // Evaluate the condition again
      return evaluateWhile({
        expr: expr,
        env: env,
        context: {
          ...context,
        },
        _comptimeIterationCount: nextCount,
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
