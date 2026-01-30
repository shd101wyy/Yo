import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import { FnCallExpr } from "../../expr";
import { isFunctionValue, valueToString } from "../../value";
import { EvaluatorContext } from "../context";
import { analyzeCtfeCapability } from "../ctfe/ctfe-analysis";
import { evaluateExpression } from "../exprs/expr";

/**
 * compt_fn(fn) - Convert a runtime function to a compile-time function.
 *
 * This builtin explicitly creates a compile-time version of a function.
 * It returns the function with all parameters and return type marked as isCompileTimeOnly.
 *
 * Usage:
 *   add :: (fn(x : i32, y : i32) -> i32) { return (x + y); };
 *   compt_add :: compt_fn(add);  // fn(compt(i32), compt(i32)) -> compt(i32)
 *
 * The returned function can only be called with compile-time known arguments.
 */
export function evaluateComptFn({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FnCallExpr {
  const argExpr = expr.args[0];
  if (!argExpr) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `compt_fn requires exactly one argument (a function)`,
    });
  }

  // Evaluate the argument to get the function value
  const evaluatedArgExpr = evaluateExpression({
    expr: argExpr,
    env,
    context,
  });

  if (!evaluatedArgExpr.$) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Failed to evaluate argument to compt_fn`,
    });
  }

  const functionValue = evaluatedArgExpr.$.value;
  if (!isFunctionValue(functionValue)) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `compt_fn requires a function argument, got: ${valueToString(functionValue)}`,
    });
  }

  // Check if already a compile-time function
  if (functionValue.type.return.isCompileTimeOnly) {
    // Already a compile-time function, just return it
    expr.$ = {
      env,
      type: functionValue.type,
      value: functionValue,
      pathCollection: [],
    };
    return expr;
  }

  // Try to create the compile-time version using CTFE analysis
  const comptFunctionValue = analyzeCtfeCapability(functionValue, env, context);

  if (comptFunctionValue) {
    // CTFE succeeded - return the compile-time version
    expr.$ = {
      env,
      type: comptFunctionValue.type,
      value: comptFunctionValue,
      pathCollection: [],
    };
    return expr;
  }

  // CTFE failed - throw an error
  throw formatErrorMessage({
    token: argExpr.token,
    errorMessage: `compt_fn: Failed to create compile-time version of function. The function body cannot be evaluated at compile time.`,
  });
}
