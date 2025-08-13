import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinKeywords,
  expectExprToBeFunctionCallOf,
  FuncCallExpr,
} from "../../expr";
import {
  createDynType,
  isModuleType,
  ModuleType,
  typeToString,
} from "../../types";
import { createTypeValue, isTypeValue } from "../../value";
import { EvaluatorContext } from "../context";

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

    // Check if moduleType has `Self` type
    if (
      moduleType.elements.findIndex((element) => element.label === "Self") ===
      -1
    ) {
      throw formatErrorMessage({
        token: moduleExpr.token,
        errorMessage: `Module type for argument ${i + 1} of '${BuiltinKeywords.Dyn}' expression must have a 'Self' type.`,
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

  const dynType = createDynType(moduleTypes);
  const dynTypeValue = createTypeValue(dynType);

  expr.$ = {
    env,
    value: dynTypeValue,
    type: dynTypeValue.type,
    isMutable: false,
    pathCollection: [],
  };
  return expr;
}
