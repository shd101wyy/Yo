import type { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import { exprToString, type FnCallExpr } from "../../expr";
import type { TypeValue } from "../../type-value";
import { areTypesCompatible } from "../../types/compatibility";
import { typeToString } from "../../types/utils";
import { isTypeValue } from "../../value";
import type { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";

/**
 * Type casting function `as`.
 * Takes two arguments: value and target type.
 * Returns the value cast to the target type if compatible.
 */
export function evaluateAs({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FnCallExpr {
  if (expr.args.length !== 2) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `"as" function expects exactly 2 arguments, got ${expr.args.length}`,
    });
  }

  // Evaluate the value argument
  const valueExpr = evaluateExpression({
    expr: expr.args[0]!,
    env,
    context: {
      ...context,
    },
  });

  if (!valueExpr.$) {
    throw formatErrorMessage({
      token: valueExpr.token,
      errorMessage: `Failed to evaluate value argument for "as":\n${exprToString(valueExpr)}`,
    });
  }

  // Evaluate the type argument
  const typeExpr = evaluateExpression({
    expr: expr.args[1]!,
    env: valueExpr.$.env,
    context: {
      ...context,
    },
  });

  if (!typeExpr.$) {
    throw formatErrorMessage({
      token: typeExpr.token,
      errorMessage: `Failed to evaluate type argument for "as":\n${exprToString(typeExpr)}`,
    });
  }

  // Check if the second argument is a type
  if (!isTypeValue(typeExpr.$.value)) {
    throw formatErrorMessage({
      token: typeExpr.token,
      errorMessage: `Second argument to "as" must be a type, got:\n${exprToString(typeExpr)}`,
    });
  }

  const targetType = (typeExpr.$.value as TypeValue).value;
  const sourceType = valueExpr.$.type;
  env = typeExpr.$.env;

  // Check if types are compatible for casting
  if (
    !areTypesCompatible({ type: targetType, env }, { type: sourceType, env })
  ) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Cannot cast from type "${typeToString(sourceType)}" to type "${typeToString(targetType)}" - types are not compatible`,
    });
  }

  // Return the value with the new type
  expr.$ = {
    env,
    type: targetType,
    value: valueExpr.$.value,
    pathCollection: valueExpr.$.pathCollection,
  };

  return expr;
}
