import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinKeywords,
  exprIsAtom,
  exprIsFunctionCallOf,
  exprToString,
  FuncCallExpr,
} from "../../expr";
import {
  createClosureType,
  FunctionType,
  isFunctionType,
  Type,
} from "../../types";
import { createTypeValue, isTypeValue } from "../../value";
import { EvaluatorContext } from "../context";

export function evaluateClosureType({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  if (!exprIsFunctionCallOf(expr, BuiltinKeywords.Closure, 2)) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expected "Closure(captureType, callType)" with 2 arguments
Examples:
  Closure(MyCapture, FnMut(elem: i32) -> i32)
  Closure(_, Fn(elem: i32) -> i32)
  Closure(MyCapture, _(elem: i32) -> i32)

Got:\n${exprToString(expr)}`,
    });
  }

  const captureTypeExpr = expr.args[0]!;
  const callTypeExpr = expr.args[1]!;

  // Check if capture type is underscore placeholder for inference
  const isCaptureUnderscore =
    exprIsAtom(captureTypeExpr) && captureTypeExpr.token.value === "_";

  // Check if call type is underscore placeholder for inference
  const isCallUnderscore =
    exprIsAtom(callTypeExpr) && callTypeExpr.token.value === "_";

  let captureType: Type | undefined = undefined;
  let currentEnv = env;

  // Handle capture type
  if (isCaptureUnderscore) {
    // For now, we'll require explicit capture types
    // TODO: Implement capture type inference
    throw formatErrorMessage({
      token: captureTypeExpr.token,
      errorMessage: `Capture type inference with "_" is not yet implemented. Please specify an explicit capture type.`,
    });
  } else {
    // Evaluate the capture type expression
    const evaluatedCaptureTypeExpr = context.evaluateExpression({
      expr: captureTypeExpr,
      env: currentEnv,
      context: {
        ...context,
      },
    });

    if (!evaluatedCaptureTypeExpr.$) {
      throw formatErrorMessage({
        token: captureTypeExpr.token,
        errorMessage: `Failed to evaluate the capture type expression:\n${exprToString(
          captureTypeExpr
        )}`,
      });
    }

    if (!isTypeValue(evaluatedCaptureTypeExpr.$.value)) {
      throw formatErrorMessage({
        token: captureTypeExpr.token,
        errorMessage: `Expected type for capture type, got:\n${exprToString(captureTypeExpr)}`,
      });
    }

    const evaluatedCaptureType = evaluatedCaptureTypeExpr.$.value.value;

    // For now, accept any type as capture type until we implement proper generic handling
    // TODO: Implement proper validation that ensures the capture type is appropriate
    captureType = evaluatedCaptureType;
    currentEnv = evaluatedCaptureTypeExpr.$.env;
  }

  let callType: FunctionType | undefined = undefined;

  // Handle call type
  if (isCallUnderscore) {
    // For now, we'll require explicit call types
    // TODO: Implement call type inference
    throw formatErrorMessage({
      token: callTypeExpr.token,
      errorMessage: `Call type inference with "_" is not yet implemented. Please specify an explicit call type.`,
    });
  } else {
    // Evaluate the call type expression
    const evaluatedCallTypeExpr = context.evaluateExpression({
      expr: callTypeExpr,
      env: currentEnv,
      context: {
        ...context,
        isEvaluatingClosureCallType: true, // Set flag to allow FnOnce/FnMut/Fn
      },
    });

    if (!evaluatedCallTypeExpr.$) {
      throw formatErrorMessage({
        token: callTypeExpr.token,
        errorMessage: `Failed to evaluate the call type expression:\n${exprToString(
          callTypeExpr
        )}`,
      });
    }

    if (!isTypeValue(evaluatedCallTypeExpr.$.value)) {
      throw formatErrorMessage({
        token: callTypeExpr.token,
        errorMessage: `Expected type for call type, got:\n${exprToString(callTypeExpr)}`,
      });
    }

    const evaluatedCallType = evaluatedCallTypeExpr.$.value.value;
    if (!isFunctionType(evaluatedCallType)) {
      throw formatErrorMessage({
        token: callTypeExpr.token,
        errorMessage: `Expected function type for call type, got:\n${exprToString(callTypeExpr)}`,
      });
    }

    // Validate that the function type has a closure kind
    if (!evaluatedCallType.closureKind) {
      throw formatErrorMessage({
        token: callTypeExpr.token,
        errorMessage: `Expected closure function type (Fn/FnMut/FnOnce) for call type, got regular function type:\n${exprToString(callTypeExpr)}`,
      });
    }

    callType = evaluatedCallType;
    currentEnv = evaluatedCallTypeExpr.$.env;
  }

  // Create the closure type
  if (!callType) {
    throw formatErrorMessage({
      token: callTypeExpr.token,
      errorMessage: `Cannot create closure type without a concrete call type`,
    });
  }

  const closureType = createClosureType(captureType, callType, currentEnv);
  const closureTypeValue = createTypeValue(closureType);

  expr.$ = {
    env: currentEnv,
    type: closureTypeValue.type,
    value: closureTypeValue,
    isMutable: false,
    pathCollection: [],
  };

  return expr;
}
