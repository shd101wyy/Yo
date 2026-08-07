import {
  BuiltinFunctions,
  type Expr,
  exprIsAtom,
  exprIsFunctionCall,
} from "../../expr";
import type { Type } from "../../types/definitions";
import {
  isArrayType,
  isAtomicReferenceStructType,
  isDynType,
  isEnumType,
  isIsoType,
  isReferenceStructType,
  isSomeType,
  isStructType,
  isTupleType,
} from "../../types/guards";
import { typeContainsRcType } from "../../types/utils";
import { isCodegenTempName, randomId } from "../../utils";
import { isFunctionValue, isNumberValue } from "../../value";
import type { FunctionGenerationContext } from "../functions/context";
import {
  type CodeGenContext,
  getDeferredDropTargetAtomName,
  getTypeString,
  isDeferredDropForClosureCapture,
} from "../utils";
import { generateExpr } from "./expr";

/**
 * If `valueArg` is an atom referring to a function parameter whose static type is an
 * unresolved SomeType (generic-typed), look up the concrete parameter type from
 * `currentFunctionType.parameters` so drop/dup codegen can find the right RC handler.
 *
 * This fixes a leak where generic-typed parameters (e.g., `f : F where F <: Fn(...)`)
 * were silently skipped by drop/dup codegen because their AST `$.type` remains a
 * SomeType without `resolvedConcreteType`, even though the specialized C signature
 * uses the concrete type.
 */
export function resolveSomeTypeParamType(
  valueArg: Expr,
  valueType: Type,
  context: CodeGenContext
): Type {
  if (!isSomeType(valueType) || valueType.resolvedConcreteType) {
    return valueType;
  }
  if (!exprIsAtom(valueArg)) {
    return valueType;
  }
  const fnCtx = context as FunctionGenerationContext;
  const fnType = fnCtx.currentFunctionType;
  if (!fnType) {
    return valueType;
  }
  const varName = valueArg.token.value;
  const param = fnType.parameters.find((p) => p.label === varName);
  if (param && !isSomeType(param.type)) {
    return param.type;
  }
  if (param && isSomeType(param.type) && param.type.resolvedConcreteType) {
    return param.type.resolvedConcreteType;
  }
  return valueType;
}

/**
 * Helper function to generate drop code for a value of any type.
 * This handles arrays recursively.
 */
export function generateDropCodeForValue(
  valueCode: string,
  valueType: Type,
  context: CodeGenContext
): string {
  // Universal drop choke point (every `fn_TYPE___drop(value)` string flows
  // through here). Skip dropping a codegen TEMP whose C declaration has not been
  // emitted at this point — declaredCVarNames grows in C-emission order, so a
  // synthetic temp scheduled for drop but declared only in a later/other branch
  // would emit a drop on an undeclared C identifier. Only bare temp names match
  // (recursive field/element valueCode like `x->f` does not). Mirrors yo-self's
  // declared_c_var_names gate.
  const trimmedDropValue = valueCode.trim();
  if (
    isCodegenTempName(trimmedDropValue) &&
    !(context.declaredCVarNames?.has(trimmedDropValue) ?? true)
  ) {
    return "";
  }
  const concreteType =
    isSomeType(valueType) && valueType.resolvedConcreteType
      ? valueType.resolvedConcreteType
      : valueType;

  if (!typeContainsRcType(concreteType)) {
    return "";
  }

  // Handle arrays recursively
  if (isArrayType(concreteType)) {
    const arrayLength = concreteType.length;
    if (!isNumberValue(arrayLength)) {
      return `/* Error: array has non-constant length */`;
    }
    const emitter = (context as FunctionGenerationContext).emitter;
    emitter.emitLine(`for (size_t i = 0; i < ${arrayLength.value}; i++) {`);
    const elementDropCode = generateDropCodeForValue(
      `(${valueCode}).data[i]`,
      concreteType.childType,
      context
    );
    if (elementDropCode) {
      emitter.emitLine(`  ${elementDropCode};`);
    }
    emitter.emitLine(`}`);
    return "";
  }

  // Handle tuples recursively
  if (isTupleType(concreteType)) {
    const emitter = (context as FunctionGenerationContext).emitter;
    for (let i = 0; i < concreteType.fields.length; i++) {
      const fieldType = concreteType.fields[i]!.type;
      const concreteFieldType =
        isSomeType(fieldType) && fieldType.resolvedConcreteType
          ? fieldType.resolvedConcreteType
          : fieldType;
      if (typeContainsRcType(concreteFieldType)) {
        const fieldDropCode = generateDropCodeForValue(
          `(${valueCode})._${i}`,
          fieldType,
          context
        );
        if (fieldDropCode) {
          emitter.emitLine(`${fieldDropCode};`);
        }
      }
    }
    return "";
  }

  // Handle other types
  if (isDynType(concreteType)) {
    return `__yo_decr_rc((void*)(${valueCode}).data)`;
  }
  if (isAtomicReferenceStructType(concreteType)) {
    return `__yo_decr_rc_atomic((void*)(${valueCode}))`;
  }
  if (isReferenceStructType(concreteType)) {
    return `__yo_decr_rc((void*)(${valueCode}))`;
  }
  if (isIsoType(concreteType)) {
    return `__yo_decr_rc_atomic((void*)(${valueCode}))`;
  }
  if (isStructType(concreteType) || isEnumType(concreteType)) {
    const dropFnCName = getDropFunctionForType(concreteType, context);
    if (dropFnCName) {
      return `${dropFnCName}(${valueCode})`;
    }
  }

  return "";
}

