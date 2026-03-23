import type { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinKeywords,
  cloneExpr,
  type Expr,
  ExprTag,
  exprIsAtomOf,
  exprIsFunctionCallOf,
  exprToString,
  type FnCallExpr,
  hasAnyControlFlow,
  hasControlFlow,
} from "../../expr";
import { isBooleanType, isUnitType } from "../../types/guards";
import { typeToString } from "../../types/utils";
import { VUnit } from "../../unit-value";
import { isBooleanValue } from "../../value";
import type { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";
import { evaluateBeginExpression } from "./begin";

/**
 * Recursively check if an expression tree contains any `break`, `return`,
 * or `escape` expressions — even inside branches of `cond`/`match`.
 *
 * This is needed because `controlFlow` flags on a `cond` expression only
 * reflect **guaranteed** control flow (all branches). A `break` inside one
 * branch of `cond` means the loop **may** terminate, but `controlFlow.break`
 * won't be set on the `cond` expression itself.
 */
function exprContainsLoopTerminator(expr: Expr): boolean {
  if (expr.tag === ExprTag.Atom) {
    // break, return, escape can appear as bare atoms
    return (
      exprIsAtomOf(expr, BuiltinKeywords.break) ||
      exprIsAtomOf(expr, BuiltinKeywords.return) ||
      exprIsAtomOf(expr, BuiltinKeywords.escape)
    );
  }

  // FnCallExpr
  const fnCall = expr as FnCallExpr;

  // Check if this is a return(expr) or escape(expr) call
  if (
    exprIsFunctionCallOf(fnCall, BuiltinKeywords.return) ||
    exprIsFunctionCallOf(fnCall, BuiltinKeywords.escape)
  ) {
    return true;
  }

  // Recurse into func and all arguments
  if (exprContainsLoopTerminator(fnCall.func)) return true;
  for (const arg of fnCall.args) {
    if (exprContainsLoopTerminator(arg)) return true;
  }

  return false;
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
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
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
    // If the condition is compile-time `true` and the body has no expression
    // that could terminate the loop (break, return, escape), the loop will run
    // forever at compile time. Error out with a helpful message.
    //
    // We walk the body AST instead of checking `controlFlow` flags because
    // controlFlow only reflects *guaranteed* control flow. A `break` inside
    // one branch of `cond` means the loop *may* terminate at runtime, but
    // `controlFlow.break` won't be set on the cond expression.
    if (isBooleanValue(conditionValue) && conditionValue.value === true) {
      const bodyFlow = evaluatedBodyExpr.$.controlFlow;
      const hasGuaranteedTerminator =
        hasControlFlow(bodyFlow, "break") ||
        hasControlFlow(bodyFlow, "return") ||
        hasControlFlow(bodyFlow, "escape");
      const hasPossibleTerminator = exprContainsLoopTerminator(bodyExpr);

      if (!hasGuaranteedTerminator && !hasPossibleTerminator) {
        // No terminator at all — this loop can never end
        throw formatErrorMessage({
          token: expr.token,
          errorMessage:
            `Infinite compile-time while loop detected. ` +
            `The condition is compile-time \`true\` but the loop body has no \`break\`, \`return\`, or \`escape\` to terminate it.\n` +
            `If you need an infinite runtime loop, use \`while runtime(true), { ... }\` instead of \`while true, { ... }\`.`,
        });
      }

      if (!hasGuaranteedTerminator && hasPossibleTerminator) {
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
        const MAX_UNROLL_ITERATIONS = 10000;
        const unrolledBodies: Expr[] = [bodyExpr]; // First iteration already evaluated

        let currentEnv = env;
        let condStillTrue = nextCondValue.value;

        for (
          let iter = 1;
          condStillTrue && iter < MAX_UNROLL_ITERATIONS;
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
            // Condition became runtime — can't unroll further, fall back
            break;
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

      // Unrolling failed (condition stayed true, became runtime, or hit max iterations)
      // Fall back to runtime loop
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
