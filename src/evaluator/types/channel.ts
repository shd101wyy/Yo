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
 * ChanType :: Chan(i32);       // channel of i32 (buffer size not part of type)
 * ChanType :: Chan(String);    // channel of String
 * chan_var: Chan(i32) := chan(i32);      // unbuffered channel
 * chan_var: Chan(i32) := chan(i32, 10);  // buffered channel (same type)
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
  // Chan type constructor expects exactly 1 argument (element type)
  // Buffer size is not part of the type (following Go's design)
  if (expr.args.length !== 1) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Chan type constructor expects exactly 1 argument, got ${expr.args.length}. Usage: Chan(ElementType)`,
    });
  }

  const elementTypeExpr = expr.args[0]!;

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

  // Create the Chan type (buffer size is not part of the type, following Go's design)
  const chanType = createChanType(elementType, env);

  // Add ARC functions to the channel type
  env = addARCFunctionsToChanType({
    chanType,
    env,
    context: { ...context },
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
