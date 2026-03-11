import type { FnCallExpr } from "../../expr";
import { isDynType, isEnumType } from "../../types/guards";
import { isTypeValue } from "../../value";
import type { CodeGenContext } from "../utils";
import {
  canOptimizeAsNullablePointer,
  getEnumVariantCName,
  getTypeString,
  sanitizeForCIdentifier,
} from "../utils";
import { generateExpr } from "./expr";

/**
 * Generate code for `downcast(dyn_value, T)`.
 *
 * Safe downcast returning Option(T). Dyn only wraps object types,
 * so the result is always an owned RC reference.
 *
 * If Option is nullable-pointer-optimized:
 *   (check) ? cast_expr : NULL
 *
 * Otherwise (full tagged union):
 *   (check)
 *     ? (OptionCName){ .tag = SOME_TAG, .data = { .Some = { .value = cast_expr } } }
 *     : (OptionCName){ .tag = NONE_TAG }
 */
export function generateDowncast(
  expr: FnCallExpr,
  indent: string,
  context: CodeGenContext
): string {
  // First argument: the dyn value (runtime)
  const dynArg = expr.args[0]!;
  const dynType = dynArg.$?.type;
  if (!dynType || !isDynType(dynType)) {
    throw new Error("downcast codegen: expected Dyn type as first argument");
  }
  const dynCode = generateExpr(dynArg, indent, context);

  // Second argument: the target type T (comptime)
  const typeArg = expr.args[1]!;
  const typeValue = typeArg.$?.value;
  if (!typeValue || !isTypeValue(typeValue)) {
    throw new Error("downcast codegen: expected TypeValue as second argument");
  }

  const targetType = typeValue.value;
  const targetTypeCName = getTypeString(targetType, context);

  // Register typeid static for the target type
  // Use raw cName (without * for reference types) to match vtable typeid naming
  const typeIdCName = context.types[targetType.id]?.cName || targetTypeCName;
  const staticVarName = `yo_typeid_${sanitizeForCIdentifier(typeIdCName)}`;
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

  // Build the is-check expression
  const isCheck = `${dynCode}.vtable->__yo_type_id == (uintptr_t)&${staticVarName}`;

  // Build the cast expression — Dyn only wraps object types.
  // The evaluator uses attachTempVariableToExpr(expr, true) so the RC
  // system handles drop automatically. We still need to dup (incr refcount)
  // here because the Dyn also holds a reference to the same object.
  const castExpr = `((${targetTypeCName})__yo_incr_rc((void*)${dynCode}.data))`;

  // Get the result Option type from the evaluated expression
  const optionType = expr.$?.type;
  if (!optionType || !isEnumType(optionType)) {
    throw new Error("downcast codegen: expected Option enum as result type");
  }

  // Check if nullable-pointer-optimized
  const nullablePointerType = canOptimizeAsNullablePointer(optionType);
  if (nullablePointerType) {
    return `((${isCheck}) ? ${castExpr} : NULL)`;
  }

  // Full tagged union construction
  const optionCName = getTypeString(optionType, context);
  const someTag = getEnumVariantCName(optionType, "Some", context);
  const noneTag = getEnumVariantCName(optionType, "None", context);

  const someExpr = `(${optionCName}){ .tag = ${someTag}, .data = { .Some = { .value = ${castExpr} } } }`;
  const noneExpr = `(${optionCName}){ .tag = ${noneTag} }`;

  return `((${isCheck}) ? ${someExpr} : ${noneExpr})`;
}
