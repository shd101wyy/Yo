import type { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import type { FnCallExpr } from "../../expr";
import { isComptimeStringType } from "../../types/guards";
import { VUnit } from "../../unit-value";
import { isComptimeStringValue, isUnknownValue } from "../../value";
import type { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";

export function evaluatePanic({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FnCallExpr {
  // Check if panic is being called inside a function context
  if (
    context.isEvaluatingFunctionBodyOrAsyncBlock?.kind !== "function-body" &&
    context.isEvaluatingFunctionBodyOrAsyncBlock?.kind !== "test-block"
  ) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `panic() can only be called inside a function body or test block`,
    });
  }

  // During CTFE capability analysis, `panic` should fail the analysis
  // This ensures functions containing `panic` cannot be evaluated at compile time
  if (context.isAnalyzingCtfeCapability) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Cannot use "panic" during compile-time function evaluation analysis. Functions containing "panic" cannot be evaluated at compile time.`,
    });
  }

  // Get the return type from the function context
  const functionReturnType =
    context.isEvaluatingFunctionBodyOrAsyncBlock.kind === "function-body"
      ? context.isEvaluatingFunctionBodyOrAsyncBlock.type.return.type
      : VUnit.type;

  // If there's an argument, evaluate it and use as the panic message
  if (expr.args.length > 0) {
    const messageExpr = expr.args[0]!;
    const evaluatedMessageExpr = evaluateExpression({
      expr: messageExpr,
      env,
      context: {
        ...context,
      },
    });
    // Let's require it to be a comptime_string for now
    if (!evaluatedMessageExpr.$) {
      throw formatErrorMessage({
        token: messageExpr.token,
        errorMessage: `Failed to evaluate panic message`,
      });
    }
    if (
      !evaluatedMessageExpr.$.value ||
      (!isComptimeStringValue(evaluatedMessageExpr.$.value) &&
        !(
          isUnknownValue(evaluatedMessageExpr.$.value) &&
          isComptimeStringType(evaluatedMessageExpr.$.value.type)
        ))
    ) {
      throw formatErrorMessage({
        token: messageExpr.token,
        errorMessage: `panic message must be a comptime_string`,
      });
    }
  }

  // Set the expression's type to match the function's return type
  expr.$ = {
    env,
    type: functionReturnType,
    value: undefined, // panic never returns a value
    pathCollection: [],
  };

  return expr;
}
