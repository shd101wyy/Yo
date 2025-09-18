import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinFunctions,
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
} from "../../types";
import {
  areValuesEqual,
  createTypeValue,
  isModuleValue,
  isTypeValue,
} from "../../value";
import { EvaluatorContext } from "../context";
import { evaluateElementType } from "./element";
import { addARCFunctionsToStructType } from "./utils";
import { validateDisposeFunction } from "./validation";

export function evaluateStructType({
  expr,
  env,
  context,
  isReferenceSemantics = false,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
  isReferenceSemantics?: boolean;
}): FuncCallExpr {
  if (!exprIsFunctionCallOf(expr, BuiltinKeywords.struct)) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expected "struct", got:\n${exprToString(expr)}`,
    });
  }

  // Create structType with empty elements
  // This is used as the SelfType for the following evaluations.
  const structType = createStructType(env, isReferenceSemantics);
  const elements = structType.elements;

  for (let i = 0; i < expr.args.length; i++) {
    const arg = expr.args[i]!;

    // spread operator for extending another struct type or module value.
    if (exprIsFunctionCall(arg) && exprIsFunctionCallOf(arg, "...", 1)) {
      const extendedExpr = arg.args[0]!;
      // Evaluate the extended struct expression

      const evaluatedExtendedExpr = context.evaluateExpression({
        expr: extendedExpr,
        env,
        context: {
          ...context,
          SelfType: structType,
        },
      });

      if (!evaluatedExtendedExpr.$) {
        throw formatErrorMessage({
          token: extendedExpr.token,
          errorMessage: `Failed to evaluate the extended expression: ${exprToString(extendedExpr)}`,
        });
      }

      // Check if it's a struct type or module value
      const extendedExprValue = evaluatedExtendedExpr.$.value;

      if (
        isTypeValue(extendedExprValue) &&
        isStructType(extendedExprValue.value)
      ) {
        const extendedStructType = extendedExprValue.value;

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
      } else if (isModuleValue(extendedExprValue)) {
        const moduleValue = extendedExprValue;
        const moduleType = moduleValue.type;
        for (let i = 0; i < moduleType.elements.length; i++) {
          const element = moduleType.elements[i]!;
          // Check if there is duplicate labels
          // If yes, then override the element
          let duplicateLabelIndex = elements.findIndex(
            (e) => e.label === element.label
          );
          if (duplicateLabelIndex >= 0) {
            throw formatErrorMessage({
              token: extendedExpr.token,
              errorMessage: `Duplicate label "${element.label}" in struct extension from module value`,
            });
          }

          duplicateLabelIndex = structType.module.elements.findIndex(
            (e) => e.label === element.label
          );
          if (duplicateLabelIndex >= 0) {
            const existingModuleElement =
              structType.module.elements[duplicateLabelIndex];

            // Meet the same module element, so we skip
            if (
              existingModuleElement?.assignedValue &&
              element.assignedValue &&
              areValuesEqual(
                {
                  value: existingModuleElement.assignedValue,
                  env: env,
                },
                { value: element.assignedValue, env: env }
              )
            ) {
              continue;
            }

            throw formatErrorMessage({
              token: extendedExpr.token,
              errorMessage: `Duplicate label "${element.label}" in struct extension from module value`,
            });
          }

          structType.module.elements.push({
            ...element,
            assignedValue: moduleValue.elements[i],
          });
        }
      } else {
        throw formatErrorMessage({
          token: extendedExpr.token,
          errorMessage: `Expected a struct type or module value for extending, got ${exprToString(
            extendedExpr
          )}`,
        });
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

      if (type.isCompileTimeOnly) {
        // ___drop function
        if (type.label === BuiltinFunctions.___drop[0]) {
          throw formatErrorMessage({
            token: exprIsFunctionCall(arg)
              ? (arg.args[0]?.token ?? arg.token)
              : arg.token,
            errorMessage: `The label "${BuiltinFunctions.___drop[0]}()" is reserved for the auto-generated function. You cannot define it as a compile-time-only element.`,
          });
        }

        // ___dup function
        if (type.label === BuiltinFunctions.___dup[0]) {
          throw formatErrorMessage({
            token: exprIsFunctionCall(arg)
              ? (arg.args[0]?.token ?? arg.token)
              : arg.token,
            errorMessage: `The label "${BuiltinFunctions.___dup[0]}()" is reserved for the auto-generated function. You cannot define it as a compile-time-only element.`,
          });
        }

        // dispose function
        // Verify the disposeFunction has the correct type.
        // fn(self : Self) -> unit
        if (type.label === BuiltinFunctions.dispose[0]) {
          validateDisposeFunction(
            type as ModuleElement,
            exprIsFunctionCall(arg)
              ? (arg.args[0]?.token ?? arg.token)
              : arg.token
          );
        }

        const moduleElement = type as ModuleElement;
        structType.module.elements.push(moduleElement);
      } else {
        elements.push(type as TupleElement);
      }

      env = nextEnv;
    }
  }

  // Auto-generate ___drop, ___dup, and ___dispose functions if needed
  env = addARCFunctionsToStructType({
    structType,
    env,
    context,
  });

  // console.log(typeToString(structType));
  const structTypeValue = createTypeValue(structType);
  expr.$ = {
    env,
    type: structTypeValue.type,
    value: structTypeValue,
    pathCollection: [],
  };

  // Append more information to "struct" token.
  expr.func.$ = expr.$;
  return expr;
}
