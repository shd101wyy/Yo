import type { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinFunctions,
  expectExprToBeFunctionCallOf,
  type FnCallExpr,
} from "../../expr";
import { createUsizeType } from "../../types/creators";
import type { Type } from "../../types/definitions";
import { getSizeOfType } from "../../types/utils";
import {
  createNumberValue,
  createUnknownValue,
  isTypeValue,
  type NumberValue,
  type UnknownValue,
} from "../../value";
import { ValueTag } from "../../value-tag";
import type { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";

export function evaluateSizeOf({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FnCallExpr {
  expectExprToBeFunctionCallOf(expr, BuiltinFunctions.sizeof, 1);

  const typeExpr = expr.args[0]!;
  // Evaluate the expression
  const evaluatedExpr = evaluateExpression({
    expr: typeExpr,
    env,
    context: {
      ...context,
    },
  });
  if (!evaluatedExpr.$) {
    throw formatErrorMessage({
      token: typeExpr.token,
      errorMessage: `Failed to evaluate expression.`,
    });
  }
  env = evaluatedExpr.$.env;

  // Check if it's a type value
  let typeToCheck: Type;
  if (evaluatedExpr.$.value && isTypeValue(evaluatedExpr.$.value)) {
    typeToCheck = evaluatedExpr.$.value.value;
  } else {
    typeToCheck = evaluatedExpr.$.type;
  }
  const typeSizeInBits = getSizeOfType(typeToCheck);
  let typeSizeValue: UnknownValue | NumberValue;
  if (typeSizeInBits === null) {
    typeSizeValue = createUnknownValue(createUsizeType(), {
      env,
      context,
    }) as UnknownValue;
  } else {
    typeSizeValue = createNumberValue(
      ValueTag.Usize,
      Math.ceil(typeSizeInBits / 8) // Convert bits to bytes
    );
  }

  expr.$ = {
    env,
    type: createUsizeType(),
    value: typeSizeValue,
    pathCollection: [],
  };
  return expr;
}
