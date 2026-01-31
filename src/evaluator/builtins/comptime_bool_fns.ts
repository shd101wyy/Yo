import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinFunctions,
  exprIsFunctionCallOf,
  exprToString,
  FnCallExpr,
} from "../../expr";
import {
  createBooleanType,
  createComptimeStringType,
  isBooleanType,
} from "../../types";
import {
  createBooleanValue,
  createComptimeStringValue,
  createUnknownValue,
  isBooleanValue,
  Value,
} from "../../value";
import { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";

export function evaluateYoComptimeBooleanFunctions({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FnCallExpr {
  if (
    exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_comptime_bool_not) ||
    exprIsFunctionCallOf(
      expr,
      BuiltinFunctions.__yo_comptime_bool_to_comptime_string
    )
  ) {
    const arg = evaluateExpression({
      expr: expr.args[0]!,
      env,
      context: {
        ...context,
      },
    });

    if (!arg.$ || !isBooleanType(arg.$.type) || !arg.$.value) {
      throw formatErrorMessage({
        token: arg.token,
        errorMessage: `Expected bool type for "${expr.func.token.value}" argument, got:\n${exprToString(
          arg
        )}`,
      });
    }
    env = arg.$.env;

    let value: Value;
    // !(x)
    if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_comptime_bool_not)) {
      if (isBooleanValue(arg.$.value)) {
        value = createBooleanValue(!arg.$.value.value);
      } else {
        value = createUnknownValue(createBooleanType(), { env });
      }
    }
    // to_string(x)
    else if (
      exprIsFunctionCallOf(
        expr,
        BuiltinFunctions.__yo_comptime_bool_to_comptime_string
      )
    ) {
      if (isBooleanValue(arg.$.value)) {
        value = createComptimeStringValue(arg.$.value.value.toString());
      } else {
        value = createUnknownValue(createComptimeStringType(), { env });
      }
    } else {
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `Unexpected function call for "${expr.func.token.value}", expected "__yo_comptime_bool_not" or "__yo_comptime_bool_to_comptime_string" function`,
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

    if (!lhs.$ || !isBooleanType(lhs.$.type) || !lhs.$.value) {
      throw formatErrorMessage({
        token: lhs.token,
        errorMessage: `Expected bool type for "${expr.func.token.value}" first argument, got:\n${exprToString(
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

    if (!rhs.$ || !isBooleanType(rhs.$.type) || !rhs.$.value) {
      throw formatErrorMessage({
        token: rhs.token,
        errorMessage: `Expected bool type for "${expr.func.token.value}" second argument, got:\n${exprToString(
          rhs
        )}`,
      });
    }
    env = rhs.$.env;

    const lhsValue = lhs.$.value;
    const rhsValue = rhs.$.value;

    let value: Value;

    // x && y
    if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_comptime_bool_and)) {
      if (isBooleanValue(lhsValue) && isBooleanValue(rhsValue)) {
        value = createBooleanValue(lhsValue.value && rhsValue.value);
      } else {
        value = createUnknownValue(createBooleanType(), { env });
      }
    }
    // x || y
    else if (
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_comptime_bool_or)
    ) {
      if (isBooleanValue(lhsValue) && isBooleanValue(rhsValue)) {
        value = createBooleanValue(lhsValue.value || rhsValue.value);
      } else {
        value = createUnknownValue(createBooleanType(), { env });
      }
    }
    // x == y
    else if (
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_comptime_bool_eq)
    ) {
      if (isBooleanValue(lhsValue) && isBooleanValue(rhsValue)) {
        value = createBooleanValue(lhsValue.value === rhsValue.value);
      } else {
        value = createUnknownValue(createBooleanType(), { env });
      }
    }
    // x != y
    else if (
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_comptime_bool_neq)
    ) {
      if (isBooleanValue(lhsValue) && isBooleanValue(rhsValue)) {
        value = createBooleanValue(lhsValue.value !== rhsValue.value);
      } else {
        value = createUnknownValue(createBooleanType(), { env });
      }
    } else {
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `Unexpected function call for comptime_bool operations: ${exprToString(
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
