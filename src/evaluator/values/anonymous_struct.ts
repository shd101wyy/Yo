import { addVariableToEnv, Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  attachTempVariableToExpr,
  Expr,
  exprIsAtom,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  exprToString,
  FuncCallExpr,
  setExprAsNeedsToCallDup,
} from "../../expr";
import { createStructType, ModuleElement, TypeElement } from "../../types";
import { randomId } from "../../utils";
import {
  createStructValue,
  createTypeValue,
  StructValue,
  Value,
} from "../../value";
import { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";
import { evaluateTypeElement } from "../types/element";
import { addARCFunctionsToStructType } from "../types/utils";
import { isValidVariableName } from "../utils";

export function evaluateAnonymousStructValue({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  const func = expr.func;
  const args = expr.args;

  // func should be "_"
  if (!exprIsAtom(func) || func.token.value !== "_") {
    throw formatErrorMessage({
      token: func.token,
      errorMessage: `Expected "_" for anonymous struct, got:\n${exprToString(func)}`,
    });
  }

  // Create structType
  const structType = createStructType(env);
  const elements: TypeElement[] = structType.elements;
  const moduleElements: ModuleElement[] = structType.module.elements;
  const values: (Value | undefined)[] = [];
  const runtimeArgExprsInOrder: Expr[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    let labelExpr: Expr | undefined = undefined;
    let valueExpr: Expr = arg;
    let label: string | undefined = undefined;

    // Check if it's type method call
    if (
      exprIsFunctionCall(arg) &&
      (exprIsFunctionCallOf(arg, "::", 2) ||
        exprIsFunctionCallOf(arg, "=", 2) ||
        exprIsFunctionCallOf(arg, "?=", 2))
    ) {
      const { element, env: nextEnv } = evaluateTypeElement({
        expr: arg,
        env,
        tupleElementIndex: i,
        context: { ...context, SelfType: structType },
        forType: "struct",
      });

      // Check if there is duplicate labels
      const duplicateLabel = moduleElements.find(
        (elem) => elem.label === element.label
      );
      if (duplicateLabel) {
        throw formatErrorMessage({
          token: arg.token,
          errorMessage: `Duplicate label "${element.label}" in anonymous struct`,
        });
      }

      if (!element.isCompileTimeOnly) {
        throw formatErrorMessage({
          token: arg.token,
          errorMessage: `Expected compile-time only field for anonymous struct, got:\n${exprToString(
            arg
          )}`,
        });
      }

      // Disallow to have the default value for anonymous struct module fields.
      if (element.defaultValue) {
        throw formatErrorMessage({
          token:
            element.exprs.defaultValueExpr?.token ?? element.exprs.expr.token,
          errorMessage: `Anonymous struct module field cannot have default value for its elements.`,
        });
      }

      // Require to have assigned value for anonymous struct module fields.
      if (!element.assignedValue) {
        throw formatErrorMessage({
          token: element.exprs.assignedValueExpr
            ? element.exprs.assignedValueExpr.token
            : element.exprs.expr.token,
          errorMessage: `Anonymous struct module field must have assigned value.`,
        });
      }

      moduleElements.push(element as ModuleElement);
      env = nextEnv;
      continue;
    }

    if (exprIsFunctionCall(arg) && exprIsFunctionCallOf(arg, ":", 2)) {
      labelExpr = arg.args[0]!;
      valueExpr = arg.args[1]!;

      if (!isValidVariableName(labelExpr)) {
        throw formatErrorMessage({
          token: labelExpr.token,
          errorMessage: `Expected identifier for anonymous struct element label, got:\n${exprToString(
            labelExpr
          )}`,
        });
      }
      label = labelExpr.token.value;
    }

    // Check if it's spread operator
    // NOTE: I disabled it for now.
    // Because it's hard to handle linear value in anonymous struct.
    /*
    if (exprIsFunctionCall(arg) && exprIsFunctionCallOf(arg, "...", 1)) {
      const extendedStructExpr = arg.args[0]!;
      // Evaluate the extended struct expression
      const evaluatedExtendedStruct = evaluateExpression({
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
      const extendedDataType = evaluatedExtendedStruct.$.type;
      if (isStructType(extendedDataType)) {
        const extendedStructType = extendedDataType;
        const extendedStructValue = evaluatedExtendedStruct.$.value as
          | StructValue
          | undefined;

        // Iterate over the elements of the extended struct
        for (let i = 0; i < extendedStructType.elements.length; i++) {
          const extendedStructElement = extendedStructType.elements[i]!;
          // Check if there is duplicate labels
          // If yes, then override the element
          const duplicateLabelIndex = elements.findIndex(
            (e) => e.label === extendedStructElement.label
          );
          if (duplicateLabelIndex >= 0) {
            // Override the existing one.
            elements[duplicateLabelIndex] = extendedStructElement;

            if (extendedStructValue) {
              // Override the existing value
              values[duplicateLabelIndex] =
                extendedStructValue.elements[duplicateLabelIndex];
            } else {
              values[duplicateLabelIndex] = undefined;
            }
          } else {
            // Add the element to the struct
            elements.push(extendedStructElement);

            if (extendedStructValue) {
              // Add the value to the struct
              values.push(extendedStructValue.elements[i]!);
            } else {
              values.push(undefined);
            }
          }
        }
      } else {
        throw formatErrorMessage({
          token: extendedStructExpr.token,
          errorMessage: `Expected a struct value for extending, got ${exprToString(
            extendedStructExpr
          )}`,
        });
      }
    }
    // Normal element
    else
    */
    {
      const evaluatedArg = evaluateExpression({
        expr: valueExpr,
        env,
        context: {
          ...context,
          SelfType: structType,
        },
      });

      setExprAsNeedsToCallDup(evaluatedArg, context);

      if (!evaluatedArg.$) {
        throw formatErrorMessage({
          token: valueExpr.token,
          errorMessage: `Failed to evaluate the anonymous struct element expression: ${exprToString(
            valueExpr
          )}`,
        });
      }
      env = evaluatedArg.$.env;
      const type = evaluatedArg.$.type;
      const element: TypeElement = {
        exprs: {
          expr: valueExpr,
          labelExpr: undefined,
          typeExpr: undefined,
          defaultValueExpr: undefined,
          assignedValueExpr: valueExpr,
        },
        type,
        label: label ?? `$element_${randomId()}`,
        isCompileTimeOnly: false, // TODO: Fix this
      };
      elements.push(element);
      runtimeArgExprsInOrder.push(evaluatedArg);

      if (evaluatedArg.$.value) {
        values.push(evaluatedArg.$?.value);
      } else {
        values.push(undefined);
      }

      if (labelExpr) {
        labelExpr.$ = evaluatedArg.$;
      }
    }
  }

  // Auto-generate ___drop, ___dup, and ___dispose functions if needed
  env = addARCFunctionsToStructType({
    structType,
    env,
    context,
  });

  // Check if it's comptime value
  let structValue: StructValue | undefined = undefined;
  structValue = values.some((value) => !value)
    ? undefined
    : createStructValue(structType, values as Value[]);

  const structTypeValue = createTypeValue(structType);
  func.$ = {
    env,
    type: structTypeValue.type,
    value: structTypeValue,
    pathCollection: [],
  };

  // Add the struct type value to the environment
  const { env: nextEnv } = addVariableToEnv({
    env,
    variable: {
      name: structType.id,
      type: structTypeValue.type,
      value: structTypeValue,
      initializedAtToken: expr.token,
      token: expr.token,
      isCompileTimeOnly: true,
      consumedAtToken: undefined,
    },
  });
  env = nextEnv;

  expr.$ = {
    env,
    type: structType,
    value: structValue,
    pathCollection: [],
    runtimeArgExprsInOrder,
  };

  // Attach temp variable to the expr
  attachTempVariableToExpr(expr, true);

  return expr;
}
