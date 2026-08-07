import type { FnCallExpr } from "../../expr";
import {
  isBoxedType,
  isDynType,
  isEnumType,
  isAtomicReferenceStructType,
  isNewtypeType,
  isReferenceStructType,
  isSomeType,
} from "../../types/guards";
import { isTypeValue } from "../../value";
import type { CodeGenContext } from "../utils";
import {
  canOptimizeAsNullablePointer,
  getEnumVariantCName,
  getTypeString,
  sanitizeForCIdentifier,
} from "../utils";
import { generateExpr } from "./expr";
import { getDupFunctionForType } from "./drop-dup";

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
  const staticVarName = `__yo_typeid_${sanitizeForCIdentifier(typeIdCName)}`;
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
  //
  // For auto-boxed value types (e.g., String via Box(String)), dyn.data points
  // to the Box struct, not the value directly. We need to extract the value
  // from the box before returning it.
  let castExpr: string;

  // Find if this concrete type was boxed by looking through dynImpls
  let wasBoxed = false;
  let boxTypeCName = "";
  let boxFieldName = "";
  for (const [, impl] of context.dynImpls) {
    if (impl.dynType.id !== dynType.id) continue;
    const resolvedConcreteType =
      isSomeType(impl.concreteType) && impl.concreteType.resolvedConcreteType
        ? impl.concreteType.resolvedConcreteType
        : impl.concreteType;
    if (
      resolvedConcreteType.id === targetType.id &&
      isBoxedType(impl.dataType)
    ) {
      wasBoxed = true;
      boxTypeCName =
        context.types[impl.dataType.id]?.cName ||
        `unknown_box_${impl.dataType.id}`;
      boxFieldName = sanitizeForCIdentifier(impl.dataType.fields[0]!.label);
      break;
    }
  }

  if (wasBoxed) {
    // For boxed types: extract the value from the box.
    // The box still owns its copy, so we must dup the extracted value.
    //
    // For object types (direct pointers), __yo_incr_rc suffices.
    // For newtypes wrapping objects (e.g., String = newtype(Option(ArrayList(u8)))),
    // we need the type's ___dup function to properly increment inner RC references.
    // For simple value types (plain enums, value structs), a memcpy is fine.
    const extractExpr = `((${boxTypeCName}*)${dynCode}.data)->${boxFieldName}`;

    // Check if the type has a ___dup function (handles newtypes, enums with RC fields, etc.)
    const dupFnCName = getDupFunctionForType(targetType, context);

    if (isReferenceStructType(targetType)) {
      // Direct object pointer — use atomic or non-atomic incr_rc
      const incrFn = isAtomicReferenceStructType(targetType)
        ? "__yo_incr_rc_atomic"
        : "__yo_incr_rc";
      castExpr = `((${targetTypeCName})${incrFn}((void*)${extractExpr}))`;
    } else if (dupFnCName) {
      // Type has a dup function (e.g., String, enums containing RC fields)
      castExpr = `${dupFnCName}((${targetTypeCName})${extractExpr})`;
    } else {
      // Fallback: check newtypes wrapping objects
      let needsRcDup = false;
      let isAtomic = false;
      let unwrapped = targetType;
      while (isNewtypeType(unwrapped) && unwrapped.fields.length === 1) {
        unwrapped = unwrapped.fields[0]!.type;
      }
      needsRcDup = isReferenceStructType(unwrapped);
      isAtomic = isAtomicReferenceStructType(unwrapped);

      if (needsRcDup) {
        const incrFn = isAtomic ? "__yo_incr_rc_atomic" : "__yo_incr_rc";
        castExpr = `((${targetTypeCName})${incrFn}((void*)${extractExpr}))`;
      } else {
        castExpr = `((${targetTypeCName})${extractExpr})`;
      }
    }
  } else {
    castExpr = `((${targetTypeCName})__yo_incr_rc((void*)${dynCode}.data))`;
  }

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
