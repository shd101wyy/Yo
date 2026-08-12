import { typeImplementsFuture } from "../../evaluator/trait-checking";
import { BuiltinFunctions, type FnCallExpr } from "../../expr";
import {
  isArrayType,
  isAtomicReferenceStructType,
  isRcType,
  isSomeType,
  isTupleType,
} from "../../types/guards";
import { isFunctionValue, isNumberValue } from "../../value";
import type { FunctionGenerationContext } from "../functions/context";
import { type CodeGenContext, getTypeString } from "../utils";
import {
  generateDropCodeForValue,
  generateDupCodeForValue,
  getDropFunctionForType,
  getDupFunctionForType,
  resolveSomeTypeParamType,
} from "./drop-dup";
import { generateExpr } from "./expr";
import { codegenFatal } from "../constants";

/**
 * __yo_decr_rc - handle reference count decrement
 */
export function generateYoDecrRc(
  expr: FnCallExpr,
  indent: string,
  context: CodeGenContext
): string {
  const selfArg = expr.args[0];
  if (!selfArg) {
    return codegenFatal(`__yo_decr_rc requires exactly 1 argument`);
  }
  const selfCode = generateExpr(selfArg, indent, context);
  return `__yo_decr_rc(${selfCode})`;
}

/**
 * __yo_incr_rc - handle reference count increment
 */
export function generateYoIncrRc(
  expr: FnCallExpr,
  indent: string,
  context: CodeGenContext
): string {
  const selfArg = expr.args[0];
  if (!selfArg) {
    return codegenFatal(`__yo_incr_rc requires exactly 1 argument`);
  }
  const selfCode = generateExpr(selfArg, indent, context);
  return `__yo_incr_rc(${selfCode})`;
}

/**
 * __yo_rc_own - return the value itself, used for transferring ownership
 */
export function generateYoRcOwn(
  expr: FnCallExpr,
  indent: string,
  context: CodeGenContext
): string {
  const selfArg = expr.args[0];
  if (!selfArg) {
    return codegenFatal(`__yo_rc_own requires exactly 1 argument`);
  }
  const selfCode = generateExpr(selfArg, indent, context);
  return selfCode; // Just return the argument as-is
}

/**
 * __yo_drop_array_element - drop array element at index without borrowing
 * This is used when dropping arrays to directly drop each element
 */
export function generateYoDropArrayElement(
  expr: FnCallExpr,
  indent: string,
  context: CodeGenContext
): string {
  const arrayArg = expr.args[0];
  const indexArg = expr.args[1];
  if (!arrayArg || !indexArg) {
    return codegenFatal(`__yo_drop_array_element requires exactly 2 arguments`);
  }

  const arrayCode = generateExpr(arrayArg, indent, context);
  const indexCode = generateExpr(indexArg, indent, context);

  // Get the array element type to find its drop function
  const arrayType = arrayArg.$?.type;
  if (!arrayType || !isArrayType(arrayType)) {
    return codegenFatal(`__yo_drop_array_element requires an array type`);
  }

  const elementType = arrayType.childType;
  const concreteElementType =
    isSomeType(elementType) && elementType.resolvedConcreteType
      ? elementType.resolvedConcreteType
      : elementType;

  // If element type is array, recursively generate inline drop code
  if (isArrayType(concreteElementType)) {
    const nestedArrayLength = concreteElementType.length;
    if (!isNumberValue(nestedArrayLength)) {
      return codegenFatal(`array element has non-constant length`);
    }
    const loopVar = `i_${Math.floor(Math.random() * 1000000)}`;
    // Generate inline drop code using ___drop recursively
    const emitter = (context as FunctionGenerationContext).emitter;
    emitter.emitLine(
      `for (size_t ${loopVar} = 0; ${loopVar} < ${nestedArrayLength.value}; ${loopVar}++) {`
    );
    // Create a fake expression for the nested array element to recursively call ___drop codegen
    const nestedArrayElement = `(${arrayCode}).data[${indexCode}].data[${loopVar}]`;
    emitter.emitLine(`  { // drop nested array element`);
    const dropCode = generateDropCodeForValue(
      nestedArrayElement,
      concreteElementType.childType,
      context
    );
    if (dropCode) {
      emitter.emitLine(`    ${dropCode};`);
    }
    emitter.emitLine(`  }`);
    emitter.emitLine(`}`);
    return ``;
  }

  // Call the drop function on the element
  // Arrays are represented as structs with a .data field containing the actual C array
  const dropFnCName = getDropFunctionForType(concreteElementType, context);
  if (dropFnCName) {
    return `${dropFnCName}((${arrayCode}).data[${indexCode}])`;
  } else {
    return `// No drop function for array element type`;
  }
}

/**
 *
 * __yo_dup_array_element - dup array element at index without borrowing
 * This is used when duping arrays to directly dup each element
 */
