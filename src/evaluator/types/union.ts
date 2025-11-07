import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinKeywords,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  exprToString,
  FuncCallExpr,
} from "../../expr";
import { createUnionType, ModuleElement, TypeElement } from "../../types";
import { createTypeValue } from "../../value";
import { EvaluatorContext } from "../context";
import { evaluateTypeElement } from "./element";

export function evaluateUnionType({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  if (!exprIsFunctionCallOf(expr, BuiltinKeywords.union)) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expected "union", got:\n${exprToString(expr)}`,
    });
  }

  // Create unionType with empty elements
  const unionType = createUnionType(env);

  const elements: TypeElement[] = [];
  unionType.elements = elements;

  const args = expr.args;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;

    const { element, env: nextEnv } = evaluateTypeElement({
      expr: arg,
      env,
      tupleElementIndex: i,
      context: { ...context, SelfType: unionType },
      forType: "union",
    });

    // Check if there is duplicate labels
    const duplicateLabel = elements.find(
      (elem) => elem.label === element.label
    );
    if (duplicateLabel) {
      throw formatErrorMessage({
        token: exprIsFunctionCall(arg)
          ? (arg.args[0]?.token ?? arg.token)
          : arg.token,
        errorMessage: `Duplicate label "${element.label}" in union field.`,
      });
    }

    // Disallow to have the default value for union type fields.
    if (element.defaultValue) {
      throw formatErrorMessage({
        token:
          element.exprs.defaultValueExpr?.token ?? element.exprs.expr.token,
        errorMessage: `Union type cannot have default value for its elements.`,
      });
    }

    if (element.isCompileTimeOnly) {
      if (!element.assignedValue) {
        throw formatErrorMessage({
          token: element.exprs.expr.token,
          errorMessage: `Module field in union type must have assigned value.`,
        });
      }

      unionType.module.elements.push(element as ModuleElement);
    } else {
      elements.push(element as TypeElement);
    }
    env = nextEnv;
  }

  const unionTypeValue = createTypeValue(unionType);
  expr.$ = {
    env,
    value: unionTypeValue,
    type: unionTypeValue.type,
    pathCollection: [],
  };

  // Append more information to "union" token.
  expr.func.$ = expr.$;
  return expr;
}
