import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import { exprToString, FuncCallExpr } from "../../expr";
import { TypeValue } from "../../type-value";
import { areTypesCompatible, typeToString } from "../../types";
import { isTypeValue } from "../../value";
import { EvaluatorContext } from "../context";

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
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  if (expr.args.length !== 2) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `"as" function expects exactly 2 arguments, got ${expr.args.length}`,
    });
  }

  // Evaluate the value argument
  const valueExpr = context.evaluateExpression({
    expr: expr.args[0]!,
    env,
    context: {
      ...context,
    },
  });

  if (!valueExpr.$) {
    throw formatErrorMessage({
      token: valueExpr.token,
      errorMessage: `Failed to evaluate value argument for "as":\n${exprToString(
        valueExpr
      )}`,
    });
  }

  // Evaluate the type argument
  const typeExpr = context.evaluateExpression({
    expr: expr.args[1]!,
    env: valueExpr.$.env,
    context: {
      ...context,
    },
  });

  if (!typeExpr.$) {
    throw formatErrorMessage({
      token: typeExpr.token,
      errorMessage: `Failed to evaluate type argument for "as":\n${exprToString(
        typeExpr
      )}`,
    });
  }

  // Check if the second argument is a type
  if (!isTypeValue(typeExpr.$.value)) {
    throw formatErrorMessage({
      token: typeExpr.token,
      errorMessage: `Second argument to "as" must be a type, got:\n${exprToString(
        typeExpr
      )}`,
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
    isMutable: valueExpr.$.isMutable,
    pathCollection: valueExpr.$.pathCollection,
  };

  return expr;
}