export function generateYoDupArrayElement(
  expr: FnCallExpr,
  indent: string,
  context: CodeGenContext
): string {
  const arrayArg = expr.args[0];
  const indexArg = expr.args[1];
  if (!arrayArg || !indexArg) {
    return codegenFatal(`__yo_dup_array_element requires exactly 2 arguments`);
  }

  const arrayCode = generateExpr(arrayArg, indent, context);
  const indexCode = generateExpr(indexArg, indent, context);

  // Get the array element type to find its dup function
  const arrayType = arrayArg.$?.type;
  if (!arrayType || !isArrayType(arrayType)) {
    return codegenFatal(`__yo_dup_array_element requires an array type`);
  }

  const elementType = arrayType.childType;
  const concreteElementType =
    isSomeType(elementType) && elementType.resolvedConcreteType
      ? elementType.resolvedConcreteType
      : elementType;

  // If element type is array, recursively generate inline dup code
  if (isArrayType(concreteElementType)) {
    const nestedArrayLength = concreteElementType.length;
    if (!isNumberValue(nestedArrayLength)) {
      return codegenFatal(`array element has non-constant length`);
    }
    const tempVar = `temp_array_${Math.floor(Math.random() * 1000000)}`;
    const loopVar = `i_${Math.floor(Math.random() * 1000000)}`;
    const elementCName = getTypeString(concreteElementType, context);
    const emitter = (context as FunctionGenerationContext).emitter;
    emitter.emitLine(
      `${elementCName} ${tempVar} = (${arrayCode}).data[${indexCode}];`
    );
    emitter.emitLine(
      `for (size_t ${loopVar} = 0; ${loopVar} < ${nestedArrayLength.value}; ${loopVar}++) {`
    );
    // Recursively generate dup code for nested array elements
    const dupCode = generateDupCodeForValue(
      `${tempVar}.data[${loopVar}]`,
      concreteElementType.childType,
      context
    );
    emitter.emitLine(`  ${tempVar}.data[${loopVar}] = ${dupCode};`);
    emitter.emitLine(`}`);
    return tempVar;
  }

  // Call the dup function on the element
  // Arrays are represented as structs with a .data field containing the actual C array
  const dupFnCName = getDupFunctionForType(concreteElementType, context);
  if (dupFnCName) {
    return `${dupFnCName}((${arrayCode}).data[${indexCode}])`;
  } else {
    return `// No dup function for array element type`;
  }
}

/**
 *
 * __yo_drop_tuple_element - drop tuple element at index without borrowing
 * This is used when dropping tuples to directly drop each element
 */
export function generateYoDropTupleElement(
  expr: FnCallExpr,
  indent: string,
  context: CodeGenContext
): string {
  const tupleArg = expr.args[0];
  const indexArg = expr.args[1];
  if (!tupleArg || !indexArg) {
    return codegenFatal(`__yo_drop_tuple_element requires exactly 2 arguments`);
  }

  const tupleCode = generateExpr(tupleArg, indent, context);
  generateExpr(indexArg, indent, context);

  // Get the tuple element type to find its drop function
  const tupleType = tupleArg.$?.type;
  if (!tupleType || !isTupleType(tupleType)) {
    return codegenFatal(`__yo_drop_tuple_element requires a tuple type`);
  }

  // Get index value
  const indexValue = indexArg.$?.value;
  if (!isNumberValue(indexValue)) {
    return codegenFatal(`__yo_drop_tuple_element requires a constant index`);
  }

  const index = Number(indexValue.value);
  if (index < 0 || index >= tupleType.fields.length) {
    return codegenFatal(`__yo_drop_tuple_element index out of bounds`);
  }

  const elementType = tupleType.fields[index]!.type;
  const concreteElementType =
    isSomeType(elementType) && elementType.resolvedConcreteType
      ? elementType.resolvedConcreteType
      : elementType;

  // For nested tuples, we need to recursively drop the RC elements
  if (isTupleType(concreteElementType)) {
    const elementAccessCode = `(${tupleCode})._${index}`;
    const dropCode = generateDropCodeForValue(
      elementAccessCode,
      concreteElementType,
      context
    );
    return dropCode;
  }

  // Call the drop function on the element
  // Tuples are represented as structs with fields named _0, _1, _2, etc.
  const dropFnCName = getDropFunctionForType(concreteElementType, context);
  if (dropFnCName) {
    return `${dropFnCName}((${tupleCode})._${index})`;
  } else {
    return `// No drop function for tuple element type`;
  }
}

/**
 *
 * __yo_dup_tuple_element - dup tuple element at index without borrowing
 * This is used when duping tuples to directly dup each element
 */
