import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinFunctions,
  BuiltinKeywords,
  expectExprToBeFunctionCallOf,
  FuncCallExpr,
} from "../../expr";
import { generateExprFromCode } from "../../parser";
import {
  createDynType,
  isFunctionType,
  isModuleType,
  ModuleType,
  typeToString,
} from "../../types";
import { createTypeValue, isTypeValue } from "../../value";
import { EvaluatorContext } from "../context";
import { addARCFunctionsToDynType } from "./utils";

export function evaluateDynType({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  expectExprToBeFunctionCallOf(expr, BuiltinKeywords.Dyn);
  const moduleExprs = expr.args;
  const moduleTypes: ModuleType[] = [];

  for (let i = 0; i < moduleExprs.length; i++) {
    const moduleExpr = moduleExprs[i]!;
    const evaluatedModule = context.evaluateExpression({
      expr: moduleExpr,
      env,
      context: {
        ...context,
      },
    });

    if (
      !evaluatedModule.$ ||
      !evaluatedModule.$.value ||
      !isTypeValue(evaluatedModule.$.value) ||
      !isModuleType(evaluatedModule.$.value.value)
    ) {
      throw new Error(
        `Expected a module type for argument ${i + 1} of 'dyn' expression.`
      );
    }
    env = evaluatedModule.$.env;

    const moduleType = evaluatedModule.$.value.value;

    // Check if moduleType has `This` type
    if (
      moduleType.elements.findIndex((element) => element.label === "This") ===
      -1
    ) {
      throw formatErrorMessage({
        token: moduleExpr.token,
        errorMessage: `Module type for argument ${i + 1} of '${BuiltinKeywords.Dyn}' expression must have a 'This' type.`,
      });
    }

    // Check if the moduleType already exists in moduleTypes
    if (moduleTypes.some((mt) => mt.id === moduleType.id)) {
      throw formatErrorMessage({
        token: moduleExpr.token,
        errorMessage: `Module type ${typeToString(moduleType)} is already included in '${BuiltinKeywords.Dyn}' expression.`,
      });
    }

    moduleTypes.push(moduleType);
  }

  // Prevent having the same function names in different moduleTypes
  for (let i = 0; i < moduleTypes.length; i++) {
    const moduleTypeA = moduleTypes[i]!;
    for (let j = i + 1; j < moduleTypes.length; j++) {
      const moduleTypeB = moduleTypes[j]!;
      for (const elementA of moduleTypeA.elements) {
        if (
          moduleTypeB.elements.findIndex(
            (elementB) =>
              elementA.label === elementB.label &&
              elementA.label !== "This" && // Allow `This` to be in multiple module types
              isFunctionType(elementA.type) &&
              isFunctionType(elementB.type)
          ) !== -1
        ) {
          throw formatErrorMessage({
            token: expr.token,
            errorMessage: `Module types ${typeToString(
              moduleTypeA
            )} and ${typeToString(
              moduleTypeB
            )} have conflicting function name '${elementA.label}' in 'dyn' expression.`,
          });
        }
      }
    }
  }

  // Prevent having ___dup, ___drop, ___dispose, dispose in moduleTypes
  const reservedFunctionNames = [
    BuiltinFunctions.___dup[0]!,
    BuiltinFunctions.___drop[0]!,
    BuiltinFunctions.___dispose[0]!,
    BuiltinFunctions.dispose[0]!,
  ];
  for (const moduleType of moduleTypes) {
    for (const element of moduleType.elements) {
      if (
        reservedFunctionNames.includes(element.label) &&
        isFunctionType(element.type)
      ) {
        throw formatErrorMessage({
          token: expr.token,
          errorMessage: `Module type ${typeToString(
            moduleType
          )} cannot have function '${element.label}' as it is reserved in 'dyn' expression.`,
        });
      }
    }
  }

  // QUESTION: From the C codegen, it seems like only the ___dispose is used for the wrapped object
  // So do we still need to have ___dup and ___drop in the module type for the wrapped object?
  // Create a module type that defines the ARC interface for the wrapped object
  // This will be used to call ___dup, ___drop, ___dispose on the inner data
  const wrappedObjectARCModuleTypeExpr = generateExprFromCode(`
module(
  Self : Type,
  /// ___dup :
  ///   fn(self: Self) -> Self,
  /// ___drop :
  ///   fn(self: Self) -> unit,
  ___dispose :
    fn(self: Self) -> unit
)
`);
  /// evaluate the wrappedObjectARCModuleTypeExpr
  const evaluatedWrappedObjectARCModuleTypeExpr = context.evaluateExpression({
    expr: wrappedObjectARCModuleTypeExpr,
    env,
    context: {
      ...context,
    },
  });
  /// get its type value, which should be a ModuleType
  const wrappedObjectARCModuleTypeValue =
    evaluatedWrappedObjectARCModuleTypeExpr.$?.value;
  if (!isTypeValue(wrappedObjectARCModuleTypeValue)) {
    throw new Error(
      `Expected a type value for wrapped object ARC module type.`
    );
  }
  if (!isModuleType(wrappedObjectARCModuleTypeValue.value)) {
    throw new Error(
      `Expected a module type for wrapped object ARC module type.`
    );
  }
  const wrappedObjectARCModuleType = wrappedObjectARCModuleTypeValue.value;

  // Create the dyn type with its own module for ARC functions
  const dynType = createDynType(
    [wrappedObjectARCModuleType, ...moduleTypes],
    env
  );

  // Add ARC functions to the dyn type's module
  env = addARCFunctionsToDynType({
    dynType,
    env,
    context,
  });
  const dynTypeValue = createTypeValue(dynType);

  expr.$ = {
    env,
    value: dynTypeValue,
    type: dynTypeValue.type,
    pathCollection: [],
  };
  return expr;
}