/**
 * Helper function to generate dup code for a value of any type.
 * This handles arrays recursively.
 */
export function generateDupCodeForValue(
  valueCode: string,
  valueType: Type,
  context: CodeGenContext
): string {
  const concreteType =
    isSomeType(valueType) && valueType.resolvedConcreteType
      ? valueType.resolvedConcreteType
      : valueType;

  // Handle arrays recursively
  if (isArrayType(concreteType)) {
    const arrayLength = concreteType.length;
    if (!isNumberValue(arrayLength)) {
      return `/* Error: array has non-constant length */`;
    }
    const tempVar = `temp_dup_${randomId("")}`;
    const loopVar = `i_${randomId("")}`;
    const arrayCName = getTypeString(concreteType, context);
    const emitter = (context as FunctionGenerationContext).emitter;
    emitter.emitLine(`${arrayCName} ${tempVar} = ${valueCode};`);
    emitter.emitLine(
      `for (size_t ${loopVar} = 0; ${loopVar} < ${arrayLength.value}; ${loopVar}++) {`
    );
    const elementDupCode = generateDupCodeForValue(
      `${tempVar}.data[${loopVar}]`,
      concreteType.childType,
      context
    );
    emitter.emitLine(`  ${tempVar}.data[${loopVar}] = ${elementDupCode};`);
    emitter.emitLine(`}`);
    return tempVar;
  }

  // Handle tuples - dup the RC fields
  if (isTupleType(concreteType)) {
    const emitter = (context as FunctionGenerationContext).emitter;
    const tempVar = `temp_dup_tuple_${randomId("")}`;
    const tupleCName = getTypeString(concreteType, context);
    emitter.emitLine(`${tupleCName} ${tempVar} = ${valueCode};`);
    for (let i = 0; i < concreteType.fields.length; i++) {
      const fieldType = concreteType.fields[i]!.type;
      const concreteFieldType =
        isSomeType(fieldType) && fieldType.resolvedConcreteType
          ? fieldType.resolvedConcreteType
          : fieldType;
      if (typeContainsRcType(concreteFieldType)) {
        const fieldDupCode = generateDupCodeForValue(
          `${tempVar}._${i}`,
          fieldType,
          context
        );
        emitter.emitLine(`${tempVar}._${i} = ${fieldDupCode};`);
      }
    }
    return tempVar;
  }

  // Handle other types
  if (isDynType(concreteType)) {
    const dynCName = getTypeString(concreteType, context);
    return `((${dynCName}){ .data = __yo_incr_rc((void*)(${valueCode}).data), .vtable = (${valueCode}).vtable })`;
  }
  if (isAtomicReferenceStructType(concreteType)) {
    const objCName = getTypeString(concreteType, context);
    return `((${objCName})__yo_incr_rc_atomic((void*)(${valueCode})))`;
  }
  if (isReferenceStructType(concreteType)) {
    const objCName = getTypeString(concreteType, context);
    return `((${objCName})__yo_incr_rc((void*)(${valueCode})))`;
  }
  if (isIsoType(concreteType)) {
    const isoCName = getTypeString(concreteType, context);
    return `((${isoCName})__yo_incr_rc_atomic((void*)(${valueCode})))`;
  }
  if (isStructType(concreteType) || isEnumType(concreteType)) {
    const dupFnCName = getDupFunctionForType(concreteType, context);
    if (dupFnCName) {
      return `${dupFnCName}(${valueCode})`;
    }
  }

  // Value types: no-op
  return valueCode;
}

