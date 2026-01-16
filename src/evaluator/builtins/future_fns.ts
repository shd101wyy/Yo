import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import { FuncCallExpr } from "../../expr";
import { extractFutureTraitFromType, typeToString } from "../../types";
import { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";

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
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
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
