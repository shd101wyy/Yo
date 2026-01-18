import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinFunctions,
  expectExprToBeFunctionCallOf,
  FnCallExpr,
} from "../../expr";
import { createUsizeType, getSizeOfType, Type } from "../../types";
import {
  createNumberValue,
  createUnknownValue,
  isTypeValue,
  NumberValue,
  UnknownValue,
} from "../../value";
import { ValueTag } from "../../value-tag";
import { EvaluatorContext } from "../context";
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
    typeSizeValue = createUnknownValue(createUsizeType()) as UnknownValue;
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
