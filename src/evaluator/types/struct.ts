import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinFunctions,
  BuiltinKeywords,
  Expr,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  exprToString,
  FuncCallExpr,
} from "../../expr";
import { generateExprFromCode } from "../../parser";
import {
  createStructType,
  isARCType,
  isStructType,
  ModuleElement,
  StructType,
  TupleElement,
  typeContainsARCType,
} from "../../types";
import {
  areValuesEqual,
  createTypeValue,
  isFunctionValue,
  isModuleValue,
  isTypeValue,
} from "../../value";
import { EvaluatorContext } from "../context";
import { evaluateElementType } from "./element";
import { validateDisposeFunction } from "./validation";

/**
 * Helper function to parse and evaluate a Yo code string in the context of a struct
 */
function parseAndEvaluateExprInStruct(
  code: string,
  structType: StructType,
  env: Environment,
  context: EvaluatorContext
): { expr: Expr; env: Environment } {
  const expr = generateExprFromCode(code);

  // Evaluate the expression with the struct as the SelfType
  const evaluatedExpr = context.evaluateExpression({
    expr,
    env,
    context: {
      ...context,
      SelfType: structType,
    },
  });

  if (!evaluatedExpr.$) {
    throw new Error(
      `Failed to evaluate auto-generated expression: ${exprToString(expr)}`
    );
  }

  return { expr: evaluatedExpr, env: evaluatedExpr.$.env };
}

/**
 * Generate ___drop function code for a struct type
 */
function generateDropFunctionCode(structType: StructType): string {
  const destructurings = structType.elements
    .filter(
      (element) =>
        !element.isCompileTimeOnly && typeContainsARCType(element.type)
    )
    .map((element) => element.label);

  const hasDisposeFunction = structType.module.elements.some(
    (element) => element.label === BuiltinFunctions.dispose[0]
  );

  const decrRcExpr = isARCType(structType)
    ? `
  ${BuiltinFunctions.__yo_decr_rc[0]!}(self${hasDisposeFunction ? `, Self.dispose` : ""});`
    : "";

  // If no fields to destructure, just create an empty function
  if (!destructurings.length) {
    return `((fn(mut(self): Self) -> unit) {
  ${decrRcExpr}
  ()
})`;
  }

  return `((fn(mut(self): Self) -> unit) {
  { ${destructurings.join(", ")} } := self;

  ${destructurings.map((label) => `(${BuiltinFunctions.___drop[0]!})(${label});`).join("\n")}
  
  ${decrRcExpr}
})`;
}

function generateDupFunctionCode(structType: StructType): string {
  const destructurings = structType.elements
    .filter(
      (element) =>
        !element.isCompileTimeOnly && typeContainsARCType(element.type)
    )
    .map((element) => element.label);

  const incrRcExpr = isARCType(structType)
    ? `
  ${BuiltinFunctions.__yo_incr_rc[0]!}(self);`
    : "";

  // If no fields to destructure, just create an empty function
  if (!destructurings.length) {
    return `((fn(mut(self) : Self) -> Self) {
  ${incrRcExpr}
  self
})`;
  }

  return `((fn(mut(self) : Self) -> Self) {
  { ${destructurings.join(", ")} } := self;

  ${destructurings.map((label) => `(${BuiltinFunctions.___dup[0]!})(${label});`).join("\n")}
  
  ${incrRcExpr}
  self
})`;
}

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
        // fn(mut(self): Self) -> unit
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

  // Auto-generate ___drop and ___dup function if it's needed
  if (typeContainsARCType(structType)) {
    const dropFunctionCode = generateDropFunctionCode(structType);
    const dupFunctionCode = generateDupFunctionCode(structType);

    // Add ___drop function to the struct type module elements
    {
      const { expr: dropFunctionExpr, env: nextEnv } =
        parseAndEvaluateExprInStruct(
          dropFunctionCode,
          structType,
          env,
          context
        );
      if (exprIsFunctionCall(dropFunctionExpr)) {
        const functionExpr = dropFunctionExpr;
        if (
          functionExpr.$ &&
          functionExpr.$.value &&
          isFunctionValue(functionExpr.$.value)
        ) {
          // The code below is necessary for the C code generator to make the ___drop function to have a more descriptive name.
          functionExpr.$.value.funcId += BuiltinFunctions.___drop[0]!;

          // Add the drop function to the struct's module elements
          const dropModuleElement: ModuleElement = {
            label: BuiltinFunctions.___drop[0]!,
            type: functionExpr.$.type,
            assignedValue: functionExpr.$.value,
            isCompileTimeOnly: true,
            isImplicit: false,
            exprs: {
              expr: dropFunctionExpr,
              labelExpr: dropFunctionExpr.args[0],
              typeExpr: undefined,
              defaultValueExpr: undefined,
              assignedValueExpr: functionExpr,
            },
          };
          structType.module.elements.push(dropModuleElement);
        }
      }

      env = nextEnv;
    }

    // Add ___dup function to the struct type module elements
    {
      const { expr: dupFunctionExpr, env: nextEnv } =
        parseAndEvaluateExprInStruct(dupFunctionCode, structType, env, context);
      if (exprIsFunctionCall(dupFunctionExpr)) {
        const functionExpr = dupFunctionExpr;
        if (
          functionExpr.$ &&
          functionExpr.$.value &&
          isFunctionValue(functionExpr.$.value)
        ) {
          // The code below is necessary for the C code generator to make the ___dup function to have a more descriptive name.
          functionExpr.$.value.funcId += BuiltinFunctions.___dup[0]!;

          // Add the dup function to the struct's module elements
          const dupModuleElement: ModuleElement = {
            label: BuiltinFunctions.___dup[0]!,
            type: functionExpr.$.type,
            assignedValue: functionExpr.$.value,
            isCompileTimeOnly: true,
            isImplicit: false,
            exprs: {
              expr: dupFunctionExpr,
              labelExpr: dupFunctionExpr.args[0],
              typeExpr: undefined,
              defaultValueExpr: undefined,
              assignedValueExpr: functionExpr,
            },
          };
          structType.module.elements.push(dupModuleElement);
        }
      }

      env = nextEnv;
    }
  }

  // console.log(typeToString(structType));
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
