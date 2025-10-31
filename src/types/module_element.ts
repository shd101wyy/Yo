import { EvaluatorContext } from "../evaluator/context";
import { generateExprFromCode } from "../parser";
import { ModuleElement, ModuleType } from "./definitions";

export function addModuleElementsByCode(
  module: ModuleType,
  context: EvaluatorContext,
  elements: Record<string, string>
) {
  const selfType = module.receiverType;
  for (const label in elements) {
    const argCode = elements[label]!;
    const argExpr = generateExprFromCode(argCode);
    const evaluatedArgCode = context.evaluateExpression({
      expr: argExpr,
      env: module.env,
      context: {
        ...context,
        SelfType: selfType,
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
}
