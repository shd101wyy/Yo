import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import { exprToString, FuncCallExpr } from "../../expr";
import { createChanType } from "../../types";
import { createTypeValue, isTypeValue } from "../../value";
import { EvaluatorContext } from "../context";
import { addARCFunctionsToChanType } from "./utils";

/**
 * Evaluate a Chan type constructor call
 * For example:
 *
 * ChanType :: Chan(i32, 0);    // unbuffered channel of i32
 * ChanType :: Chan(String, 10); // buffered channel of String with buffer size 10
 * chan_var: Chan(i32, 0) := chan(i32, 0);
 */
export function evaluateChanType({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  // Chan type constructor expects exactly 2 arguments (element type and buffer size)
  if (expr.args.length !== 2) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Chan type constructor expects exactly 2 arguments, got ${expr.args.length}. Usage: Chan(ElementType, BufferSize)`,
    });
  }

  const elementTypeExpr = expr.args[0]!;
  const bufferSizeExpr = expr.args[1]!;

  // Evaluate element type expression
  const evaluatedElementTypeExpr = context.evaluateExpression({
    expr: elementTypeExpr,
    env,
    context: { ...context },
  });

  if (!evaluatedElementTypeExpr.$) {
    throw formatErrorMessage({
      token: elementTypeExpr.token,
      errorMessage: `Failed to evaluate the element type expression for Chan:\n${exprToString(
        elementTypeExpr
      )}`,
    });
  }
  env = evaluatedElementTypeExpr.$.env;

  // Check if the element type expression is a type
  if (!isTypeValue(evaluatedElementTypeExpr.$.value)) {
    throw formatErrorMessage({
      token: elementTypeExpr.token,
      errorMessage: `Chan type constructor expects a type as its first argument, but got:\n${exprToString(
        elementTypeExpr
      )}`,
    });
  }

  const elementType = evaluatedElementTypeExpr.$.value.value;

  // Evaluate buffer size expression
  const evaluatedBufferSizeExpr = context.evaluateExpression({
    expr: bufferSizeExpr,
    env,
    context: { ...context },
  });

  if (!evaluatedBufferSizeExpr.$) {
    throw formatErrorMessage({
      token: bufferSizeExpr.token,
      errorMessage: `Failed to evaluate the buffer size expression for Chan:\n${exprToString(
        bufferSizeExpr
      )}`,
    });
  }
  env = evaluatedBufferSizeExpr.$.env;

  // The buffer size must be a compile-time value
  if (!evaluatedBufferSizeExpr.$.value) {
    throw formatErrorMessage({
      token: bufferSizeExpr.token,
      errorMessage: `Chan type constructor expects a compile-time known buffer size, but got a runtime value:\n${exprToString(
        bufferSizeExpr
      )}`,
    });
  }

  const bufferSizeValue = evaluatedBufferSizeExpr.$.value;

  // Create the Chan type
  const chanType = createChanType(elementType, bufferSizeValue, env);

  // Add ARC functions to the channel type
  env = addARCFunctionsToChanType({
    chanType,
    env,
    context,
  });

  const typeValueForChan = createTypeValue(chanType);

  expr.$ = {
    env,
    type: typeValueForChan.type,
    value: typeValueForChan,
    pathCollection: [],
  };
  return expr;
}
