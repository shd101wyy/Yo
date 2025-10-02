import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinFunctions,
  expectExprToBeFunctionCallOf,
  exprIsFunctionCall,
  exprToString,
  FuncCallExpr,
} from "../../expr";
import { isFunctionType } from "../../types/guards";
import { VUnit } from "../../unit-value";
import { EvaluatorContext } from "../context";

/**
 * Evaluates the go builtin function.
 *
 * go takes a function call expression and executes it as a cooperative task,
 * returning unit.
 *
 * Examples:
 * - go say("hello", 18, ch) -> unit
 * - go compute(42) -> unit
 *
 * @param params - The evaluation parameters
 * @returns The function call expression with unit type
 */
export function evaluateGo({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  expectExprToBeFunctionCallOf(expr, BuiltinFunctions.go, 1);

  const functionCallExpr = expr.args[0]!;
  if (!exprIsFunctionCall(functionCallExpr)) {
    throw formatErrorMessage({
      token: functionCallExpr.token,
      errorMessage: `Expected a function call expression inside go, got:\n${exprToString(
        functionCallExpr
      )}`,
    });
  }

  // Evaluate the function call expression to check if it's valid
  const evaluatedExpr = context.evaluateExpression({
    expr: functionCallExpr,
    env,
    context: { ...context, isSpawningFunctionCall: env },
  });

  if (!evaluatedExpr.$) {
    throw formatErrorMessage({
      token: functionCallExpr.token,
      errorMessage: `Failed to evaluate expression.`,
    });
  }

  if (!exprIsFunctionCall(evaluatedExpr)) {
    throw formatErrorMessage({
      token: functionCallExpr.token,
      errorMessage: `Expected a function call expression inside go, got:\n${exprToString(
        functionCallExpr
      )}`,
    });
  }

  if (!isFunctionType(evaluatedExpr.func.$?.type)) {
    throw formatErrorMessage({
      token: evaluatedExpr.func.token,
      errorMessage: `Expected a function type for the called function, got ${evaluatedExpr.func.$?.type.tag}`,
    });
  }

  const functionType = evaluatedExpr.func.$.type;
  if (functionType.return.isCompileTimeOnly) {
    throw formatErrorMessage({
      token: functionCallExpr.token,
      errorMessage: `Cannot spawn a task for a function that returns a compile-time-only value.`,
    });
  }
  env = evaluatedExpr.$.env;

  // go always returns unit
  expr.$ = {
    env,
    type: VUnit.type,
    value: undefined, // Runtime value, not compile-time
    pathCollection: [],
  };

  return expr;
}

/**
 * Evaluates the __yo_concurrency_set_maximum_threads builtin function.
 *
 * __yo_concurrency_set_maximum_threads takes a usize argument specifying the maximum
 * number of threads that should be used to run tasks.
 *
 * Examples:
 * - __yo_concurrency_set_maximum_threads(1) -> unit
 * - __yo_concurrency_set_maximum_threads(4) -> unit
 *
 * @param params - The evaluation parameters
 * @returns The expression with unit type
 */
export function evaluateTaskSetMaximumThreads({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  expectExprToBeFunctionCallOf(
    expr,
    BuiltinFunctions.__yo_concurrency_set_maximum_threads,
    1
  );

  const argExpr = expr.args[0]!;

  // Evaluate the argument expression
  const evaluatedExpr = context.evaluateExpression({
    expr: argExpr,
    env,
    context: { ...context },
  });

  if (!evaluatedExpr.$) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Failed to evaluate expression.`,
    });
  }

  env = evaluatedExpr.$.env;

  // Return unit type
  expr.$ = {
    env,
    type: VUnit.type,
    value: undefined, // Runtime value, not compile-time
    pathCollection: [],
  };

  return expr;
}
