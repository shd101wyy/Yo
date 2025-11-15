import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinFunctions,
  BuiltinKeywords,
  expectExprToBeFunctionCallOf,
  FuncCallExpr,
} from "../../expr";
import {
  createDynType,
  isFunctionType,
  isModuleType,
  ModuleType,
  typeToString,
} from "../../types";
import { createTypeValue, isTypeValue } from "../../value";
import { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";

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
    const evaluatedModule = evaluateExpression({
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
      for (const elementA of moduleTypeA.fields) {
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

  // Prevent having "dispose" in moduleTypes
  const reservedFunctionNames = [BuiltinFunctions.dispose[0]!];
  for (const moduleType of moduleTypes) {
    for (const element of moduleType.fields) {
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

  // Create the dyn type
  const dynType = createDynType([...moduleTypes], env);

  const dynTypeValue = createTypeValue(dynType);

  expr.$ = {
    env,
    value: dynTypeValue,
    type: dynTypeValue.type,
    pathCollection: [],
  };
  return expr;
}
