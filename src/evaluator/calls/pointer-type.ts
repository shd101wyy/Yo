import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinFunctions,
  Expr,
  ExprTag,
  exprToString,
  FnCallExpr,
  replaceExprWithFuncCallExpr,
} from "../../expr";
import { TokenType } from "../../token";
import { Type } from "../../types/definitions";
import { isPtrType } from "../../types/guards";
import { typeToString } from "../../types/utils";
import { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";

/**
 * Try to convert a value to a pointer type by casting.
 * Returns the result if successful, or undefined if this is not a pointer type call.
 */
export function tryToConvertToPointerType({
  targetType,
  argExpr,
  expr,
  callerEnv,
  context,
}: {
  targetType: Type;
  argExpr: Expr;
  expr: FnCallExpr;
  callerEnv: Environment;
  context: EvaluatorContext;
}): { expr: Expr; env: Environment } | undefined {
  if (!isPtrType(targetType)) {
    return undefined;
  }

  // Evaluate the argument
  const evaluatedArg = evaluateExpression({
    expr: argExpr,
    env: callerEnv,
    context: { ...context, expectedType: undefined },
  });

  if (!evaluatedArg.$) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Failed to evaluate argument: ${exprToString(argExpr)}`,
    });
  }

  const env = evaluatedArg.$.env;
  const argType = evaluatedArg.$.type;

  // Check if the source is also a pointer type
  if (!isPtrType(argType)) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Cannot cast ${typeToString(argType)} to ${typeToString(targetType)}. Expected a pointer type.`,
    });
  }

  // Create __yo_as(value, TargetType) call for runtime pointer casting
  // Reuse the generic __yo_as builtin for pointer casting
  const yoAsFuncExpr: FnCallExpr = {
    tag: ExprTag.FnCall,
    func: {
      tag: ExprTag.Atom,
      token: {
        ...expr.token,
        value: BuiltinFunctions.__yo_as[0]!,
        type: TokenType.Identifier,
      },
      $: undefined,
    },
    // Pass the evaluated argument and the type expression
    args: [evaluatedArg, expr.func],
    token: expr.token,
    $: {
      env,
      type: targetType,
      value: undefined, // Pointer casting is only available at runtime
      pathCollection: evaluatedArg.$.pathCollection,
      // Set runtimeArgExprsInOrder for codegen (only the value argument, not the type)
      runtimeArgExprsInOrder: [evaluatedArg],
    },
  };

  // Replace the original expr with the __yo_as call
  replaceExprWithFuncCallExpr(expr, yoAsFuncExpr);

  return { expr, env };
}
