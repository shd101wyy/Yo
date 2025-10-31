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
  isComptIntType,
} from "../../types";
import {
  createBooleanValue,
  createComptFloatValue,
  createComptIntValue,
  createComptStringValue,
  createUnknownValue,
  isComptIntValue,
  Value,
} from "../../value";
import { EvaluatorContext } from "../context";

export function evaluateYoComptIntFunctions({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  if (
    exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_int_neg) ||
    exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_int_to_float) ||
    exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_int_to_string)
  ) {
    const arg = context.evaluateExpression({
      expr: expr.args[0]!,
      env,
      context: {
        ...context,
      },
    });

    if (!arg.$ || !isComptIntType(arg.$.type) || !arg.$.value) {
      throw formatErrorMessage({
        token: arg.token,
        errorMessage: `Expected compt_int type for "${expr.func.token.value}" argument, got:\n${exprToString(
          arg
        )}`,
      });
    }
    env = arg.$.env;

    let value: Value;
    // -(x)
    if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_int_neg)) {
      if (isComptIntValue(arg.$.value)) {
        value = createComptIntValue(-arg.$.value.value);
      } else {
        value = createUnknownValue(createComptIntType());
      }
    }
    // to_float(x)
    else if (
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_int_to_float)
    ) {
      if (isComptIntValue(arg.$.value)) {
        value = createComptFloatValue(arg.$.value.value);
      } else {
        value = createUnknownValue(createComptFloatType());
      }
    }
    // to_string(x)
    else if (
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_int_to_string)
    ) {
      if (isComptIntValue(arg.$.value)) {
        value = createComptStringValue(arg.$.value.value.toString());
      } else {
        value = createUnknownValue(createComptStringType());
      }
    } else {
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `Unexpected function call for "${expr.func.token.value}", expected "__yo_compt_int_neg
          " function`,
      });
    }
    expr.$ = {
      env,
      type: value.type,
      value: value,
      pathCollection: [],
    };
  } else {
    const lhs = context.evaluateExpression({
      expr: expr.args[0]!,
      env,
      context: {
        ...context,
      },
    });

    if (!lhs.$ || !isComptIntType(lhs.$.type) || !lhs.$.value) {
      throw formatErrorMessage({
        token: lhs.token,
        errorMessage: `Expected compt_int type for "${expr.func.token.value}" first argument, got:\n${exprToString(
          lhs
        )}`,
      });
    }
    env = lhs.$.env;

    const rhs = context.evaluateExpression({
      expr: expr.args[1]!,
      env,
      context: {
        ...context,
      },
    });

    if (!rhs.$ || !isComptIntType(rhs.$.type) || !rhs.$.value) {
      throw formatErrorMessage({
        token: rhs.token,
        errorMessage: `Expected compt_int type for "${expr.func.token.value}" second argument, got:\n${exprToString(
          rhs
        )}`,
      });
    }
    env = rhs.$.env;

    const lhsValue = lhs.$.value;
    const rhsValue = rhs.$.value;

    let value: Value;

    // x + y
    if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_int_add)) {
      if (isComptIntValue(lhsValue) && isComptIntValue(rhsValue)) {
        value = createComptIntValue(lhsValue.value + rhsValue.value);
      } else {
        value = createUnknownValue(createComptIntType());
      }
    }
    // x - y
    else if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_int_sub)) {
      if (isComptIntValue(lhsValue) && isComptIntValue(rhsValue)) {
        value = createComptIntValue(lhsValue.value - rhsValue.value);
      } else {
        value = createUnknownValue(createComptIntType());
      }
    }
    // x * y
    else if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_int_mul)) {
      if (isComptIntValue(lhsValue) && isComptIntValue(rhsValue)) {
        value = createComptIntValue(lhsValue.value * rhsValue.value);
      } else {
        value = createUnknownValue(createComptIntType());
      }
    }
    // x / y
    else if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_int_div)) {
      if (isComptIntValue(lhsValue) && isComptIntValue(rhsValue)) {
        if (rhsValue.value === 0) {
          throw formatErrorMessage({
            token: rhs.token,
            errorMessage: `Division by zero in "${expr.func.token.value}" operation`,
          });
        }

        value = createComptIntValue(
          Math.trunc(lhsValue.value / rhsValue.value)
        );
      } else {
        value = createUnknownValue(createComptIntType());
      }
    }
    // x % y
    else if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_int_mod)) {
      if (isComptIntValue(lhsValue) && isComptIntValue(rhsValue)) {
        if (rhsValue.value === 0) {
          throw formatErrorMessage({
            token: rhs.token,
            errorMessage: `Modulo by zero in "${expr.func.token.value}" operation`,
          });
        }

        value = createComptIntValue(lhsValue.value % rhsValue.value);
      } else {
        value = createUnknownValue(createComptIntType());
      }
    }
    // x == y
    else if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_int_eq)) {
      if (isComptIntValue(lhsValue) && isComptIntValue(rhsValue)) {
        value = createBooleanValue(lhsValue.value == rhsValue.value);
      } else {
        value = createUnknownValue(createBooleanType());
      }
    }
    // x != y
    else if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_int_neq)) {
      if (isComptIntValue(lhsValue) && isComptIntValue(rhsValue)) {
        value = createBooleanValue(lhsValue.value != rhsValue.value);
      } else {
        value = createUnknownValue(createBooleanType());
      }
    }
    // x < y
    else if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_int_lt)) {
      if (isComptIntValue(lhsValue) && isComptIntValue(rhsValue)) {
        value = createBooleanValue(lhsValue.value < rhsValue.value);
      } else {
        value = createUnknownValue(createBooleanType());
      }
    }
    // x <= y
    else if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_int_lte)) {
      if (isComptIntValue(lhsValue) && isComptIntValue(rhsValue)) {
        value = createBooleanValue(lhsValue.value <= rhsValue.value);
      } else {
        value = createUnknownValue(createBooleanType());
      }
    }
    // x > y
    else if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_int_gt)) {
      if (isComptIntValue(lhsValue) && isComptIntValue(rhsValue)) {
        value = createBooleanValue(lhsValue.value > rhsValue.value);
      } else {
        value = createUnknownValue(createBooleanType());
      }
    }
    // x >= y
    else if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_int_gte)) {
      if (isComptIntValue(lhsValue) && isComptIntValue(rhsValue)) {
        value = createBooleanValue(lhsValue.value >= rhsValue.value);
      } else {
        value = createUnknownValue(createBooleanType());
      }
    } else {
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `Unexpected function call for compt_int arithmetic: ${exprToString(
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
