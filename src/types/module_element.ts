import { Environment } from "../env";
import { EvaluatorContext } from "../evaluator/context";
import { generateExprFromCode } from "../parser";
import { ModuleElement, ModuleType } from "./definitions";

export function addModuleElementByCode(
  module: ModuleType,
  env: Environment,
  context: EvaluatorContext,
  label: string,
  argCode: string
) {
  const argExpr = generateExprFromCode(argCode);
  const evaluatedArgCode = context.evaluateExpression({
    expr: argExpr,
    env,
    context: {
      ...context,
      SelfType: module.receiverType,
    },
  });
  if (!evaluatedArgCode.$ || !evaluatedArgCode.$.value) {
    throw new Error(`Failed to evaluate module element code:
- label: ${label}
- argCode:

${argCode}`);
  }

  const argValue = evaluatedArgCode.$.value;
  const moduleElement: ModuleElement = {
    label,
    isCompileTimeOnly: true,
    type: argValue.type,
    assignedValue: argValue,
    exprs: {
      expr: argExpr,
      typeExpr: undefined,
      labelExpr: undefined,
      defaultValueExpr: undefined,
    },
  };

  module.elements.push(moduleElement);
}
