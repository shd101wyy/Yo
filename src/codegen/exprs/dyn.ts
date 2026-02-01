import { extractFnTraitFromType } from "../../evaluator/trait-checking";
import { FnCallExpr } from "../../expr";
import { Type } from "../../types/definitions";
import { isBoxedType, isDynType, isObjectType } from "../../types/guards";
import { CodeGenContext, getVariableTypeString } from "../utils";
import { generateExpr } from "./expr";

/**
 * Generate C code for a dyn() constructor call
 */
export function generateDynCall(
  expr: FnCallExpr,
  indent: string,
  context: CodeGenContext
): string {
  if (!expr.$?.dynCallTraitValues || expr.$.dynCallTraitValues.length === 0) {
    return `/* Error: dyn() call missing trait values */`;
  }

  // Use runtimeArgExprsInOrder which contains the evaluated args with metadata
  const valueExpr = expr.$?.runtimeArgExprsInOrder?.[0] ?? expr.args[0];
  if (!valueExpr) {
    return `/* Error: dyn() requires a value argument */`;
  }

  // Get the dyn type information
  const dynType = expr.$.type;
  if (!isDynType(dynType)) {
    return `/* Error: dyn() result type is not DynType */`;
  }

  // Note: Dyn is always a value type fat pointer (per DYN_DESIGN.md).
  // Closures are value types, so Dyn(Fn(...)) must wrap a boxed closure: `dyn(box(closure))`.

  // Regular dyn() call - dyn is a value type (fat pointer)
  // The wrapped value must be an object type (including Box(T)).
  const valueType = valueExpr.$?.type;
  if (!valueType) {
    return `/* Error: dyn() value has no type */`;
  }

  // Get the module value from dynCallTraitValues
  const traitValues = expr.$.dynCallTraitValues;
  if (!traitValues || traitValues.length === 0) {
    return `/* Error: dyn() call missing trait values */`;
  }

  // dyn() requires an object type (including Box(T)); value types must use box().
  if (!isObjectType(valueType) && !isBoxedType(valueType)) {
    return `/* Error: dyn() requires an object type (use box() for value types) */`;
  }

  // If value is Box(T), the impl concrete type is T, but the runtime data type is Box(T).
  const concreteType: Type = isBoxedType(valueType)
    ? valueType.fields[0]!.type
    : valueType;

  // Create a unique key for this impl combination
  const dynTypeCName =
    context.types[dynType.id]?.cName || `yo_dyn_${dynType.id}`;
  // For boxed closures, concreteType is often `Impl(Fn(...))` which is a `SomeType`.
  // Prefer the corresponding FnTraitType's C name so generated symbols are stable.
  const concreteTypeCName = (() => {
    const direct = context.types[concreteType.id]?.cName;
    if (direct) {
      return direct;
    }
    const fnModule = extractFnTraitFromType(concreteType);
    const fnModuleCName = fnModule
      ? context.types[fnModule.id]?.cName
      : undefined;
    return fnModuleCName || `unknown_${concreteType.id}`;
  })();
  const implKey = `${concreteTypeCName}_${dynTypeCName}`;

  // Register this impl in context for later generation
  context.dynImpls.set(implKey, {
    dynType,
    concreteType,
    dataType: valueType,
    traitValues,
  });

  // Generate the value expression
  let valueCode = generateExpr(valueExpr, indent, context);

  // If the value expression has a temporary variable name assigned by the evaluator,
  // we must declare it because deferred drop expressions might refer to it.
  if (valueExpr.$?.variableName && valueCode !== valueExpr.$.variableName) {
    const varTypeAndName = getVariableTypeString(
      valueExpr.$.type!,
      valueExpr.$.variableName,
      context
    );
    context.emitter.emitLine(`${indent}${varTypeAndName} = ${valueCode};`);
    valueCode = valueExpr.$.variableName;
  }

  const tempVarName = expr.$?.variableName;
  if (!tempVarName) {
    return `/* Error: dyn() expression missing temp variable name */`;
  }

  // Generate: Dyn value = { .data = valueCode, .vtable = &vtable }
  const vtableName = `yo_vtable_${implKey}`;
  context.emitter.emitLine(`${indent}${dynTypeCName} ${tempVarName} = {`);
  context.emitter.emitLine(`${indent}  .data = ${valueCode},`);
  context.emitter.emitLine(`${indent}  .vtable = &${vtableName}`);
  context.emitter.emitLine(`${indent}};`);

  return tempVarName;
}
