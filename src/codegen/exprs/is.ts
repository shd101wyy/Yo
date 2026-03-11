import type { FnCallExpr } from "../../expr";
import { isDynType } from "../../types/guards";
import { isTypeValue } from "../../value";
import type { CodeGenContext } from "../utils";
import { getTypeString, sanitizeForCIdentifier } from "../utils";
import { generateExpr } from "./expr";

/**
 * Generate code for `is(dyn_value, T)`.
 *
 * Checks if the Dyn value's runtime type ID matches the compile-time type T.
 * Emits: `(dyn_value.vtable->__yo_type_id == (uintptr_t)&yo_typeid_T)`
 */
export function generateIs(
  expr: FnCallExpr,
  indent: string,
  context: CodeGenContext
): string {
  // First argument: the dyn value (runtime)
  const dynArg = expr.args[0]!;
  const dynType = dynArg.$?.type;
  if (!dynType || !isDynType(dynType)) {
    throw new Error("is codegen: expected Dyn type as first argument");
  }
  const dynCode = generateExpr(dynArg, indent, context);

  // Second argument: the target type T (comptime)
  const typeArg = expr.args[1]!;
  const typeValue = typeArg.$?.value;
  if (!typeValue || !isTypeValue(typeValue)) {
    throw new Error("is codegen: expected TypeValue as second argument");
  }

  const targetType = typeValue.value;
  // Use raw cName (without * for reference types) to match vtable typeid naming
  const typeCName =
    context.types[targetType.id]?.cName || getTypeString(targetType, context);
  const staticVarName = `yo_typeid_${sanitizeForCIdentifier(typeCName)}`;

  // Register the static declaration if not already registered
  if (!context.typeIdStatics) {
    context.typeIdStatics = new Map();
  }
  if (!context.typeIdStatics.has(targetType.id)) {
    context.typeIdStatics.set(targetType.id, staticVarName);
    context.emitter.emitDeclarationLine(
      `static const char ${staticVarName} = 0;`
    );
  }

  context.cIncludes.add("<stdint.h>");
  return `(${dynCode}.vtable->__yo_type_id == (uintptr_t)&${staticVarName})`;
}
