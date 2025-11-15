import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import { Expr, FuncCallExpr } from "../../expr";
import { areTypesCompatible, ComptListType, typeToString } from "../../types";
import { createComptListValue, Value } from "../../value";
import { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";

/**
 * This function creates an ComptList value from an ComptListType and initial values.
 * eg:
 *
 *   ExprList :: ComptList(Expr);
 *   list :: ExprList(quote(x), quote(y), quote(z));
 */
export function tryToImplementComptListByComptListType({
  expr,
  comptListType,
  argExprs,
  callerEnv,
  context,
}: {
  expr: FuncCallExpr;
  comptListType: ComptListType;
  argExprs: Expr[];
  callerEnv: Environment;
  context: EvaluatorContext;
}): Expr {
  // Evaluate each argument and check type compatibility
  const elements: Value[] = [];
  let env = callerEnv;

  const expectedElementType = comptListType.childType;

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
        errorMessage: `Failed to evaluate ComptList element at index ${i}.`,
      });
    }

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
        errorMessage: `ComptList element at index ${i} has incompatible type:
- Expected: ${typeToString(expectedElementType)}
- Given   : ${typeToString(evaluatedArg.$.type)}`,
      });
    }

    // Store the value if available (for compile-time ComptList)
    if (evaluatedArg.$.value !== undefined) {
      elements.push(evaluatedArg.$.value);
    } else {
      throw formatErrorMessage({
        token: argExpr.token,
        errorMessage: `Expected compile-time known value for ComptList element at index ${i}, got ${typeToString(evaluatedArg.$.type)}`,
      });
    }
  }

  // Create the compt list value
  const comptListValue = createComptListValue(
    comptListType.childType,
    elements
  );

  // Set the result
  expr.$ = {
    env,
    value: comptListValue,
    type: comptListType,
    pathCollection: [],
  };

  return expr;
}
