import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import { Expr, exprIsFunctionCall, FuncCallExpr } from "../../expr";
import {
  createTupleType,
  createUnitType,
  TupleElement,
  TupleType,
  typeOfType,
} from "../../types";
import { createTypeValue } from "../../value";
import { EvaluatorContext } from "../context";
import { evaluateElementType } from "./element";

export function evaluateTupleElementsType({
  args,
  env,
  context,
  forType,
}: {
  args: Expr[];
  env: Environment;
  context: EvaluatorContext;
  forType: "tuple" | "struct" | "enum" | "union";
}): {
  type: TupleType;
  env: Environment;
} {
  const tupleElements: TupleElement[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;

    const { type, env: nextEnv } = evaluateElementType({
      expr: arg,
      env,
      tupleElementIndex: i,
      context: { ...context },
      forType,
    });

    // Check if there is duplicate labels
    if (type.label) {
      const duplicateLabel = tupleElements.find(
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
    }

    // Check if it's compile-time only
    if (type.isCompileTimeOnly) {
      throw formatErrorMessage({
        token: exprIsFunctionCall(arg)
          ? (arg.args[0]?.token ?? arg.token)
          : arg.token,
        errorMessage: `Tuple element cannot be compile-time only.`,
      });
    }

    tupleElements.push(type as TupleElement);
    env = nextEnv;
  }

  const tupleType: TupleType = createTupleType(tupleElements);
  return {
    type: tupleType,
    env,
  };
}

export function evaluateTupleType({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  if (expr.args.length === 0) {
    const value = createTypeValue(createUnitType());
    expr.$ = {
      env,
      value,
      type: value.type,
      isMutable: false,
    };
    return expr;
  }

  const { type: tupleType, env: nextEnv } = evaluateTupleElementsType({
    args: expr.args,
    env,
    context: { ...context },
    forType: "tuple",
  });
  env = nextEnv;

  // We disallow the tuple elements to have defaultValue for the tuple type
  tupleType.elements.forEach((tupleElement) => {
    if (tupleElement.exprs.defaultValueExpr) {
      throw formatErrorMessage({
        token: tupleElement.exprs.defaultValueExpr!.token,
        errorMessage: `Tuple type cannot have default value.`,
      });
    }
  });

  expr.$ = {
    env,
    value: createTypeValue(tupleType),
    type: typeOfType(tupleType),
    isMutable: false,
  };
  return expr;
}