/**
 * Helper function to get the C name of the ___drop function for a given type.
 * Returns undefined if no drop function is found.
 */
export function getDropFunctionForType(
  type: Type,
  context: CodeGenContext
): string | undefined {
  // For types that have a trait with ___drop function
  if (
    isStructType(type) ||
    isEnumType(type) ||
    isDynType(type) ||
    isSomeType(type) ||
    isIsoType(type)
  ) {
    const dropFunction = type.trait.fields.find(
      (field) => field.label === BuiltinFunctions.___drop[0]
    );

    if (
      dropFunction &&
      dropFunction.assignedValue &&
      isFunctionValue(dropFunction.assignedValue)
    ) {
      const dropFunctionCName =
        context.functions[dropFunction.assignedValue.funcId]?.cName;
      return dropFunctionCName;
    }
  }

  return undefined;
}

/**
 * Helper function to get the C name of the ___dup function for a given type.
 * Returns undefined if no dup function is found.
 */
export function getDupFunctionForType(
  type: Type,
  context: CodeGenContext
): string | undefined {
  // For types that have a trait with ___dup function
  if (
    isStructType(type) ||
    isEnumType(type) ||
    isDynType(type) ||
    isSomeType(type) ||
    isIsoType(type)
  ) {
    const dupFunction = type.trait.fields.find(
      (field) => field.label === BuiltinFunctions.___dup[0]
    );

    if (
      dupFunction &&
      dupFunction.assignedValue &&
      isFunctionValue(dupFunction.assignedValue)
    ) {
      const dupFunctionCName =
        context.functions[dupFunction.assignedValue.funcId]?.cName;
      return dupFunctionCName;
    }
  }

  return undefined;
}

export function generateDeferredDropExpressions(
  expr: Expr,
  indent: string,
  context: FunctionGenerationContext
) {
  const emitter = context.emitter;

  if (expr.$?.deferredDropExpressions) {
    for (const dropExpr of expr.$.deferredDropExpressions) {
      if (
        isDeferredDropForClosureCapture(
          dropExpr,
          context.currentClosureCaptures
        )
      ) {
        continue;
      }

      // Skip a TEMP whose C declaration has not been emitted yet at this point
      // (declaredCVarNames grows in C-emission order). A synthetic temp scheduled
      // for drop but declared only in a later/other branch would otherwise emit
      // `___drop` on an undeclared C identifier (this loop is used for
      // function-body/begin scope-end drops via generateFunctionBody). For a
      // codegen temp the source atom name equals its C name, so
      // getDeferredDropTargetAtomName suffices. Applies only to temps; regular
      // named locals are always declared. Mirrors yo-self's declared_c_var_names.
      const dropTargetName = getDeferredDropTargetAtomName(dropExpr);
      if (
        dropTargetName &&
        isCodegenTempName(dropTargetName) &&
        !(context.declaredCVarNames?.has(dropTargetName) ?? true)
      ) {
        continue;
      }

      // Skip drops already emitted inside short-circuit conditional branches
      if (context.shortCircuitHandledDropVarNames) {
        const targetVarName = getDeferredDropTargetAtomName(dropExpr);
        if (
          targetVarName &&
          context.shortCircuitHandledDropVarNames.has(targetVarName)
        ) {
          context.shortCircuitHandledDropVarNames.delete(targetVarName);
          continue;
        }
      }
      const dropCode = generateExpr(dropExpr, indent, context);
      if (dropCode) {
        emitter.emitLine(`${indent}${dropCode};`);
      }
    }
  }
}

/**
 * Generate C code for all deferred dup expressions.
 * This is used to generate dup calls for expressions that need reference counting.
 * The dup expressions are created during evaluation and deferred to codegen to ensure
 * proper context (e.g., closure captures, state machine variables).
 */
export function generateDeferredDupExpressions(
  expr: Expr,
  indent: string,
  context: FunctionGenerationContext
) {
  const emitter = context.emitter;

  if (expr.$?.deferredDupExpressions) {
    for (const dupExpr of expr.$.deferredDupExpressions) {
      if (exprIsFunctionCall(dupExpr)) {
        const dupCode = generateExpr(dupExpr, indent, context);
        if (dupCode) {
          emitter.emitLine(`${indent}${dupCode};`);
        }
      }
    }
  }
}
