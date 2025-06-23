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
  createStructType,
  isStructType,
  ModuleElement,
  TupleElement,
} from "../../type-checker";
import { createTypeValue, isTypeValue } from "../../value";
import { EvaluatorContext } from "../context";
import { evaluateElementType } from "./element";

export function evaluateStructType({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  if (!exprIsFunctionCallOf(expr, BuiltinKeywords.struct)) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expected "struct", got:\n${exprToString(expr)}`,
    });
  }

  // Create structType with empty elements
  // This is used as the SelfType for the following evaluations.
  const structType = createStructType(env);
  const elements = structType.elements;

  for (let i = 0; i < expr.args.length; i++) {
    const arg = expr.args[i]!;

    // spread operator for extending another struct type
    // NOTE: Let's disable this for now.
    //       Maybe the spread operator should only work with struct value, not struct type.
    //       It also causes confusion. Like should we extend the type methods there?
    if (exprIsFunctionCall(arg) && exprIsFunctionCallOf(arg, "...", 1)) {
      const extendedStructExpr = arg.args[0]!;
      // Evaluate the extended struct expression
      const evaluatedExtendedStruct = context.evaluateExpression({
        expr: extendedStructExpr,
        env,
        context: {
          ...context,
          SelfType: structType,
        },
      });
      if (!evaluatedExtendedStruct.$) {
        throw formatErrorMessage({
          token: extendedStructExpr.token,
          errorMessage: `Failed to evaluate the extended struct expression: ${exprToString(extendedStructExpr)}`,
        });
      }

      // Check if it's a struct type
      const extendedStructTypeValue = evaluatedExtendedStruct.$.value;
      if (
        !isTypeValue(extendedStructTypeValue) ||
        !isStructType(extendedStructTypeValue.value)
      ) {
        throw formatErrorMessage({
          token: extendedStructExpr.token,
          errorMessage: `Expected a struct type for extending, got ${exprToString(
            extendedStructExpr
          )}`,
        });
      }
      const extendedStructType = extendedStructTypeValue.value;

      // Iterate over the elements of the extended struct
      for (const extendedStructElement of extendedStructType.elements) {
        // Check if there is duplicate labels
        // If yes, then override the element
        const duplicateLabelIndex = elements.findIndex(
          (e) => e.label === extendedStructElement.label
        );
        if (duplicateLabelIndex >= 0) {
          // Override the existing one.
          elements[duplicateLabelIndex] = extendedStructElement;
        } else {
          // Add the element to the struct
          elements.push(extendedStructElement);
        }
      }
    }
    // tuple element
    else {
      const { type, env: nextEnv } = evaluateElementType({
        expr: arg,
        env,
        tupleElementIndex: i,
        context: { ...context, SelfType: structType },
        forType: "struct",
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
          errorMessage: `Duplicate label "${type.label}" in struct`,
        });
      }

      // Compile-time field must have an assigned value
      if (type.isCompileTimeOnly && !type.assignedValue) {
        throw formatErrorMessage({
          token: type.exprs.expr.token,
          errorMessage: `Compile-time only field "${type.label}" must have an assigned value.`,
        });
      }

      if (type.isCompileTimeOnly) {
        structType.module.elements.push(type as ModuleElement);
      } else {
        elements.push(type as TupleElement);
      }

      env = nextEnv;
    }
  }

  const structTypeValue = createTypeValue(structType);
  expr.$ = {
    env,
    type: structTypeValue.type,
    value: structTypeValue,
    isMutable: false,
    pathCollection: [],
  };

  // Append more information to "struct" token.
  expr.func.$ = expr.$;
  return expr;
}
