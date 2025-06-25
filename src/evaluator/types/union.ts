import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinKeywords,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  exprToString,
  FuncCallExpr,
} from "../../expr";
import {
  createUnionType,
  ModuleElement,
  TupleElement,
} from "../../types";
import { createTypeValue } from "../../value";
import { EvaluatorContext } from "../context";
import { evaluateElementType } from "./element";

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

  const elements: TupleElement[] = [];
  unionType.elements = elements;

  const args = expr.args;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;

    const { type, env: nextEnv } = evaluateElementType({
      expr: arg,
      env,
      tupleElementIndex: i,
      context: { ...context, SelfType: unionType },
      forType: "union",
    });

    // Check if there is duplicate labels
    const duplicateLabel = elements.find(
      (element) => element.label === type.label
    );
    if (duplicateLabel) {
      throw formatErrorMessage({
        token: exprIsFunctionCall(arg)
          ? (arg.args[0]?.token ?? arg.token)
          : arg.token,
        errorMessage: `Duplicate label "${type.label}" in tuple`,
      });
    }

    // Compile-time field must have an assigned value
    if (type.isCompileTimeOnly && !type.assignedValue) {
      throw formatErrorMessage({
        token: type.exprs.expr.token,
        errorMessage: `Compile-time only field "${type.label}" must have an assigned value.`,
      });
    }

    // Disallow to have the default value for union type fields.
    if (type.defaultValue) {
      throw formatErrorMessage({
        token: type.exprs.defaultValueExpr?.token ?? type.exprs.expr.token,
        errorMessage: `Union type cannot have default value for its elements.`,
      });
    }

    if (type.isCompileTimeOnly) {
      unionType.module.elements.push(type as ModuleElement);
    } else {
      elements.push(type as TupleElement);
    }
    env = nextEnv;
  }

  const unionTypeValue = createTypeValue(unionType);
  expr.$ = {
    env,
    value: unionTypeValue,
    type: unionTypeValue.type,
    isMutable: false,
    pathCollection: [],
  };

  // Append more information to "union" token.
  expr.func.$ = expr.$;
  return expr;
}
