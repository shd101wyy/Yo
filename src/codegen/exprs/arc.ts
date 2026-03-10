import type { FnCallExpr } from "../../expr";
import type { TypeValue } from "../../type-value";
import type { ArcType } from "../../types/definitions";
import { isArcType } from "../../types/guards";
import { isTypeValue } from "../../value";
import { type CodeGenContext, getTypeString } from "../utils";
import { generateExpr } from "./expr";

export function generateYoArcDispose(
  expr: FnCallExpr,
  indent: string,
  context: CodeGenContext
): string {
  const selfArg = expr.args[0];
  if (!selfArg) {
    return `// Error: __yo_arc_dispose requires exactly 1 argument`;
  }
  const selfCode = generateExpr(selfArg, indent, context);
  const selfType = selfArg.$?.type;

  if (!selfType || !isArcType(selfType)) {
    return `// Error: __yo_arc_dispose requires an Arc type`;
  }

  const arcTypeCName = getTypeString(selfType, context);
  return `__yo_arc_dispose_${arcTypeCName}(${selfCode})`;
}

export function isArcTypeCall(expr: FnCallExpr): boolean {
  const funcValue = expr.func.$?.value;
  return (
    isTypeValue(funcValue) &&
    isArcType(funcValue.value) &&
    expr.args.length === 1
  );
}

/**
 * Arc(T)(value) - Arc value constructor
 */
export function generateArcTypeCall(
  expr: FnCallExpr,
  indent: string,
  context: CodeGenContext
): string {
  if (!isArcTypeCall(expr)) {
    return `/* Error: generateArcTypeCall called on non-Arc type call */`;
  }

  const funcValue = expr.func.$?.value as TypeValue;
  const arcType = funcValue!.value as ArcType;
  const childType = arcType.childType;

  const valueArg = expr.args[0]!;
  const valueCode = generateExpr(valueArg, indent, context);

  const arcTypeCName = getTypeString(arcType, context);
  const childTypeCName = getTypeString(childType, context);

  if (!context.arcTypes) {
    context.arcTypes = new Map();
  }
  if (!context.arcTypes.has(arcTypeCName)) {
    context.arcTypes.set(arcTypeCName, { childTypeCName, arcType });
  }

  return `__yo_create_arc_${arcTypeCName}(${valueCode})`;
}
