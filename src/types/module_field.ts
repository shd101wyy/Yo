import { evaluateExpression } from "../evaluator/exprs/expr";
import { generateExprFromCode } from "../parser";
import { ModuleField, ModuleType } from "./definitions";

export function addModuleFieldsByCode(
  module: ModuleType,
  elements: Record<string, string>
) {
  const selfType = module.receiverType;
  for (const label in elements) {
    const argCode = elements[label]!;
    const argExpr = generateExprFromCode(argCode);
    const evaluatedArgCode = evaluateExpression({
      expr: argExpr,
      env: module.env,
      context: {
        SelfType: selfType,
        stdPath: "",
      },
    });
    if (!evaluatedArgCode.$ || !evaluatedArgCode.$.value) {
      throw new Error(`Failed to evaluate module field code:
- label: ${label}
- argCode:

${argCode}`);
    }

    const argValue = evaluatedArgCode.$.value;
    const moduleField: ModuleField = {
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

    module.fields.push(moduleField);
  }
}
