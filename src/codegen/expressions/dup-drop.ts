import { BuiltinFunctions } from "../../expr";
import {
  isArrayType,
  isDynType,
  isEnumType,
  isIsoType,
  isObjectType,
  isSomeType,
  isStructType,
  isTupleType,
  Type,
  typeContainsRcType,
} from "../../types";
import { randomId } from "../../utils";
import { isFunctionValue, isNumberValue } from "../../value";
import { FunctionGenerationContext } from "../functions/context";
import { CodeGenContext, getTypeString } from "../utils";

/**
 * Helper function to generate drop code for a value of any type.
 * This handles arrays recursively.
 */
export function generateDropCodeForValue(
  valueCode: string,
  valueType: Type,
  context: CodeGenContext
): string {
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
          concreteFieldType,
          context
        );
        if (fieldDropCode) {
          emitter.emitLine(`  ${fieldDropCode};`);
        }
      }
    }
    return "";
  }

  // Handle other types
  if (isDynType(concreteType)) {
    return `__yo_decr_rc((void*)(${valueCode}).data)`;
  }
  if (isObjectType(concreteType)) {
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
    const tempVar = `temp_dup_${randomId("")}`; // Use randomId instead of Date.now
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
    const tempVar = `temp_dup_tuple_${randomId("")}`; // Use randomId instead of Date.now
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
          concreteFieldType,
          context
        );
        emitter.emitLine(`  ${tempVar}._${i} = ${fieldDupCode};`);
      }
    }
    return tempVar;
  }

  // Handle other types
  if (isDynType(concreteType)) {
    const dynCName = getTypeString(concreteType, context);
    return `((${dynCName}){ .data = __yo_incr_rc((void*)(${valueCode}).data), .vtable = (${valueCode}).vtable })`;
  }
  if (isObjectType(concreteType)) {
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