export function generateYoDupTupleElement(
  expr: FnCallExpr,
  indent: string,
  context: CodeGenContext
): string {
  const tupleArg = expr.args[0];
  const indexArg = expr.args[1];
  if (!tupleArg || !indexArg) {
    return codegenFatal(`__yo_dup_tuple_element requires exactly 2 arguments`);
  }

  const tupleCode = generateExpr(tupleArg, indent, context);
  generateExpr(indexArg, indent, context);

  // Get the tuple element type to find its dup function
  const tupleType = tupleArg.$?.type;
  if (!tupleType || !isTupleType(tupleType)) {
    return codegenFatal(`__yo_dup_tuple_element requires a tuple type`);
  }

  // Get index value
  const indexValue = indexArg.$?.value;
  if (!isNumberValue(indexValue)) {
    return codegenFatal(`__yo_dup_tuple_element requires a constant index`);
  }

  const index = Number(indexValue.value);
  if (index < 0 || index >= tupleType.fields.length) {
    return codegenFatal(`__yo_dup_tuple_element index out of bounds`);
  }

  const elementType = tupleType.fields[index]!.type;
  const concreteElementType =
    isSomeType(elementType) && elementType.resolvedConcreteType
      ? elementType.resolvedConcreteType
      : elementType;

  // For nested tuples, we need to recursively dup the RC elements
  if (isTupleType(concreteElementType)) {
    const elementAccessCode = `(${tupleCode})._${index}`;
    const dupCode = generateDupCodeForValue(
      elementAccessCode,
      concreteElementType,
      context
    );
    return dupCode;
  }

  // Call the dup function on the element
  // Tuples are represented as structs with fields named _0, _1, _2, etc.
  const dupFnCName = getDupFunctionForType(concreteElementType, context);
  if (dupFnCName) {
    return `${dupFnCName}((${tupleCode})._${index})`;
  } else {
    return `// No dup function for tuple element type`;
  }
}

/**
 *
 * ___dup - generic dup hook used by evaluator for reference-counted values.
 * In many cases the evaluator rewrites `___dup(x)` into `x.___dup()`, but in
 * some contexts (e.g. deferred dup for dyn-closure captures) the builtin call
 * is intentionally deferred to codegen.
 */
export function generateDup(
  expr: FnCallExpr,
  indent: string,
  context: CodeGenContext
): string {
  const valueArg = expr.args[0];
  if (!valueArg) {
    return codegenFatal(`___dup requires exactly 1 argument`);
  }

  const valueCode = generateExpr(valueArg, indent, context);
  let valueType = valueArg.$?.type ?? expr.$?.type;
  if (!valueType) {
    // Best-effort: preserve the expression.
    return valueCode;
  }

  valueType = resolveSomeTypeParamType(valueArg, valueType, context);
  return generateDupCodeForValue(valueCode, valueType, context);
}

/**
 *
 * ___drop - generic drop hook used by evaluator for reference-counted values.
 * Similar to ___dup, some drops are deferred to codegen.
 */
export function generateDrop(
  expr: FnCallExpr,
  indent: string,
  context: CodeGenContext
): string {
  const valueArg = expr.args[0];
  if (!valueArg) {
    return codegenFatal(`___drop requires exactly 1 argument`);
  }

  const valueCode = generateExpr(valueArg, indent, context);
  let valueType = valueArg.$?.type ?? expr.$?.type;
  if (!valueType) {
    return ``;
  }

  valueType = resolveSomeTypeParamType(valueArg, valueType, context);
  return generateDropCodeForValue(valueCode, valueType, context);
}

/**
 * __yo_dyn_drop - call dispose on dyn object via dispose function then __yo_decr_rc on dyn
 */
export function generateYoDynDrop(
  expr: FnCallExpr,
  indent: string,
  context: CodeGenContext
): string {
  const selfArg = expr.args[0];
  if (!selfArg) {
    return codegenFatal(`__yo_dyn_drop requires exactly 1 argument`);
  }
  const selfCode = generateExpr(selfArg, indent, context);
  // Dyn is a value type; ref-counting applies to its .data pointer.
  return `__yo_decr_rc((void*)(${selfCode}).data)`;
}

/**
 * __yo_dyn_dup - call dup on wrapped object via vtable and __yo_incr_rc on dyn
 */
export function generateYoDynDup(
  expr: FnCallExpr,
  indent: string,
  context: CodeGenContext
): string {
  const selfArg = expr.args[0];
  if (!selfArg) {
    return codegenFatal(`__yo_dyn_dup requires exactly 1 argument`);
  }
  const selfCode = generateExpr(selfArg, indent, context);
  // Dyn is a value type; ref-counting applies to its .data pointer.
  return `__yo_incr_rc((void*)(${selfCode}).data)`;
}

/**
 * __yo_incr_rc_atomic - atomic reference count increment for Iso types
 */
