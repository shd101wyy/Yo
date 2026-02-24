import type { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import type { FnCallExpr } from "../../expr";
import { createUnitType } from "../../types/creators";
import { typeToString } from "../../types/utils";
import type { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";
import { extractFutureTraitFromType } from "../trait-checking";

/**
 * Evaluates the await builtin function (stackless async value extraction).
 *
 * await extracts a value of type T from Future(T).
 * It can only be used inside async function bodies.
 *
 * Examples:
 * - await(task) where task: Future(i32) => returns i32
 */
export function evaluateAwait({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FnCallExpr {
  if (expr.args.length !== 1) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `await expects exactly 1 argument, got ${expr.args.length}.`,
    });
  }

  // Check if we're in an async block
  if (context.isEvaluatingFunctionBodyOrAsyncBlock?.kind !== "async-block") {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `"await" can only be used inside an "async" block.`,
    });
  }

  const argExpr = expr.args[0]!;

  // Evaluate the argument expression
  const evaluatedArg = evaluateExpression({
    expr: argExpr,
    env,
    context: { ...context },
  });

  if (!evaluatedArg.$) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Failed to evaluate await argument expression.`,
    });
  }

  env = evaluatedArg.$.env;

  // Check that the argument is a Future(T), Impl(Future(T)), or Dyn(Future(T))
  const argType = evaluatedArg.$.type;
  const futureModuleType = extractFutureTraitFromType(argType);
  if (!futureModuleType) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `await expects type that implements Future(T), but got: ${typeToString(argType)}`,
    });
  }

  // Extract the element type T from Future(T)
  const outputType = futureModuleType.isFuture.outputType;

  expr.$ = {
    env,
    type: outputType,
    value: undefined, // Runtime value, not compile-time
    pathCollection: [],
  };

  // NOTE: No need to run the following functions:
  // attachTempVariableToExpr(expr, false);
  // setExprAsNeedsToCallDup(expr, { ...context }); // We allow to await on a Future multiple times, so we need to call dup here.
  return expr;
}

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
