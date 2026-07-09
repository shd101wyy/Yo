import type { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinFunctions,
  exprIsFunctionCallOf,
  exprToString,
  type FnCallExpr,
} from "../../expr";
import {
  createBooleanType,
  createComptimeIntType,
  createComptimeStringType,
} from "../../types/creators";
import { isComptimeIntType, isComptimeStringType } from "../../types/guards";
import {
  createBooleanValue,
  createComptimeIntValue,
  createComptimeStringValue,
  createUnknownValue,
  isComptimeIntValue,
  isComptimeStringValue,
  type Value,
} from "../../value";
import type { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";

export function evaluateYoComptimeStringFunctions({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FnCallExpr {
  if (
    exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_comptime_string_length) ||
    exprIsFunctionCallOf(
      expr,
      BuiltinFunctions.__yo_comptime_string_to_upper
    ) ||
    exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_comptime_string_to_lower)
  ) {
    const arg = evaluateExpression({
      expr: expr.args[0]!,
      env,
      context: {
        ...context,
      },
    });

    if (!arg.$ || !isComptimeStringType(arg.$.type) || !arg.$.value) {
      throw formatErrorMessage({
        token: arg.token,
        errorMessage: `Expected comptime_str type for "${expr.func.token.value}" argument, got:\n${exprToString(
          arg
        )}`,
      });
    }
    env = arg.$.env;

    let value: Value;
    // length(x)
    if (
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_comptime_string_length)
    ) {
      if (isComptimeStringValue(arg.$.value)) {
        // BYTE length (UTF-8), not JS UTF-16 char count: `len()` on
        // str/String counts bytes, and the comptime fold must agree — a
        // multibyte literal (e.g. an em-dash) otherwise folds short and every
        // downstream consumer (loops, __yo_str .len emission via runtime
        // values) truncates the tail bytes.
        value = createComptimeIntValue(
          BigInt(Buffer.byteLength(arg.$.value.value, "utf8"))
        );
      } else {
        value = createUnknownValue(createComptimeIntType(), { env, context });
      }
    }
    // to_upper(x)
    else if (
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_comptime_string_to_upper)
    ) {
      if (isComptimeStringValue(arg.$.value)) {
        value = createComptimeStringValue(arg.$.value.value.toUpperCase());
      } else {
        value = createUnknownValue(createComptimeStringType(), {
          env,
          context,
        });
      }
    }
    // to_lower(x)
    else if (
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_comptime_string_to_lower)
    ) {
      if (isComptimeStringValue(arg.$.value)) {
        value = createComptimeStringValue(arg.$.value.value.toLowerCase());
      } else {
        value = createUnknownValue(createComptimeStringType(), {
          env,
          context,
        });
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
    exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_comptime_string_slice)
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
      !isComptimeStringType(stringArg.$.type) ||
      !stringArg.$.value
    ) {
      throw formatErrorMessage({
        token: stringArg.token,
        errorMessage: `Expected comptime_str type for "${expr.func.token.value}" string argument, got:\n${exprToString(
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

    if (
      !startArg.$ ||
      !isComptimeIntType(startArg.$.type) ||
      !startArg.$.value
    ) {
      throw formatErrorMessage({
        token: startArg.token,
        errorMessage: `Expected comptime_int type for "${expr.func.token.value}" start argument, got:\n${exprToString(
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

      if (!endArg.$ || !isComptimeIntType(endArg.$.type) || !endArg.$.value) {
        throw formatErrorMessage({
          token: endArg.token,
          errorMessage: `Expected comptime_int type for "${expr.func.token.value}" end argument, got:\n${exprToString(
            endArg
          )}`,
        });
      }
      env = endArg.$.env;
    }

    let value: Value;
    if (
      isComptimeStringValue(stringArg.$.value) &&
      isComptimeIntValue(startArg.$.value)
    ) {
      const str = stringArg.$.value.value;
      const startValue = startArg.$.value.value;
      const start =
        typeof startValue === "bigint" ? Number(startValue) : startValue;
      let end = str.length; // default to string length

      // Check if end argument was provided and is valid
      if (
        endArg &&
        endArg.$ &&
        endArg.$.value &&
        isComptimeIntValue(endArg.$.value)
      ) {
        const endValue = endArg.$.value.value;
        end = typeof endValue === "bigint" ? Number(endValue) : endValue;
      }

      // Use JavaScript's slice semantics
      value = createComptimeStringValue(str.slice(start, end));
    } else {
      value = createUnknownValue(createComptimeStringType(), { env, context });
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

    if (!lhs.$ || !isComptimeStringType(lhs.$.type) || !lhs.$.value) {
      throw formatErrorMessage({
        token: lhs.token,
        errorMessage: `Expected comptime_str type for "${expr.func.token.value}" first argument, got:\n${exprToString(
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

    if (!rhs.$ || !isComptimeStringType(rhs.$.type) || !rhs.$.value) {
      throw formatErrorMessage({
        token: rhs.token,
        errorMessage: `Expected comptime_str type for "${expr.func.token.value}" second argument, got:\n${exprToString(
          rhs
        )}`,
      });
    }
    env = rhs.$.env;

    const lhsValue = lhs.$.value;
    const rhsValue = rhs.$.value;

    let value: Value;

    // x + y (concatenation)
    if (
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_comptime_string_concat)
    ) {
      if (isComptimeStringValue(lhsValue) && isComptimeStringValue(rhsValue)) {
        value = createComptimeStringValue(lhsValue.value + rhsValue.value);
      } else {
        value = createUnknownValue(createComptimeStringType(), {
          env,
          context,
        });
      }
    }
    // x == y
    else if (
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_comptime_string_eq)
    ) {
      if (isComptimeStringValue(lhsValue) && isComptimeStringValue(rhsValue)) {
        value = createBooleanValue(lhsValue.value === rhsValue.value);
      } else {
        value = createUnknownValue(createBooleanType(), { env, context });
      }
    }
    // x != y
    else if (
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_comptime_string_neq)
    ) {
      if (isComptimeStringValue(lhsValue) && isComptimeStringValue(rhsValue)) {
        value = createBooleanValue(lhsValue.value !== rhsValue.value);
      } else {
        value = createUnknownValue(createBooleanType(), { env, context });
      }
    }
    // x < y (lexicographic comparison)
    else if (
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_comptime_string_lt)
    ) {
      if (isComptimeStringValue(lhsValue) && isComptimeStringValue(rhsValue)) {
        value = createBooleanValue(lhsValue.value < rhsValue.value);
      } else {
        value = createUnknownValue(createBooleanType(), { env, context });
      }
    }
    // x <= y
    else if (
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_comptime_string_lte)
    ) {
      if (isComptimeStringValue(lhsValue) && isComptimeStringValue(rhsValue)) {
        value = createBooleanValue(lhsValue.value <= rhsValue.value);
      } else {
        value = createUnknownValue(createBooleanType(), { env, context });
      }
    }
    // x > y
    else if (
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_comptime_string_gt)
    ) {
      if (isComptimeStringValue(lhsValue) && isComptimeStringValue(rhsValue)) {
        value = createBooleanValue(lhsValue.value > rhsValue.value);
      } else {
        value = createUnknownValue(createBooleanType(), { env, context });
      }
    }
    // x >= y
    else if (
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_comptime_string_gte)
    ) {
      if (isComptimeStringValue(lhsValue) && isComptimeStringValue(rhsValue)) {
        value = createBooleanValue(lhsValue.value >= rhsValue.value);
      } else {
        value = createUnknownValue(createBooleanType(), { env, context });
      }
    } else {
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `Unexpected function call for comptime_str operations: ${exprToString(expr)}`,
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
