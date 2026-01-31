import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import { Expr, FnCallExpr, setExprAsNeedsToCallDup } from "../../expr";
import {
  areTypesCompatible,
  ComptimeListType,
  typeToString,
} from "../../types";
import { createComptimeListValue, Value } from "../../value";
import { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";

/**
 * This function creates an ComptimeList value from an ComptimeListType and initial values.
 * eg:
 *
 *   ExprList :: ComptimeList(Expr);
 *   list :: ExprList(quote(x), quote(y), quote(z));
 */
export function tryToImplementComptimeListByComptimeListType({
  expr,
  comptimeListType,
  argExprs,
  callerEnv,
  context,
}: {
  expr: FnCallExpr;
  comptimeListType: ComptimeListType;
  argExprs: Expr[];
  callerEnv: Environment;
  context: EvaluatorContext;
}): Expr {
  // Evaluate each argument and check type compatibility
  const elements: Value[] = [];
  let env = callerEnv;

  const expectedElementType = comptimeListType.childType;

  for (let i = 0; i < argExprs.length; i++) {
    const argExpr = argExprs[i]!;

    // Evaluate the argument with the expected element type
    const evaluatedArg = evaluateExpression({
      expr: argExpr,
      env,
      context: {
        ...context,
        expectedType: { type: expectedElementType, env },
      },
    });

    if (!evaluatedArg.$) {
      throw formatErrorMessage({
        token: argExpr.token,
        errorMessage: `Failed to evaluate ComptimeList element at index ${i}.`,
      });
    }

    setExprAsNeedsToCallDup(evaluatedArg, context);

    env = evaluatedArg.$.env;

    // Check type compatibility with the expected element type
    if (
      !areTypesCompatible(
        { type: expectedElementType, env },
        { type: evaluatedArg.$.type, env }
      )
    ) {
      throw formatErrorMessage({
        token: argExpr.token,
        errorMessage: `ComptimeList element at index ${i} has incompatible type:
- Expected: ${typeToString(expectedElementType)}
- Given   : ${typeToString(evaluatedArg.$.type)}`,
      });
    }

    // Store the value if available (for compile-time ComptimeList)
    if (evaluatedArg.$.value !== undefined) {
      elements.push(evaluatedArg.$.value);
    } else {
      throw formatErrorMessage({
        token: argExpr.token,
        errorMessage: `Expected compile-time known value for ComptimeList element at index ${i}, got ${typeToString(evaluatedArg.$.type)}`,
      });
    }
  }

  // Create the comptime list value
  const comptimeListValue = createComptimeListValue(
    comptimeListType.childType,
    elements
  );

  // Set the result
  expr.$ = {
    env,
    value: comptimeListValue,
    type: comptimeListType,
    pathCollection: [],
  };

  return expr;
}
