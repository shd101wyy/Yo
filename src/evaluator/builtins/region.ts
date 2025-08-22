import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinFunctions,
  exprIsFunctionCallOf,
  exprToString,
  FuncCallExpr,
} from "../../expr";
import { createBooleanType, isRegionType } from "../../types";
import {
  areValuesEqual,
  createBooleanValue,
  createUnknownValue,
  isRegionValue,
  Value,
} from "../../value";
import { EvaluatorContext } from "../context";

export function evaluateYoRegionFunctions({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  if (
    exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_region_eq) ||
    exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_region_neq) ||
    exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_region_lt) ||
    exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_region_lte) ||
    exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_region_gt) ||
    exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_region_gte)
  ) {
    const leftArg = context.evaluateExpression({
      expr: expr.args[0]!,
      env,
      context: {
        ...context,
      },
    });

    if (!leftArg.$ || !isRegionType(leftArg.$.type) || !leftArg.$.value) {
      throw formatErrorMessage({
        token: leftArg.token,
        errorMessage: `Expected region type for "${expr.func.token.value}" left argument, got:\n${exprToString(
          leftArg
        )}`,
      });
    }
    env = leftArg.$.env;

    const rightArg = context.evaluateExpression({
      expr: expr.args[1]!,
      env,
      context: {
        ...context,
      },
    });

    if (!rightArg.$ || !isRegionType(rightArg.$.type) || !rightArg.$.value) {
      throw formatErrorMessage({
        token: rightArg.token,
        errorMessage: `Expected region type for "${expr.func.token.value}" right argument, got:\n${exprToString(
          rightArg
        )}`,
      });
    }
    env = rightArg.$.env;

    let value: Value;
    // eq(x, y)
    if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_region_eq)) {
      value = createBooleanValue(
        areValuesEqual(
          { value: leftArg.$.value, env: leftArg.$.env },
          { value: rightArg.$.value, env: rightArg.$.env }
        )
      );
    }
    // neq(x, y)
    else if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_region_neq)) {
      value = createBooleanValue(
        !areValuesEqual(
          { value: leftArg.$.value, env: leftArg.$.env },
          { value: rightArg.$.value, env: rightArg.$.env }
        )
      );
    }
    // lt(x, y) - x has shorter lifetime than y (x.lifetime > y.lifetime)
    else if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_region_lt)) {
      if (isRegionValue(leftArg.$.value) && isRegionValue(rightArg.$.value)) {
        value = createBooleanValue(
          leftArg.$.value.lifetime > rightArg.$.value.lifetime
        );
      } else {
        value = createUnknownValue(createBooleanType());
      }
    }
    // lte(x, y) - x has shorter or equal lifetime than y (x.lifetime >= y.lifetime)
    else if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_region_lte)) {
      if (isRegionValue(leftArg.$.value) && isRegionValue(rightArg.$.value)) {
        value = createBooleanValue(
          leftArg.$.value.lifetime >= rightArg.$.value.lifetime
        );
      } else {
        value = createUnknownValue(createBooleanType());
      }
    }
    // gt(x, y) - x has longer lifetime than y (x.lifetime < y.lifetime)
    else if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_region_gt)) {
      if (isRegionValue(leftArg.$.value) && isRegionValue(rightArg.$.value)) {
        value = createBooleanValue(
          leftArg.$.value.lifetime < rightArg.$.value.lifetime
        );
      } else {
        value = createUnknownValue(createBooleanType());
      }
    }
    // gte(x, y) - x has longer or equal lifetime than y (x.lifetime <= y.lifetime)
    else if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_region_gte)) {
      if (isRegionValue(leftArg.$.value) && isRegionValue(rightArg.$.value)) {
        value = createBooleanValue(
          leftArg.$.value.lifetime <= rightArg.$.value.lifetime
        );
      } else {
        value = createUnknownValue(createBooleanType());
      }
    } else {
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `Unknown region function: ${expr.func.token.value}`,
      });
    }

    expr.$ = {
      env,
      type: createBooleanType(),
      value,
      isMutable: false,
      pathCollection: [],
    };
    return expr;
  }

  throw formatErrorMessage({
    token: expr.token,
    errorMessage: `Unknown expression for region function evaluation: ${exprToString(expr)}`,
  });
}
