import { Environment } from "../../env";
import { expectExprToBeFunctionCallOf, FuncCallExpr } from "../../expr";
import { createDynType, isModuleType, ModuleType } from "../../types";
import { createTypeValue, isTypeValue } from "../../value";
import { EvaluatorContext } from "../context";

export function evaluateDyn({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  expectExprToBeFunctionCallOf(expr, "dyn");
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
      throw new Error(
        `Module type for argument ${i + 1} of 'dyn' expression must have a 'Self' type.`
      );
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
