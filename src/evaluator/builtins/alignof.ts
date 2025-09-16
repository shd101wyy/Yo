import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinFunctions,
  expectExprToBeFunctionCallOf,
  FuncCallExpr,
} from "../../expr";
import { createUsizeType, getAlignmentOfType, Type } from "../../types";
import {
  createNumberValue,
  createUnknownValue,
  isTypeValue,
  NumberValue,
  UnknownValue,
} from "../../value";
import { ValueTag } from "../../value-tag";
import { EvaluatorContext } from "../context";

export function evaluateAlignOf({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  expectExprToBeFunctionCallOf(expr, BuiltinFunctions.alignof, 1);

  const typeExpr = expr.args[0]!;
  // Evaluate the expression
  const evaluatedExpr = context.evaluateExpression({
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
  const typeAlign = getAlignmentOfType(typeToCheck);
  let typeAlignValue: UnknownValue | NumberValue;
  if (typeAlign === null) {
    typeAlignValue = createUnknownValue(createUsizeType()) as UnknownValue;
  } else {
    typeAlignValue = createNumberValue(
      ValueTag.Usize,
      typeAlign // alignment in bytes
    );
  }

  expr.$ = {
    env,
    type: createUsizeType(),
    value: typeAlignValue,
    pathCollection: [],
  };
  return expr;
}
