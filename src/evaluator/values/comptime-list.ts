import type { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import { exprToString, type FnCallExpr } from "../../expr";
import { areTypesCompatible } from "../../types/compatibility";
import type { Type } from "../../types/definitions";
import { isComptimeListType } from "../../types/guards";
import { typeToString } from "../../types/utils";
import { createComptimeListValue, type Value } from "../../value";
import type { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";

export function evaluateComptimeListValue({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FnCallExpr {
  const elements: Value[] = [];
  const args = expr.args;

  // We disallow the empty comptime_list for now.
  if (args.length === 0) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expected at least one element in comptime_list, got ${args.length}`,
    });
  }

  // Check if we have an expected comptime_list type from the context
  let childType: Type | undefined = undefined;
  if (context.expectedType && isComptimeListType(context.expectedType.type)) {
    childType = context.expectedType.type.childType;
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const evaluatedArg = evaluateExpression({
      expr: arg,
      env,
      context: {
        ...context,
      },
    });
    if (!evaluatedArg.$ || !evaluatedArg.$.value) {
      throw formatErrorMessage({
        token: arg.token,
        errorMessage: `Failed to evaluate expr_list element. Expected compile-time known value:\n${exprToString(arg)}`,
      });
    }
    env = evaluatedArg.$.env;
    const value = evaluatedArg.$.value;
    elements.push(value);

    // Check type
    if (!childType) {
      childType = evaluatedArg.$.type;
    } else {
      // Check if the type of the element matches the first element type
      if (
        !areTypesCompatible(
          { type: childType, env },
          { type: evaluatedArg.$.type, env }
        )
      ) {
        throw formatErrorMessage({
          token: arg.token,
          errorMessage: `Mismatched element types in comptime_list. Expected element of type ${typeToString(childType)}, got ${typeToString(evaluatedArg.$.type)}`,
        });
      }
    }
  }

  const exprListValue = createComptimeListValue(childType!, elements);
  expr.$ = {
    env,
    type: exprListValue.type,
    value: exprListValue,
    pathCollection: [],
  };

  return expr;
}
