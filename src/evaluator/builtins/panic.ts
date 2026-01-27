import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import { FnCallExpr } from "../../expr";
import { isComptStringType } from "../../types";
import {
  createUnknownValue,
  isComptStringValue,
  isUnknownValue,
} from "../../value";
import { EvaluatorContext } from "../context";
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
  /**
   * The old compt_assert also checks code like below. I am not sure if we should do the same here:
   *
   *   // Do nothing if we are not really executing.
   *   if (context.isValidatingFunctionDefinition || !context.isExecuting) {
   *     expr.$ = {
   *       env,
   *       type: VUnit.type,
   *       value: VUnit,
   *       pathCollection: [],
   *     };
   *     return expr;
   *   }
   *
   */

  // Check if panic is being called inside a function context
  if (context.isEvaluatingFunctionBodyOrAsyncBlock?.kind !== "function-body") {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `panic() can only be called inside a function body`,
    });
  }

  // Get the return type from the function context
  const functionReturnType =
    context.isEvaluatingFunctionBodyOrAsyncBlock.type.return.type;

  // Evaluate message if provided
  let message = "panic";
  if (expr.args.length > 0) {
    const messageExpr = expr.args[0]!;
    const evaluatedMessageExpr = evaluateExpression({
      expr: messageExpr,
      env,
      context: {
        ...context,
      },
    });
    // Let's require it to be a compt_string for now
    if (!evaluatedMessageExpr.$) {
      throw formatErrorMessage({
        token: messageExpr.token,
        errorMessage: `Failed to evaluate panic message`,
      });
    }
    if (
      !evaluatedMessageExpr.$.value ||
      (!isComptStringValue(evaluatedMessageExpr.$.value) &&
        !(
          isUnknownValue(evaluatedMessageExpr.$.value) &&
          isComptStringType(evaluatedMessageExpr.$.value.type)
        ))
    ) {
      throw formatErrorMessage({
        token: messageExpr.token,
        errorMessage: `panic message must be a compt_string`,
      });
    }

    // Extract the message string if it's a compile-time known value
    if (isComptStringValue(evaluatedMessageExpr.$.value)) {
      message = evaluatedMessageExpr.$.value.value;
    }
  }

  // Panic at compile-time should fail compilation only when:
  // - We're actually executing (not just analyzing/validating), AND
  // - We're not during CTFE capability analysis (which uses UnknownValue)
  //
  // We DON'T trigger during function definition validation (isValidatingFunctionDefinition)
  // because all branches are visited with UnknownValue, and we can't know if this
  // branch will actually be taken at runtime.
  if (context.isExecuting && !context.isAnalyzingCtfeCapability) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Panic at compile-time: ${message}`,
      isAssertionError: true,
    });
  }

  // Otherwise, return UnknownValue when in compile-time context (validation/analysis),
  // or undefined for runtime panic code generation
  expr.$ = {
    env,
    type: functionReturnType,
    value: context.isEvaluatingFunctionBodyOrAsyncBlock.type.return
      .isCompileTimeOnly
      ? createUnknownValue(functionReturnType)
      : undefined, // Runtime panic - no value
    pathCollection: [],
  };

  return expr;
}
