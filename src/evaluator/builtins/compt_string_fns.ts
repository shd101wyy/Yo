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
  createComptIntType,
  createComptStringType,
  isComptIntType,
  isComptStringType,
} from "../../types";
import {
  createBooleanValue,
  createComptIntValue,
  createComptStringValue,
  createUnknownValue,
  isComptIntValue,
  isComptStringValue,
  Value,
} from "../../value";
import { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";

export function evaluateYoComptStringFunctions({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  if (
    exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_string_length) ||
    exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_string_to_upper) ||
    exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_string_to_lower)
  ) {
    const arg = evaluateExpression({
      expr: expr.args[0]!,
      env,
      context: {
        ...context,
      },
    });

    if (!arg.$ || !isComptStringType(arg.$.type) || !arg.$.value) {
      throw formatErrorMessage({
        token: arg.token,
        errorMessage: `Expected compt_string type for "${expr.func.token.value}" argument, got:\n${exprToString(
          arg
        )}`,
      });
    }
    env = arg.$.env;

    let value: Value;
    // length(x)
    if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_string_length)) {
      if (isComptStringValue(arg.$.value)) {
        value = createComptIntValue(arg.$.value.value.length);
      } else {
        value = createUnknownValue(createComptIntType());
      }
    }
    // to_upper(x)
    else if (
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_string_to_upper)
    ) {
      if (isComptStringValue(arg.$.value)) {
        value = createComptStringValue(arg.$.value.value.toUpperCase());
      } else {
        value = createUnknownValue(createComptStringType());
      }
    }
    // to_lower(x)
    else if (
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_string_to_lower)
    ) {
      if (isComptStringValue(arg.$.value)) {
        value = createComptStringValue(arg.$.value.value.toLowerCase());
      } else {
        value = createUnknownValue(createComptStringType());
      }
    } else {
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `Unexpected function call for "${expr.func.token.value}", expected string unary function`,
      });
    }
    expr.$ = {
      env,
      type: value.type,
      value: value,
      pathCollection: [],
    };
  }
  // Handle slice function with 2-3 arguments
  else if (
    exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_string_slice)
  ) {
    // slice(string, start, end?) - validate argument count
    if (expr.args.length < 2 || expr.args.length > 3) {
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `"${expr.func.token.value}" expects 2 or 3 arguments (string, start, end?), got ${expr.args.length}`,
      });
    }

    // Evaluate the string argument
    const stringArg = evaluateExpression({
      expr: expr.args[0]!,
      env,
      context: {
        ...context,
      },
    });

    if (
      !stringArg.$ ||
      !isComptStringType(stringArg.$.type) ||
      !stringArg.$.value
    ) {
      throw formatErrorMessage({
        token: stringArg.token,
        errorMessage: `Expected compt_string type for "${expr.func.token.value}" string argument, got:\n${exprToString(
          stringArg
        )}`,
      });
    }
    env = stringArg.$.env;

    // Evaluate the start argument
    const startArg = evaluateExpression({
      expr: expr.args[1]!,
      env,
      context: {
        ...context,
      },
    });

    if (!startArg.$ || !isComptIntType(startArg.$.type) || !startArg.$.value) {
      throw formatErrorMessage({
        token: startArg.token,
        errorMessage: `Expected compt_int type for "${expr.func.token.value}" start argument, got:\n${exprToString(
          startArg
        )}`,
      });
    }
    env = startArg.$.env;

    let endArg: typeof startArg | undefined = undefined;
    // Evaluate the end argument if provided
    if (expr.args.length === 3) {
      endArg = evaluateExpression({
        expr: expr.args[2]!,
        env,
        context: {
          ...context,
        },
      });

      if (!endArg.$ || !isComptIntType(endArg.$.type) || !endArg.$.value) {
        throw formatErrorMessage({
          token: endArg.token,
          errorMessage: `Expected compt_int type for "${expr.func.token.value}" end argument, got:\n${exprToString(
            endArg
          )}`,
        });
      }
      env = endArg.$.env;
    }

    let value: Value;
    if (
      isComptStringValue(stringArg.$.value) &&
      isComptIntValue(startArg.$.value)
    ) {
      const str = stringArg.$.value.value;
      const start = startArg.$.value.value;
      let end = str.length; // default to string length

      // Check if end argument was provided and is valid
      if (
        endArg &&
        endArg.$ &&
        endArg.$.value &&
        isComptIntValue(endArg.$.value)
      ) {
        end = endArg.$.value.value;
      }

      // Use JavaScript's slice semantics
      value = createComptStringValue(str.slice(start, end));
    } else {
      value = createUnknownValue(createComptStringType());
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

    if (!lhs.$ || !isComptStringType(lhs.$.type) || !lhs.$.value) {
      throw formatErrorMessage({
        token: lhs.token,
        errorMessage: `Expected compt_string type for "${expr.func.token.value}" first argument, got:\n${exprToString(
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

    if (!rhs.$ || !isComptStringType(rhs.$.type) || !rhs.$.value) {
      throw formatErrorMessage({
        token: rhs.token,
        errorMessage: `Expected compt_string type for "${expr.func.token.value}" second argument, got:\n${exprToString(
          rhs
        )}`,
      });
    }
    env = rhs.$.env;

    const lhsValue = lhs.$.value;
    const rhsValue = rhs.$.value;

    let value: Value;

    // x + y (concatenation)
    if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_string_concat)) {
      if (isComptStringValue(lhsValue) && isComptStringValue(rhsValue)) {
        value = createComptStringValue(lhsValue.value + rhsValue.value);
      } else {
        value = createUnknownValue(createComptStringType());
      }
    }
    // x == y
    else if (
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_string_eq)
    ) {
      if (isComptStringValue(lhsValue) && isComptStringValue(rhsValue)) {
        value = createBooleanValue(lhsValue.value === rhsValue.value);
      } else {
        value = createUnknownValue(createBooleanType());
      }
    }
    // x != y
    else if (
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_string_neq)
    ) {
      if (isComptStringValue(lhsValue) && isComptStringValue(rhsValue)) {
        value = createBooleanValue(lhsValue.value !== rhsValue.value);
      } else {
        value = createUnknownValue(createBooleanType());
      }
    }
    // x < y (lexicographic comparison)
    else if (
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_string_lt)
    ) {
      if (isComptStringValue(lhsValue) && isComptStringValue(rhsValue)) {
        value = createBooleanValue(lhsValue.value < rhsValue.value);
      } else {
        value = createUnknownValue(createBooleanType());
      }
    }
    // x <= y
    else if (
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_string_lte)
    ) {
      if (isComptStringValue(lhsValue) && isComptStringValue(rhsValue)) {
        value = createBooleanValue(lhsValue.value <= rhsValue.value);
      } else {
        value = createUnknownValue(createBooleanType());
      }
    }
    // x > y
    else if (
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_string_gt)
    ) {
      if (isComptStringValue(lhsValue) && isComptStringValue(rhsValue)) {
        value = createBooleanValue(lhsValue.value > rhsValue.value);
      } else {
        value = createUnknownValue(createBooleanType());
      }
    }
    // x >= y
    else if (
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_string_gte)
    ) {
      if (isComptStringValue(lhsValue) && isComptStringValue(rhsValue)) {
        value = createBooleanValue(lhsValue.value >= rhsValue.value);
      } else {
        value = createUnknownValue(createBooleanType());
      }
    } else {
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `Unexpected function call for compt_string operations: ${exprToString(
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
