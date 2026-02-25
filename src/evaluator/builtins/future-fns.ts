import type { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import type { FnCallExpr } from "../../expr";
import { createUnitType } from "../../types/creators";
import { typeToString } from "../../types/utils";
import type { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";
import { extractFutureTraitFromType } from "../trait-checking";

/**
 * Evaluates the join builtin function (concurrent Future completion).
 *
 * join takes 1+ Future arguments, starts all cold futures concurrently,
 * and waits for all to complete. It returns unit (does not extract results).
 * Use await on each future after join to extract individual results.
 *
 * Examples:
 * - join(task1, task2) where task1: Future(i32), task2: Future(String) => returns unit
 */
export function evaluateJoin({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FnCallExpr {
  if (expr.args.length < 1) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `join expects at least 1 argument, got ${expr.args.length}.`,
    });
  }

  // Check if we're in a valid context (async block, function body, or test block)
  const blockKind = context.isEvaluatingFunctionBodyOrAsyncBlock?.kind;
  if (
    blockKind !== "async-block" &&
    blockKind !== "function-body" &&
    blockKind !== "test-block"
  ) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `"join" can only be used inside an "async" block or a function body.`,
    });
  }

  // Evaluate each argument and verify it's a Future
  for (let i = 0; i < expr.args.length; i++) {
    const argExpr = expr.args[i]!;

    const evaluatedArg = evaluateExpression({
      expr: argExpr,
      env,
      context: { ...context },
    });

    if (!evaluatedArg.$) {
      throw formatErrorMessage({
        token: argExpr.token,
        errorMessage: `Failed to evaluate join argument ${i} expression.`,
      });
    }

    env = evaluatedArg.$.env;

    // Check that the argument is a Future(T)
    const argType = evaluatedArg.$.type;
    const futureModuleType = extractFutureTraitFromType(argType);
    if (!futureModuleType) {
      throw formatErrorMessage({
        token: argExpr.token,
        errorMessage: `join expects type that implements Future(T) for argument ${i}, but got: ${typeToString(argType)}`,
      });
    }
  }

  // join returns unit
  expr.$ = {
    env,
    type: createUnitType(),
    value: undefined,
    pathCollection: [],
  };

  return expr;
}
