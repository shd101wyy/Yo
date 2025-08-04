import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinKeywords,
  exprIsFunctionCallOf,
  exprToString,
  FuncCallExpr,
} from "../../expr";
import { createBooleanType, isBooleanType } from "../../types";
import {
  createBooleanValue,
  createUnknownValue,
  isBooleanValue,
  isUnknownValue,
  Value,
} from "../../value";
import { EvaluatorContext } from "../context";

export function evaluateAndOr({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  const kind: "and" | "or" = exprIsFunctionCallOf(expr, BuiltinKeywords.and)
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
      isMutable: false,
      pathCollection: [],
      isAccessingProperty: false,
    };
    return expr;
  }

  // Short-circuiting evaluation
  let currentEnv = env;
  let resultValue: Value | undefined = undefined;
  let allKnown = true;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;

    const evaluatedArg = context.evaluateExpression({
      expr: arg,
      env: currentEnv,
      context: {
        ...context,
      },
    });

    if (!evaluatedArg.$ || !isBooleanType(evaluatedArg.$.type)) {
      throw formatErrorMessage({
        token: arg.token,
        errorMessage: `Expected boolean type for "${kind}" argument, got:\n${exprToString(arg)}`,
      });
    }

    currentEnv = evaluatedArg.$.env;
    const argValue = evaluatedArg.$.value;

    if (isUnknownValue(argValue)) {
      // If we encounter an unknown value, we can't short-circuit
      allKnown = false;
      resultValue = createUnknownValue(createBooleanType());
      // Continue evaluating remaining args for side effects
      continue;
    }

    if (isBooleanValue(argValue)) {
      const boolVal = argValue.value;

      if (kind === "and") {
        if (!boolVal) {
          // Short-circuit: false && anything = false
          resultValue = createBooleanValue(false);
          break;
        }
        // Continue with next argument (true so far)
        resultValue = createBooleanValue(true);
      } else {
        // kind === "or"
        if (boolVal) {
          // Short-circuit: true || anything = true
          resultValue = createBooleanValue(true);
          break;
        }
        // Continue with next argument (false so far)
        resultValue = createBooleanValue(false);
      }
    } else {
      // Runtime value - can't determine result at compile time
      allKnown = false;
      resultValue = undefined;
      // Continue evaluating remaining args for side effects and type checking
    }
  }

  // If we couldn't determine the result statically, set to undefined (runtime value)
  if (!allKnown && isBooleanValue(resultValue)) {
    resultValue = undefined;
  }

  expr.$ = {
    env: currentEnv,
    type: createBooleanType(),
    value: resultValue,
    isMutable: false,
    pathCollection: [],
    isAccessingProperty: false,
  };
  return expr;
}
