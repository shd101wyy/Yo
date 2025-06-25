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
  createComptStringType,
  isBooleanType,
} from "../../types";
import {
  createBooleanValue,
  createComptStringValue,
  createUnknownValue,
  isBooleanValue,
  Value,
} from "../../value";
import { EvaluatorContext } from "../context";

export function evaluateYoComptBooleanFunctions({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  if (
    exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_boolean_not) ||
    exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_boolean_to_string)
  ) {
    const arg = context.evaluateExpression({
      expr: expr.args[0]!,
      env,
      context: {
        ...context,
      },
    });

    if (!arg.$ || !isBooleanType(arg.$.type) || !arg.$.value) {
      throw formatErrorMessage({
        token: arg.token,
        errorMessage: `Expected boolean type for "${expr.func.token.value}" argument, got:\n${exprToString(
          arg
        )}`,
      });
    }
    env = arg.$.env;

    let value: Value;
    // !(x)
    if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_boolean_not)) {
      if (isBooleanValue(arg.$.value)) {
        value = createBooleanValue(!arg.$.value.value);
      } else {
        value = createUnknownValue(createBooleanType());
      }
    }
    // to_string(x)
    else if (
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_boolean_to_string)
    ) {
      if (isBooleanValue(arg.$.value)) {
        value = createComptStringValue(arg.$.value.value.toString());
      } else {
        value = createUnknownValue(createComptStringType());
      }
    } else {
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `Unexpected function call for "${expr.func.token.value}", expected "__yo_compt_boolean_not" or "__yo_compt_boolean_to_string" function`,
      });
    }
    expr.$ = {
      env,
      type: value.type,
      value: value,
      isMutable: false,
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

    if (!lhs.$ || !isBooleanType(lhs.$.type) || !lhs.$.value) {
      throw formatErrorMessage({
        token: lhs.token,
        errorMessage: `Expected boolean type for "${expr.func.token.value}" first argument, got:\n${exprToString(
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

    if (!rhs.$ || !isBooleanType(rhs.$.type) || !rhs.$.value) {
      throw formatErrorMessage({
        token: rhs.token,
        errorMessage: `Expected boolean type for "${expr.func.token.value}" second argument, got:\n${exprToString(
          rhs
        )}`,
      });
    }
    env = rhs.$.env;

    const lhsValue = lhs.$.value;
    const rhsValue = rhs.$.value;

    let value: Value;

    // x && y
    if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_boolean_and)) {
      if (isBooleanValue(lhsValue) && isBooleanValue(rhsValue)) {
        value = createBooleanValue(lhsValue.value && rhsValue.value);
      } else {
        value = createUnknownValue(createBooleanType());
      }
    }
    // x || y
    else if (
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_boolean_or)
    ) {
      if (isBooleanValue(lhsValue) && isBooleanValue(rhsValue)) {
        value = createBooleanValue(lhsValue.value || rhsValue.value);
      } else {
        value = createUnknownValue(createBooleanType());
      }
    }
    // x == y
    else if (
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_boolean_eq)
    ) {
      if (isBooleanValue(lhsValue) && isBooleanValue(rhsValue)) {
        value = createBooleanValue(lhsValue.value === rhsValue.value);
      } else {
        value = createUnknownValue(createBooleanType());
      }
    }
    // x != y
    else if (
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_boolean_neq)
    ) {
      if (isBooleanValue(lhsValue) && isBooleanValue(rhsValue)) {
        value = createBooleanValue(lhsValue.value !== rhsValue.value);
      } else {
        value = createUnknownValue(createBooleanType());
      }
    } else {
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `Unexpected function call for compt_boolean operations: ${exprToString(
          expr
        )}`,
      });
    }

    expr.$ = {
      env,
      type: value.type,
      value: value,
      isMutable: false,
      pathCollection: [],
    };
  }

  return expr;
}
