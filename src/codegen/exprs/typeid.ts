import type { FnCallExpr } from "../../expr";
import { isTypeValue } from "../../value";
import type { CodeGenContext } from "../utils";
import { getTypeString, sanitizeForCIdentifier } from "../utils";

/**
 * Generate code for `typeid(T)`.
 *
 * Each unique type gets a `static const char yo_typeid_XXX = 0;` declaration.
 * The expression evaluates to `(uintptr_t)&yo_typeid_XXX`.
 */
export function generateTypeId(
  expr: FnCallExpr,
  indent: string,
  context: CodeGenContext
): string {
  const arg = expr.args[0]!;

  const typeValue = arg.$?.value;
  if (!typeValue || !isTypeValue(typeValue)) {
    throw new Error("typeid codegen: expected TypeValue argument");
  }

  const type = typeValue.value;
  const typeId = type.id;
  // Use raw cName (without * for reference types) to match vtable typeid naming
  const typeCName =
    context.types[typeId]?.cName || getTypeString(type, context);
  const staticVarName = `yo_typeid_${sanitizeForCIdentifier(typeCName)}`;

  // Register the static declaration if not already registered
  if (!context.typeIdStatics) {
    context.typeIdStatics = new Map();
  }
  if (!context.typeIdStatics.has(typeId)) {
    context.typeIdStatics.set(typeId, staticVarName);
    // Emit the static declaration immediately
    context.emitter.emitDeclarationLine(
      `static const char ${staticVarName} = 0;`
    );
  }

  context.cIncludes.add("<stdint.h>");
  return `(uintptr_t)&${staticVarName}`;
}
