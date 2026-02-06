import type { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinKeywords,
  type Expr,
  exprIsFunctionCallOf,
  exprToString,
  type FnCallExpr,
} from "../../expr";
import { convertComptimeTypeToRuntimeType } from "../../types/utils";
import type { EvaluatorContext } from "../context";
import { evaluateExpression } from "./expr";

/**
 * Evaluates the `runtime` builtin keyword.
 *
 * `runtime(expr)` forces the expression to be evaluated as a runtime value,
 * even if it could be evaluated at compile time.
 *
 * This is useful to:
 * 1. Prevent CTFE (Compile-Time Function Evaluation) for a function
 * 2. Force a value to be runtime when you don't want compile-time optimization
 *
 * During CTFE analysis, `runtime` throws an error, causing the analysis to fail.
 * This ensures that functions containing `runtime` are not marked as CTFE-capable.
 */
export function evaluateRuntime({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): Expr {
  if (!exprIsFunctionCallOf(expr, BuiltinKeywords.runtime, 1)) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expected runtime(expr), got:\n${exprToString(expr)}`,
    });
  }

  // During CTFE capability analysis, `runtime` should fail the analysis
  // This ensures functions containing `runtime` cannot be evaluated at compile time
  if (context.isAnalyzingCtfeCapability) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Cannot use "runtime" during compile-time function evaluation analysis. The "runtime" keyword forces runtime evaluation and prevents CTFE.`,
    });
  }

  // Evaluate the argument
  const argExpr = expr.args[0]!;
  const evaluatedArg = evaluateExpression({
    expr: argExpr,
    env,
    context: { ...context },
  });

  if (!evaluatedArg.$?.type) {
    throw formatErrorMessage({
      token: evaluatedArg.token,
      errorMessage: `Failed to evaluate runtime argument:\n${exprToString(evaluatedArg)}`,
    });
  }

  // Convert compile-time type to runtime type (e.g., comptime_int -> i32)
  const runtimeType = convertComptimeTypeToRuntimeType({
    type: evaluatedArg.$.type,
    expectedType: undefined,
    expr: evaluatedArg,
    env: evaluatedArg.$.env ?? env,
  });

  // Return the expression with runtime type and undefined value (runtime value)
  expr.$ = {
    type: runtimeType,
    value: undefined, // Runtime value - not known at compile time
    env: evaluatedArg.$.env ?? env,
    pathCollection: evaluatedArg.$.pathCollection ?? [],
  };

  return expr;
}
