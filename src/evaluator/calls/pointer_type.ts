import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinFunctions,
  Expr,
  ExprTag,
  exprToString,
  FuncCallExpr,
  replaceExprWithFuncCallExpr,
} from "../../expr";
import { TokenType } from "../../token";
import { isPtrType, Type, typeToString } from "../../types";
import { createUnknownValue } from "../../value";
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
  expr: FuncCallExpr;
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
  const yoAsFuncExpr: FuncCallExpr = {
    tag: ExprTag.FuncCall,
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
      value: createUnknownValue(targetType),
      pathCollection: evaluatedArg.$.pathCollection,
      // Set runtimeArgExprsInOrder for codegen (only the value argument, not the type)
      runtimeArgExprsInOrder: [evaluatedArg],
    },
  };

  // Replace the original expr with the __yo_as call
  replaceExprWithFuncCallExpr(expr, yoAsFuncExpr);

  return { expr, env };
}
