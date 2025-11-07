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

  let elementType: Type | undefined = undefined;

  // Check if we have an expected compt_list type from the context
  let expectedElementType: Type | undefined = undefined;
  if (context.expectedType && isComptListType(context.expectedType.type)) {
    expectedElementType = context.expectedType.type.elementType;
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
    if (!elementType) {
      elementType = expectedElementType || evaluatedArg.$.type;
    } else {
      // Check if the type of the element matches the first element type
      if (
        !areTypesCompatible(
          { type: elementType, env },
          { type: evaluatedArg.$.type, env }
        )
      ) {
        throw formatErrorMessage({
          token: arg.token,
          errorMessage: `Mismatched element types in compt_list. Expected element of type ${typeToString(elementType)}, got ${typeToString(evaluatedArg.$.type)}`,
        });
      }
    }
  }

  const exprListValue = createComptListValue(elementType!, elements);
  expr.$ = {
    env,
    type: exprListValue.type,
    value: exprListValue,
    pathCollection: [],
  };

  return expr;
}
