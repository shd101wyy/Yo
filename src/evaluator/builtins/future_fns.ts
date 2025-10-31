import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinFunctions,
  expectExprToBeFunctionCallOf,
  exprToString,
  FuncCallExpr,
} from "../../expr";
import { isFutureType, typeToString } from "../../types";
import { VUnit } from "../../unit-value";
import { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";

/**
 * Evaluates __yo_future_drop builtin function.
 * Just evaluates the argument and returns unit.
 */
export function evaluateYoFutureDrop({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  expectExprToBeFunctionCallOf(expr, [BuiltinFunctions.__yo_future_drop[0]!]);

  const argExpr = expr.args[0]!;
  const evaluatedArgExpr = evaluateExpression({
    expr: argExpr,
    env,
    context: {
      ...context,
    },
  });

  if (!evaluatedArgExpr.$) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Failed to evaluate the argument expression for "${BuiltinFunctions.__yo_future_drop[0]!}":\n${exprToString(
        argExpr
      )}`,
    });
  }
  env = evaluatedArgExpr.$.env;

  expr.$ = {
    env,
    type: VUnit.type,
    value: VUnit,
    pathCollection: [],
  };
  return expr;
}

/**
 * Evaluates __yo_future_dup builtin function.
 * Just evaluates the argument and returns unit.
 */
export function evaluateYoFutureDup({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  expectExprToBeFunctionCallOf(expr, [BuiltinFunctions.__yo_future_dup[0]!]);

  const argExpr = expr.args[0]!;
  const evaluatedArgExpr = evaluateExpression({
    expr: argExpr,
    env,
    context: {
      ...context,
    },
  });

  if (!evaluatedArgExpr.$) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Failed to evaluate the argument expression for "${BuiltinFunctions.__yo_future_dup[0]!}":\n${exprToString(
        argExpr
      )}`,
    });
  }
  env = evaluatedArgExpr.$.env;

  expr.$ = {
    env,
    type: VUnit.type,
    value: VUnit,
    pathCollection: [],
  };
  return expr;
}

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

  // Check that the argument is a Future(T)
  const argType = evaluatedArg.$.type;
  if (!isFutureType(argType)) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `await expects a Future(T) type, but got: ${typeToString(argType)}`,
    });
  }

  // Extract the element type T from Future(T)
  const elementType = argType.elementType;

  expr.$ = {
    env,
    type: elementType,
    value: undefined, // Runtime value, not compile-time
    pathCollection: [],
  };

  // NOTE: No need to run the following functions:
  // attachTempVariableToExpr(expr, false);
  // setExprAsNeedsToCallDup(expr, { ...context }); // We allow to await on a Future multiple times, so we need to call dup here.
  return expr;
}
