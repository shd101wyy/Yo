import { extractFnTraitFromType } from "../../evaluator/trait-checking";
import { type FnCallExpr, exprIsFunctionCall } from "../../expr";
import type { Type } from "../../types/definitions";
import {
  isBoxedType,
  isDynType,
  isReferenceStructType,
  isSomeType,
} from "../../types/guards";
import { type FunctionGenerationContext } from "../functions/context";
import {
  type CodeGenContext,
  getVariableNameForCodegen,
  getVariableTypeString,
} from "../utils";
import { generateDeferredDupExpressions } from "./drop-dup";
import { generateExpr } from "./expr";
import { getStateMachineFieldName } from "../async/state-machine";

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

  // Get the effect record value from dynCallTraitValues
  const traitValues = expr.$.dynCallTraitValues;
  if (!traitValues || traitValues.length === 0) {
    return `/* Error: dyn() call missing trait values */`;
  }

  // dyn() requires an object type (including Box(T)); value types must use box().
  if (!isReferenceStructType(valueType) && !isBoxedType(valueType)) {
    return `/* Error: dyn() requires an object type (use box() for value types) */`;
  }

  // If value is Box(T), the impl concrete type is T, but the runtime data type is Box(T).
  const concreteType: Type = isBoxedType(valueType)
    ? valueType.fields[0]!.type
    : valueType;

  // Resolve SomeType to its concrete type for name lookup
  const resolvedConcreteType =
    isSomeType(concreteType) && concreteType.resolvedConcreteType
      ? concreteType.resolvedConcreteType
      : concreteType;

  // Create a unique key for this impl combination
  const dynTypeCName =
    context.types[dynType.id]?.cName || `__yo_dyn_${dynType.id}`;
  // For boxed closures, concreteType is often `Impl(Fn(...))` which is a `SomeType`.
  // Prefer the corresponding FnTraitType's C name so generated symbols are stable.
  const concreteTypeCName = (() => {
    const direct = context.types[resolvedConcreteType.id]?.cName;
    if (direct) {
      return direct;
    }
    const fnTrait = extractFnTraitFromType(resolvedConcreteType);
    const fnTraitCName = fnTrait ? context.types[fnTrait.id]?.cName : undefined;
    return fnTraitCName || `unknown_${resolvedConcreteType.id}`;
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

  // Emit deferred dup expressions for the inner value (e.g., dyn(dog) must dup dog
  // so both the Dyn wrapper's drop and the scope-exit drop can each decrement RC).
  if (
    valueExpr.$?.deferredDupExpressions &&
    valueExpr.$.deferredDupExpressions.length > 0
  ) {
    generateDeferredDupExpressions(
      valueExpr,
      indent,
      context as FunctionGenerationContext
    );
    const dupExpr = valueExpr.$.deferredDupExpressions[0]!;
    if (exprIsFunctionCall(dupExpr) && dupExpr.$?.variableName) {
      valueCode = getVariableNameForCodegen(
        dupExpr.$.variableName,
        dupExpr.$.env
      );
    }
  }

  const tempVarName = expr.$?.variableName;
  if (!tempVarName) {
    return `/* Error: dyn() expression missing temp variable name */`;
  }

  // In SM context, use the SM field instead of a C local variable.
  // This ensures escape handlers can correctly access and drop the dyn value.
  const functionContext = context as FunctionGenerationContext;
  let smFieldRef: string | undefined;
  if (
    functionContext.inAsyncStateMachine &&
    functionContext.stateMachineVariables
  ) {
    for (const [, capturedVar] of functionContext.stateMachineVariables) {
      if (capturedVar.kind === "local" && capturedVar.id === tempVarName) {
        smFieldRef = `sm->${getStateMachineFieldName(capturedVar.id, "local", functionContext.stateMachineFieldAliases)}`;
        break;
      }
    }
  }

  // Generate: Dyn value = { .data = valueCode, .vtable = &vtable }
  const vtableName = `__yo_vtable_${implKey}`;
  if (smFieldRef) {
    context.emitter.emitLine(`${indent}${smFieldRef} = (${dynTypeCName}){`);
    context.emitter.emitLine(`${indent}  .data = ${valueCode},`);
    context.emitter.emitLine(`${indent}  .vtable = &${vtableName}`);
    context.emitter.emitLine(`${indent}};`);
    return smFieldRef;
  } else {
    const funcCtx = context as FunctionGenerationContext;
    if (!funcCtx.declaredTempVars) funcCtx.declaredTempVars = new Set();
    if (!funcCtx.declaredTempVars.has(tempVarName)) {
      funcCtx.declaredTempVars.add(tempVarName);
    }
    context.emitter.emitLine(`${indent}${dynTypeCName} ${tempVarName} = {`);
    context.emitter.emitLine(`${indent}  .data = ${valueCode},`);
    context.emitter.emitLine(`${indent}  .vtable = &${vtableName}`);
    context.emitter.emitLine(`${indent}};`);
    return tempVarName;
  }
}
