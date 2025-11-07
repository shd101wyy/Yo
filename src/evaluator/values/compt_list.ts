import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import { exprToString, FuncCallExpr } from "../../expr";
import {
  areTypesCompatible,
  isComptListType,
  Type,
  typeToString,
} from "../../types";
import { createComptListValue, Value } from "../../value";
import { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";

export function evaluateComptListValue({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  const elements: Value[] = [];
  const args = expr.args;

  // We disallow the empty compt_list for now.
  if (args.length === 0) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expected at least one element in compt_list, got ${args.length}`,
    });
  }

  // Check if we have an expected compt_list type from the context
  let childType: Type | undefined = undefined;
  if (context.expectedType && isComptListType(context.expectedType.type)) {
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
          errorMessage: `Mismatched element types in compt_list. Expected element of type ${typeToString(childType)}, got ${typeToString(evaluatedArg.$.type)}`,
        });
      }
    }
  }

  const exprListValue = createComptListValue(childType!, elements);
  expr.$ = {
    env,
    type: exprListValue.type,
    value: exprListValue,
    pathCollection: [],
  };

  return expr;
}
