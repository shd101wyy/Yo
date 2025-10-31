import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinFunctions,
  exprIsFunctionCallOf,
  exprToString,
  FuncCallExpr,
} from "../../expr";
import {
  createBooleanType,
  createComptFloatType,
  createComptIntType,
  createComptStringType,
  isComptFloatType,
} from "../../types";
import {
  createBooleanValue,
  createComptFloatValue,
  createComptIntValue,
  createComptStringValue,
  createUnknownValue,
  isComptFloatValue,
  Value,
} from "../../value";
import { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";

export function evaluateYoComptFloatFunctions({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  if (
    exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_float_neg) ||
    exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_float_to_int) ||
    exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_float_to_string)
  ) {
    const arg = evaluateExpression({
      expr: expr.args[0]!,
      env,
      context: {
        ...context,
      },
    });

    if (!arg.$ || !isComptFloatType(arg.$.type) || !arg.$.value) {
      throw formatErrorMessage({
        token: arg.token,
        errorMessage: `Expected compt_float type for "${expr.func.token.value}" argument, got:\n${exprToString(
          arg
        )}`,
      });
    }
    env = arg.$.env;

    let value: Value;
    // -(x)
    if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_float_neg)) {
      if (isComptFloatValue(arg.$.value)) {
        value = createComptFloatValue(-arg.$.value.value);
      } else {
        value = createUnknownValue(createComptFloatType());
      }
    }
    // to_int(x)
    else if (
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_float_to_int)
    ) {
      if (isComptFloatValue(arg.$.value)) {
        value = createComptIntValue(Math.floor(arg.$.value.value));
      } else {
        value = createUnknownValue(createComptIntType());
      }
    }
    // to_string(x)
    else if (
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_float_to_string)
    ) {
      if (isComptFloatValue(arg.$.value)) {
        value = createComptStringValue(arg.$.value.value.toString());
      } else {
        value = createUnknownValue(createComptStringType());
      }
    } else {
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `Unexpected function call for "${expr.func.token.value}", expected "__yo_compt_float_neg" function`,
      });
    }
    expr.$ = {
      env,
      type: value.type,
      value: value,
      pathCollection: [],
    };
  } else {
    const lhs = evaluateExpression({
      expr: expr.args[0]!,
      env,
      context: {
        ...context,
      },
    });

    if (!lhs.$ || !isComptFloatType(lhs.$.type) || !lhs.$.value) {
      throw formatErrorMessage({
        token: lhs.token,
        errorMessage: `Expected compt_float type for "${expr.func.token.value}" first argument, got:\n${exprToString(
          lhs
        )}`,
      });
    }
    env = lhs.$.env;

    const rhs = evaluateExpression({
      expr: expr.args[1]!,
      env,
      context: {
        ...context,
      },
    });

    if (!rhs.$ || !isComptFloatType(rhs.$.type) || !rhs.$.value) {
      throw formatErrorMessage({
        token: rhs.token,
        errorMessage: `Expected compt_float type for "${expr.func.token.value}" second argument, got:\n${exprToString(
          rhs
        )}`,
      });
    }
    env = rhs.$.env;

    const lhsValue = lhs.$.value;
    const rhsValue = rhs.$.value;

    let value: Value;

    // x + y
    if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_float_add)) {
      if (isComptFloatValue(lhsValue) && isComptFloatValue(rhsValue)) {
        value = createComptFloatValue(lhsValue.value + rhsValue.value);
      } else {
        value = createUnknownValue(createComptFloatType());
      }
    }
    // x - y
    else if (
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_float_sub)
    ) {
      if (isComptFloatValue(lhsValue) && isComptFloatValue(rhsValue)) {
        value = createComptFloatValue(lhsValue.value - rhsValue.value);
      } else {
        value = createUnknownValue(createComptFloatType());
      }
    }
    // x * y
    else if (
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_float_mul)
    ) {
      if (isComptFloatValue(lhsValue) && isComptFloatValue(rhsValue)) {
        value = createComptFloatValue(lhsValue.value * rhsValue.value);
      } else {
        value = createUnknownValue(createComptFloatType());
      }
    }
    // x / y
    else if (
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_float_div)
    ) {
      if (isComptFloatValue(lhsValue) && isComptFloatValue(rhsValue)) {
        if (rhsValue.value === 0) {
          throw formatErrorMessage({
            token: rhs.token,
            errorMessage: `Division by zero in "${expr.func.token.value}" operation`,
          });
        }

        value = createComptFloatValue(lhsValue.value / rhsValue.value);
      } else {
        value = createUnknownValue(createComptFloatType());
      }
    }
    // x == y
    else if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_float_eq)) {
      if (isComptFloatValue(lhsValue) && isComptFloatValue(rhsValue)) {
        value = createBooleanValue(lhsValue.value == rhsValue.value);
      } else {
        value = createUnknownValue(createBooleanType());
      }
    }
    // x != y
    else if (
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_float_neq)
    ) {
      if (isComptFloatValue(lhsValue) && isComptFloatValue(rhsValue)) {
        value = createBooleanValue(lhsValue.value != rhsValue.value);
      } else {
        value = createUnknownValue(createBooleanType());
      }
    }
    // x < y
    else if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_float_lt)) {
      if (isComptFloatValue(lhsValue) && isComptFloatValue(rhsValue)) {
        value = createBooleanValue(lhsValue.value < rhsValue.value);
      } else {
        value = createUnknownValue(createBooleanType());
      }
    }
    // x <= y
    else if (
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_float_lte)
    ) {
      if (isComptFloatValue(lhsValue) && isComptFloatValue(rhsValue)) {
        value = createBooleanValue(lhsValue.value <= rhsValue.value);
      } else {
        value = createUnknownValue(createBooleanType());
      }
    }
    // x > y
    else if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_float_gt)) {
      if (isComptFloatValue(lhsValue) && isComptFloatValue(rhsValue)) {
        value = createBooleanValue(lhsValue.value > rhsValue.value);
      } else {
        value = createUnknownValue(createBooleanType());
      }
    }
    // x >= y
    else if (
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_float_gte)
    ) {
      if (isComptFloatValue(lhsValue) && isComptFloatValue(rhsValue)) {
        value = createBooleanValue(lhsValue.value >= rhsValue.value);
      } else {
        value = createUnknownValue(createBooleanType());
      }
    } else {
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `Unexpected function call for compt_float arithmetic: ${exprToString(
          expr
        )}`,
      });
    }

    expr.$ = {
      env,
      type: value.type,
      value: value,
      pathCollection: [],
    };
  }

  return expr;
}
