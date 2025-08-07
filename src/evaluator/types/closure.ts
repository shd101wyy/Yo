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
  createSomeType,
  createTypeType,
  FunctionType,
  isFunctionType,
  isSomeType,
  isStructType,
  SomeType,
  StructType,
} from "../../types";
import { randomId } from "../../utils";
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
      errorMessage: `Expected "Closure(callType, captureType)" with 2 arguments
Examples:
  Closure(FnMut(elem: i32) -> i32, MyCapture)
  Closure(Fn(elem: i32) -> i32, _)
  Closure(_(elem: i32) -> i32, MyCapture)

Got:\n${exprToString(expr)}`,
    });
  }

  const callTypeExpr = expr.args[0]!;
  const captureTypeExpr = expr.args[1]!;

  // Check if capture type is underscore placeholder for inference
  const isCaptureUnderscore =
    exprIsAtom(captureTypeExpr) && captureTypeExpr.token.value === "_";

  // Check if call type is underscore placeholder for inference
  const isCallUnderscore =
    exprIsAtom(callTypeExpr) && callTypeExpr.token.value === "_";

  let captureType: SomeType | StructType;
  let currentEnv = env;

  // Handle capture type
  if (isCaptureUnderscore) {
    // Create a SomeType for inference with a unique name
    const captureTypePlaceholderName = `_capture_${randomId()}`;
    captureType = createSomeType(createTypeType(), captureTypePlaceholderName);
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

    // Ensure the capture type is either SomeType or StructType
    if (
      isSomeType(evaluatedCaptureType) ||
      isStructType(evaluatedCaptureType)
    ) {
      captureType = evaluatedCaptureType;
    } else {
      throw formatErrorMessage({
        token: captureTypeExpr.token,
        errorMessage: `Expected SomeType or StructType for capture type, got: ${evaluatedCaptureType.tag}`,
      });
    }

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
        isEvaluatingClosureCallType: true, // Set flag to allow FnMove/FnMut/Fn
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
        errorMessage: `Expected closure function type (Fn/FnMut/FnMove) for call type, got regular function type:\n${exprToString(callTypeExpr)}`,
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

  const closureType = createClosureType(callType, captureType, currentEnv);
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