export function generateYoIncrRcAtomic(
  expr: FnCallExpr,
  indent: string,
  context: CodeGenContext
): string {
  const selfArg = expr.args[0];
  if (!selfArg) {
    return codegenFatal(`__yo_incr_rc_atomic requires exactly 1 argument`);
  }
  const selfCode = generateExpr(selfArg, indent, context);
  return `__yo_incr_rc_atomic(${selfCode})`;
}

/**
 * __yo_decr_rc_atomic - atomic reference count decrement for Iso types
 */
export function generateYoDecrRcAtomic(
  expr: FnCallExpr,
  indent: string,
  context: CodeGenContext
): string {
  const selfArg = expr.args[0];
  if (!selfArg) {
    return codegenFatal(`__yo_decr_rc_atomic requires exactly 1 argument`);
  }
  const selfCode = generateExpr(selfArg, indent, context);
  return `__yo_decr_rc_atomic(${selfCode})`;
}

/**
 * __yo_sometype_drop - dispatch to resolvedConcreteType's ___drop if available
 */
export function generateYoSomeTypeDrop(
  expr: FnCallExpr,
  indent: string,
  context: CodeGenContext
): string {
  const selfArg = expr.args[0];
  if (!selfArg) {
    return codegenFatal(`__yo_sometype_drop requires exactly 1 argument`);
  }
  const argType = selfArg.$?.type;

  // Impl(Future(T)) is heap-backed and ref-counted: decrement refcount
  // The state machine will be freed when refcount hits 0
  if (argType && isSomeType(argType) && typeImplementsFuture(argType)) {
    const selfCode = generateExpr(selfArg, indent, context);
    return `if (${selfCode} != NULL) { __yo_decr_rc((void*)${selfCode}); }`;
  }

  if (argType && isSomeType(argType) && argType.resolvedConcreteType) {
    // Dispatch to concrete type's ___drop
    const concreteType = argType.resolvedConcreteType;
    const dropFn = concreteType.trait?.fields.find(
      (f) => f.label === BuiltinFunctions.___drop[0]
    );
    if (
      dropFn &&
      dropFn.assignedValue &&
      isFunctionValue(dropFn.assignedValue)
    ) {
      const dropFnCName = context.functions[dropFn.assignedValue.funcId]?.cName;
      if (dropFnCName) {
        const selfCode = generateExpr(selfArg, indent, context);
        return `${dropFnCName}(${selfCode})`;
      }
    }
  }
  // No concrete type or no drop function - no-op
  return `/* __yo_sometype_drop: no-op */`;
}

export function generateYoSomeTypeDup(
  expr: FnCallExpr,
  indent: string,
  context: CodeGenContext
): string {
  const selfArg = expr.args[0];
  if (!selfArg) {
    return codegenFatal(`__yo_sometype_dup requires exactly 1 argument`);
  }
  const argType = selfArg.$?.type;

  // Impl(Future(T)) is heap-backed and ref-counted: increment refcount
  if (argType && isSomeType(argType) && typeImplementsFuture(argType)) {
    const selfCode = generateExpr(selfArg, indent, context);
    return `__yo_incr_rc((void*)${selfCode})`;
  }

  if (argType && isSomeType(argType) && argType.resolvedConcreteType) {
    // Dispatch to concrete type's ___dup
    const concreteType = argType.resolvedConcreteType;
    const dupFn = concreteType.trait?.fields.find(
      (f) => f.label === BuiltinFunctions.___dup[0]
    );
    if (dupFn && dupFn.assignedValue && isFunctionValue(dupFn.assignedValue)) {
      const dupFnCName = context.functions[dupFn.assignedValue.funcId]?.cName;
      if (dupFnCName) {
        const selfCode = generateExpr(selfArg, indent, context);
        return `${dupFnCName}(${selfCode})`;
      }
    }
  }
  // No concrete type or no dup function - no-op
  return `/* __yo_sometype_dup: no-op */`;
}

export function generateRcCall(
  expr: FnCallExpr,
  indent: string,
  context: CodeGenContext
): string {
  if (expr.args.length !== 1) {
    return codegenFatal(`rc requires exactly 1 argument`);
  }
  const argExpr = expr.args[0]!;
  const argType = argExpr.$?.type;
  if (!argType) {
    return codegenFatal(`rc argument missing type information`);
  }

  const argCode = generateExpr(argExpr, indent, context);

  // For GC types (reference-counted objects), return the actual ref_count
  if (isRcType(argType)) {
    if (isAtomicReferenceStructType(argType)) {
      // Atomic objects need atomic_load to avoid data races across threads
      return `atomic_load_explicit((_Atomic uint32_t*)&((__yo_ref_header_t*)(${argCode}))->ref_count, memory_order_acquire)`;
    }
    return `((__yo_ref_header_t*)(${argCode}))->ref_count`;
  } else {
    // For value types, always return 1
    return `1`;
  }
}
