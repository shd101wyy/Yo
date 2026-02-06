import type { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinKeywords,
  exprIsFunctionCallOf,
  exprToString,
  type FnCallExpr,
} from "../../expr";
import { createBooleanType } from "../../types/creators";
import { isBooleanType } from "../../types/guards";
import {
  createBooleanValue,
  createUnknownValue,
  isBooleanValue,
  isUnknownValue,
  type Value,
} from "../../value";
import type { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";

export function evaluateAndOr({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FnCallExpr {
  const kind: "and" | "or" = exprIsFunctionCallOf(expr, BuiltinKeywords.op_and)
    ? "and"
    : "or";
  const args = expr.args;

  if (args.length === 0) {
    // Empty and/or - return true for and, false for or
    const value = createBooleanValue(kind === "and");
    expr.$ = {
      env: env,
      type: createBooleanType(),
      value,
      pathCollection: [],
      isAccessingProperty: false,
    };
    return expr;
  }

  // Short-circuiting evaluation
  let currentEnv = env;
  let resultValue: Value | undefined = undefined;
  let hasUnknown = false;
  let hasRuntime = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;

    const evaluatedArg = evaluateExpression({
      expr: arg,
      env: currentEnv,
      context: {
        ...context,
      },
    });

    if (!evaluatedArg.$ || !isBooleanType(evaluatedArg.$.type)) {
      throw formatErrorMessage({
        token: arg.token,
        errorMessage: `Expected bool type for "${kind}" argument, got:\n${exprToString(arg)}`,
      });
    }

    currentEnv = evaluatedArg.$.env;
    const argValue = evaluatedArg.$.value;

    if (isUnknownValue(argValue)) {
      hasUnknown = true;
      // Continue evaluating remaining args for side effects and possible short-circuit
      continue;
    }

    if (isBooleanValue(argValue)) {
      const boolVal = argValue.value;

      if (kind === "and") {
        if (!boolVal) {
          // Short-circuit: false && anything = false (definitive compile-time answer)
          resultValue = createBooleanValue(false);
          break;
        }
        // Continue with next argument (true so far)
        if (!hasUnknown && !hasRuntime) {
          resultValue = createBooleanValue(true);
        }
      } else {
        // kind === "or"
        if (boolVal) {
          // Short-circuit: true || anything = true (definitive compile-time answer)
          resultValue = createBooleanValue(true);
          break;
        }
        // Continue with next argument (false so far)
        if (!hasUnknown && !hasRuntime) {
          resultValue = createBooleanValue(false);
        }
      }
    } else {
      // Runtime value - can't determine result at compile time
      hasRuntime = true;
      // Continue evaluating remaining args for side effects and possible short-circuit
    }
  }

  // Determine final result based on what we encountered
  if (isBooleanValue(resultValue)) {
    // We short-circuited with a definitive answer - keep it
    // (false && anything = false, true || anything = true)
  } else if (hasRuntime || hasUnknown) {
    // Mixed unknown/runtime values, or only unknown/runtime values
    if (hasRuntime) {
      resultValue = undefined; // Runtime evaluation needed
    } else {
      resultValue = createUnknownValue(createBooleanType(), {
        env: currentEnv,
        context,
      }); // Only unknowns
    }
  }

  expr.$ = {
    env: currentEnv,
    type: createBooleanType(),
    value: resultValue,
    pathCollection: [],
    isAccessingProperty: false,
  };
  return expr;
}
