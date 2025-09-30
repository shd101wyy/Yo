import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import { exprToString, FuncCallExpr } from "../../expr";
import { createThreadType } from "../../types";
import { createTypeValue, isTypeValue } from "../../value";
import { EvaluatorContext } from "../context";

/**
 * Evaluate a Thread type constructor call
 * For example:
 *
 * ThreadType :: Thread(i32);
 * thread: Thread(i32) := spawn someFunction();
 */
export function evaluateThreadCall({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  // Thread type constructor expects exactly 1 argument (the return type)
  if (expr.args.length !== 1) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Thread type constructor expects exactly 1 argument, got ${expr.args.length}. Usage: Thread(ReturnType)`,
    });
  }

  const argExpr = expr.args[0]!;

  const evaluatedArgExpr = context.evaluateExpression({
    expr: argExpr,
    env,
    context: {
      ...context,
    },
  });

  if (!evaluatedArgExpr.$) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Failed to evaluate the argument expression for Thread:\n${exprToString(
        argExpr
      )}`,
    });
  }
  env = evaluatedArgExpr.$.env;

  // Check if the argExpr is a type
  if (isTypeValue(evaluatedArgExpr.$.value)) {
    const typeValue = evaluatedArgExpr.$.value;
    const returnType = typeValue.value;

    // Create the Thread type
    const threadType = createThreadType(returnType, env);
    const typeValueForThread = createTypeValue(threadType);

    expr.$ = {
      env,
      type: typeValueForThread.type,
      value: typeValueForThread,
      pathCollection: [],
    };
    return expr;
  }
  // If not a type value, this is an error
  else {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Thread type constructor expects a type argument, but got a value:\n${exprToString(
        argExpr
      )}`,
    });
  }
}
