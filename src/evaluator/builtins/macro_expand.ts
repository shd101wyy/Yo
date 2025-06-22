import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinFunctions,
  expectExprToBeFunctionCallOf,
  exprIsFunctionCall,
  FuncCallExpr,
} from "../../expr";
import { createExprType, isExprType, typeToString } from "../../type-checker";
import { isExprValue } from "../../value";
import { evaluateFunctionCall } from "../calls/function";
import { EvaluatorContext } from "../context";

/**
 * macro_expand will expand the macro call and return the expanded expression.
 * eg:
 *
 *   macro_expand(quote(3 + 4));
 *   macro_expand(quote(if true, 1, 2));
 *
 * It accepts an Expr as an argument.
 */
export function evaluateMacroExpand({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  expectExprToBeFunctionCallOf(expr, BuiltinFunctions.macro_expand, 1);

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
      errorMessage: `Failed to evaluate the argument expression for "macro_expand":\n${argExpr.toString()}`,
    });
  }
  env = evaluatedArgExpr.$.env;

  if (!isExprType(evaluatedArgExpr.$.type)) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `The argument expression for "macro_expand" must be an Expr value, but got: ${typeToString(evaluatedArgExpr.$.type)}`,
    });
  }

  const exprValue = evaluatedArgExpr.$.value;
  if (isExprValue(exprValue)) {
    const exprToExpand = exprValue.value;
    if (exprIsFunctionCall(exprToExpand)) {
      const expandedExpr = evaluateFunctionCall({
        expr: exprToExpand,
        env: env,
        context: {
          ...context,
        },
        forMacroExpansion: true,
      });
      expr.$ = {
        env,
        type: createExprType(),
        value: expandedExpr.$!.value,
        isMutable: evaluatedArgExpr.$.isMutable,
        pathCollection: evaluatedArgExpr.$.pathCollection,
      };
    } else {
      // No need to expand the expression, just return it as is.
      expr.$ = {
        env,
        type: evaluatedArgExpr.$.type,
        value: evaluatedArgExpr.$.value,
        isMutable: evaluatedArgExpr.$.isMutable,
        pathCollection: evaluatedArgExpr.$.pathCollection,
      };
    }
  } else {
    // Unknown value;
    expr.$ = {
      env,
      type: evaluatedArgExpr.$.type,
      value: evaluatedArgExpr.$.value,
      isMutable: evaluatedArgExpr.$.isMutable,
      pathCollection: evaluatedArgExpr.$.pathCollection,
    };
  }
  return expr;
}
