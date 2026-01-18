import { getVariablesFromEnv } from "../../env";
import {
  BuiltinFunctions,
  BuiltinKeywords,
  Expr,
  exprIsAtom,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  ExprTag,
  exprToString,
  FnCallExpr,
} from "../../expr";
import {
  ArrayType,
  extractFnTraitFromType,
  extractFutureTraitFromType,
  isArrayType,
  isDynType,
  isEnumType,
  isFunctionType,
  isIsoType,
  isNewtypeType,
  isObjectType,
  isPtrType,
  isRcType,
  isSliceType,
  isSomeType,
  isStructType,
  isTupleType,
  isUnionType,
  isUnitType,
  SliceType,
  SomeType,
  TraitType,
  Type,
  typeImplementsFn,
  typeImplementsFuture,
  TypeTag,
} from "../../types";
import { isTempVariableName, randomId } from "../../utils";
import {
  isBooleanValue,
  isComptStringValue,
  isFunctionValue,
  isNumberValue,
  isTypeValue,
  isUnknownValue,
  Value,
} from "../../value";
import { BuiltinYoInlineFunctions } from "../constants";
import { FunctionGenerationContext } from "../functions/context";
import {
  canOptimizeAsNullablePointer,
  canOptimizeAsSimpleEnum,
  CodeGenContext,
  getDeferredDupTargetAtomName,
  getEnumVariantCName,
  getTypeString,
  getVariableNameForCodegen,
  getVariableTypeString,
  isFunctionValueWithOnlyBuiltinYoInlineFunctionCall,
  sanitizeForCIdentifier,
} from "../utils";
import {
  checkVariableIsClosureCaptured,
  generateClosureConstruction,
  isClosureConstruction,
} from "./closures";
import { generateExpr, setGenerateExprFn } from "./expr";

/**
 * Generate C code for an expression - extracted from original codegen-c.ts
 */
export function _generateExpr(
  expr: Expr,
  indent: string,
  context: CodeGenContext
): string {
  let result: string;

  switch (expr.tag) {
    case ExprTag.FnCall:
      result = generateFuncCall(expr, indent, context);
      break;
    case ExprTag.Atom:
      result = generateAtom(expr, context);
      break;
  }

  return result;
}

// Set the generateExpr function for use in other modules
setGenerateExprFn(_generateExpr);

/**
 * Generate C code for a function call expression - extracted from original codegen-c.ts
 */
function generateFuncCall(
  expr: FnCallExpr,
  indent: string,
  context: CodeGenContext
): string {
  const emitter = context.emitter;

  // Handle macro function calls (functions with isUnquote return type)
  // If expr.$.macroExpansion is set, this macro call has already been expanded
  // during evaluation. Generate code for the expanded form instead.
  if (expr.$?.macroExpansion) {
    return generateExpr(expr.$.macroExpansion, indent, context);
  }

  // Handle method calls to ___drop/___dup on SomeType with resolvedConcreteType.
  // These are wrapper functions that were not collected during function collection
  // because they just call builtins. We handle them here by dispatching to the
  // concrete type's methods or using the appropriate ref-counting operation.
  if (
    exprIsFunctionCall(expr.func) &&
    exprIsFunctionCallOf(expr.func, ".", 2) &&
    expr.func.args[1] &&
    exprIsAtom(expr.func.args[1])
  ) {
    const methodName = expr.func.args[1].token.value;
    const receiverExpr = expr.func.args[0];
    const receiverType = receiverExpr?.$?.type;

    if (
      receiverType &&
      isSomeType(receiverType) &&
      typeImplementsFuture(receiverType)
    ) {
      // SomeType implementing Future - ALWAYS use ref-counting operations directly.
      // Futures are heap-allocated state machines (pointers), not value types.
      // The resolvedConcreteType might be the capture struct (value type), but we can't
      // dispatch to its ___drop/___dup because those expect struct values, not pointers.
      // The state machine manages its own memory and uses ref-counting.
      if (methodName === BuiltinFunctions.___drop[0]) {
        const receiverCode = generateExpr(receiverExpr!, indent, context);
        return `if (${receiverCode} != NULL) { __yo_decr_rc((void*)${receiverCode}); }`;
      }

      if (methodName === BuiltinFunctions.___dup[0]) {
        const receiverCode = generateExpr(receiverExpr!, indent, context);
        return `__yo_incr_rc((void*)${receiverCode})`;
      }
    }
  }

  // Handle anonymous function/closure construction
  if (isClosureConstruction(expr)) {
    return generateClosureConstruction(expr, indent, context);
  }

  // __yo_decr_rc - handle reference count decrement
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_decr_rc)) {
    const selfArg = expr.args[0];
    if (!selfArg) {
      return `// Error: __yo_decr_rc requires exactly 1 argument`;
    }
    const selfCode = generateExpr(selfArg, indent, context);
    return `__yo_decr_rc(${selfCode})`;
  }

  // __yo_incr_rc - handle reference count increment
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_incr_rc)) {
    const selfArg = expr.args[0];
    if (!selfArg) {
      return `// Error: __yo_incr_rc requires exactly 1 argument`;
    }
    const selfCode = generateExpr(selfArg, indent, context);
    return `__yo_incr_rc(${selfCode})`;
  }

  // __yo_rc_own - return the value itself, used for transferring ownership
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_rc_own)) {
    const selfArg = expr.args[0];
    if (!selfArg) {
      return `// Error: __yo_rc_own requires exactly 1 argument`;
    }
    const selfCode = generateExpr(selfArg, indent, context);
    return selfCode; // Just return the argument as-is
  }

  // __yo_drop_array_element - drop array element at index without borrowing
  // This is used when dropping arrays to directly drop each element
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_drop_array_element)) {
    const arrayArg = expr.args[0];
    const indexArg = expr.args[1];
    if (!arrayArg || !indexArg) {
      return `// Error: __yo_drop_array_element requires exactly 2 arguments`;
    }

    const arrayCode = generateExpr(arrayArg, indent, context);
    const indexCode = generateExpr(indexArg, indent, context);

    // Get the array element type to find its drop function
    const arrayType = arrayArg.$?.type;
    if (!arrayType || !isArrayType(arrayType)) {
      return `// Error: __yo_drop_array_element requires an array type`;
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
        return `// Error: array element has non-constant length`;
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

  // __yo_dup_array_element - dup array element at index without borrowing
  // This is used when duping arrays to directly dup each element
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_dup_array_element)) {
    const arrayArg = expr.args[0];
    const indexArg = expr.args[1];
    if (!arrayArg || !indexArg) {
      return `// Error: __yo_dup_array_element requires exactly 2 arguments`;
    }

    const arrayCode = generateExpr(arrayArg, indent, context);
    const indexCode = generateExpr(indexArg, indent, context);

    // Get the array element type to find its dup function
    const arrayType = arrayArg.$?.type;
    if (!arrayType || !isArrayType(arrayType)) {
      return `// Error: __yo_dup_array_element requires an array type`;
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
        return `// Error: array element has non-constant length`;
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

  // __yo_drop_tuple_element - drop tuple element at index without borrowing
  // This is used when dropping tuples to directly drop each element
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_drop_tuple_element)) {
    const tupleArg = expr.args[0];
    const indexArg = expr.args[1];
    if (!tupleArg || !indexArg) {
      return `// Error: __yo_drop_tuple_element requires exactly 2 arguments`;
    }

    const tupleCode = generateExpr(tupleArg, indent, context);
    generateExpr(indexArg, indent, context);

    // Get the tuple element type to find its drop function
    const tupleType = tupleArg.$?.type;
    if (!tupleType || !isTupleType(tupleType)) {
      return `// Error: __yo_drop_tuple_element requires a tuple type`;
    }

    // Get index value
    const indexValue = indexArg.$?.value;
    if (!isNumberValue(indexValue)) {
      return `// Error: __yo_drop_tuple_element requires a constant index`;
    }

    const index = Number(indexValue.value);
    if (index < 0 || index >= tupleType.fields.length) {
      return `// Error: __yo_drop_tuple_element index out of bounds`;
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

  // __yo_dup_tuple_element - dup tuple element at index without borrowing
  // This is used when duping tuples to directly dup each element
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_dup_tuple_element)) {
    const tupleArg = expr.args[0];
    const indexArg = expr.args[1];
    if (!tupleArg || !indexArg) {
      return `// Error: __yo_dup_tuple_element requires exactly 2 arguments`;
    }

    const tupleCode = generateExpr(tupleArg, indent, context);
    generateExpr(indexArg, indent, context);

    // Get the tuple element type to find its dup function
    const tupleType = tupleArg.$?.type;
    if (!tupleType || !isTupleType(tupleType)) {
      return `// Error: __yo_dup_tuple_element requires a tuple type`;
    }

    // Get index value
    const indexValue = indexArg.$?.value;
    if (!isNumberValue(indexValue)) {
      return `// Error: __yo_dup_tuple_element requires a constant index`;
    }

    const index = Number(indexValue.value);
    if (index < 0 || index >= tupleType.fields.length) {
      return `// Error: __yo_dup_tuple_element index out of bounds`;
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

  // ___dup - generic dup hook used by evaluator for reference-counted values.
  // In many cases the evaluator rewrites `___dup(x)` into `x.___dup()`, but in
  // some contexts (e.g. deferred dup for dyn-closure captures) the builtin call
  // is intentionally deferred to codegen.
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.___dup)) {
    const valueArg = expr.args[0];
    if (!valueArg) {
      return `// Error: ___dup requires exactly 1 argument`;
    }

    const valueCode = generateExpr(valueArg, indent, context);
    const valueType = valueArg.$?.type ?? expr.$?.type;
    if (!valueType) {
      // Best-effort: preserve the expression.
      return valueCode;
    }

    return generateDupCodeForValue(valueCode, valueType, context);
  }

  // ___drop - generic drop hook used by evaluator for reference-counted values.
  // Similar to ___dup, some drops are deferred to codegen.
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.___drop)) {
    const valueArg = expr.args[0];
    if (!valueArg) {
      return `// Error: ___drop requires exactly 1 argument`;
    }

    const valueCode = generateExpr(valueArg, indent, context);
    const valueType = valueArg.$?.type ?? expr.$?.type;
    if (!valueType) {
      return ``;
    }

    return generateDropCodeForValue(valueCode, valueType, context);
  }

  // __yo_dyn_drop - call dispose on dyn object via dispose function then __yo_decr_rc on dyn
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_dyn_drop)) {
    const selfArg = expr.args[0];
    if (!selfArg) {
      return `// Error: __yo_dyn_drop requires exactly 1 argument`;
    }
    const selfCode = generateExpr(selfArg, indent, context);
    // Dyn is a value type; ref-counting applies to its .data pointer.
    return `__yo_decr_rc((void*)(${selfCode}).data)`;
  }

  // __yo_dyn_dup - call dup on wrapped object via vtable and __yo_incr_rc on dyn
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_dyn_dup)) {
    const selfArg = expr.args[0];
    if (!selfArg) {
      return `// Error: __yo_dyn_dup requires exactly 1 argument`;
    }
    const selfCode = generateExpr(selfArg, indent, context);
    // Dyn is a value type; ref-counting applies to its .data pointer.
    return `__yo_incr_rc((void*)(${selfCode}).data)`;
  }

  // __yo_incr_rc_atomic - atomic reference count increment for Iso types
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_incr_rc_atomic)) {
    const selfArg = expr.args[0];
    if (!selfArg) {
      return `// Error: __yo_incr_rc_atomic requires exactly 1 argument`;
    }
    const selfCode = generateExpr(selfArg, indent, context);
    return `__yo_incr_rc_atomic(${selfCode})`;
  }

  // __yo_decr_rc_atomic - atomic reference count decrement for Iso types
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_decr_rc_atomic)) {
    const selfArg = expr.args[0];
    if (!selfArg) {
      return `// Error: __yo_decr_rc_atomic requires exactly 1 argument`;
    }
    const selfCode = generateExpr(selfArg, indent, context);
    return `__yo_decr_rc_atomic(${selfCode})`;
  }

  // __yo_iso_extract - extract inner value from Iso type
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_iso_extract)) {
    const selfArg = expr.args[0];
    if (!selfArg) {
      return `// Error: __yo_iso_extract requires exactly 1 argument`;
    }
    const selfCode = generateExpr(selfArg, indent, context);
    const selfType = selfArg.$?.type;

    if (!selfType || !isIsoType(selfType)) {
      return `// Error: __yo_iso_extract requires an Iso type`;
    }

    const isoTypeCName = getTypeString(selfType, context);

    // Register the Option type C name for the extract function
    // The return type of __yo_iso_extract is Option(ChildType)
    const returnType = expr.$?.type;
    if (returnType && context.isoTypes?.has(isoTypeCName)) {
      const isoInfo = context.isoTypes.get(isoTypeCName)!;
      if (!isoInfo.optionTypeCName) {
        isoInfo.optionTypeCName = getTypeString(returnType, context);
      }
    }

    const extractCall = `__yo_iso_extract_${isoTypeCName}(${selfCode})`;

    // If this expression has a temp variable (for cleanup), emit declaration + assignment
    const tempVar = expr.$?.variableName;
    if (tempVar && returnType) {
      context.emitter.emitLine(
        `${indent}${getTypeString(returnType, context)} ${tempVar} = ${extractCall};`
      );
      return tempVar;
    }

    return extractCall;
  }

  // __yo_iso_dispose - dispose inner value of Iso if not extracted
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_iso_dispose)) {
    const selfArg = expr.args[0];
    if (!selfArg) {
      return `// Error: __yo_iso_dispose requires exactly 1 argument`;
    }
    const selfCode = generateExpr(selfArg, indent, context);
    const selfType = selfArg.$?.type;

    if (!selfType || !isIsoType(selfType)) {
      return `// Error: __yo_iso_dispose requires an Iso type`;
    }

    const isoTypeCName = getTypeString(selfType, context);
    return `__yo_iso_dispose_${isoTypeCName}(${selfCode})`;
  }

  // Iso(T)(value) - Iso value constructor
  // Check if this is a call to an Iso type constructor (not just any expression returning Iso type)
  // The function being called must be a TypeValue containing an IsoType
  const funcValue = expr.func.$?.value;
  if (
    isTypeValue(funcValue) &&
    isIsoType(funcValue.value) &&
    expr.args.length === 1
  ) {
    const isoType = funcValue.value;
    const childType = isoType.childType;

    const valueArg = expr.args[0]!;
    const valueCode = generateExpr(valueArg, indent, context);

    // Register the Iso type
    const isoTypeCName = getTypeString(isoType, context);
    const childTypeCName = getTypeString(childType, context);

    if (!context.isoTypes) {
      context.isoTypes = new Map();
    }
    if (!context.isoTypes.has(isoTypeCName)) {
      context.isoTypes.set(isoTypeCName, { childTypeCName, isoType });
    }

    // Generate allocation and initialization
    // Iso_T* iso = __yo_malloc(sizeof(Iso_T));
    // iso->arc = 1;
    // iso->extracted = false;
    // iso->value = value;
    // return iso;
    return `__yo_create_iso_${isoTypeCName}(${valueCode})`;
  }

  // __yo_sometype_drop - dispatch to resolvedConcreteType's ___drop if available
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_sometype_drop)) {
    const selfArg = expr.args[0];
    if (!selfArg) {
      return `// Error: __yo_sometype_drop requires exactly 1 argument`;
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
        const dropFnCName =
          context.functions[dropFn.assignedValue.funcId]?.cName;
        if (dropFnCName) {
          const selfCode = generateExpr(selfArg, indent, context);
          return `${dropFnCName}(${selfCode})`;
        }
      }
    }
    // No concrete type or no drop function - no-op
    return `/* __yo_sometype_drop: no-op */`;
  }

  // __yo_sometype_dup - dispatch to resolvedConcreteType's ___dup if available
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_sometype_dup)) {
    const selfArg = expr.args[0];
    if (!selfArg) {
      return `// Error: __yo_sometype_dup requires exactly 1 argument`;
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
      if (
        dupFn &&
        dupFn.assignedValue &&
        isFunctionValue(dupFn.assignedValue)
      ) {
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

  // __yo_gc_collect - trigger garbage collection
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_gc_collect)) {
    if (expr.args.length !== 0) {
      return `// Error: __yo_gc_collect requires exactly 0 arguments`;
    }
    return `__yo_gc_collect()`;
  }

  // rc - get the reference count of a value
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.rc)) {
    if (expr.args.length !== 1) {
      return `// Error: rc requires exactly 1 argument`;
    }
    const argExpr = expr.args[0]!;
    const argType = argExpr.$?.type;
    if (!argType) {
      return `// Error: rc argument missing type information`;
    }

    const argCode = generateExpr(argExpr, indent, context);

    // For GC types (reference-counted objects), return the actual ref_count
    if (isRcType(argType)) {
      return `((yo_ref_header_t*)(${argCode}))->ref_count`;
    } else {
      // For value types, always return 1
      return `1`;
    }
  }

  // panic - print error message and abort execution
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.panic)) {
    // panic() never returns, so we need to handle it specially
    // We need to generate the panic code and then provide a dummy value for the assignment
    const returnType = expr.$?.type;
    if (!returnType) {
      return `// Error: panic() missing type information`;
    }

    if (expr.args.length === 0) {
      // No message provided, just call abort()
      emitter.emitLine(`${indent}abort();`);
    } else if (expr.args.length === 1) {
      // Message provided, print to stderr then abort
      const messageArg = expr.args[0]!;

      // The message should be a compile-time string value
      if (messageArg.$?.value && isComptStringValue(messageArg.$.value)) {
        const message = messageArg.$.value.value;
        emitter.emitLine(
          `${indent}fprintf(stderr, "%s\\n", ${JSON.stringify(message)});`
        );
        emitter.emitLine(`${indent}abort();`);
      } else {
        // Runtime message - generate code to evaluate it
        const messageCode = generateExpr(messageArg, indent, context);
        emitter.emitLine(`${indent}fprintf(stderr, "%s\\n", ${messageCode});`);
        emitter.emitLine(`${indent}abort();`);
      }
    } else {
      return `// Error: panic accepts 0 or 1 arguments, got ${expr.args.length}`;
    }

    // Since panic never returns, we need to provide a dummy value of the correct type
    // This code is unreachable but needed for C compilation
    const returnTypeStr = getTypeString(returnType, context);
    return `(*((${returnTypeStr}*)NULL))`; // This will never execute but has the right type
  }

  // test - test declaration, skipped during normal compilation
  // Tests are handled by the test runner which generates a main function for each test
  if (exprIsFunctionCallOf(expr, BuiltinKeywords.test)) {
    // No-op: test declarations produce no C code
    return `/* test declaration skipped */`;
  }

  // __yo_thread_set_maximum_threads - set maxmium number of threads for coroutine schedular
  if (
    exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_thread_set_maximum_threads)
  ) {
    const numArg = expr.args[0];
    if (!numArg) {
      return `// Error: __yo_thread_set_maximum_threads requires exactly 1 argument`;
    }
    const numCode = generateExpr(numArg, indent, context);
    return `__yo_thread_set_maximum_threads(${numCode})`;
  }

  // op_and - && operator with short-circuit evaluation
  if (exprIsFunctionCallOf(expr, BuiltinKeywords.op_and)) {
    if (expr.args.length === 0) {
      return `true`; // Empty && returns true
    }
    if (expr.args.length === 1) {
      return generateExpr(expr.args[0]!, indent, context);
    }
    // Generate: (arg1 && arg2 && ... && argN)
    const argCodes = expr.args.map((arg) => generateExpr(arg, indent, context));
    return `(${argCodes.join(" && ")})`;
  }

  // op_or - || operator with short-circuit evaluation
  if (exprIsFunctionCallOf(expr, BuiltinKeywords.op_or)) {
    if (expr.args.length === 0) {
      return `false`; // Empty || returns false
    }
    if (expr.args.length === 1) {
      return generateExpr(expr.args[0]!, indent, context);
    }
    // Generate: (arg1 || arg2 || ... || argN)
    const argCodes = expr.args.map((arg) => generateExpr(arg, indent, context));
    return `(${argCodes.join(" || ")})`;
  }

  // async - async block that creates a Future
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.async)) {
    return generateAsyncBlock(expr, indent, context);
  }

  // dyn() - dynamic dispatch constructor
  if (exprIsFunctionCallOf(expr, BuiltinKeywords.dyn)) {
    return generateDynCall(expr, indent, context);
  }

  // await - extract value from Future
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.await)) {
    const futureArg = expr.args[0];
    if (!futureArg) {
      return `// Error: await requires exactly 1 argument`;
    }

    // const futureCode = generateExpr(futureArg, indent, context);
    const futureType = futureArg.$?.type;

    // Check if the type implements Future (handles both FutureTraitType and SomeType with Future impl)
    if (!futureType || !typeImplementsFuture(futureType)) {
      return `// Error: await argument must be a Future type`;
    }

    // Extract the Future module type to get the result type
    const futureModuleType = extractFutureTraitFromType(futureType);
    if (!futureModuleType) {
      return `// Error: could not extract Future module from type`;
    }

    // In async context (state machine), await expressions don't generate code
    // The result is extracted at the start of the next state
    // If this await expression is assigned to a variable, that variable's name is in expr.$.variableName
    const functionContext = context as FunctionGenerationContext;
    if (functionContext.inStateMachine) {
      // Return empty string - the actual await logic is handled by state machine generator
      // The result will be available in the target variable in the next state
      return ``;
    }

    // Outside async context - this is an error
    return `// Error: await should only be used inside async blocks`;
  }

  // return
  if (exprIsFunctionCallOf(expr, BuiltinKeywords.return)) {
    const arg = expr.args[0];
    if (arg) {
      if (!expr.$) {
        throw new Error(`Internal error: return expression missing metadata`);
      }
      // For non-unit types, we need a temporary variable to hold the return value
      // before deferred drop expressions run
      if (!expr.$.variableName && !isUnitType(expr.$.type)) {
        return `// Error: return expression missing temporary variable name`;
      }

      // Special handling for async functions: we need to get the raw value code
      // without temp variable indirection to properly declare the temp variable
      const functionContext = context as FunctionGenerationContext;
      let argCode: string;
      let needsTempVarDeclaration = false;

      if (functionContext.inStateMachine && arg.$?.variableName) {
        // In async context: generate raw value code by temporarily clearing variableName
        const savedVariableName = arg.$.variableName;
        arg.$.variableName = undefined;
        argCode = generateExpr(arg, indent, context);
        arg.$.variableName = savedVariableName;
        needsTempVarDeclaration = true;
      } else {
        // Check if arg has both a variableName and deferredDupExpressions
        // This happens when we need to store the arg value in a temp var before duping it
        if (
          arg.$?.variableName &&
          arg.$?.deferredDupExpressions &&
          arg.$.deferredDupExpressions.length > 0
        ) {
          // Generate the arg value without the variableName to get the raw expression
          const savedVariableName = arg.$.variableName;
          arg.$.variableName = undefined;
          const rawArgCode = generateExpr(arg, indent, context);
          arg.$.variableName = savedVariableName;

          // Declare and assign the temp variable
          const argType = getTypeString(arg.$.type!, context);
          const argTempVar = getVariableNameForCodegen(
            savedVariableName,
            arg.$.env
          );

          if (argTempVar !== rawArgCode) {
            context.emitter.emitLine(
              `${indent}${argType} ${argTempVar} = ${rawArgCode};`
            );
          }
          argCode = argTempVar;
        } else {
          argCode = generateExpr(arg, indent, context);
        }
      }

      // Handle deferred dup expressions for the return argument.
      // This is needed when returning a borrowed parameter - we must call dup
      // to increment the reference count since return values are owned.
      let handledDeferredDup = false;
      if (
        arg.$?.deferredDupExpressions &&
        arg.$.deferredDupExpressions.length > 0
      ) {
        generateDeferredDupExpressions(arg, indent, functionContext);
        const dupExpr = arg.$.deferredDupExpressions[0]!;
        if (exprIsFunctionCall(dupExpr) && dupExpr.$?.variableName) {
          argCode = getVariableNameForCodegen(
            dupExpr.$.variableName,
            dupExpr.$.env
          );
          handledDeferredDup = true;
        }
      }

      const returnType = getTypeString(expr.$.type!, context);

      // The evaluator provides a temp variable name for return expressions so we can
      // compute the value before running deferred drops.
      const returnTempVar = expr.$.variableName
        ? getVariableNameForCodegen(expr.$.variableName, expr.$.env)
        : undefined;

      // Skip re-declaring if we already generated a dup call with a temp variable
      // Also skip if the variable name is the same as the arg code (e.g., returning a local variable)
      if (
        !handledDeferredDup &&
        !isUnitType(expr.$.type) &&
        returnTempVar &&
        returnTempVar !== argCode // Prevent something like: int32_t counter = counter;
      ) {
        context.emitter.emitLine(
          `${indent}${returnType} ${returnTempVar} = ${argCode};`
        );
      }

      if (expr.$.deferredDropExpressions) {
        generateDeferredDropExpressions(expr, indent, context);
      }

      // Check if we're in a state machine - if so, complete the Future instead of returning
      if (functionContext.inStateMachine) {
        // State machine return - complete the Future and clean up
        const futureType = functionContext.inStateMachine.futureType;
        const futureModuleType = extractFutureTraitFromType(futureType)!;
        const childType = futureModuleType.isFuture.outputType;
        const isUnitResult = isUnitType(childType);

        // Generate pending deferred drops from enclosing begin blocks
        // This is needed when returning early from inside a cond branch - the outer
        // begin block's deferred drops would otherwise be skipped.
        // Only generate these if the return expression doesn't already have its own
        // deferred drops (to avoid double-dropping).
        if (
          functionContext.pendingDeferredDrops &&
          (!expr.$.deferredDropExpressions ||
            expr.$.deferredDropExpressions.length === 0)
        ) {
          context.emitter.emitLine(
            `${indent}// Drop local variables before early completion`
          );
          for (const dropExpr of functionContext.pendingDeferredDrops) {
            const dropCode = generateExpr(dropExpr, indent, context);
            if (dropCode) {
              context.emitter.emitLine(`${indent}${dropCode};`);
            }
          }
        }

        context.emitter.emitLine(
          `${indent}// Final state - complete the result Future`
        );
        context.emitter.emitLine(
          `${indent}ASYNC_DEBUG("${context.currentFunctionName}: Completing async function\\n");`
        );

        // Store the result if not unit
        if (!isUnitResult) {
          // Use argCode directly if we didn't need a temp variable, otherwise use the temp variable
          const resultValue =
            expr.$.variableName && needsTempVarDeclaration
              ? expr.$.variableName
              : expr.$.variableName || argCode;
          context.emitter.emitLine(`${indent}sm->result = ${resultValue};`);
        }

        // Set state to COMPLETED with release semantics
        // This ensures the result write above is visible to other threads
        context.emitter.emitLine(
          `${indent}ASYNC_DEBUG("${context.currentFunctionName}: Setting state to COMPLETED\\n");`
        );
        context.emitter.emitLine(
          `${indent}atomic_store_explicit(&sm->state, -1, memory_order_release);  // -1 = completed`
        );

        // Check if there's a continuation waiting (with acquire semantics to see the continuation registration)
        context.emitter.emitLine(``);
        context.emitter.emitLine(
          `${indent}// Check if there's a continuation waiting for this Future to complete`
        );
        context.emitter.emitLine(
          `${indent}void (*continuation_fn)(void*) = atomic_load_explicit(&sm->continuation_fn, memory_order_acquire);`
        );
        context.emitter.emitLine(
          `${indent}void* continuation_sm = atomic_load_explicit(&sm->continuation_sm, memory_order_acquire);`
        );
        context.emitter.emitLine(`${indent}if (continuation_fn != NULL) {`);
        context.emitter.emitLine(
          `${indent}  ASYNC_DEBUG("${context.currentFunctionName}: Spawning continuation: resume_fn=%p, sm=%p\\n", (void*)continuation_fn, continuation_sm);`
        );
        context.emitter.emitLine(
          `${indent}  yo_async_spawn_task(continuation_fn, continuation_sm);`
        );
        context.emitter.emitLine(`${indent}}`);

        context.emitter.emitLine(
          `${indent}sm->state = ${Number.MAX_SAFE_INTEGER};  // Terminal state`
        );
        context.emitter.emitLine(``);
        context.emitter.emitLine(
          `${indent}// Release the "running task" reference now that task is complete`
        );
        context.emitter.emitLine(
          `${indent}// This balances the __yo_incr_rc in the constructor`
        );
        context.emitter.emitLine(`${indent}__yo_decr_rc((void*)sm);`);
        context.emitter.emitLine(``);
        // Return from the void resume function
        context.emitter.emitLine(`${indent}return;`);
        // Return empty string so no additional code is generated
        return ``;
      }

      // Normal (non-state-machine) return

      // Generate pending deferred drops from enclosing begin blocks
      // This is needed when returning early from inside a cond/match branch - the outer
      // begin block's deferred drops would otherwise be skipped.
      // Only generate these if the return expression doesn't already have its own
      // deferred drops (to avoid double-dropping).
      if (
        functionContext.pendingDeferredDrops &&
        (!expr.$.deferredDropExpressions ||
          expr.$.deferredDropExpressions.length === 0)
      ) {
        context.emitter.emitLine(
          `${indent}// Drop local variables before early return`
        );
        for (const dropExpr of functionContext.pendingDeferredDrops) {
          const dropCode = generateExpr(dropExpr, indent, context);
          if (dropCode) {
            context.emitter.emitLine(`${indent}${dropCode};`);
          }
        }
      }

      if (isUnitType(expr.$.type)) {
        return `return`;
      }

      // If we handled deferred dup, use argCode (which is the dup result temp variable)
      // Otherwise use expr.$.variableName as before
      const returnValue = handledDeferredDup
        ? argCode
        : (returnTempVar ?? argCode);
      return `return ${returnValue}`;
    } else {
      if (expr.$?.deferredDropExpressions) {
        generateDeferredDropExpressions(expr, indent, context);
      }

      const functionContext = context as FunctionGenerationContext;

      // Generate pending deferred drops for unit return as well
      if (functionContext.pendingDeferredDrops) {
        context.emitter.emitLine(
          `${indent}// Drop local variables before early return`
        );
        for (const dropExpr of functionContext.pendingDeferredDrops) {
          const dropCode = generateExpr(dropExpr, indent, context);
          if (dropCode) {
            context.emitter.emitLine(`${indent}${dropCode};`);
          }
        }
      }

      return "return";
    }
  }

  // __yo_array_fill builtin (handled similarly to Array.fill)
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_array_fill, 2)) {
    const arrayTypeArg = expr.args[0]!;
    const fillValueArg = expr.args[1]!;

    // Get the ArrayType from the first argument's value
    const arrayTypeValue = arrayTypeArg.$?.value;
    if (
      !arrayTypeValue ||
      !isTypeValue(arrayTypeValue) ||
      !isArrayType(arrayTypeValue.value)
    ) {
      return "/* ERROR: __yo_array_fill first argument must be an ArrayType */";
    }

    const arrayType = arrayTypeValue.value;
    const length = arrayType.length;
    if (!isNumberValue(length)) {
      return "/* ERROR: __yo_array_fill requires compile-time known array length */";
    }

    // Generate the array fill code (macro expansion)
    const arrayTypeName = getTypeString(arrayType, context);
    const fillValueCode = generateExpr(fillValueArg, indent, context);
    const tempVarName = expr.$?.variableName || `temp_array_${Date.now()}`;
    const indexVarName = `i_${randomId(expr.$?.env.modulePath ?? "")}`;

    // Generate array declaration and fill loop
    emitter.emitLine(`${indent}${arrayTypeName} ${tempVarName};`);
    emitter.emitLine(
      `${indent}for (int ${indexVarName} = 0; ${indexVarName} < ${length.value}; ${indexVarName}++) {`
    );
    emitter.emitLine(
      `${indent}  ${tempVarName}.data[${indexVarName}] = ${fillValueCode};`
    );
    emitter.emitLine(`${indent}}`);

    return tempVarName;
  }

  // compile-time variable
  if (exprIsFunctionCallOf(expr, "::", 2)) {
    return "";
  }

  // bindings
  if (exprIsFunctionCallOf(expr, ":", 2)) {
    const lhs = expr.args[0]!;
    if (
      exprIsFunctionCall(lhs) &&
      exprIsFunctionCallOf(lhs, BuiltinKeywords.compt, 1)
    ) {
      // compile-time variable
      return "";
    }

    if (!lhs.$?.type) {
      return `// Error: No type information for left-hand side ${exprToString(lhs)}\n`;
    }
    const varName = lhs.token.value;
    const varTypeAndName = getVariableTypeString(lhs.$.type, varName, context);

    context.emitter.emitLine(
      // NOTE: We cannot assign "const" here.
      `${indent}${varTypeAndName};`
    );
    return "";
  }
  // Initialization assignment
  else if (exprIsFunctionCallOf(expr, ":=", 2)) {
    const lhs = expr.args[0]!;
    const rhs = expr.args[1]!;

    // Debug: Log all := assignments in state machines
    const functionContext = context as FunctionGenerationContext;

    if (
      exprIsFunctionCall(lhs) &&
      exprIsFunctionCallOf(lhs, BuiltinKeywords.compt, 1)
    ) {
      // compile-time variable
      return "";
    }

    // In state machine context, skip variable "load" expressions (localVar := stateMachineVar)
    // These are generated by the type checker to create local copies of variables
    // But in state machines, we access variables directly through sm->var_xxx
    if (functionContext.inStateMachine && exprIsAtom(lhs) && exprIsAtom(rhs)) {
      const lhsName = lhs.token.value;
      const rhsName = rhs.token.value;

      // Check if both refer to the same state machine variable
      // This handles cases like: b := b (creating a local copy)
      const lhsIsStateMachineVar =
        functionContext.stateMachineVariables &&
        Array.from(functionContext.stateMachineVariables.values()).some(
          (v) => v.name === lhsName
        );
      const rhsIsStateMachineVar =
        functionContext.stateMachineVariables &&
        Array.from(functionContext.stateMachineVariables.values()).some(
          (v) => v.name === rhsName
        );

      // Skip if both sides reference state machine variables with the same name
      // OR if we're trying to create a local copy of a state machine variable
      if (
        lhsName === rhsName &&
        (lhsIsStateMachineVar || rhsIsStateMachineVar)
      ) {
        // Self-assignment of state machine variable - skip to avoid redundant local copy

        return "";
      }
    }

    // Check if it's destructurings
    if (expr.$?.runtimeDestructurings) {
      const runtimeDestructurings = expr.$.runtimeDestructurings;
      const rhsCode = generateExpr(rhs, indent, context);
      const rhsType = rhs.$?.type;
      runtimeDestructurings.forEach(({ label, type, variableName }) => {
        // Sanitize the variable name for C
        const sanitizedVariableName = sanitizeForCIdentifier(
          variableName,
          type.isExtern === "c"
        );
        const varTypeAndName = getVariableTypeString(
          type,
          sanitizedVariableName,
          context
        );

        // Handle newtype destructuring - just use the value itself
        if (
          rhsType &&
          isStructType(rhsType) &&
          rhsType.isNewtype &&
          rhsType.fields.length === 1
        ) {
          const singleField = rhsType.fields[0];
          if (singleField && singleField.label === label) {
            // For newtype, destructuring the single field just returns the value itself
            context.emitter.emitLine(
              `${indent}${varTypeAndName} = ${rhsCode}; // Destructuring ${label} (newtype)`
            );
            return;
          }
        }

        let fieldName = label.match(/^\d+$/)
          ? `_${label}`
          : sanitizeForCIdentifier(label, type.isExtern === "c");

        if (rhsType && isTupleType(rhsType) && !label.match(/^\d+$/)) {
          const index = rhsType.fields.findIndex((el) => el.label === label);
          fieldName = index >= 0 ? `_${index}` : fieldName;
        }

        // Use -> for ref types (which are pointers), . for regular types
        const memberAccessOp = rhsType && isObjectType(rhsType) ? "->" : ".";

        context.emitter.emitLine(
          `${indent}${varTypeAndName} = ${rhsCode}${memberAccessOp}${fieldName}; // Destructuring ${label}`
        );
      });
      return "";
    }

    if (exprIsAtom(lhs)) {
      const varName = lhs.token.value;
      if (!lhs.$?.type) {
        return `// Error: No type information for variable ${varName}\n`;
      }

      // Check if the variable being assigned to is compile-time
      // If so, skip code generation (compile-time variables don't exist at runtime)
      if (lhs.$?.env) {
        const variables = getVariablesFromEnv(lhs.$.env, varName);
        if (
          variables.length > 0 &&
          variables[variables.length - 1]!.isCompileTimeOnly
        ) {
          return "";
        }
      }

      // Check if we're in a state machine context and this is a captured variable
      const functionContext = context as FunctionGenerationContext;

      // To check if a variable is in the state machine, we need to:
      // 1. Look up the variable in the environment to get its ID
      // 2. Check if that ID is a key in stateMachineVariables map
      let isStateMachineVar = false;
      let varId: string | undefined;

      if (
        functionContext.inStateMachine &&
        functionContext.stateMachineVariables &&
        lhs.$?.env
      ) {
        // Get the variable from the environment
        const variables = getVariablesFromEnv(lhs.$.env, varName);
        if (variables.length > 0) {
          const variable = variables[variables.length - 1]!;
          // Check if this variable (or its owner if it's borrowing) is in state machine
          const idToCheck = variable.isOwningTheSameRcValueAs
            ? variable.isOwningTheSameRcValueAs.id
            : variable.id;

          if (functionContext.stateMachineVariables.has(idToCheck)) {
            isStateMachineVar = true;
            varId = idToCheck;
          }
        }
      }

      // Handle array initialization specially
      if (isArrayType(lhs.$.type)) {
        // Check if RHS is an array literal
        if (
          exprIsFunctionCall(rhs) &&
          exprIsFunctionCallOf(rhs, BuiltinKeywords.array)
        ) {
          // Direct initialization with array literal
          const rhsCode = generateExpr(rhs, indent, context);

          if (isStateMachineVar && varId) {
            // In state machine - assign to sm->var_xxx field
            context.emitter.emitLine(`${indent}sm->var_${varId} = ${rhsCode};`);
          } else {
            // Skip unit type variables (zero-sized types, optimized away like Rust)
            if (!isUnitType(lhs.$.type)) {
              const varTypeAndName = getVariableTypeString(
                lhs.$.type,
                varName,
                context
              );
              context.emitter.emitLine(
                `${indent}${varTypeAndName} = ${rhsCode};`
              );
            }
          }
        } else {
          // Copying from another array - use direct struct assignment
          // Handle temp variable assignment for Rc values
          let rhsCode: string;
          if (rhs.$?.variableName) {
            const tempVarName = getVariableNameForCodegen(
              rhs.$.variableName,
              rhs.$.env
            );

            const rhsExprCode = generateExpr(rhs, indent, context);

            // Generate temp variable assignment first (only if not in state machine)
            if (!isStateMachineVar) {
              const tempVarType = getVariableTypeString(
                rhs.$.type!,
                tempVarName,
                context
              );
              if (tempVarName !== rhsExprCode) {
                context.emitter.emitLine(
                  `${indent}${tempVarType} = ${rhsExprCode};`
                );
              }
            }

            // Use temp variable for the main assignment
            rhsCode = tempVarName;
          } else {
            rhsCode = generateExpr(rhs, indent, context);
          }

          if (isStateMachineVar && varId) {
            // In state machine - assign to sm->var_xxx field
            context.emitter.emitLine(`${indent}sm->var_${varId} = ${rhsCode};`);
          } else {
            // Skip unit type variables (zero-sized types, optimized away like Rust)
            if (!isUnitType(lhs.$.type)) {
              const varTypeAndName = getVariableTypeString(
                lhs.$.type,
                varName,
                context
              );
              context.emitter.emitLine(
                `${indent}${varTypeAndName} = ${rhsCode};`
              );
            }
          }
        }
      } else {
        // Non-array initialization - use existing logic
        let rhsCode: string;

        const rhsIsClosureConstruction =
          exprIsFunctionCall(rhs) &&
          rhs.$?.closureFunctionValue &&
          rhs.$?.type &&
          typeImplementsFn(rhs.$.type);

        // If RHS has a temp variable name (e.g., for Rc values), we need to:
        // 1. First generate the RHS expression and assign it to the temp variable
        // 2. Then use the temp variable for the assignment
        // BUT: don't create temp variables for captured variables
        // ALSO: don't create temp variables if the temp var name is the same as the variable itself
        if (rhs.$?.variableName) {
          const tempVarName = getVariableNameForCodegen(
            rhs.$.variableName,
            rhs.$.env
          );

          const sanitizedVarName = getVariableNameForCodegen(
            varName,
            lhs.$.env
          );

          // Skip temp variable creation if temp var name matches the actual variable name
          // This prevents redundant declarations like "int32_t x = x;"
          if (tempVarName === sanitizedVarName) {
            // Just use the variable directly, no temp variable needed
            rhsCode = generateExpr(rhs, indent, context);

            // Handle deferred dup expressions even for simple variable references
            if (
              !rhsIsClosureConstruction &&
              rhs.$?.deferredDupExpressions &&
              rhs.$.deferredDupExpressions.length > 0
            ) {
              generateDeferredDupExpressions(rhs, indent, functionContext);
              const dupExpr = rhs.$.deferredDupExpressions[0]!;
              if (exprIsFunctionCall(dupExpr) && dupExpr.$?.variableName) {
                rhsCode = getVariableNameForCodegen(
                  dupExpr.$.variableName,
                  dupExpr.$.env
                );
              }
            }
          } else if (
            exprIsAtom(rhs) &&
            tempVarName ===
              getVariableNameForCodegen(rhs.token.value, rhs.$.env)
          ) {
            // Just use the variable directly, no temp variable needed
            rhsCode = generateExpr(rhs, indent, context);

            // Handle deferred dup expressions even for simple variable references
            if (
              !rhsIsClosureConstruction &&
              rhs.$?.deferredDupExpressions &&
              rhs.$.deferredDupExpressions.length > 0
            ) {
              generateDeferredDupExpressions(rhs, indent, functionContext);
              const dupExpr = rhs.$.deferredDupExpressions[0]!;
              if (exprIsFunctionCall(dupExpr) && dupExpr.$?.variableName) {
                rhsCode = getVariableNameForCodegen(
                  dupExpr.$.variableName,
                  dupExpr.$.env
                );
              }
            }
          } else {
            // Check if this temp variable is for a captured variable - if so, skip temp variable creation
            const functionContext = context as FunctionGenerationContext;
            if (
              exprIsAtom(rhs) &&
              functionContext.currentClosureCaptures &&
              functionContext.currentClosureCaptures.includes(
                rhs.token.value
              ) &&
              rhs.$?.env &&
              functionContext.currentClosureCaptureFrameLevel !== undefined &&
              checkVariableIsClosureCaptured(
                rhs.token.value,
                rhs.$.env,
                functionContext.currentClosureCaptureFrameLevel
              )
            ) {
              // This is a captured variable, don't create a temp variable for it
              // Generate closure access directly
              const currentClosureType = functionContext.currentClosureType;
              if (currentClosureType && currentClosureType.isClosure) {
                const closureTypeEntry = Object.values(
                  functionContext.types
                ).find((entry) => entry.type === currentClosureType);
                if (closureTypeEntry) {
                  // Note: captureType is no longer on ClosureType, so we use a naming convention
                  // The capture struct name follows the pattern: closure_type_name + "_capture"
                  const captureStructName = `${closureTypeEntry.cName}_capture`;
                  rhsCode = `((${captureStructName}*)closure_context->data)->${getVariableNameForCodegen(rhs.token.value, rhs.$.env)}`;
                } else {
                  rhsCode = `closure_context->${getVariableNameForCodegen(rhs.token.value, rhs.$.env)}`;
                }
              } else {
                rhsCode = `closure_context->${getVariableNameForCodegen(rhs.token.value, rhs.$.env)}`;
              }
            } else {
              // Normal temp variable handling
              const rhsExprCode = generateExpr(rhs, indent, context);

              // Check if the RHS expression already generates the same temp variable
              // If so, don't generate a redundant assignment
              if (rhsExprCode.trim() !== tempVarName) {
                // Generate temp variable assignment first
                const tempVarType = getVariableTypeString(
                  rhs.$.type!,
                  tempVarName,
                  context
                );
                context.emitter.emitLine(
                  `${indent}${tempVarType} = ${rhsExprCode};`
                );
              }

              // Handle deferred dup expressions for RHS
              // After generating the RHS temp variable, check if we need to dup it
              if (
                !rhsIsClosureConstruction &&
                rhs.$?.deferredDupExpressions &&
                rhs.$.deferredDupExpressions.length > 0
              ) {
                generateDeferredDupExpressions(rhs, indent, functionContext);
                // Use the dup result variable instead of the original temp variable
                const dupExpr = rhs.$.deferredDupExpressions[0]!;
                if (exprIsFunctionCall(dupExpr) && dupExpr.$?.variableName) {
                  rhsCode = getVariableNameForCodegen(
                    dupExpr.$.variableName,
                    dupExpr.$.env
                  );
                } else {
                  // Use temp variable for the main assignment
                  rhsCode = tempVarName;
                }
              } else {
                // Use temp variable for the main assignment
                rhsCode = tempVarName;
              }
            }
          }
        } else {
          rhsCode = generateExpr(rhs, indent, context);

          // Handle deferred dup expressions for RHS without temp variable
          if (
            !rhsIsClosureConstruction &&
            rhs.$?.deferredDupExpressions &&
            rhs.$.deferredDupExpressions.length > 0
          ) {
            const functionContext = context as FunctionGenerationContext;
            generateDeferredDupExpressions(rhs, indent, functionContext);
            // Use the dup result variable
            const dupExpr = rhs.$.deferredDupExpressions[0]!;
            if (exprIsFunctionCall(dupExpr) && dupExpr.$?.variableName) {
              rhsCode = getVariableNameForCodegen(
                dupExpr.$.variableName,
                dupExpr.$.env
              );
            }
          }
        }

        // Special handling for slice initialization.
        if (isSliceType(lhs.$.type)) {
          const sliceType = lhs.$.type; // Get the slice type directly

          if (isStateMachineVar && varId) {
            // In state machine - assign to sm->var_xxx field
            context.emitter.emitLine(`${indent}sm->var_${varId} = ${rhsCode};`);
          } else {
            // Skip unit type variables (zero-sized types, optimized away like Rust)
            if (!isUnitType(sliceType)) {
              const varTypeAndName = getVariableTypeString(
                sliceType,
                varName,
                context
              );
              context.emitter.emitLine(
                `${indent}${varTypeAndName} = ${rhsCode};`
              );
            }
          }
        } else {
          // Normal initialization
          if (isStateMachineVar && varId) {
            // In state machine - assign to sm->var_xxx field
            context.emitter.emitLine(`${indent}sm->var_${varId} = ${rhsCode};`);
          } else {
            // Check if RHS is a temp variable with a registered async struct name
            const rhsIsTempVar = isTempVariableName(
              rhs.$!.env.modulePath,
              rhsCode.trim()
            );
            let cTypeString: string;

            if (rhsIsTempVar && context.tempVarAsyncStructNames) {
              const asyncStructName = context.tempVarAsyncStructNames.get(
                rhsCode.trim()
              );
              if (asyncStructName) {
                cTypeString = `${asyncStructName}*`;
              } else {
                cTypeString = getTypeString(lhs.$.type, context);
              }
            } else {
              cTypeString = getTypeString(lhs.$.type, context);
            }

            // Skip unit type variables (zero-sized types, optimized away like Rust)
            if (!isUnitType(lhs.$.type)) {
              context.emitter.emitLine(
                `${indent}${cTypeString} ${getVariableNameForCodegen(varName, lhs.$.env)} = ${rhsCode};`
              );
            }
          }
        }
      }
      return "";
    }
  }
  // Assignent with mutability or initialization
  else if (exprIsFunctionCallOf(expr, "=", 2)) {
    let lhs = expr.args[0]!;
    const rhs = expr.args[1]!;

    let isInitialization = false;
    if (exprIsFunctionCall(lhs) && exprIsFunctionCallOf(lhs, ":", 2)) {
      isInitialization = true;
      lhs = lhs.args[0]!; // Get the actual variable being assigned
    }
    if (
      exprIsFunctionCall(lhs) &&
      exprIsFunctionCallOf(lhs, BuiltinKeywords.compt)
    ) {
      // compile-time variable
      return "";
    }

    // Check if LHS is a field/index access into a compile-time variable
    // e.g., p1.x = 5 where p1 is compile-time
    // e.g., arr(0) = 10 where arr is compile-time
    if (lhs.$?.pathCollection && lhs.$?.pathCollection.length > 0) {
      const path = lhs.$.pathCollection[0];
      if (path && path.length >= 2) {
        const baseVariableName = path[0];
        if (typeof baseVariableName === "string" && lhs.$?.env) {
          const variables = getVariablesFromEnv(lhs.$.env, baseVariableName);
          if (
            variables.length > 0 &&
            variables[variables.length - 1]!.isCompileTimeOnly
          ) {
            // Base variable is compile-time, so this assignment should not generate code
            return "";
          }
        }
      }
    }

    // Check if LHS is a simple variable name that refers to a compile-time variable
    if (exprIsAtom(lhs) && lhs.$?.env) {
      const varName = lhs.token.value;
      const variables = getVariablesFromEnv(lhs.$.env, varName);
      if (
        variables.length > 0 &&
        variables[variables.length - 1]!.isCompileTimeOnly
      ) {
        // Compile-time variable - skip code generation
        return "";
      }
    }

    if (!lhs.$?.type) {
      return `// Error: No type information for left-hand side ${exprToString(lhs)}\n`;
    }
    const lhsCode = generateExpr(lhs, indent, context);

    // Check if we need to save the old value into temp variable
    if (expr.$?.variableName) {
      const tempVarName = expr.$.variableName;

      // Skip temp variable declaration in state machines if lhsCode already accesses sm->var_xxx
      const functionContext = context as FunctionGenerationContext;
      const skipTempVar =
        functionContext.inStateMachine && lhsCode.startsWith("sm->");

      if (!skipTempVar) {
        const tempVarNameAndType = getVariableTypeString(
          lhs.$.type,
          tempVarName,
          context
        );

        // Handle array assignment specially
        if (isArrayType(lhs.$.type)) {
          // For array, use direct struct assignment
          context.emitter.emitLine(
            `${indent}${tempVarNameAndType} = ${lhsCode}; // Save old value for later use`
          );
        } else {
          if (!isUnitType(lhs.$.type)) {
            context.emitter.emitLine(
              `${indent}${tempVarNameAndType} = ${lhsCode}; // Save old value for later use`
            );
          }
        }
      }
    }

    // Handle array assignments specially
    if (isArrayType(lhs.$.type)) {
      // Since we use struct wrappers consistently, we can use direct struct assignment
      const rhsCode = generateExpr(rhs, indent, context);

      // Check if RHS is a closure construction
      const rhsIsClosureConstruction =
        exprIsFunctionCall(rhs) &&
        rhs.$?.closureFunctionValue &&
        rhs.$?.type &&
        typeImplementsFn(rhs.$.type);

      // Handle deferred dup expressions for RHS
      const functionContext = context as FunctionGenerationContext;
      let finalRhsCode = rhsCode;
      if (
        !rhsIsClosureConstruction &&
        rhs.$?.deferredDupExpressions &&
        rhs.$.deferredDupExpressions.length > 0
      ) {
        // If RHS has a variable name, we need to declare it first
        if (rhs.$?.variableName && rhs.$?.type) {
          const rhsVarName = getVariableNameForCodegen(
            rhs.$.variableName,
            rhs.$.env
          );
          // Only emit the variable declaration if it's not the same as rhsCode
          if (rhsVarName !== rhsCode.trim()) {
            const rhsTypeStr = getTypeString(rhs.$.type, context);
            context.emitter.emitLine(
              `${indent}${rhsTypeStr} ${rhsVarName} = ${rhsCode};`
            );
          }
        }

        generateDeferredDupExpressions(rhs, indent, functionContext);
        // Use the dup result variable instead of the original
        const dupExpr = rhs.$.deferredDupExpressions[0]!;
        if (exprIsFunctionCall(dupExpr) && dupExpr.$?.variableName) {
          finalRhsCode = getVariableNameForCodegen(
            dupExpr.$.variableName,
            dupExpr.$.env
          );
        }
      }

      if (isInitialization) {
        // For initialization
        const varTypeAndName = getVariableTypeString(
          lhs.$.type,
          generateExpr(lhs, indent, context),
          context
        );
        context.emitter.emitLine(
          `${indent}${varTypeAndName} = ${finalRhsCode};`
        );
      } else {
        // For assignment to existing array variable, use direct struct assignment
        context.emitter.emitLine(`${indent}${lhsCode} = ${finalRhsCode};`);
      }
    } else {
      // Non-array assignment - use existing logic
      const rhsCode = generateExpr(rhs, indent, context);

      // Check if RHS is a closure construction
      const rhsIsClosureConstruction =
        exprIsFunctionCall(rhs) &&
        rhs.$?.closureFunctionValue &&
        rhs.$?.type &&
        typeImplementsFn(rhs.$.type);

      // Handle deferred dup expressions for RHS
      const functionContext = context as FunctionGenerationContext;
      let finalRhsCode = rhsCode;
      if (
        !rhsIsClosureConstruction &&
        rhs.$?.deferredDupExpressions &&
        rhs.$.deferredDupExpressions.length > 0
      ) {
        // If RHS has a variable name, we need to declare it first
        if (rhs.$?.variableName && rhs.$?.type) {
          const rhsVarName = getVariableNameForCodegen(
            rhs.$.variableName,
            rhs.$.env
          );
          // Only emit the variable declaration if it's not the same as rhsCode
          if (rhsVarName !== rhsCode.trim()) {
            const rhsTypeStr = getTypeString(rhs.$.type, context);
            context.emitter.emitLine(
              `${indent}${rhsTypeStr} ${rhsVarName} = ${rhsCode};`
            );
          }
        }

        generateDeferredDupExpressions(rhs, indent, functionContext);
        // Use the dup result variable instead of the original
        const dupExpr = rhs.$.deferredDupExpressions[0]!;
        if (exprIsFunctionCall(dupExpr) && dupExpr.$?.variableName) {
          finalRhsCode = getVariableNameForCodegen(
            dupExpr.$.variableName,
            dupExpr.$.env
          );
        }
      }

      // Check if we need to cast closure types
      // const lhsType = lhs.$.type;
      // const rhsType = rhs.$?.type;
      // if (
      //   lhsType &&
      //   rhsType &&
      //   isClosureType(lhsType) &&
      //   isClosureType(rhsType)
      // ) {
      //   // Note: All closure types are now the same (no base vs specific distinction)
      //   // since captureType is no longer part of ClosureType
      //   // No cast needed
      // }

      if (!isUnitType(lhs.$.type)) {
        // For Impl(Future(...)) bindings, use RHS's actual async block type if available
        // This ensures task := run_task(b) uses run_task's state machine type
        const lhsType = lhs.$.type;
        const rhsType = rhs.$?.type;
        let rhsAsyncStructName: string | undefined;

        // Special case: if RHS is a temp variable from a function call returning Future,
        // we should use the temp variable's already-declared type instead of inferring from lhsType
        // Temp variables have the pattern _yoXXXXXXXX_temp_NNNNN
        const rhsIsTempVar = isTempVariableName(
          rhs.$!.env.modulePath,
          finalRhsCode.trim()
        );

        // If RHS is a temp variable, check if it has a stored async struct name
        if (rhsIsTempVar && context.tempVarAsyncStructNames) {
          rhsAsyncStructName = context.tempVarAsyncStructNames.get(
            finalRhsCode.trim()
          );
        }

        const shouldUseFutureType =
          isInitialization &&
          rhsType &&
          typeImplementsFuture(lhsType) &&
          typeImplementsFuture(rhsType);

        let cTypeString: string;
        if (rhsIsTempVar && shouldUseFutureType) {
          // RHS is a temp variable that was already declared with the correct Future type
          // Use 'auto' or just don't specify the type - let C infer it from the RHS
          // Actually, C doesn't have type inference, so we need to use the RHS's type
          // But we don't know the RHS's C type here. The best we can do is use the temp variable's
          // type by looking at the generated code. But that's not possible.
          // So instead, just don't emit the initialization - emit an alias assignment.
          // NO WAIT - we can't do that because this IS the initialization.
          // The only solution is to get the correct type from the function's async block.
          if (rhsAsyncStructName) {
            cTypeString = `${rhsAsyncStructName}*`;
          } else {
            cTypeString = getTypeString(rhsType!, context);
          }
        } else if (shouldUseFutureType && rhsAsyncStructName) {
          // Use the async block's struct name directly
          cTypeString = `${rhsAsyncStructName}*`;
        } else {
          cTypeString = getTypeString(
            shouldUseFutureType ? rhsType! : lhsType,
            context
          );
        }

        context.emitter.emitLine(
          `${indent}${isInitialization ? cTypeString + " " : ""}${lhsCode} = ${finalRhsCode};`
        );
      }
    }

    return expr.$?.variableName ?? "";
  }
  // already computed and it's not unit value
  else if (
    expr.$?.value &&
    !isUnknownValue(expr.$?.value) &&
    !isUnitType(expr.$.type)
  ) {
    const value: Value = expr.$.value;
    return generateComptValue(value, context, expr);
  }
  // . field access
  else if (exprIsFunctionCallOf(expr, ".", 2)) {
    return generateFieldAccess(expr, indent, context);
  }
  // begin
  else if (exprIsFunctionCallOf(expr, BuiltinKeywords.begin)) {
    const tempVariableName = expr.$?.variableName;
    const valueType = expr.$?.type;
    const functionContext = context as FunctionGenerationContext;

    if (tempVariableName && valueType) {
      // Expression form: begin block that returns a value
      if (!isUnitType(valueType) && !expr.$?.controlFlow) {
        context.emitter.emitLine(
          `${indent}${getTypeString(valueType, context)} ${tempVariableName};`
        );
      }

      // Evaluate each argument
      context.emitter.emitLine(`${indent}{ // begin block`);

      // Set pending deferred drops from this begin block
      // These need to be generated when early returning from inside this block
      const previousPendingDeferredDrops = functionContext.pendingDeferredDrops;
      functionContext.pendingDeferredDrops = expr.$?.deferredDropExpressions;

      // Generate and emit code for each arg IMMEDIATELY to preserve order
      // This is important because generateExpr may have side effects that emit code
      const argsCode: string[] = [];
      const isReturningValue = !isUnitType(valueType) && !expr.$?.controlFlow;

      for (let idx = 0; idx < expr.args.length; idx++) {
        const arg = expr.args[idx]!;
        const result = generateExpr(arg, indent + "  ", context);
        argsCode.push(result);

        // Emit immediately to preserve order (generateExpr might emit temp vars as side effects)
        // But skip emitting the last expression if it's being used as the return value
        const isLastExpr = idx === expr.args.length - 1;
        if (result && !(isLastExpr && isReturningValue)) {
          if (arg.$ && isTempVariableName(arg.$.env.modulePath, result)) {
            // Skip
          } else {
            context.emitter.emitLine(`${indent}  ${result};`);
          }
        }
      }
      if (isReturningValue) {
        const lastArg = expr.args[expr.args.length - 1]!;
        let lastArgCode = argsCode[argsCode.length - 1]!;

        // Handle deferred dup expressions for the return value
        // This is needed when returning a borrowed value - we must call dup
        if (
          lastArg.$?.deferredDupExpressions &&
          lastArg.$.deferredDupExpressions.length > 0
        ) {
          // Similar to return statement handling: first declare/assign the value
          // before calling dup on it
          if (lastArg.$?.variableName) {
            const savedVariableName = lastArg.$.variableName;
            lastArg.$.variableName = undefined;
            const rawArgCode = generateExpr(lastArg, indent + "  ", context);
            lastArg.$.variableName = savedVariableName;

            const argType = getTypeString(lastArg.$.type!, context);
            const argTempVar = getVariableNameForCodegen(
              savedVariableName,
              lastArg.$.env
            );

            if (argTempVar !== rawArgCode) {
              context.emitter.emitLine(
                `${indent}  ${argType} ${argTempVar} = ${rawArgCode};`
              );
            }
            lastArgCode = argTempVar;
          }

          generateDeferredDupExpressions(lastArg, indent + "  ", context);
          const dupExpr = lastArg.$.deferredDupExpressions[0]!;
          if (exprIsFunctionCall(dupExpr) && dupExpr.$?.variableName) {
            lastArgCode = getVariableNameForCodegen(
              dupExpr.$.variableName,
              dupExpr.$.env
            );
          }
        }

        context.emitter.emitLine(
          `${indent}  ${tempVariableName} = ${lastArgCode};`
        );
      }

      // Generate deferred drop expressions before closing the block
      if (expr.$?.deferredDropExpressions) {
        for (const dropExpr of expr.$.deferredDropExpressions) {
          const dropCode = generateExpr(dropExpr, indent + "  ", context);
          if (dropCode) {
            context.emitter.emitLine(`${indent}  ${dropCode};`);
          }
        }
      }

      context.emitter.emitLine(`${indent}} // end begin block`);

      // Restore previous pending deferred drops
      functionContext.pendingDeferredDrops = previousPendingDeferredDrops;

      return isUnitType(valueType) || expr.$?.controlFlow
        ? ""
        : tempVariableName;
    } else {
      // Statement form: begin block without returning a value
      context.emitter.emitLine(`${indent}{ // begin block`);

      // Set pending deferred drops for statement form as well
      const previousPendingDeferredDrops = functionContext.pendingDeferredDrops;
      functionContext.pendingDeferredDrops = expr.$?.deferredDropExpressions;

      const argsCode = expr.args.map((arg) =>
        generateExpr(arg, indent + "  ", context)
      );
      argsCode.forEach((argCode) => {
        if (argCode) {
          context.emitter.emitLine(`${indent}  ${argCode};`);
        }
      });

      // Generate deferred drop expressions before closing the block
      if (expr.$?.deferredDropExpressions) {
        for (const dropExpr of expr.$.deferredDropExpressions) {
          const dropCode = generateExpr(dropExpr, indent + "  ", context);
          if (dropCode) {
            context.emitter.emitLine(`${indent}  ${dropCode};`);
          }
        }
      }

      context.emitter.emitLine(`${indent}} // end begin block`);

      // Restore previous pending deferred drops
      functionContext.pendingDeferredDrops = previousPendingDeferredDrops;

      return "";
    }
  }
  // cond
  else if (exprIsFunctionCallOf(expr, BuiltinKeywords.cond)) {
    return generateCondExpression(expr, indent, context);
  }
  // match
  else if (exprIsFunctionCallOf(expr, BuiltinKeywords.match)) {
    return generateMatchExpression(expr, indent, context);
  }
  // ptr value
  else if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_address_of, 1)) {
    const type = expr.$?.type;
    if (!type) {
      return `// Error: No type information for pointer/reference expression ${exprToString(expr)}\n`;
    }
    const arg = expr.args[0]!;

    // Special case: *(arr(0:3)) or *(arr(:)) should create slice values directly
    if (exprIsFunctionCall(arg)) {
      const funcType = arg.func.$?.type;
      if (funcType && isArrayType(funcType)) {
        const firstArg = arg.args[0];
        if (
          firstArg &&
          exprIsFunctionCall(firstArg) &&
          exprIsFunctionCallOf(firstArg, ":")
        ) {
          // *(arr(start:end)) -> create slice value directly
          const arrayCode = generateExpr(arg.func!, indent, context);
          const startCode = generateExpr(firstArg.args[0]!, indent, context);
          const endCode = generateExpr(firstArg.args[1]!, indent, context);

          const sliceTypeName = `Slice_${sanitizeForCIdentifier(getTypeString((funcType as ArrayType).childType, context))}`;
          // Register the slice type
          if (!context.sliceStructTypes.has(sliceTypeName)) {
            context.sliceStructTypes.set(sliceTypeName, {
              childType: getTypeString(
                (funcType as ArrayType).childType,
                context
              ),
            });
          }
          return `(${sliceTypeName}){ .data = &${arrayCode}.data[${startCode}], .length = ${endCode} - ${startCode} }`;
        } else if (
          firstArg &&
          exprIsAtom(firstArg) &&
          firstArg.token.value === ":"
        ) {
          // *(arr(:)) -> create slice value for whole array
          const arrayCode = generateExpr(arg.func!, indent, context);
          const arrayType = funcType as ArrayType;
          const childType = arrayType.childType;

          const sliceTypeName = `Slice_${sanitizeForCIdentifier(getTypeString(childType, context))}`;
          // Register the slice type
          if (!context.sliceStructTypes.has(sliceTypeName)) {
            context.sliceStructTypes.set(sliceTypeName, {
              childType: getTypeString(childType, context),
            });
          }

          if (isNumberValue(arrayType.length)) {
            return `(${sliceTypeName}){ .data = &${arrayCode}.data[0], .length = ${arrayType.length.value} }`;
          } else {
            return `/* Error: Cannot slice array with non-compile-time length */`;
          }
        }
      } else if (
        funcType &&
        (isSliceType(funcType) ||
          (isPtrType(funcType) && isSliceType(funcType.childType)))
      ) {
        // Handle slice-from-slice: *(slice(start:end))
        const sliceBaseType = isSliceType(funcType)
          ? (funcType as SliceType)
          : (funcType.childType as SliceType);
        const firstArg = arg.args[0];
        if (
          firstArg &&
          exprIsFunctionCall(firstArg) &&
          exprIsFunctionCallOf(firstArg, ":")
        ) {
          // *(slice(start:end)) -> create sub-slice
          const sliceCode = generateExpr(arg.func!, indent, context);
          const startCode = generateExpr(firstArg.args[0]!, indent, context);
          const endCode = generateExpr(firstArg.args[1]!, indent, context);

          const sliceTypeName = `Slice_${sanitizeForCIdentifier(getTypeString(sliceBaseType.childType, context))}`;
          // Register the slice type
          if (!context.sliceStructTypes.has(sliceTypeName)) {
            context.sliceStructTypes.set(sliceTypeName, {
              childType: getTypeString(sliceBaseType.childType, context),
            });
          }
          return `(${sliceTypeName}){ .data = &${sliceCode}.data[${startCode}], .length = ${endCode} - ${startCode} }`;
        } else if (
          firstArg &&
          exprIsAtom(firstArg) &&
          firstArg.token.value === ":"
        ) {
          // *(slice(:)) -> create slice copy of whole slice
          const sliceCode = generateExpr(arg.func!, indent, context);

          const sliceTypeName = `Slice_${sanitizeForCIdentifier(getTypeString(sliceBaseType.childType, context))}`;
          // Register the slice type
          if (!context.sliceStructTypes.has(sliceTypeName)) {
            context.sliceStructTypes.set(sliceTypeName, {
              childType: getTypeString(sliceBaseType.childType, context),
            });
          }
          return `(${sliceTypeName}){ .data = ${sliceCode}.data, .length = ${sliceCode}.length }`;
        }
      }
    }

    // Check if the argument is a literal value that needs to be made addressable
    // In C, we can't take the address of a literal directly (&1 is invalid)
    // We need to use a compound literal: &(int32_t){1}
    const argValue = arg.$?.value;
    const argType = arg.$?.type;

    if (argValue !== undefined && argType) {
      // Check for compile-time values that need compound literals
      if (isNumberValue(argValue) || isBooleanValue(argValue)) {
        const argCode = generateExpr(arg, indent, context);
        const typeName = getTypeString(argType, context);
        return `(&(${typeName}){${argCode}})`;
      }
      // For compt_string with conversion, the generateExpr already generates the struct
      if (isComptStringValue(argValue) && arg.$?.convertedRuntimeType) {
        const argCode = generateExpr(arg, indent, context);
        return `(&${argCode})`;
      }
    }

    const argCode = generateExpr(arg, indent, context);

    // For pointer/reference creation, we need to be careful about constness
    // Simply use the address-of operator without an explicit cast to avoid const issues
    return `(&${argCode})`;
  }
  // (anonymous) tuple value
  else if (exprIsFunctionCallOf(expr, BuiltinKeywords.tuple)) {
    const runtimeArgExprs = expr.$?.runtimeArgExprsInOrder;
    const cName = context.types[expr.$?.type?.id ?? ""]?.cName;
    const tempVar = expr.$?.variableName;

    if (runtimeArgExprs && cName) {
      const functionContext = context as FunctionGenerationContext;

      // Generate tuple initialization with dup handling for each argument
      // Use explicit field assignments with numeric indices
      const argsList = runtimeArgExprs
        .map((arg, index) => {
          const argCode = generateExpr(arg, indent, context);

          // Handle deferred dup expressions for tuple fields
          let finalArgValue = argCode;
          if (
            arg.$?.deferredDupExpressions &&
            arg.$.deferredDupExpressions.length > 0
          ) {
            generateDeferredDupExpressions(arg, indent, functionContext);
            // Use the dup result variable instead of the original
            const dupExpr = arg.$.deferredDupExpressions[0]!;
            if (exprIsFunctionCall(dupExpr) && dupExpr.$?.variableName) {
              finalArgValue = getVariableNameForCodegen(
                dupExpr.$.variableName,
                dupExpr.$.env
              );
            }
          }

          // Use explicit field assignment with numeric index
          return `._${index} = ${finalArgValue}`;
        })
        .join(", ");

      // If this tuple has a temporary variable name, declare it
      if (tempVar && expr.$?.type) {
        const tupleValue = `(${cName}){ ${argsList} }`;
        const varTypeAndName = getVariableTypeString(
          expr.$.type,
          tempVar,
          context
        );
        context.emitter.emitLine(`${indent}${varTypeAndName} = ${tupleValue};`);
        return tempVar;
      } else {
        return `(${cName}){ ${argsList} }`;
      }
    } else if (expr.args.length === 0) {
      // unit value - optimize away like Rust (no storage, no code)
      // If there's a temp variable, we don't declare it at all
      // Just return empty string for inline use
      return "";
    } else {
      // Fallback: use expr.args directly if runtimeArgExprsInOrder is not set
      const args = runtimeArgExprs ?? expr.args;
      if (!cName) {
        return `/* Error: tuple type not found - typeId: ${expr.$?.type?.id ?? "none"} */`;
      }

      const argsList = args
        .map((arg, index) => {
          const argCode = generateExpr(arg, indent, context);
          return `._${index} = ${argCode}`;
        })
        .join(", ");

      // If this tuple has a temporary variable name, declare it
      if (tempVar && expr.$?.type) {
        const tupleValue = `(${cName}){ ${argsList} }`;
        const varTypeAndName = getVariableTypeString(
          expr.$.type,
          tempVar,
          context
        );
        context.emitter.emitLine(`${indent}${varTypeAndName} = ${tupleValue};`);
        return tempVar;
      } else {
        return `(${cName}){ ${argsList} }`;
      }
    }
  }
  // (anonymous) array value
  else if (exprIsFunctionCallOf(expr, BuiltinKeywords.array)) {
    const runtimeArgExprs = expr.$?.runtimeArgExprsInOrder;
    const arrayType = expr.$?.type;
    const tempVar = expr.$?.variableName;

    if (isArrayType(arrayType) && runtimeArgExprs) {
      const functionContext = context as FunctionGenerationContext;

      // Generate struct wrapper initialization with dup handling for each element
      const argsList = runtimeArgExprs
        .map((arg) => {
          const argCode = generateExpr(arg, indent, context);

          // Handle deferred dup expressions for array fields
          if (
            arg.$?.deferredDupExpressions &&
            arg.$.deferredDupExpressions.length > 0
          ) {
            generateDeferredDupExpressions(arg, indent, functionContext);
            // Use the dup result variable instead of the original
            const dupExpr = arg.$.deferredDupExpressions[0]!;
            if (exprIsFunctionCall(dupExpr) && dupExpr.$?.variableName) {
              return getVariableNameForCodegen(
                dupExpr.$.variableName,
                dupExpr.$.env
              );
            }
          }

          return argCode;
        })
        .join(", ");
      const arrayTypeName = getTypeString(arrayType, context);

      // If this array has a temporary variable name, declare it
      if (tempVar && expr.$?.type) {
        const arrayValue = `(${arrayTypeName}){ .data = { ${argsList} } }`;
        const varTypeAndName = getVariableTypeString(
          expr.$.type,
          tempVar,
          context
        );
        context.emitter.emitLine(`${indent}${varTypeAndName} = ${arrayValue};`);
        return tempVar;
      } else {
        return `(${arrayTypeName}){ .data = { ${argsList} } }`;
      }
    }
  }
  // recur
  else if (exprIsFunctionCallOf(expr, BuiltinKeywords.recur)) {
    const runtimeArgExprs = expr.$?.runtimeArgExprsInOrder;
    if (runtimeArgExprs) {
      const functionContext = context as FunctionGenerationContext;

      // Generate recur call with arguments and dup handling
      const argsList = runtimeArgExprs
        .map((arg) => {
          const argCode = generateExpr(arg, indent, context);

          // Handle deferred dup expressions for recur arguments
          if (
            arg.$?.deferredDupExpressions &&
            arg.$.deferredDupExpressions.length > 0
          ) {
            generateDeferredDupExpressions(arg, indent, functionContext);
            // Use the dup result variable instead of the original
            const dupExpr = arg.$.deferredDupExpressions[0]!;
            if (exprIsFunctionCall(dupExpr) && dupExpr.$?.variableName) {
              return getVariableNameForCodegen(
                dupExpr.$.variableName,
                dupExpr.$.env
              );
            }
          }

          return argCode;
        })
        .join(", ");
      return `${context.currentFunctionName}(${argsList})`;
    } else {
      return `// Error: No arguments for recur call ${exprToString(expr)}\n`;
    }
  }
  // sizeof
  else if (exprIsFunctionCallOf(expr, BuiltinFunctions.sizeof, 1)) {
    const arg = expr.args[0]!;
    const argCode = generateExpr(arg, indent, context);
    return `sizeof(${argCode})`; // Use sizeof operator on the argument
  }
  // __yo_decr_rc
  else if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_decr_rc)) {
    const arg = expr.args[0]!;
    const argCode = generateExpr(arg, indent, context);
    return `__yo_decr_rc(${argCode})`;
  }
  // Builtin Yo inline functions
  else if (exprIsFunctionCallOf(expr, BuiltinYoInlineFunctions)) {
    // NOTE: || expr.args is necessary to support function call like __yo_as(i, i32);
    const runtimeArgExprs = expr.$?.runtimeArgExprsInOrder || expr.args;
    if (runtimeArgExprs) {
      const functionContext = context as FunctionGenerationContext;

      const args = runtimeArgExprs.map((arg) => {
        const argCode = generateExpr(arg, indent, context);

        // Handle deferred dup expressions for inline function arguments
        if (
          arg.$?.deferredDupExpressions &&
          arg.$.deferredDupExpressions.length > 0
        ) {
          generateDeferredDupExpressions(arg, indent, functionContext);
          // Use the dup result variable instead of the original
          const dupExpr = arg.$.deferredDupExpressions[0]!;
          if (exprIsFunctionCall(dupExpr) && dupExpr.$?.variableName) {
            return getVariableNameForCodegen(
              dupExpr.$.variableName,
              dupExpr.$.env
            );
          }
        }

        return argCode;
      });

      return generateYoInlineFunctionCall(
        expr.func.token.value,
        args,
        expr,
        context
      );
    }
  }
  // while loop
  else if (exprIsFunctionCallOf(expr, BuiltinKeywords.while)) {
    return generateWhileLoop(expr, indent, context);
  }
  // anonymous function (fn(x) -> body)
  else if (
    exprIsFunctionCallOf(expr, "->", 2) &&
    exprIsFunctionCall(expr.args[0]) &&
    exprIsFunctionCallOf(expr.args[0], BuiltinKeywords.fn)
  ) {
    // Anonymous functions should have been evaluated and have a function value
    const functionValue = expr.$?.value;
    if (isFunctionValue(functionValue)) {
      return generateComptValue(functionValue, context);
    } else {
      return `// Error: Anonymous function missing function value`;
    }
  }
  // consume
  else if (exprIsFunctionCallOf(expr, BuiltinFunctions.consume)) {
    const argExpr = expr.args[0]!;
    const argCode = generateExpr(argExpr, indent, context);
    const argType = argExpr.$?.type;

    // Generate drop code for the consumed value
    // consume() marks the value as moved in the evaluator, so we must drop it in codegen
    if (argType && argCode) {
      const dropCode = generateDropCodeForValue(argCode, argType, context);
      if (dropCode) {
        const emitter = context.emitter;
        emitter.emitLine(`${indent}${dropCode};`);
      }
    }

    return argCode;
  }
  // functions that should be skipped
  // compt_expect_error
  else if (
    exprIsFunctionCallOf(expr, BuiltinFunctions.compt_expect_error) ||
    exprIsFunctionCallOf(expr, BuiltinFunctions.compt_assert) ||
    exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_var_print_info) ||
    exprIsFunctionCallOf(
      expr,
      BuiltinFunctions.__yo_var_is_owning_the_rc_value
    ) ||
    exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_var_has_other_aliases)
  ) {
    // no-op in C, just return empty string
    return "";
  }
  // open for runtime struct
  else if (exprIsFunctionCallOf(expr, BuiltinKeywords.open)) {
    // Check if this is a runtime struct destructuring
    if (
      expr.$?.runtimeDestructurings &&
      expr.$.runtimeDestructurings.length > 0
    ) {
      const argExpr = expr.args[0];
      if (!argExpr || !argExpr.$?.type) {
        return "// Error: open expression has no argument or type";
      }

      const argType = argExpr.$.type;
      const argValue = argExpr.$.value;

      // Only generate code for runtime struct values
      if (isStructType(argType) && argValue === undefined) {
        const structCode = generateExpr(argExpr, indent, context);
        const runtimeDestructurings = expr.$.runtimeDestructurings;

        // Generate local variable declarations for each field
        for (const destructuring of runtimeDestructurings) {
          const fieldType = getTypeString(destructuring.type, context);
          const varName = destructuring.variableName;
          const fieldLabel = sanitizeForCIdentifier(destructuring.label);

          // Generate: type varName = structCode.fieldLabel;
          context.emitter.emitLine(
            `${indent}${fieldType} ${varName} = ${structCode}.${fieldLabel};`
          );
        }
      }
    }
    return "";
  }
  // other function call
  else {
    const functionType = expr.func.$?.type;
    const functionValue = expr.func.$?.value;

    if (isFunctionType(functionType)) {
      const runtimeArgExprs = expr.$?.runtimeArgExprsInOrder;

      if (runtimeArgExprs) {
        // Check if this is a method call on a dyn object
        let isDynMethodCall = false;
        if (
          exprIsFunctionCall(expr.func) &&
          exprIsFunctionCallOf(expr.func, ".", 2)
        ) {
          const objectExpr = expr.func.args[0];
          const objectType = objectExpr?.$?.type;
          if (objectType && isDynType(objectType)) {
            isDynMethodCall = true;
          }
        }

        // Generate arg list with special handling for dyn method calls
        const args = runtimeArgExprs.map((arg, index) => {
          // First, check if this argument needs a temporary variable
          if (arg.$?.variableName && arg.$?.type) {
            const functionContext = context as FunctionGenerationContext;

            // Check if this variable is captured by a closure
            const isClosureCapturedVariable =
              functionContext.currentClosureCaptures &&
              functionContext.currentClosureCaptures.includes(
                arg.$.variableName
              ) &&
              exprIsAtom(arg) &&
              arg.$.env &&
              functionContext.currentClosureCaptureFrameLevel !== undefined &&
              checkVariableIsClosureCaptured(
                arg.token.value,
                arg.$.env,
                functionContext.currentClosureCaptureFrameLevel
              );

            // Generate the argument expression and declare it as a temp variable
            const argCode = generateExpr(arg, indent, context);

            // Check if this variable is captured by a state machine
            const isStateMachineCapturedVariable =
              functionContext.inStateMachine && argCode.startsWith("sm->");

            // Track whether we emitted a temp variable declaration
            let emittedTempVarDeclaration = false;

            if (
              argCode &&
              argCode !== arg.$.variableName &&
              !isClosureCapturedVariable &&
              !isStateMachineCapturedVariable
            ) {
              // Only emit declaration if:
              // 1. The expression doesn't already handle it
              // 2. It's not a closure-captured variable (those are accessed inline from closure_context->data)
              // 3. It's not a state machine variable (those are accessed via sm->var_xxx)
              // 4. It's not a redundant self-assignment (e.g., int32_t errno_ = errno_)
              const sanitizedVarName = getVariableNameForCodegen(
                arg.$.variableName,
                arg.$.env
              );
              if (argCode !== sanitizedVarName) {
                const varTypeAndName = getVariableTypeString(
                  arg.$.type,
                  arg.$.variableName,
                  context
                );
                context.emitter.emitLine(
                  `${indent}${varTypeAndName} = ${argCode};`
                );
                emittedTempVarDeclaration = true;
              }
            }

            // Handle deferred dup expressions for function arguments
            // After generating the argument temp variable, check if we need to dup it
            // Start with argCode (which may be aliased) instead of arg.$.variableName
            let finalArgVarName = emittedTempVarDeclaration
              ? arg.$.variableName
              : argCode;
            if (
              arg.$?.deferredDupExpressions &&
              arg.$.deferredDupExpressions.length > 0
            ) {
              // Only treat deferred dup as a replacement for the argument value
              // when it actually targets this argument. For example, closure
              // construction may carry deferred dups for captured variables; those
              // must be applied during capture initialization, not substituted as
              // the call argument.
              const argTargets = new Set<string>();
              if (arg.$?.variableName) {
                argTargets.add(
                  getVariableNameForCodegen(arg.$.variableName, arg.$.env)
                );
              }
              if (argCode) {
                argTargets.add(argCode);
              }
              if (exprIsAtom(arg)) {
                argTargets.add(
                  getVariableNameForCodegen(arg.token.value, arg.$.env)
                );
              }

              const matchingDupExpr = arg.$.deferredDupExpressions.find((e) => {
                const target = getDeferredDupTargetAtomName(e);
                if (!target) return false;
                return argTargets.has(
                  getVariableNameForCodegen(target, e.$?.env)
                );
              });

              if (matchingDupExpr) {
                generateDeferredDupExpressions(arg, indent, functionContext);
                if (
                  exprIsFunctionCall(matchingDupExpr) &&
                  matchingDupExpr.$?.variableName
                ) {
                  finalArgVarName = getVariableNameForCodegen(
                    matchingDupExpr.$.variableName,
                    matchingDupExpr.$.env
                  );
                }
              }
            }

            // For dyn method calls, transform the first argument (self) from dyn object to data pointer
            // EXCEPT for dyn object's own methods (which are in the dyn type's .trait)
            if (isDynMethodCall && index === 0) {
              // Check if this method exists in the dyn type's own trait
              if (
                exprIsFunctionCall(expr.func) &&
                exprIsFunctionCallOf(expr.func, ".", 2)
              ) {
                const objectExpr = expr.func.args[0];
                const dynType = objectExpr?.$?.type;
                const methodExpr = expr.func.args[1];

                if (exprIsAtom(methodExpr) && isDynType(dynType)) {
                  const methodName = methodExpr.token.value;
                  // Check if this method exists in the dyn type's trait
                  const dynMethod = dynType.trait.fields.find(
                    (field) => field.label === methodName
                  );

                  if (dynMethod) {
                    // This is a dyn object's own method, pass the dyn object directly
                    return sanitizeForCIdentifier(
                      finalArgVarName,
                      arg.$.type.isExtern === "c"
                    );
                  }
                }
              }

              // For all other methods (wrapped object methods), pass the wrapped object data
              // Dyn is a value type, but callers may pass a borrow (pointer) depending on the method signature.
              const argType = arg.$?.type;
              if (argType && isPtrType(argType)) {
                return `${sanitizeForCIdentifier(finalArgVarName, arg.$.type.isExtern === "c")}->data`;
              }
              return `(${sanitizeForCIdentifier(finalArgVarName, arg.$.type.isExtern === "c")}).data`;
            } else {
              // If this is a closure-captured variable, use the generated code (inline access)
              // If this is a state machine variable, use the generated code (sm->var_xxx access)
              // Otherwise use the sanitized variable name (potentially duped)
              return isClosureCapturedVariable || isStateMachineCapturedVariable
                ? argCode
                : sanitizeForCIdentifier(
                    finalArgVarName,
                    arg.$.type.isExtern === "c"
                  );
            }
          } else {
            // For dyn method calls, transform the first argument (self) from dyn object to data pointer
            // EXCEPT for dyn object's own methods (which are in the dyn type's .trait)
            if (isDynMethodCall && index === 0) {
              const dynObjectCode = generateExpr(arg, indent, context);

              // Check if this method exists in the dyn type's own trait
              if (
                exprIsFunctionCall(expr.func) &&
                exprIsFunctionCallOf(expr.func, ".", 2)
              ) {
                const objectExpr = expr.func.args[0];
                const dynType = objectExpr?.$?.type;
                const methodExpr = expr.func.args[1];

                if (exprIsAtom(methodExpr) && isDynType(dynType)) {
                  const methodName = methodExpr.token.value;
                  // Check if this method exists in the dyn type's trait
                  const dynMethod = dynType.trait.fields.find(
                    (field) => field.label === methodName
                  );

                  if (dynMethod) {
                    // This is a dyn object's own method, pass the dyn object directly
                    return dynObjectCode;
                  }
                }
              }

              // For all other methods (wrapped object methods), pass the wrapped object data
              const argType = arg.$?.type;
              if (argType && isPtrType(argType)) {
                return `(${dynObjectCode})->data`;
              }
              return `(${dynObjectCode}).data`;
            } else {
              return generateExpr(arg, indent, context);
            }
          }
        });
        const argsList = args.join(", ");

        // Check if this is an extern "yo" function - handle these first before regular function values
        if (functionType.isExtern === "yo" && functionType.externName) {
          const externFuncName = functionType.externName;

          if (BuiltinYoInlineFunctions.includes(externFuncName)) {
            return generateYoInlineFunctionCall(
              externFuncName,
              args,
              expr,
              context
            );
          } else if (externFuncName === "__yo_thread_spawn") {
            // Special handling for __yo_thread_spawn(cb : Impl(Fn() -> unit, Send))
            // We need to:
            // 1. Find the closure function from implClosureCallMap
            // 2. Heap-allocate the closure data (since thread needs it after function returns)
            // 3. Call __yo_thread_spawn(closure_fn, heap_closure_data)
            return generateThreadSpawnCall(expr, indent, context);
          } else if (externFuncName === "__yo_worker_spawn") {
            // Special handling for __yo_worker_spawn(cb : Impl(Fn() -> unit, Send))
            // Similar to __yo_thread_spawn but spawns on the worker pool
            return generateWorkerSpawnCall(expr, indent, context);
          } else if (isUnitType(functionType.return.type)) {
            // If the function returns unit, just call it without assignment
            context.emitter.emitLine(
              `${indent}${externFuncName}(${argsList});`
            );

            // Handle deferred drop expressions if they exist
            if (expr.$?.deferredDropExpressions) {
              generateDeferredDropExpressions(expr, indent, context);
            }

            return ""; // No return value
          } else {
            return `${externFuncName}(${argsList})`;
          }
        }

        if (isFunctionValue(functionValue)) {
          // Check if it's function vaue whose body only contains Yo operator
          const operatorFunctionName =
            isFunctionValueWithOnlyBuiltinYoInlineFunctionCall(functionValue);
          if (operatorFunctionName) {
            return generateYoInlineFunctionCall(
              operatorFunctionName,
              args,
              expr,
              context
            );
          }

          // Get new function type, which might be specialized.
          const functionType =
            functionValue.specializedType ?? functionValue.type;
          // Normal function call
          const cFuncName = context.functions[functionValue.funcId]?.cName;
          if (cFuncName) {
            // Generate function call
            if (isUnitType(functionType.return.type)) {
              // If the function returns unit, just call it without assignment
              context.emitter.emitLine(`${indent}${cFuncName}(${argsList});`);

              // Handle deferred drop expressions if they exist
              if (expr.$?.deferredDropExpressions) {
                generateDeferredDropExpressions(expr, indent, context);
              }

              return ""; // No return value
            } else {
              // If it returns a value, assign to a temp variable
              const tempVar = expr.$?.variableName;
              if (tempVar) {
                // For Impl(Future(...)), use the actual function return type to get the correct state machine type
                const returnType =
                  functionValue.specializedType?.return.type ??
                  functionType.return.type;
                const exprType = expr.$?.type;

                // Check if both types implement Future
                const exprIsFuture = exprType && typeImplementsFuture(exprType);
                const returnIsFuture =
                  returnType && typeImplementsFuture(returnType);

                let cTypeString: string;
                if (exprIsFuture && returnIsFuture) {
                  // For Future types, we need to get the correct state machine struct name
                  // The function's body should have an async block with the correct struct name
                  // The body might be wrapped in a begin() block, so we need to unwrap it
                  let funcBody = functionValue.body;

                  // If body is begin(async(...)), unwrap to get the async block
                  if (funcBody && exprIsFunctionCallOf(funcBody, "begin")) {
                    const beginArgs = (funcBody as FnCallExpr).args;
                    if (beginArgs.length > 0) {
                      const lastArg = beginArgs[beginArgs.length - 1]!;
                      if (
                        exprIsFunctionCallOf(lastArg, BuiltinFunctions.async)
                      ) {
                        funcBody = lastArg;
                      }
                    }
                  }

                  if (
                    funcBody &&
                    exprIsFunctionCallOf(funcBody, BuiltinFunctions.async) &&
                    funcBody.$?.asyncStateMachineStructName
                  ) {
                    // Use the async block's registered struct name directly
                    const asyncStructName =
                      funcBody.$.asyncStateMachineStructName;
                    cTypeString = `${asyncStructName}*`;

                    // Store the mapping for variable binding later
                    if (!context.tempVarAsyncStructNames) {
                      context.tempVarAsyncStructNames = new Map();
                    }
                    context.tempVarAsyncStructNames.set(
                      tempVar,
                      asyncStructName
                    );
                  } else {
                    // Fallback to getTypeString on return type
                    cTypeString = getTypeString(returnType, context);
                  }
                } else {
                  // cTypeString = getTypeString(exprType ?? returnType, context);
                  // Use returnType (from function signature) instead of exprType (from expression metadata)
                  // because exprType might have unresolved type parameters from nested generic calls
                  cTypeString = getTypeString(returnType ?? exprType, context);
                }

                context.emitter.emitLine(
                  `${indent}${cTypeString} ${tempVar} = ${cFuncName}(${argsList});`
                );

                // Handle deferred drop expressions if they exist
                if (expr.$?.deferredDropExpressions) {
                  generateDeferredDropExpressions(expr, indent, context);
                }

                return tempVar; // Return the temp variable name
              } else {
                // Error: regular function call returns non-unit type but no temp variable assigned
                return `// Error: Regular function call returns ${getTypeString(functionValue.specializedType?.return.type ?? functionType.return.type, context)} but no temp variable assigned`;
              }
            }
          }
        } else {
          const externFunction = context.externFunctions[functionType.id];
          if (externFunction) {
            // Generate regular extern function call
            const cFuncName = externFunction.cName;

            // Handle deferred drop expressions if they exist
            if (expr.$?.deferredDropExpressions) {
              generateDeferredDropExpressions(expr, indent, context);
            }

            return `${cFuncName}(${argsList})`;
          } else {
            // Function parameter call (e.g., callback(x))
            const funcCode = generateExpr(expr.func, indent, context);
            if (isUnitType(functionType.return.type)) {
              // If the function returns unit, just call it without assignment
              context.emitter.emitLine(`${indent}${funcCode}(${argsList});`);

              // Handle deferred drop expressions if they exist
              if (expr.$?.deferredDropExpressions) {
                generateDeferredDropExpressions(expr, indent, context);
              }

              return ""; // No return value
            } else {
              // If it returns a value, assign to a temp variable or return directly
              const tempVar = expr.$?.variableName;
              if (tempVar) {
                // For Impl(Future(...)), use the actual function return type to get the correct state machine type
                const returnType = functionType.return.type;
                const exprType = expr.$?.type;
                const typeToUse =
                  exprType &&
                  returnType &&
                  typeImplementsFuture(exprType) &&
                  typeImplementsFuture(returnType)
                    ? returnType // Use function's return type for correct state machine
                    : (exprType ?? returnType); // Otherwise use expr type or fallback to return type

                context.emitter.emitLine(
                  `${indent}${getTypeString(typeToUse, context)} ${tempVar} = ${funcCode}(${argsList});`
                );

                // Handle deferred drop expressions if they exist
                if (expr.$?.deferredDropExpressions) {
                  generateDeferredDropExpressions(expr, indent, context);
                }

                return tempVar; // Return the temp variable name
              } else {
                // Error: function parameter call returns non-unit type but no temp variable assigned
                return `// Error: Function parameter call returns ${getTypeString(functionType.return.type, context)} but no temp variable assigned`;
              }
            }
          }
        }
      }
    } else if (functionType && typeImplementsFn(functionType)) {
      const closureValueType = functionType;
      const fnModule = extractFnTraitFromType(closureValueType)!;
      // Check if this is a Dyn closure (uses vtable) or Impl closure (static dispatch)
      const isDynClosure = isDynType(closureValueType);
      {
        const callSig = fnModule.isFn.callType;
        // Handle closure calls with dynamic dispatch through vtable
        const runtimeArgExprs = expr.$?.runtimeArgExprsInOrder;

        if (runtimeArgExprs) {
          // First, handle arguments that need temporary variables
          const functionContext = context as FunctionGenerationContext;
          for (const arg of runtimeArgExprs) {
            if (arg.$?.variableName && arg.$?.type) {
              // Check if this variable is captured by a closure
              const isClosureCapturedVariable =
                functionContext.currentClosureCaptures &&
                functionContext.currentClosureCaptures.includes(
                  arg.$.variableName
                ) &&
                exprIsAtom(arg) &&
                arg.$.env &&
                functionContext.currentClosureCaptureFrameLevel !== undefined &&
                checkVariableIsClosureCaptured(
                  arg.token.value,
                  arg.$.env,
                  functionContext.currentClosureCaptureFrameLevel
                );

              // Generate the argument expression and declare it as a temp variable
              const argCode = generateExpr(arg, indent, context);

              // Check if this variable is captured by a state machine
              const isStateMachineCapturedVariable =
                functionContext.inStateMachine && argCode.startsWith("sm->");

              if (
                argCode &&
                argCode !== arg.$.variableName &&
                !isClosureCapturedVariable &&
                !isStateMachineCapturedVariable
              ) {
                // Only emit declaration if:
                // 1. The expression doesn't already handle it
                // 2. It's not a closure-captured variable (those are accessed inline from closure_context->data)
                // 3. It's not a state machine variable (those are accessed via sm->var_xxx)
                const varTypeAndName = getVariableTypeString(
                  arg.$.type,
                  arg.$.variableName,
                  context
                );
                context.emitter.emitLine(
                  `${indent}${varTypeAndName} = ${argCode};`
                );
              }
            }
          }

          // Generate closure value and function arguments
          const closureCode = generateExpr(expr.func, indent, context);
          const args = runtimeArgExprs.map((arg) => {
            if (arg.$?.variableName && arg.$?.type) {
              // Check if this is a closure-captured variable - if so, use the full access expression
              const isClosureCapturedVariable =
                functionContext.currentClosureCaptures &&
                functionContext.currentClosureCaptures.includes(
                  arg.$.variableName
                ) &&
                exprIsAtom(arg) &&
                arg.$.env &&
                functionContext.currentClosureCaptureFrameLevel !== undefined &&
                checkVariableIsClosureCaptured(
                  arg.token.value,
                  arg.$.env,
                  functionContext.currentClosureCaptureFrameLevel
                );

              if (isClosureCapturedVariable) {
                // Return the inline access expression
                return generateExpr(arg, indent, context);
              } else {
                // Check if this is a state machine variable
                const argCode = generateExpr(arg, indent, context);
                const isStateMachineCapturedVariable =
                  functionContext.inStateMachine && argCode.startsWith("sm->");

                // Handle deferred dup expressions for closure call arguments
                let finalArgVarName = arg.$.variableName;
                if (
                  arg.$?.deferredDupExpressions &&
                  arg.$.deferredDupExpressions.length > 0
                ) {
                  generateDeferredDupExpressions(arg, indent, functionContext);
                  // Use the dup result variable instead of the original
                  const dupExpr = arg.$.deferredDupExpressions[0]!;
                  if (exprIsFunctionCall(dupExpr) && dupExpr.$?.variableName) {
                    finalArgVarName = getVariableNameForCodegen(
                      dupExpr.$.variableName,
                      dupExpr.$.env
                    );
                  }
                }

                return isStateMachineCapturedVariable
                  ? argCode
                  : finalArgVarName;
              }
            } else {
              return generateExpr(arg, indent, context);
            }
          });

          // Dispatch:
          // - Dyn(Fn(...)) uses vtable: closure.vtable->call(closure.data, args...)
          // - Impl(Fn(...)) uses static dispatch: closure_impl(&closure, args...)
          let closureCall: string;
          if (isDynClosure) {
            const allArgs = [`(${closureCode}).data`, ...args];
            closureCall = `(${closureCode}).vtable->call(${allArgs.join(", ")})`;
          } else {
            // For Impl closures, the value is the concrete capture struct.
            // Find the corresponding generated implementation function.
            let concreteTypeId: string | undefined;
            if (closureValueType.tag === TypeTag.SomeType) {
              const someType = closureValueType as SomeType;
              if (someType.resolvedConcreteType) {
                concreteTypeId = someType.resolvedConcreteType.id;
              }
            }

            const mapped = concreteTypeId
              ? context.implClosureCallMap.get(concreteTypeId)
              : undefined;

            if (!mapped) {
              // Fallback to old representation if mapping is missing.
              const allArgs = [`(${closureCode}).data`, ...args];
              closureCall = `(${closureCode}).call(${allArgs.join(", ")})`;
            } else {
              const allArgs = [`&(${closureCode})`, ...args];
              closureCall = `${mapped.functionCName}(${allArgs.join(", ")})`;
            }
          }

          // Get return type from the closure's function signature
          const returnType = callSig.return.type;

          if (isUnitType(returnType)) {
            // If the closure returns unit, just call it without assignment
            context.emitter.emitLine(`${indent}${closureCall};`);

            // Handle deferred drop expressions if they exist
            if (expr.$?.deferredDropExpressions) {
              generateDeferredDropExpressions(expr, indent, context);
            }

            return ""; // No return value
          } else {
            // If it returns a value, assign to a temp variable or return directly
            const tempVar = expr.$?.variableName;
            if (tempVar) {
              context.emitter.emitLine(
                `${indent}${getTypeString(returnType, context)} ${tempVar} = ${closureCall};`
              );

              // Handle deferred drop expressions if they exist
              if (expr.$?.deferredDropExpressions) {
                generateDeferredDropExpressions(expr, indent, context);
              }

              return tempVar; // Return the temp variable name
            } else {
              // Error: closure returns non-unit type but no temp variable assigned
              return `// Error: Closure call returns ${getTypeString(returnType, context)} but no temp variable assigned`;
            }
          }
        } else {
          // Note: Closure construction is now handled in the isTypeValue(functionValue) branch below
          // by checking for expr.$?.closureFunctionValue
          return `// Error: No runtime args found for closure call`;
        }
      }
    } else if (isTypeValue(functionValue)) {
      // struct
      if (isStructType(functionValue.value)) {
        const structType = functionValue.value;
        const runtimeArgExprs = expr.$?.runtimeArgExprsInOrder;
        const cName = context.types[structType.id]?.cName;
        const labels = structType.fields.map((field) => field.label);
        const tempVar = expr.$?.variableName;

        if (
          runtimeArgExprs &&
          cName &&
          labels.length === runtimeArgExprs.length
        ) {
          // Handle newtype as zero-cost abstraction
          if (structType.isNewtype && structType.fields.length === 1) {
            // For newtype, just use the underlying value directly (with cast for type safety)
            const argCode = generateExpr(runtimeArgExprs[0]!, indent, context);
            const newtypeValue = `((${cName})(${argCode}))`;

            // If this newtype has a temporary variable name, declare it
            if (tempVar && expr.$?.type) {
              const varTypeAndName = getVariableTypeString(
                expr.$.type,
                tempVar,
                context
              );
              context.emitter.emitLine(
                `${indent}${varTypeAndName} = ${newtypeValue};`
              );
              return tempVar;
            } else {
              return newtypeValue;
            }
          }

          if (structType.isReferenceSemantics) {
            // For object, call the constructor function
            const functionContext = context as FunctionGenerationContext;

            const argsList = runtimeArgExprs
              .map((arg) => {
                const argCode = generateExpr(arg, indent, context);

                // Handle deferred dup expressions for constructor arguments
                if (
                  arg.$?.deferredDupExpressions &&
                  arg.$.deferredDupExpressions.length > 0
                ) {
                  // If the arg has a variable name but generateExpr didn't create a declaration,
                  // we need to create it now so the dup call can reference it
                  if (arg.$?.variableName && arg.$?.type) {
                    const argVarName = getVariableNameForCodegen(
                      arg.$.variableName,
                      arg.$.env
                    );
                    // Only emit the declaration if argCode is different from the variable name
                    // to avoid generating code like: prev_opt = prev_opt;
                    if (argCode !== argVarName) {
                      const argType = arg.$.type;
                      const argTypeStr = getTypeString(argType, context);
                      // Emit the variable declaration and assignment
                      context.emitter.emitLine(
                        `${indent}${argTypeStr} ${argVarName} = ${argCode};`
                      );
                    }
                  }

                  generateDeferredDupExpressions(arg, indent, functionContext);
                  // Use the dup result variable instead of the original
                  const dupExpr = arg.$.deferredDupExpressions[0]!;
                  if (exprIsFunctionCall(dupExpr) && dupExpr.$?.variableName) {
                    return getVariableNameForCodegen(
                      dupExpr.$.variableName,
                      dupExpr.$.env
                    );
                  }
                }

                return argCode;
              })
              .join(", ");

            const constructorName = `__yo_new_${cName}`;
            const structValue = `${constructorName}(${argsList})`;

            // If this struct has a temporary variable name, declare it
            if (tempVar && expr.$?.type) {
              const varTypeAndName = getVariableTypeString(
                expr.$.type,
                tempVar,
                context
              );
              context.emitter.emitLine(
                `${indent}${varTypeAndName} = ${structValue};`
              );
              return tempVar;
            } else {
              return structValue;
            }
          } else {
            // For regular struct, generate struct initialization as before
            const functionContext = context as FunctionGenerationContext;

            const argsList = runtimeArgExprs
              .map((arg, index) => {
                const argCode = generateExpr(arg, indent, context);
                // For tuples, always use numeric field names _0, _1, _2...
                // For regular structs, use the actual field labels
                const fieldName = isTupleType(structType)
                  ? `_${index}`
                  : sanitizeForCIdentifier(
                      labels[index]!,
                      structType.isExtern === "c"
                    );

                // Handle deferred dup expressions for struct fields
                let finalArgValue = argCode;
                if (
                  arg.$?.deferredDupExpressions &&
                  arg.$.deferredDupExpressions.length > 0
                ) {
                  // If the arg has a variable name but generateExpr didn't create a declaration,
                  // we need to create it now so the dup call can reference it
                  if (arg.$?.variableName && arg.$?.type) {
                    const argVarName = getVariableNameForCodegen(
                      arg.$.variableName,
                      arg.$.env
                    );
                    const argType = arg.$.type;
                    const argTypeStr = getTypeString(argType, context);
                    // Only emit the variable declaration if argCode is different from argVarName
                    // to prevent self-assignment like: var = var;
                    if (argCode !== argVarName) {
                      context.emitter.emitLine(
                        `${indent}${argTypeStr} ${argVarName} = ${argCode};`
                      );
                    }
                  }

                  generateDeferredDupExpressions(arg, indent, functionContext);
                  // Use the dup result variable instead of the original
                  const dupExpr = arg.$.deferredDupExpressions[0]!;
                  if (exprIsFunctionCall(dupExpr) && dupExpr.$?.variableName) {
                    finalArgValue = getVariableNameForCodegen(
                      dupExpr.$.variableName,
                      dupExpr.$.env
                    );
                  }
                }

                return `.${fieldName} = ` + finalArgValue;
              })
              .join(", ");
            const structValue = `(${cName}){ ${argsList} }`;

            // If this struct has a temporary variable name, declare it
            if (tempVar && expr.$?.type) {
              const varTypeAndName = getVariableTypeString(
                expr.$.type,
                tempVar,
                context
              );
              context.emitter.emitLine(
                `${indent}${varTypeAndName} = ${structValue};`
              );
              return tempVar;
            } else {
              return structValue;
            }
          }
        }
      }
      // closure type - closure construction
      // Note: This is now handled at the top of generateFuncCall by checking expr.$.closureFunctionValue
      else if (typeImplementsFn(functionValue.value)) {
        return `// Error: Closure construction should have been handled by closureFunctionValue check at top of generateFuncCall`;
      }
      // union
      // union is supposed to have only one member initialized
      else if (isUnionType(functionValue.value)) {
        const tempVar = expr.$?.variableName;
        const arg = expr.args[0]!;
        if (
          arg &&
          exprIsFunctionCall(arg) &&
          exprIsFunctionCallOf(arg, ":", 2)
        ) {
          const labelExpr = arg.args[0]!;
          const fieldExpr = arg.args[1]!;
          const cName = context.types[functionValue.value.id]?.cName;
          if (cName && exprIsAtom(labelExpr) && fieldExpr) {
            const functionContext = context as FunctionGenerationContext;
            const label = labelExpr.token.value;
            const sanitizedLabel = getVariableNameForCodegen(
              label,
              labelExpr.$?.env
            );
            const fieldCode = generateExpr(fieldExpr, indent, context);

            // Handle deferred dup expressions for union field
            let finalFieldValue = fieldCode;
            if (
              fieldExpr.$?.deferredDupExpressions &&
              fieldExpr.$.deferredDupExpressions.length > 0
            ) {
              generateDeferredDupExpressions(
                fieldExpr,
                indent,
                functionContext
              );
              // Use the dup result variable instead of the original
              const dupExpr = fieldExpr.$.deferredDupExpressions[0]!;
              if (exprIsFunctionCall(dupExpr) && dupExpr.$?.variableName) {
                finalFieldValue = getVariableNameForCodegen(
                  dupExpr.$.variableName,
                  dupExpr.$.env
                );
              }
            }

            const unionValue = `(${cName}){ .${sanitizedLabel} = ${finalFieldValue} }`;

            // If this union has a temporary variable name, declare it
            if (tempVar && expr.$?.type) {
              const varTypeAndName = getVariableTypeString(
                expr.$.type,
                tempVar,
                context
              );
              context.emitter.emitLine(
                `${indent}${varTypeAndName} = ${unionValue};`
              );
              return tempVar;
            } else {
              return unionValue;
            }
          }
        }
      }
      // enum
      else if (isEnumType(functionValue.value)) {
        const enumType = functionValue.value;
        const runtimeArgExprs = expr.$?.runtimeArgExprsInOrder;
        const cName = context.types[enumType.id]?.cName;
        const tempVar = expr.$?.variableName;

        if (enumType.selectedVariantName && runtimeArgExprs && cName) {
          // Check if this enum can be optimized as a nullable pointer
          const nullablePointerType = canOptimizeAsNullablePointer(enumType);
          if (nullablePointerType) {
            const variantName = enumType.selectedVariantName;
            const variant = enumType.variants.find(
              (v) => v.name === variantName
            );

            if (variant) {
              if (!variant.fields || variant.fields.length === 0) {
                // This is the "None" case - return NULL
                const enumValue = "NULL";
                if (tempVar && expr.$?.type) {
                  const varTypeAndName = getVariableTypeString(
                    expr.$.type,
                    tempVar,
                    context
                  );
                  context.emitter.emitLine(
                    `${indent}${varTypeAndName} = ${enumValue};`
                  );
                  return tempVar;
                } else {
                  return enumValue;
                }
              } else if (variant.fields.length === 1) {
                // This is the "Some" case - return the pointer value directly
                const pointerValue = generateExpr(
                  runtimeArgExprs[0]!,
                  indent,
                  context
                );
                if (tempVar && expr.$?.type) {
                  const varTypeAndName = getVariableTypeString(
                    expr.$.type,
                    tempVar,
                    context
                  );
                  context.emitter.emitLine(
                    `${indent}${varTypeAndName} = ${pointerValue};`
                  );
                  return tempVar;
                } else {
                  return pointerValue;
                }
              }
            }
          }

          // Check if this enum can be optimized as a simple C enum
          const simpleEnumOptimizable = canOptimizeAsSimpleEnum(enumType);
          if (simpleEnumOptimizable) {
            const variantName = enumType.selectedVariantName;
            // For simple enums, just return the enum constant
            const enumValue = getEnumVariantCName(
              enumType,
              variantName,
              context
            );
            if (tempVar && expr.$?.type) {
              const varTypeAndName = getVariableTypeString(
                expr.$.type,
                tempVar,
                context
              );
              context.emitter.emitLine(
                `${indent}${varTypeAndName} = ${enumValue};`
              );
              return tempVar;
            } else {
              return enumValue;
            }
          }

          // Generate enum initialization (fallback for non-optimized enums)
          const variantName = enumType.selectedVariantName;
          const variant = enumType.variants.find((v) => v.name === variantName);
          if (variant) {
            // Filter out unit type arguments - they don't need to be stored
            const nonUnitElements =
              variant.fields?.filter((field) => !isUnitType(field.type)) || [];

            const functionContext = context as FunctionGenerationContext;

            const argsList = runtimeArgExprs
              .map((arg, index) => {
                if (variant.fields) {
                  const field = variant.fields[index];
                  if (field && !isUnitType(field.type)) {
                    const argCode = generateExpr(arg, indent, context);
                    const sanitizedLabel = getVariableNameForCodegen(
                      field.label,
                      arg.$?.env
                    );

                    // Handle deferred dup expressions for enum variant fields
                    let finalArgValue = argCode;
                    if (
                      arg.$?.deferredDupExpressions &&
                      arg.$.deferredDupExpressions.length > 0
                    ) {
                      generateDeferredDupExpressions(
                        arg,
                        indent,
                        functionContext
                      );
                      // Use the dup result variable instead of the original
                      const dupExpr = arg.$.deferredDupExpressions[0]!;
                      if (
                        exprIsFunctionCall(dupExpr) &&
                        dupExpr.$?.variableName
                      ) {
                        finalArgValue = getVariableNameForCodegen(
                          dupExpr.$.variableName,
                          dupExpr.$.env
                        );
                      }
                    }

                    return `.${sanitizedLabel} = ` + finalArgValue;
                  }
                  return ""; // Skip if no field matches or if it's unit type
                } else {
                  return "";
                }
              })
              .filter((s) => s) // Remove empty strings
              .join(", ");

            // If there are no non-unit fields, we only need the tag
            const enumValue =
              nonUnitElements.length > 0
                ? `(${cName}){ .tag = ${getEnumVariantCName(enumType, variantName, context)}, .data = { .${variantName} = { ${argsList} } } }`
                : `(${cName}){ .tag = ${getEnumVariantCName(enumType, variantName, context)} }`;
            if (tempVar && expr.$?.type) {
              const varTypeAndName = getVariableTypeString(
                expr.$.type,
                tempVar,
                context
              );
              context.emitter.emitLine(
                `${indent}${varTypeAndName} = ${enumValue};`
              );
              return tempVar;
            } else {
              return enumValue;
            }
          }
        }
      }
    } else if (isArrayType(functionType)) {
      const firstArg = expr.args[0];

      // Check if this is a slicing operation: arr(start:end) or arr(:)
      if (
        firstArg &&
        exprIsFunctionCall(firstArg) &&
        exprIsFunctionCallOf(firstArg, ":")
      ) {
        // arr(start:end) -> create slice value
        const arrayCode = generateExpr(expr.func!, indent, context);
        const startCode = generateExpr(firstArg.args[0]!, indent, context);
        const endCode = generateExpr(firstArg.args[1]!, indent, context);

        const sliceTypeName = `Slice_${sanitizeForCIdentifier(getTypeString((functionType as ArrayType).childType, context))}`;
        // Register the slice type
        if (!context.sliceStructTypes.has(sliceTypeName)) {
          context.sliceStructTypes.set(sliceTypeName, {
            childType: getTypeString(
              (functionType as ArrayType).childType,
              context
            ),
          });
        }
        return `(${sliceTypeName}){ .data = &${arrayCode}.data[${startCode}], .length = (${endCode}) - (${startCode}) }`;
      } else if (
        firstArg &&
        exprIsAtom(firstArg) &&
        firstArg.token.value === ":"
      ) {
        // arr(:) -> create slice value for whole array
        const arrayCode = generateExpr(expr.func!, indent, context);
        const arrayType = functionType as ArrayType;
        const childType = arrayType.childType;

        const sliceTypeName = `Slice_${sanitizeForCIdentifier(getTypeString(childType, context))}`;
        // Register the slice type
        if (!context.sliceStructTypes.has(sliceTypeName)) {
          context.sliceStructTypes.set(sliceTypeName, {
            childType: getTypeString(childType, context),
          });
        }

        if (isNumberValue(arrayType.length)) {
          return `(${sliceTypeName}){ .data = &${arrayCode}.data[0], .length = ${arrayType.length.value} }`;
        } else {
          return `/* Error: Cannot slice array with non-compile-time length */`;
        }
      }

      // Array access by index: arr[index] or arr(index)
      const arrayCode = generateExpr(expr.func!, indent, context);
      const indexCode = generateExpr(firstArg!, indent, context);
      // Generate array access with struct wrapper
      return `${arrayCode}.data[${indexCode}]`; // Access the element at the index
    } else if (isSliceType(functionType)) {
      const firstArg = expr.args[0];

      // Check if this is a sub-slicing operation: slice(start:end) or slice(:)
      if (
        firstArg &&
        exprIsFunctionCall(firstArg) &&
        exprIsFunctionCallOf(firstArg, ":")
      ) {
        // slice(start:end) -> create sub-slice
        const sliceCode = generateExpr(expr.func!, indent, context);
        const startCode = generateExpr(firstArg.args[0]!, indent, context);
        const endCode = generateExpr(firstArg.args[1]!, indent, context);

        const sliceTypeName = `Slice_${sanitizeForCIdentifier(getTypeString((functionType as SliceType).childType, context))}`;
        // Register the slice type
        if (!context.sliceStructTypes.has(sliceTypeName)) {
          context.sliceStructTypes.set(sliceTypeName, {
            childType: getTypeString(
              (functionType as SliceType).childType,
              context
            ),
          });
        }
        return `(${sliceTypeName}){ .data = &${sliceCode}.data[${startCode}], .length = (${endCode}) - (${startCode}) }`;
      } else if (
        firstArg &&
        exprIsAtom(firstArg) &&
        firstArg.token.value === ":"
      ) {
        // slice(:) -> create slice copy of whole slice
        const sliceCode = generateExpr(expr.func!, indent, context);

        const sliceTypeName = `Slice_${sanitizeForCIdentifier(getTypeString((functionType as SliceType).childType, context))}`;
        // Register the slice type
        if (!context.sliceStructTypes.has(sliceTypeName)) {
          context.sliceStructTypes.set(sliceTypeName, {
            childType: getTypeString(
              (functionType as SliceType).childType,
              context
            ),
          });
        }
        return `(${sliceTypeName}){ .data = ${sliceCode}.data, .length = ${sliceCode}.length }`;
      }

      // Slice access by index: slice.data[index]
      const sliceCode = generateExpr(expr.func!, indent, context);
      const indexCode = generateExpr(firstArg!, indent, context);
      return `${sliceCode}.data[${indexCode}]`; // Access the element at the index in the slice
    } else if (
      functionType &&
      isPtrType(functionType) &&
      isSliceType(functionType.childType)
    ) {
      // This case should no longer exist since slices are no longer behind pointers
      // But keep it for backward compatibility during migration
      const sliceCode = generateExpr(expr.func!, indent, context);
      const indexCode = generateExpr(expr.args[0]!, indent, context);
      return `${sliceCode}.data[${indexCode}]`; // Access the element at the index in the slice
    }
  }

  if (exprIsFunctionCall(expr)) {
    throw new Error(`Unhandled function call: ${exprToString(expr)}`);
  }

  return `// Failed to transpile ${exprToString(expr)}`;
}

// Re-export drop/dup functions from drop_dup.ts
export {
  generateDropCodeForValue,
  generateDupCodeForValue,
  getDropFunctionForType,
  getDupFunctionForType,
} from "./drop_dup";

export {
  generateThreadSpawnCall,
  generateWorkerSpawnCall,
} from "./parallelism";

// Import for internal use
import {
  generateDropCodeForValue,
  generateDupCodeForValue,
  getDropFunctionForType,
  getDupFunctionForType,
} from "./drop_dup";

import {
  generateThreadSpawnCall,
  generateWorkerSpawnCall,
} from "./parallelism";

import { generateAsyncBlock } from "./async";
import { generateAtom } from "./atom";
import { generateComptValue } from "./compt_value";
import { generateDynCall } from "./dyn";

/**
 * Generate field access for structs, unions, and enums - extracted from original codegen-c.ts
 */
function generateFieldAccess(
  expr: FnCallExpr,
  indent: string,
  context: CodeGenContext
): string {
  if (expr.args.length !== 2) {
    return "/* ERROR: field access requires exactly 2 arguments */";
  }

  const objectExpr = expr.args[0];
  const fieldExpr = expr.args[1];

  if (!objectExpr || !fieldExpr) {
    return "/* ERROR: invalid field access arguments */";
  }

  const objectCode = generateExpr(objectExpr, indent, context);
  const objectType = objectExpr.$?.type;
  const objectValue = objectExpr.$?.value;

  if (exprIsAtom(fieldExpr)) {
    const fieldName = fieldExpr.token.value;

    // Check if this field access is actually a method access (function from type's trait or nested traits)
    // This includes both direct type methods and methods from nested traits
    if (expr.$?.value && isFunctionValue(expr.$.value)) {
      const functionValue = expr.$.value;
      const cFunctionName =
        context.functions[functionValue.funcId]?.cName || functionValue.funcId;
      return cFunctionName;
    }

    // Fallback: Check if this is an Rc method call (___drop, ___dup, ___dispose)
    // Sometimes, we only called addRcFunctionSignaturesToStructType / addRcFunctionSignaturesToEnumType
    // So they are using the `undefined` function value, before we actually update its trait fields.
    if (
      !expr.$?.value &&
      (BuiltinFunctions.___dispose.includes(fieldName) ||
        BuiltinFunctions.___drop.includes(fieldName) ||
        BuiltinFunctions.___dup.includes(fieldName)) &&
      objectType
    ) {
      // For Rc methods, we need to look up the function from the type's trait
      // and return the function name directly instead of treating it as field access
      let typeTrait: TraitType | null = null;

      if (isStructType(objectType)) {
        typeTrait = objectType.trait;
      } else if (isEnumType(objectType)) {
        typeTrait = objectType.trait;
      }

      if (typeTrait) {
        // Find the function in the type's trait
        const functionElement = typeTrait.fields.find(
          (field) =>
            field.label === fieldName &&
            field.assignedValue &&
            isFunctionValue(field.assignedValue)
        );

        if (functionElement && isFunctionValue(functionElement.assignedValue)) {
          const functionValue = functionElement.assignedValue;
          const cFunctionName =
            context.functions[functionValue.funcId]?.cName ||
            functionValue.funcId;
          return cFunctionName;
        } else {
          return `/* ERROR: Rc method ${fieldName} not found in type module */`;
        }
      } else {
        return `/* ERROR: No module found for Rc method ${fieldName} */`;
      }
    }

    // Handle newtype field access - just return the object itself (zero-cost abstraction)
    if (isNewtypeType(objectType) && objectType.fields.length === 1) {
      // For newtype, accessing the single field just returns the value itself
      // since newtype is typedef'd to the underlying type
      const singleField = objectType.fields[0];
      if (singleField && singleField.label === fieldName) {
        return objectCode;
      }
    }

    // Check if the object is an enum type
    if (isEnumType(objectType)) {
      const enumType = objectType;

      // Check if this enum is optimized as a nullable pointer
      const nullablePointerType = canOptimizeAsNullablePointer(enumType);
      if (nullablePointerType) {
        // For optimized nullable pointer enums, direct field access should be simplified
        // ptr.value becomes ptr (since ptr is already the pointer)
        // NOTE: No need to check fieldName, as the nullablePointerType always only has one field
        // if (fieldName === "value") {
        return objectCode; // Return the pointer directly
        // }
      }

      // For enum field access, we need to determine which variant contains this field
      // and generate the appropriate path: object.data.VariantName.fieldName
      for (const variant of enumType.variants) {
        if (variant.fields) {
          for (const field of variant.fields) {
            if (field.label === fieldName) {
              // Found the field in this variant
              const variantName = variant.name;
              return `${objectCode}.data.${variantName}.${sanitizeForCIdentifier(fieldName)}`;
            }
          }
        }
      }

      return `/* ERROR: field ${fieldName} not found in enum ${enumType.typeName} */`;
    } else if (isTypeValue(objectValue) && isEnumType(objectValue.value)) {
      const enumType = objectValue.value;
      const variant = enumType.variants.find((v) => v.name === fieldName);
      const cName = context.types[enumType.id]?.cName;

      // Accessing variant that has no fields.
      // Like: Color.Red
      if (!!variant && !variant.fields && cName) {
        const tagName = getEnumVariantCName(enumType, variant.name, context);
        return `(${cName}){ .tag = ${tagName}, .data = {  } }`;
      }
    }
    // Check if the object is pointer or reference
    else if (isPtrType(objectType)) {
      if (fieldName === "*") {
        // Regular dereference for pointers/references
        // Ensure proper parenthesization: (*ptr) not *(ptr)
        return `(*${objectCode})`; // Dereference the pointer/reference
      }
      // Special handling for slice types: pointer-to-slice field access
      // (but not dereference which was already handled above)
      else if (isSliceType(objectType.childType)) {
        // For pointer-to-slice, use arrow notation for field access
        return `${objectCode}->${sanitizeForCIdentifier(fieldName)}`;
      } else {
        // Dereference until not a pointer/reference
        let dereferenceLevel = 0;
        let currentType: Type = objectType;
        while (isPtrType(currentType)) {
          dereferenceLevel++;
          currentType = currentType.childType;
        }

        // IMPORTANT: For reference-semantics types (objects), the type is already a pointer in C.
        // So *(MyBox) in Yo becomes MyBox** in C, which requires 2 dereferences, not 1.
        // We need to add an extra dereference level for reference-semantics types.
        if (
          dereferenceLevel > 0 &&
          isStructType(currentType) &&
          currentType.isReferenceSemantics
        ) {
          dereferenceLevel++;
        }

        // Check if the dereferenced type is a newtype accessing its single field
        if (isNewtypeType(currentType) && currentType.fields.length === 1) {
          const singleField = currentType.fields[0];
          if (singleField && singleField.label === fieldName) {
            // For newtype, accessing the single field through a pointer just dereferences the pointer
            // since newtype is typedef'd to the underlying type
            if (dereferenceLevel === 1) {
              return `(*${objectCode})`;
            } else {
              return `${"*".repeat(dereferenceLevel)}(${objectCode})`;
            }
          }
        }

        if (dereferenceLevel > 0) {
          // For pointer types, use arrow notation for field access
          if (dereferenceLevel === 1) {
            return `${objectCode}->${sanitizeForCIdentifier(fieldName)}`;
          } else {
            // Multiple levels of dereference: (*ptr)->field for ptr**
            // Need to parenthesize the dereferenced expression to get correct precedence
            const dereferencedObjectCode = `(${"*".repeat(dereferenceLevel - 1)}${objectCode})`;
            return `${dereferencedObjectCode}->${sanitizeForCIdentifier(fieldName)}`;
          }
        } else {
          // If no dereferencing is needed, just access the field
          return `${objectCode}.${sanitizeForCIdentifier(fieldName)}`;
        }
      }
    }
    // For tuple type, we need to convert the field to index
    else if (isTupleType(objectType)) {
      if (fieldName.match(/^\d+$/)) {
        return `${objectCode}._${fieldName}`;
      } else {
        const index = objectType.fields.findIndex(
          (field) => field.label === fieldName
        );
        return `${objectCode}._${index}`;
      }
    }
    // Handle dynamic dispatch method access
    else if (isDynType(objectType)) {
      // For dyn types, access methods through vtable
      // e.g. s.speak becomes s.vtable->speak (Dyn is value type, vtable is pointer)
      return `${objectCode}.vtable->${sanitizeForCIdentifier(fieldName)}`;
    } else {
      // For C structs and unions, access fields directly
      // Check if this is a reference-counted type (object)
      if (isObjectType(objectType)) {
        // For ref types (pointers), access field directly: ptr->field
        return `${objectCode}->${sanitizeForCIdentifier(fieldName)}`;
      } else {
        // For regular structs/enums, access fields directly
        return `${objectCode}.${sanitizeForCIdentifier(fieldName)}`;
      }
    }
  }

  return "/* ERROR: field name must be an identifier */";
}

/**
 * Generate a conditional expression (cond) as a value expression - extracted from original codegen-c.ts
 */
function generateCondExpression(
  expr: FnCallExpr,
  indent: string,
  context: CodeGenContext
): string {
  // Check if the cond expression has been evaluated and has a variable name
  if (expr.$) {
    const tempVar = expr.$.variableName;
    const valueType = expr.$.type;
    const isUnit = valueType && isUnitType(valueType);

    // For unit types, don't declare a temporary variable
    if (!isUnit && tempVar) {
      const varType = getTypeString(valueType, context);
      context.emitter.emitLine(`${indent}${varType} ${tempVar};`);
    }

    // Generate if-else chain for each condition => value pair
    // Strategy:
    // - If all conditions before a compile-time true are compile-time false, just generate the value directly
    // - Otherwise: First condition becomes `if (...) {}`, all subsequent become nested in a single `else { ... }`

    // First pass: check if we can optimize to direct value generation
    let firstNonFalseBranchIndex = -1;
    for (let i = 0; i < expr.args.length; i++) {
      const arg = expr.args[i];
      if (exprIsFunctionCall(arg) && exprIsFunctionCallOf(arg, "=>", 2)) {
        const condition = arg.args[0];
        if (condition) {
          const isFalse =
            isBooleanValue(condition.$?.value) &&
            condition.$.value.value === false;
          if (!isFalse) {
            firstNonFalseBranchIndex = i;
            break;
          }
        }
      }
    }

    // Check if the first non-false branch is a compile-time true
    let canOptimizeToDirect = false;
    if (firstNonFalseBranchIndex >= 0) {
      const firstArg = expr.args[firstNonFalseBranchIndex];
      if (
        firstArg &&
        exprIsFunctionCall(firstArg) &&
        exprIsFunctionCallOf(firstArg, "=>", 2)
      ) {
        const firstCondition = firstArg.args[0];
        if (
          firstCondition &&
          isBooleanValue(firstCondition.$?.value) &&
          firstCondition.$.value.value === true
        ) {
          canOptimizeToDirect = true;
        }
      }
    }

    // If we can optimize to direct generation, just generate the value expression
    if (canOptimizeToDirect && firstNonFalseBranchIndex >= 0) {
      const arg = expr.args[firstNonFalseBranchIndex];
      if (
        arg &&
        exprIsFunctionCall(arg) &&
        exprIsFunctionCallOf(arg, "=>", 2)
      ) {
        const value = arg.args[1];
        if (value) {
          // Generate the value expression directly
          const valueCode = generateExpr(value, indent, context);

          // Check if we need to assign to temp variable
          if (tempVar && !isUnit) {
            if (
              valueCode &&
              valueCode !== "" &&
              !valueCode.startsWith("goto") &&
              valueCode !== "continue" &&
              valueCode !== "break" &&
              !valueCode.includes("return")
            ) {
              context.emitter.emitLine(`${indent}${tempVar} = ${valueCode};`);
            }
            // For goto, continue, break, return statements, emit them directly
            else if (
              valueCode &&
              (valueCode.startsWith("goto") ||
                valueCode === "continue" ||
                valueCode === "break" ||
                valueCode.includes("return"))
            ) {
              context.emitter.emitLine(`${indent}${valueCode};`);
            }
          }
        }
      }

      // For unit types, return empty string; for others, return temp variable
      return isUnit ? "" : (tempVar ?? "");
    }

    // Otherwise, generate full if-else chain
    let currentIndent = indent;
    let elseBlockDepth = 0; // Track how many else blocks we need to close at the end
    let hasEmittedBranch = false; // Track whether we've emitted any branch (not skipped)

    for (let i = 0; i < expr.args.length; i++) {
      const arg = expr.args[i];
      if (exprIsFunctionCall(arg) && exprIsFunctionCallOf(arg, "=>", 2)) {
        // This is a condition => value pair
        const condition = arg.args[0];
        const value = arg.args[1];

        if (condition && value) {
          // Skip compile-time false conditions
          if (
            isBooleanValue(condition.$?.value) &&
            condition.$.value.value === false
          ) {
            continue;
          }

          // For the first EMITTED branch, generate `if (...) {}` or just `{}`
          if (!hasEmittedBranch) {
            if (
              isBooleanValue(condition.$?.value) &&
              condition.$.value.value === true
            ) {
              // Compile-time true as first condition - just use a block
              context.emitter.emitLine(`${currentIndent}{`);
            } else {
              // Regular condition
              const conditionCode = generateExpr(
                condition,
                currentIndent,
                context
              );
              context.emitter.emitLine(
                `${currentIndent}if (${conditionCode}) {`
              );
            }
            hasEmittedBranch = true;
          } else {
            // For subsequent conditions, wrap in `else {` and increment depth
            context.emitter.emitLine(`${currentIndent}else {`);
            elseBlockDepth++;
            currentIndent += "  ";

            const isCompileTimeTrue =
              isBooleanValue(condition.$?.value) &&
              condition.$.value.value === true;

            if (isCompileTimeTrue) {
              // Compile-time true - no condition needed, value goes directly in the else block
              // We'll close the else block at the end, not here
            } else {
              // Regular condition - generate if inside the else block
              const conditionCode = generateExpr(
                condition,
                currentIndent,
                context
              );
              context.emitter.emitLine(
                `${currentIndent}if (${conditionCode}) {`
              );
            }
          }

          // Determine the indent for the value block
          const isCompileTimeTrue =
            isBooleanValue(condition.$?.value) &&
            condition.$.value.value === true;

          // For compile-time true in else block (not first branch), don't add extra indentation
          const valueIndent =
            hasEmittedBranch && isCompileTimeTrue
              ? currentIndent
              : currentIndent + "  ";

          // Handle begin blocks specially in conditional expressions
          if (
            exprIsFunctionCall(value) &&
            exprIsFunctionCallOf(value, BuiltinKeywords.begin)
          ) {
            // For begin blocks in conditionals, we need to generate the statements inline
            // like generateLoopBody but also capture the final expression result

            const beginArgs = value.args;

            // Generate each statement except the last one
            for (let j = 0; j < beginArgs.length - 1; j++) {
              const arg = beginArgs[j]!;
              const argCode = generateExpr(arg, valueIndent, context);
              // Skip temp variable references
              if (
                argCode &&
                arg.$ &&
                !isTempVariableName(arg.$.env.modulePath, argCode)
              ) {
                context.emitter.emitLine(`${valueIndent}${argCode};`);
              }
            }

            // Generate the final expression and assign it to temp variable
            if (beginArgs.length > 0) {
              const finalExpr = beginArgs[beginArgs.length - 1]!;
              // Generate deferred dup expressions for the final expression (e.g., returning a borrowed value)
              if (finalExpr.$?.deferredDupExpressions) {
                generateDeferredDupExpressions(
                  finalExpr,
                  valueIndent,
                  context as FunctionGenerationContext
                );
              }
              const finalExprCode = generateExpr(
                finalExpr,
                valueIndent,
                context
              );

              if (finalExprCode) {
                // Check if this is a control flow statement
                if (
                  finalExprCode === "continue" ||
                  finalExprCode === "break" ||
                  finalExprCode.startsWith("goto") ||
                  (exprIsFunctionCall(finalExpr) &&
                    exprIsFunctionCallOf(finalExpr, BuiltinKeywords.return)) ||
                  finalExprCode.includes("return")
                ) {
                  // For control flow statements, emit them directly without assignment
                  context.emitter.emitLine(`${valueIndent}${finalExprCode};`);
                } else if (tempVar && !isUnit) {
                  context.emitter.emitLine(
                    `${valueIndent}${tempVar} = ${finalExprCode};`
                  );
                }
              }
            }

            // Generate deferred drop expressions for the begin block
            if (value.$?.deferredDropExpressions) {
              generateDeferredDropExpressions(value, valueIndent, context);
            }
          } else {
            // Generate deferred dup expressions for non-begin value expressions
            if (value.$?.deferredDupExpressions) {
              generateDeferredDupExpressions(
                value,
                valueIndent,
                context as FunctionGenerationContext
              );
            }
            // Generate the value expression INSIDE the conditional block
            const valueCode = generateExpr(value, valueIndent, context);

            // Check if this is a control flow statement or unit expression
            if (
              valueCode === "continue" ||
              valueCode === "break" ||
              valueCode.startsWith("goto") ||
              (exprIsFunctionCall(value) &&
                exprIsFunctionCallOf(value, BuiltinKeywords.return)) ||
              valueCode.includes("return")
            ) {
              // For control flow statements, emit them directly without assignment
              context.emitter.emitLine(`${valueIndent}${valueCode};`);
            } else if (valueCode === "" || !valueCode) {
              // For unit expressions, don't emit anything
            } else if (tempVar) {
              // For regular expressions, assign to temp variable (only if not unit type)
              if (!isUnit) {
                context.emitter.emitLine(
                  `${valueIndent}${tempVar} = ${valueCode};`
                );
              }
            }
          }

          // Close the if/block for this condition
          // For compile-time true in an else block, we don't close anything here (the else block closes at the end)
          // For all other cases, close the if block or the initial block
          const needsClosing = !(hasEmittedBranch && isCompileTimeTrue);
          if (needsClosing) {
            context.emitter.emitLine(`${currentIndent}}`);
          }
        }
      }
    }

    // Close all the else blocks we opened
    for (let i = 0; i < elseBlockDepth; i++) {
      currentIndent = currentIndent.slice(0, -2); // Remove 2 spaces
      context.emitter.emitLine(`${currentIndent}}`);
    }

    // For unit types, return empty string; for others, return temp variable
    return isUnit ? "" : (tempVar ?? "");
  }

  // Fallback for non-evaluated expressions
  return '/* "cond" expression is not evaluated */';
}

/**
 * Generate a match expression as a value (C switch statement) - extracted from original codegen-c.ts
 */
function generateMatchExpression(
  expr: FnCallExpr,
  indent: string,
  context: CodeGenContext
): string {
  if (!expr.$) {
    return `/* "match" expression is not evaluated */`;
  }
  const tempVariableName = expr.$.variableName;
  const valueType = expr.$.type;
  const isUnit = valueType && isUnitType(valueType);

  // Create temp variable declaration
  if (!isUnit && tempVariableName) {
    const varType = getTypeString(valueType, context);
    context.emitter.emitLine(`${indent}${varType} ${tempVariableName};`);
  }

  // Generate the matched value
  const matchedValueCode = generateExpr(expr.args[0]!, indent, context);
  const matchValueType = expr.args[0]!.$?.type;
  if (!matchValueType) {
    return `// Error: "match" expression requires an enum type`;
  }

  // Check if it's a pointer/reference type OR reference semantics type
  // If yes, then automatically dereference one-level of it.
  let ptrOrRefType: TypeTag.Ptr | "ref_semantics" | undefined = undefined;

  let enumType: Type;
  if (isPtrType(matchValueType)) {
    enumType = matchValueType.childType;
    ptrOrRefType = matchValueType.tag;
  } else if (isObjectType(matchValueType)) {
    // ref enum types are represented as pointers in C
    enumType = matchValueType;
    ptrOrRefType = "ref_semantics";
  } else {
    enumType = matchValueType;
  }

  if (!isEnumType(enumType)) {
    return `// Error: "match" expression requires an enum type`;
  }
  const enumCName = context.types[enumType.id]?.cName;
  if (!enumCName) {
    return `// Error: "match" expression enum type ${enumType.typeName} has no C name`;
  }

  // Check if this enum is optimized as a nullable pointer
  const nullablePointerType = canOptimizeAsNullablePointer(enumType);
  if (nullablePointerType) {
    // Generate optimized nullable pointer matching using if/else instead of switch
    const caseExprs = expr.args.slice(1);

    // Find which variant is the null case and which is the pointer case
    let nullCase: { caseBody: Expr } | null = null;
    let pointerCase: {
      caseBody: Expr;
      variantName: string;
      casePattern: Expr;
    } | null = null;

    for (const caseExpr of caseExprs) {
      if (
        exprIsFunctionCall(caseExpr) &&
        exprIsFunctionCallOf(caseExpr, "=>", 2)
      ) {
        const caseValue = caseExpr.args[0]!; // .None, .Some(ptr)
        const caseBody = caseExpr.args[1]!;

        if (
          caseValue &&
          caseBody &&
          exprIsFunctionCall(caseValue) &&
          exprIsFunctionCallOf(caseValue, ".") // Destructuring pattern like .None
        ) {
          nullCase = { caseBody };
        } else {
          // Destructuring pattern like .Some(value)
          // Handle destructuring pattern
          const variantExpr = (caseValue as FnCallExpr).func;
          // Check if variant is a field access like .Some
          if (
            variantExpr &&
            exprIsFunctionCall(variantExpr) &&
            exprIsFunctionCallOf(variantExpr, ".")
          ) {
            const variantNameExpr = variantExpr.args[0]!;
            if (variantNameExpr && exprIsAtom(variantNameExpr)) {
              const variantName = variantNameExpr.token.value;
              pointerCase = {
                caseBody,
                variantName,
                casePattern: caseValue,
              };
            }
          }
        }
      }
    }

    // Generate the optimized if/else structure
    context.emitter.emitLine(
      `${indent}if (${ptrOrRefType && ptrOrRefType !== "ref_semantics" ? "*" : ""}${matchedValueCode} != NULL) {`
    );

    if (pointerCase) {
      // For nullable pointer optimization with destructuring pattern like .Some(value),
      // we need to bind the destructured variable to the pointer value
      let destructuredVarName: string | undefined;
      if (
        exprIsFunctionCall(pointerCase.casePattern) &&
        pointerCase.casePattern.args.length > 0
      ) {
        // Destructuring pattern: .Some(value)
        const destructuredVar = pointerCase.casePattern.args[0];
        if (destructuredVar && exprIsAtom(destructuredVar)) {
          destructuredVarName = destructuredVar.token.value;
          const varType = nullablePointerType;
          // Declare and bind the destructured variable to the pointer
          context.emitter.emitLine(
            `${indent}  ${getTypeString(varType, context)} ${destructuredVarName} = ${matchedValueCode};`
          );
        }
      }

      // Add destructured variable to localShadowedVariables so it uses the local C var
      const functionContext = context as FunctionGenerationContext;
      if (destructuredVarName && functionContext.inStateMachine) {
        if (!functionContext.localShadowedVariables) {
          functionContext.localShadowedVariables = new Set();
        }
        functionContext.localShadowedVariables.add(destructuredVarName);
      }

      const bodyCode = generateCaseBody(
        pointerCase.caseBody,
        indent + "  ",
        context
      );

      // Remove destructured variable from localShadowedVariables after generating body
      if (destructuredVarName && functionContext.localShadowedVariables) {
        functionContext.localShadowedVariables.delete(destructuredVarName);
      }

      // Check if body has control flow (return, break, continue) - don't assign temp in that case
      const hasControlFlow =
        bodyCode === "" ||
        bodyCode === "break" ||
        bodyCode === "continue" ||
        bodyCode.includes("return");
      if (!isUnit && tempVariableName && !hasControlFlow) {
        // For nullable pointer match, the body returns the actual value
        // If bodyCode is empty or just returns the matched value itself, use the matched value
        const resultCode = bodyCode || matchedValueCode;
        context.emitter.emitLine(
          `${indent}  ${tempVariableName} = ${resultCode};`
        );
      } else if (bodyCode && bodyCode !== "") {
        context.emitter.emitLine(`${indent}  ${bodyCode};`);
      }
    }

    context.emitter.emitLine(`${indent}} else {`);

    if (nullCase) {
      const bodyCode = generateCaseBody(
        nullCase.caseBody,
        indent + "  ",
        context
      );
      // Check if body has control flow (return, break, continue) - don't assign temp in that case
      const hasControlFlow =
        bodyCode === "" ||
        bodyCode === "break" ||
        bodyCode === "continue" ||
        bodyCode.includes("return");
      if (!isUnit && tempVariableName && !hasControlFlow) {
        context.emitter.emitLine(
          `${indent}  ${tempVariableName} = ${bodyCode};`
        );
      } else if (bodyCode && bodyCode !== "") {
        context.emitter.emitLine(`${indent}  ${bodyCode};`);
      }
    }

    context.emitter.emitLine(`${indent}}`);
    return isUnit ? "" : (tempVariableName ?? "");
  }

  // Check if this enum can be optimized as a simple C enum
  const simpleEnumOptimizable = canOptimizeAsSimpleEnum(enumType);
  if (simpleEnumOptimizable) {
    // Generate optimized simple enum matching
    context.emitter.emitLine(
      `${indent}switch (${ptrOrRefType && ptrOrRefType !== "ref_semantics" ? "*" : ""}${matchedValueCode}) {`
    );

    const caseExprs = expr.args.slice(1);
    for (let i = 0; i < caseExprs.length; i++) {
      const caseExpr = caseExprs[i];
      if (
        exprIsFunctionCall(caseExpr) &&
        exprIsFunctionCallOf(caseExpr, "=>", 2)
      ) {
        // This is a case => value pair
        const caseValue = caseExpr.args[0];
        const caseBody = caseExpr.args[1];

        if (
          caseValue &&
          caseBody &&
          exprIsFunctionCall(caseValue) &&
          exprIsFunctionCallOf(caseValue, ".", 1)
        ) {
          const variantName = caseValue.args[0]!.token.value;
          const variantTag = getEnumVariantCName(
            enumType,
            variantName,
            context
          );

          // Generate the case label
          context.emitter.emitLine(`${indent}case ${variantTag}:`);

          // Generate the body of the case
          const bodyCode = generateCaseBody(caseBody, indent + "  ", context);
          if (!isUnit && tempVariableName && bodyCode) {
            context.emitter.emitLine(
              `${indent}  ${tempVariableName} = ${bodyCode};`
            );
          } else if (bodyCode) {
            context.emitter.emitLine(`${indent}  ${bodyCode};`);
          }

          // Check if we need to break out of the loop instead of just the switch
          if (context.currentLoopLabel && caseBody.$?.controlFlow === "break") {
            context.emitter.emitLine(
              `${indent}  goto ${context.currentLoopLabel};`
            );
          } else if (caseBody.$?.controlFlow === "continue") {
            // For continue, we need to break out of the switch first
            context.emitter.emitLine(`${indent}  break;`);
            // Then add a goto to the continue label (if it exists for 3-argument while loops)
            if (context.currentContinueLabel) {
              context.emitter.emitLine(
                `${indent}  goto ${context.currentContinueLabel};`
              );
            }
          } else {
            context.emitter.emitLine(`${indent}  break;`);
          }
        }
      }
    }

    context.emitter.emitLine(`${indent}}`);
    return isUnit ? "" : (tempVariableName ?? "");
  }

  // Original tagged union matching
  context.emitter.emitLine(
    `${indent}switch (${ptrOrRefType === "ref_semantics" || ptrOrRefType ? matchedValueCode + "->tag" : "(" + matchedValueCode + ").tag"}) {`
  );

  const caseExprs = expr.args.slice(1);
  for (let i = 0; i < caseExprs.length; i++) {
    const caseExpr = caseExprs[i];
    if (
      exprIsFunctionCall(caseExpr) &&
      exprIsFunctionCallOf(caseExpr, "=>", 2)
    ) {
      // This is a case => value pair
      const caseValue = caseExpr.args[0];
      let caseBody = caseExpr.args[1];

      if (
        caseValue &&
        caseBody &&
        // caseValue now has to be a variant:
        exprIsFunctionCall(caseValue) &&
        caseValue.func.tag === ExprTag.Atom &&
        caseValue.func.token.value === "." &&
        caseValue.args.length >= 1 // Allow 1 or more arguments for destructuring
      ) {
        const variantName = caseValue.args[0]!.token.value; // Get the variant name
        const variantTag = getEnumVariantCName(enumType, variantName, context);

        // Generate the case label
        context.emitter.emitLine(`${indent}case ${variantTag}:`);

        // Handle destructuring patterns like .Point(point) => { ... }
        if (caseValue.args.length > 1) {
          // This is a destructuring pattern
          const variant = enumType.variants.find((v) => v.name === variantName);
          if (variant && variant.fields) {
            // Get destructuring params (skip the variant name at index 0)
            const destructuringParams = caseValue.args.slice(1);

            // Check if we have labeled destructuring
            const hasLabeledParams = destructuringParams.some(
              (param) =>
                exprIsFunctionCall(param) && exprIsFunctionCallOf(param, ":", 2)
            );

            if (hasLabeledParams) {
              // Handle labeled destructuring like .Circle(r : radius)
              for (const param of destructuringParams) {
                if (
                  exprIsFunctionCall(param) &&
                  exprIsFunctionCallOf(param, ":", 2)
                ) {
                  const labelExpr = param.args[0]!;
                  const variableExpr = param.args[1]!;

                  if (!exprIsAtom(labelExpr)) {
                    continue;
                  }

                  const label = labelExpr.token.value;

                  // Find the field with matching label
                  const variantElement = variant.fields.find(
                    (f) => f.label === label
                  );
                  if (!variantElement) {
                    continue;
                  }

                  // Skip unit type fields - they don't exist in the generated struct
                  if (isUnitType(variantElement.type)) {
                    continue;
                  }

                  // Handle the variable part (could be identifier or _)
                  if (exprIsAtom(variableExpr)) {
                    const varName = variableExpr.token.value;

                    // Skip if variable name is "_" (ignore pattern)
                    if (varName !== "_") {
                      const fieldName = sanitizeForCIdentifier(label);
                      const fieldType = getTypeString(
                        variantElement.type,
                        context
                      );

                      // Generate variable declaration and assignment
                      const accessPrefix =
                        ptrOrRefType === "ref_semantics" || ptrOrRefType
                          ? "->"
                          : ".";
                      context.emitter.emitLine(
                        `${indent}  /* MARKER: Generating labeled destructured variable ${varName} from field ${label} */`
                      );
                      context.emitter.emitLine(
                        `${indent}  ${fieldType} ${varName} = ${matchedValueCode}${accessPrefix}data.${variantName}.${fieldName};`
                      );

                      // Check if this variable needs to be stored in the state machine
                      const functionContext =
                        context as FunctionGenerationContext;
                      if (
                        functionContext?.inStateMachine &&
                        functionContext.stateMachineVariables
                      ) {
                        let varId: string | undefined;

                        if (variableExpr.$?.env) {
                          const vars = getVariablesFromEnv(
                            variableExpr.$.env,
                            varName
                          );
                          if (vars.length > 0) {
                            varId = vars[vars.length - 1]!.id;
                          }
                        }

                        if (
                          varId &&
                          functionContext.stateMachineVariables.has(varId)
                        ) {
                          context.emitter.emitLine(
                            `${indent}  sm->var_${varId} = ${varName};`
                          );
                        }
                      }
                    }
                  }
                }
              }
            } else {
              // Handle positional destructuring
              // Generate local variable declarations for destructured fields
              for (
                let fieldIndex = 0;
                fieldIndex < destructuringParams.length &&
                fieldIndex < variant.fields.length;
                fieldIndex++
              ) {
                const destructuredVar = destructuringParams[fieldIndex]!;
                const variantElement = variant.fields[fieldIndex];

                if (exprIsAtom(destructuredVar) && variantElement) {
                  // Skip unit type fields - they don't exist in the generated struct
                  if (isUnitType(variantElement.type)) {
                    continue;
                  }

                  const varName = destructuredVar.token.value;

                  // Skip if variable name is "_" (ignore pattern)
                  if (varName !== "_") {
                    const fieldName = sanitizeForCIdentifier(
                      variantElement.label
                    );
                    const fieldType = getTypeString(
                      variantElement.type,
                      context
                    );

                    // Generate variable declaration and assignment
                    const accessPrefix =
                      ptrOrRefType === "ref_semantics" || ptrOrRefType
                        ? "->"
                        : ".";
                    context.emitter.emitLine(
                      `${indent}  /* MARKER: Generating destructured variable ${varName} */`
                    );
                    context.emitter.emitLine(
                      `${indent}  ${fieldType} ${varName} = ${matchedValueCode}${accessPrefix}data.${variantName}.${fieldName};`
                    );
                    // Check if this variable needs to be stored in the state machine
                    // For async contexts, pattern-matched variables that are used across await points
                    // need to be stored in the state machine structure
                    const functionContext =
                      context as FunctionGenerationContext;
                    if (
                      functionContext?.inStateMachine &&
                      functionContext.stateMachineVariables
                    ) {
                      // Find the variable ID by searching through state machine variables
                      // The state machine tracks variables by their ID
                      let varId: string | undefined;

                      // Try to get ID from expr metadata if available
                      // if (destructuredVar.$?.id) {
                      //   varId = destructuredVar.$.id;
                      // } else
                      if (destructuredVar.$?.env) {
                        // Try to look up in environment
                        const vars = getVariablesFromEnv(
                          destructuredVar.$.env,
                          varName
                        );
                        if (vars.length > 0) {
                          varId = vars[vars.length - 1]!.id;
                        }
                      }

                      if (
                        varId &&
                        functionContext.stateMachineVariables.has(varId)
                      ) {
                        // This variable crosses an await boundary, store it in state machine
                        context.emitter.emitLine(
                          `${indent}  sm->var_${varId} = ${varName};`
                        );
                      }
                    }
                  }
                }
              }
            }
          }
        }

        if (
          exprIsFunctionCall(caseBody) &&
          exprIsFunctionCallOf(caseBody, "=>", 2)
        ) {
          const renameExpr = caseBody.args[0]!;
          context.emitter.emitLine(
            `${indent}  ${getTypeString(matchValueType, context)} ${renameExpr.token.value} = ${matchedValueCode};`
          );

          caseBody = caseBody.args[1]!; // Get the value part of the case
        }

        // Generate the body of the case
        const bodyCode = generateCaseBody(caseBody, indent + "  ", context);
        if (!isUnit && tempVariableName && bodyCode) {
          context.emitter.emitLine(
            `${indent}  ${tempVariableName} = ${bodyCode};`
          );
        } else if (bodyCode) {
          context.emitter.emitLine(`${indent}  ${bodyCode};`);
        }

        // Check if we need to break out of the loop instead of just the switch
        if (context.currentLoopLabel && caseBody.$?.controlFlow === "break") {
          context.emitter.emitLine(
            `${indent}  goto ${context.currentLoopLabel};`
          );
        } else if (caseBody.$?.controlFlow === "continue") {
          context.emitter.emitLine(`${indent}  break;`);
          if (context.currentContinueLabel) {
            context.emitter.emitLine(
              `${indent}  goto ${context.currentContinueLabel};`
            );
          }
        } else {
          context.emitter.emitLine(`${indent}  break;`);
        }
      }
      // Handle destructuring patterns like .Point(point) => { ... }
      else if (
        caseValue &&
        caseBody &&
        exprIsFunctionCall(caseValue) &&
        exprIsFunctionCall(caseValue.func) &&
        caseValue.func.func.tag === ExprTag.Atom &&
        caseValue.func.func.token.value === "." &&
        caseValue.func.args.length === 1
      ) {
        // Extract variant name from .Point(point) pattern
        const variantName = caseValue.func.args[0]!.token.value;
        const variantTag = getEnumVariantCName(enumType, variantName, context);
        const destructuringParams = caseValue.args;

        // Generate the case label
        context.emitter.emitLine(`${indent}case ${variantTag}:`);

        // Generate local variable declarations for destructured fields
        const variant = enumType.variants.find((v) => v.name === variantName);
        if (variant && variant.fields && destructuringParams.length > 0) {
          // Check if we have labeled destructuring
          const hasLabeledParams = destructuringParams.some(
            (param) =>
              exprIsFunctionCall(param) && exprIsFunctionCallOf(param, ":", 2)
          );

          if (hasLabeledParams) {
            // Handle labeled destructuring like .Circle(r : radius)
            for (const param of destructuringParams) {
              if (
                exprIsFunctionCall(param) &&
                exprIsFunctionCallOf(param, ":", 2)
              ) {
                const labelExpr = param.args[0]!;
                const variableExpr = param.args[1]!;

                if (!exprIsAtom(labelExpr)) {
                  continue;
                }

                const label = labelExpr.token.value;

                // Find the field with matching label
                const variantElement = variant.fields.find(
                  (f) => f.label === label
                );
                if (!variantElement) {
                  continue;
                }

                // Handle the variable part (could be identifier or _)
                if (exprIsAtom(variableExpr)) {
                  const varName = variableExpr.token.value;

                  // Skip if variable name is "_" (ignore pattern)
                  if (varName !== "_") {
                    if (isUnitType(variantElement.type)) {
                      context.emitter.emitLine(
                        `${indent}  // ${varName} is unit type (no value)`
                      );
                    } else {
                      const fieldName = sanitizeForCIdentifier(label);
                      const fieldType = getTypeString(
                        variantElement.type,
                        context
                      );

                      // Generate variable declaration and assignment
                      const accessPrefix =
                        ptrOrRefType === "ref_semantics" || ptrOrRefType
                          ? "->"
                          : ".";
                      context.emitter.emitLine(
                        `${indent}  ${fieldType} ${varName} = ${matchedValueCode}${accessPrefix}data.${variantName}.${fieldName};`
                      );

                      // Check if this variable needs to be stored in the state machine
                      const functionContext =
                        context as FunctionGenerationContext;
                      if (
                        functionContext?.inStateMachine &&
                        functionContext.stateMachineVariables
                      ) {
                        let varId: string | undefined;

                        if (variableExpr.$?.env) {
                          const vars = getVariablesFromEnv(
                            variableExpr.$.env,
                            varName
                          );
                          if (vars.length > 0) {
                            varId = vars[vars.length - 1]!.id;
                          }
                        }

                        if (
                          varId &&
                          functionContext.stateMachineVariables.has(varId)
                        ) {
                          context.emitter.emitLine(
                            `${indent}  sm->var_${varId} = ${varName};`
                          );
                        }
                      }
                    }
                  }
                }
              }
            }
          } else {
            // Handle positional destructuring like .Circle(radius)
            for (
              let fieldIndex = 0;
              fieldIndex <
              Math.min(destructuringParams.length, variant.fields.length);
              fieldIndex++
            ) {
              const destructuredVar = destructuringParams[fieldIndex]!;
              const variantElement = variant.fields[fieldIndex];

              if (destructuredVar.tag === ExprTag.Atom && variantElement) {
                const varName = destructuredVar.token.value;

                // Skip if variable name is "_" (ignore pattern)
                if (varName !== "_") {
                  // For unit type fields, generate a comment instead of a variable
                  // This allows the variable name to be "declared" without generating invalid C
                  if (isUnitType(variantElement.type)) {
                    context.emitter.emitLine(
                      `${indent}  // ${varName} is unit type (no value)`
                    );
                    // Register this as a unit variable so expression generation can handle it
                    // (Expression generation should skip generating references to unit variables)
                  } else {
                    const fieldName = sanitizeForCIdentifier(
                      variantElement.label
                    );
                    const fieldType = getTypeString(
                      variantElement.type,
                      context
                    );

                    // Generate variable declaration and assignment
                    const accessPrefix =
                      ptrOrRefType === "ref_semantics" || ptrOrRefType
                        ? "->"
                        : ".";
                    context.emitter.emitLine(
                      `${indent}  ${fieldType} ${varName} = ${matchedValueCode}${accessPrefix}data.${variantName}.${fieldName};`
                    );

                    // Check if this variable needs to be stored in the state machine
                    const functionContext =
                      context as FunctionGenerationContext;
                    if (
                      functionContext?.inStateMachine &&
                      functionContext.stateMachineVariables
                    ) {
                      let varId: string | undefined;

                      // if (destructuredVar.$?.id) {
                      //   varId = destructuredVar.$.id;
                      // } else
                      if (destructuredVar.$?.env) {
                        const vars = getVariablesFromEnv(
                          destructuredVar.$.env,
                          varName
                        );
                        if (vars.length > 0) {
                          varId = vars[vars.length - 1]!.id;
                        }
                      }

                      if (
                        varId &&
                        functionContext.stateMachineVariables.has(varId)
                      ) {
                        // This variable crosses an await boundary, store it in state machine
                        context.emitter.emitLine(
                          `${indent}  sm->var_${varId} = ${varName};`
                        );
                      }
                    }
                  }
                }
              }
            }
          }
        }

        if (
          exprIsFunctionCall(caseBody) &&
          exprIsFunctionCallOf(caseBody, "=>", 2)
        ) {
          const renameExpr = caseBody.args[0]!;
          context.emitter.emitLine(
            `${indent}  ${getTypeString(matchValueType, context)} ${renameExpr.token.value} = ${matchedValueCode};`
          );

          caseBody = caseBody.args[1]!; // Get the value part of the case
        }

        // Generate the body of the case
        const bodyCode = generateCaseBody(caseBody, indent + "  ", context);
        if (!isUnit && tempVariableName && bodyCode) {
          context.emitter.emitLine(
            `${indent}  ${tempVariableName} = ${bodyCode};`
          );
        } else if (bodyCode) {
          context.emitter.emitLine(`${indent}  ${bodyCode};`);
        }

        // Check if we need to break out of the loop instead of just the switch
        if (context.currentLoopLabel && caseBody.$?.controlFlow === "break") {
          context.emitter.emitLine(
            `${indent}  goto ${context.currentLoopLabel};`
          );
        } else if (caseBody.$?.controlFlow === "continue") {
          context.emitter.emitLine(`${indent}  break;`);
          if (context.currentContinueLabel) {
            context.emitter.emitLine(
              `${indent}  goto ${context.currentContinueLabel};`
            );
          }
        } else {
          context.emitter.emitLine(`${indent}  break;`);
        }
      }
    }
  }

  context.emitter.emitLine(`${indent}}`);

  // Generate deferred drop expressions for the match expression after the switch closes
  // This ensures owned variables (like the matched enum) are cleaned up
  if (expr.$?.deferredDropExpressions) {
    generateDeferredDropExpressions(expr, indent, context);
  }

  return isUnit ? "" : (tempVariableName ?? ""); // Return the temp variable name
}

/**
 * Generate a return statement for a function body expression - extracted from original codegen-c.ts
 */
export function generateReturnStatement(
  expr: Expr,
  indent: string,
  context: CodeGenContext
): void {
  switch (expr.tag) {
    case ExprTag.Atom: {
      // Use generateExpressionAsCode to handle compile-time values
      let atomCode = generateAtom(expr, context);

      // Handle deferred dup expressions for atoms (borrowed parameters that need to be duped before returning)
      if (
        expr.$?.deferredDupExpressions &&
        expr.$.deferredDupExpressions.length > 0
      ) {
        generateDeferredDupExpressions(
          expr,
          indent,
          context as FunctionGenerationContext
        );
        // Use the duped value's variable name instead of the original
        const dupExpr = expr.$.deferredDupExpressions[0]!;
        if (exprIsFunctionCall(dupExpr) && dupExpr.$?.variableName) {
          atomCode = getVariableNameForCodegen(
            dupExpr.$.variableName,
            dupExpr.$.env
          );
        }
      }

      context.emitter.emitLine(`${indent}return ${atomCode};`);
      break;
    }
    case ExprTag.FnCall: {
      // Handle deferred dup expressions for function calls (e.g., field access that needs duping)
      if (
        expr.$?.deferredDupExpressions &&
        expr.$.deferredDupExpressions.length > 0
      ) {
        // Check if expr has a variableName for storing the intermediate value
        if (expr.$?.variableName) {
          // Generate the expression value without the variableName to get the raw expression
          const savedVariableName = expr.$.variableName;
          expr.$.variableName = undefined;
          const rawCode = generateFuncCall(expr, indent, context);
          expr.$.variableName = savedVariableName;

          // Declare and assign the temp variable
          const exprType = getTypeString(expr.$.type!, context);
          const exprTempVar = sanitizeForCIdentifier(savedVariableName);
          if (exprTempVar !== rawCode) {
            context.emitter.emitLine(
              `${indent}${exprType} ${exprTempVar} = ${rawCode};`
            );
          }
        } else {
          // No temp variable name, just generate the expression
          const rawCode = generateFuncCall(expr, indent, context);
          context.emitter.emitLine(`${indent}${rawCode};`);
        }

        // Generate the deferred dup expressions
        generateDeferredDupExpressions(
          expr,
          indent,
          context as FunctionGenerationContext
        );

        // Use the duped value's variable name for the return
        const dupExpr = expr.$.deferredDupExpressions[0]!;
        if (exprIsFunctionCall(dupExpr) && dupExpr.$?.variableName) {
          const dupedValue = getVariableNameForCodegen(
            dupExpr.$.variableName,
            dupExpr.$.env
          );
          context.emitter.emitLine(`${indent}return ${dupedValue};`);
        } else {
          // Fallback: return the raw code
          const funcCallCode = generateFuncCall(expr, indent, context);
          context.emitter.emitLine(`${indent}return ${funcCallCode};`);
        }
      } else {
        // No deferred dup expressions, generate normally
        const funcCallCode = generateFuncCall(expr, indent, context);
        if (!exprIsFunctionCallOf(expr, BuiltinKeywords.return)) {
          context.emitter.emitLine(`${indent}return ${funcCallCode};`);
        } else {
          context.emitter.emitLine(`${indent}${funcCallCode};`);
        }
      }
      break;
    }
  }
}

/**
 * Generate Yo operator function call - extracted from original codegen-c.ts
 */
function generateYoInlineFunctionCall(
  functionName: string,
  args: string[],
  expr: FnCallExpr,
  context: CodeGenContext
): string {
  // +
  if (BuiltinFunctions.__yo_op_add.includes(functionName)) {
    return `((${args[0]!}) + (${args[1]!}))`;
  }
  // -
  else if (BuiltinFunctions.__yo_op_sub.includes(functionName)) {
    return `((${args[0]!}) - (${args[1]!}))`;
  }
  // *
  else if (BuiltinFunctions.__yo_op_mul.includes(functionName)) {
    return `((${args[0]!}) * (${args[1]!}))`;
  }
  // /
  else if (BuiltinFunctions.__yo_op_div.includes(functionName)) {
    return `((${args[0]!}) / (${args[1]!}))`;
  }
  // %
  else if (BuiltinFunctions.__yo_op_mod.includes(functionName)) {
    return `((${args[0]!}) % (${args[1]!}))`;
  }
  // neg -
  else if (BuiltinFunctions.__yo_op_neg.includes(functionName)) {
    return `(-(${args[0]!}))`;
  }
  // ==
  else if (BuiltinFunctions.__yo_op_eq.includes(functionName)) {
    return `((${args[0]!}) == (${args[1]!}))`;
  }
  // !=
  else if (BuiltinFunctions.__yo_op_neq.includes(functionName)) {
    return `((${args[0]!}) != (${args[1]!}))`;
  }
  // <
  else if (BuiltinFunctions.__yo_op_lt.includes(functionName)) {
    return `((${args[0]!}) < (${args[1]!}))`;
  }
  // <=
  else if (BuiltinFunctions.__yo_op_lte.includes(functionName)) {
    return `((${args[0]!}) <= (${args[1]!}))`;
  }
  // >
  else if (BuiltinFunctions.__yo_op_gt.includes(functionName)) {
    return `((${args[0]!}) > (${args[1]!}))`;
  }
  // >=
  else if (BuiltinFunctions.__yo_op_gte.includes(functionName)) {
    return `((${args[0]!}) >= (${args[1]!}))`;
  }
  // !
  else if (BuiltinFunctions.__yo_op_not.includes(functionName)) {
    return `(!(${args[0]!}))`;
  }
  // &
  else if (BuiltinFunctions.__yo_op_bit_and.includes(functionName)) {
    return `((${args[0]!}) & (${args[1]!}))`;
  }
  // |
  else if (BuiltinFunctions.__yo_op_bit_or.includes(functionName)) {
    return `((${args[0]!}) | (${args[1]!}))`;
  }
  // ^
  else if (BuiltinFunctions.__yo_op_bit_xor.includes(functionName)) {
    return `((${args[0]!}) ^ (${args[1]!}))`;
  }
  // ~
  else if (BuiltinFunctions.__yo_op_bit_complement.includes(functionName)) {
    return `(~(${args[0]!}))`;
  }
  // <<
  else if (BuiltinFunctions.__yo_op_bit_left_shift.includes(functionName)) {
    return `((${args[0]!}) << (${args[1]!}))`;
  }
  // >>
  else if (BuiltinFunctions.__yo_op_bit_right_shift.includes(functionName)) {
    return `((${args[0]!}) >> (${args[1]!}))`;
  }
  // __yo_noop
  else if (BuiltinFunctions.__yo_noop.includes(functionName)) {
    return "";
  }
  // __yo_return_self
  else if (BuiltinFunctions.__yo_return_self.includes(functionName)) {
    // This is a special case where we just return the first argument
    return `(*${args[0]!})`;
  }
  // __yo_ms_sleep
  else if (BuiltinFunctions.__yo_ms_sleep.includes(functionName)) {
    // Cross-platform sleep - takes milliseconds
    // Windows Sleep takes milliseconds, usleep takes microseconds
    return `(
#ifdef _WIN32
Sleep(${args[0]!})
#else
usleep((${args[0]!}) * 1000)
#endif
)`;
  }
  // __yo_decr_rc
  else if (BuiltinFunctions.__yo_decr_rc.includes(functionName)) {
    return `__yo_decr_rc((void*)(${args[0]!}))`;
  }
  // __yo_as - generic type casting for primitives and pointers
  else if (BuiltinFunctions.__yo_as.includes(functionName) && expr.$?.type) {
    // The return type tells us what to cast to
    const targetCType = getTypeString(expr.$.type, context);
    return `((${targetCType})(${args[0]!}))`;
  }
  // __yo_ptr_add
  else if (BuiltinFunctions.__yo_ptr_add.includes(functionName)) {
    return `(${args[0]!} + ${args[1]!})`;
  }
  // __yo_ptr_sub
  else if (BuiltinFunctions.__yo_ptr_sub.includes(functionName)) {
    return `(${args[0]!} - ${args[1]!})`;
  }
  // __yo_ptr_diff
  else if (BuiltinFunctions.__yo_ptr_diff.includes(functionName)) {
    return `(${args[0]!} - ${args[1]!})`;
  }
  // __yo_ptr_eq
  else if (BuiltinFunctions.__yo_ptr_eq.includes(functionName)) {
    return `(${args[0]!} == ${args[1]!})`;
  }
  // __yo_ptr_neq
  else if (BuiltinFunctions.__yo_ptr_neq.includes(functionName)) {
    return `(${args[0]!} != ${args[1]!})`;
  }
  // __yo_ptr_lt
  else if (BuiltinFunctions.__yo_ptr_lt.includes(functionName)) {
    return `(${args[0]!} < ${args[1]!})`;
  }
  // __yo_ptr_lte
  else if (BuiltinFunctions.__yo_ptr_lte.includes(functionName)) {
    return `(${args[0]!} <= ${args[1]!})`;
  }
  // __yo_ptr_gt
  else if (BuiltinFunctions.__yo_ptr_gt.includes(functionName)) {
    return `(${args[0]!} > ${args[1]!})`;
  }
  // __yo_ptr_gte
  else if (BuiltinFunctions.__yo_ptr_gte.includes(functionName)) {
    return `(${args[0]!} >= ${args[1]!})`;
  }
  // __yo_slice_len - access the length field of a slice fat pointer
  else if (BuiltinFunctions.__yo_slice_len.includes(functionName)) {
    return `(${args[0]!}.length)`;
  }
  // Handle other operators that are not defined in Yo
  else {
    return `/* Unhandled operator ${functionName} */`;
  }
}

/**
 * Generate step expression for for loop increment section.
 * This generates the step expression inline without emitting it as a statement.
 */
function generateStepExpression(
  stepExpr: Expr,
  context: CodeGenContext
): string {
  // Handle begin blocks specially for multiple step expressions
  if (
    exprIsFunctionCall(stepExpr) &&
    exprIsFunctionCallOf(stepExpr, BuiltinKeywords.begin)
  ) {
    // Extract all assignment expressions from the begin block
    const assignments: string[] = [];

    for (const arg of stepExpr.args) {
      if (exprIsFunctionCall(arg) && exprIsFunctionCallOf(arg, "=", 2)) {
        const lhs = arg.args[0]!;
        const rhs = arg.args[1]!;

        const lhsCode = generateExpr(lhs, "", context);
        const rhsCode = generateExpr(rhs, "", context);

        assignments.push(`${lhsCode} = ${rhsCode}`);
      }
    }

    // Join multiple assignments with comma operator
    return assignments.join(", ");
  }
  // Handle single assignment expressions
  else if (
    exprIsFunctionCall(stepExpr) &&
    exprIsFunctionCallOf(stepExpr, "=", 2)
  ) {
    const lhs = stepExpr.args[0]!;
    const rhs = stepExpr.args[1]!;

    // For step expressions, we want inline assignment like "i = i + 1"
    const lhsCode = generateExpr(lhs, "", context);
    const rhsCode = generateExpr(rhs, "", context);

    return `${lhsCode} = ${rhsCode}`;
  }

  // For other expressions, just generate normally
  return generateExpr(stepExpr, "", context);
}

/**
 * Generate body statements for loop bodies.
 * This handles begin blocks by extracting their statements without the surrounding braces.
 */
function generateLoopBody(
  bodyExpr: Expr,
  indent: string,
  context: CodeGenContext
): void {
  // Handle begin blocks specially for loop bodies
  if (
    exprIsFunctionCall(bodyExpr) &&
    exprIsFunctionCallOf(bodyExpr, BuiltinKeywords.begin)
  ) {
    // Generate each statement in the begin block directly
    for (const arg of bodyExpr.args) {
      const argCode = generateExpr(arg, indent, context);
      if (argCode) {
        context.emitter.emitLine(`${indent}${argCode};`);
      }
    }

    // Generate deferred drop expressions before end of loop body
    if (bodyExpr.$?.deferredDropExpressions) {
      for (const dropExpr of bodyExpr.$.deferredDropExpressions) {
        const dropCode = generateExpr(dropExpr, indent, context);
        if (dropCode) {
          context.emitter.emitLine(`${indent}${dropCode};`);
        }
      }
    }
  } else {
    // For non-begin expressions, generate normally
    const bodyCode = generateExpr(bodyExpr, indent, context);
    if (bodyCode) {
      context.emitter.emitLine(`${indent}${bodyCode};`);
    }
  }
}

/**
 * Generate case body for match/cond expressions, handling begin blocks specially
 * Returns the body code string for assignment to temp variable
 */
function generateCaseBody(
  bodyExpr: Expr,
  indent: string,
  context: CodeGenContext
): string {
  // Handle begin blocks specially
  if (
    exprIsFunctionCall(bodyExpr) &&
    exprIsFunctionCallOf(bodyExpr, BuiltinKeywords.begin)
  ) {
    const beginArgs = bodyExpr.args;

    // Generate each statement except the last one
    for (let j = 0; j < beginArgs.length - 1; j++) {
      const arg = beginArgs[j]!;
      const argCode = generateExpr(arg, indent, context);
      if (argCode) {
        context.emitter.emitLine(`${indent}${argCode};`);
      }
    }

    // Get the final expression code for return/assignment
    let finalExprCode = "";
    if (beginArgs.length > 0) {
      const finalExpr = beginArgs[beginArgs.length - 1]!;
      // Generate deferred dup expressions for the final expression (e.g., returning a borrowed value)
      if (
        finalExpr.$?.deferredDupExpressions &&
        finalExpr.$.deferredDupExpressions.length > 0
      ) {
        generateDeferredDupExpressions(
          finalExpr,
          indent,
          context as FunctionGenerationContext
        );
        // Use the duped value's variable name instead of the original expression
        const dupExpr = finalExpr.$.deferredDupExpressions[0]!;
        if (exprIsFunctionCall(dupExpr) && dupExpr.$?.variableName) {
          finalExprCode = getVariableNameForCodegen(
            dupExpr.$.variableName,
            dupExpr.$.env
          );
        } else {
          finalExprCode = generateExpr(finalExpr, indent, context);
        }
      } else {
        finalExprCode = generateExpr(finalExpr, indent, context);
      }
    }

    // Generate deferred drop expressions for the begin block
    if (bodyExpr.$?.deferredDropExpressions) {
      generateDeferredDropExpressions(bodyExpr, indent, context);
    }

    return finalExprCode;
  } else {
    // For non-begin expressions, check for deferred dup expressions
    if (bodyExpr.$?.deferredDupExpressions) {
      generateDeferredDupExpressions(
        bodyExpr,
        indent,
        context as FunctionGenerationContext
      );
    }
    return generateExpr(bodyExpr, indent, context);
  }
}

/**
 * Generate C code for while loop expression
 * Supports both while(condition, body) and while(condition, step, body) forms
 * The 3-argument form is transpiled to a C for loop, 2-argument form to a C while loop
 */
function generateWhileLoop(
  expr: FnCallExpr,
  indent: string,
  context: CodeGenContext
): string {
  const args = expr.args;

  if (args.length === 2) {
    // 2-argument form: while(condition, body) -> C while loop
    // We need to re-evaluate the condition on each iteration, so we use while(true)
    // and check the condition inside with a break statement
    const conditionExpr = args[0]!;
    const bodyExpr = args[1]!;

    // Track that we're in a loop for proper break/continue handling in nested match expressions
    const savedLoopLabel = context.currentLoopLabel;
    const loopLabel = `loop_${Math.random().toString(36).substr(2, 9)}`;
    context.currentLoopLabel = loopLabel;

    context.emitter.emitLine(`${indent}while (true) {`);
    const conditionCode = generateExpr(conditionExpr, indent + "  ", context);
    context.emitter.emitLine(`${indent}  if (!(${conditionCode})) {`);
    context.emitter.emitLine(`${indent}    break;`);
    context.emitter.emitLine(`${indent}  }`);
    generateLoopBody(bodyExpr, indent + "  ", context);
    context.emitter.emitLine(`${indent}}`);
    context.emitter.emitLine(`${indent}${loopLabel}:;`);

    context.currentLoopLabel = savedLoopLabel;

    return "";
  } else if (args.length === 3) {
    // 3-argument form: while(condition, step, body) -> C for loop
    // We need to re-evaluate the condition on each iteration
    const conditionExpr = args[0]!;
    const stepExpr = args[1]!;
    const bodyExpr = args[2]!;

    // Track that we're in a loop for proper break/continue handling in nested match expressions
    const savedLoopLabel = context.currentLoopLabel;
    const savedContinueLabel = context.currentContinueLabel;
    const loopLabel = `loop_${Math.random().toString(36).substr(2, 9)}`;
    const continueLabel = `continue_${Math.random().toString(36).substr(2, 9)}`;
    context.currentLoopLabel = loopLabel;
    context.currentContinueLabel = continueLabel;

    context.emitter.emitLine(`${indent}while (true) {`);
    const conditionCode = generateExpr(conditionExpr, indent + "  ", context);
    context.emitter.emitLine(`${indent}  if (!(${conditionCode})) {`);
    context.emitter.emitLine(`${indent}    break;`);
    context.emitter.emitLine(`${indent}  }`);
    generateLoopBody(bodyExpr, indent + "  ", context);
    context.emitter.emitLine(`${indent}${continueLabel}:;`);
    const stepCode = generateStepExpression(stepExpr, context);
    context.emitter.emitLine(`${indent}  ${stepCode};`);
    context.emitter.emitLine(`${indent}}`);
    context.emitter.emitLine(`${indent}${loopLabel}:;`);

    context.currentLoopLabel = savedLoopLabel;
    context.currentContinueLabel = savedContinueLabel;

    return "";
  } else {
    context.emitter.emitLine(
      `${indent}/* Error: while loop expects 2 or 3 arguments, got ${args.length} */`
    );
    return "";
  }
}

export function generateDeferredDropExpressions(
  expr: Expr,
  indent: string,
  context: FunctionGenerationContext
) {
  const emitter = context.emitter;

  if (expr.$?.deferredDropExpressions) {
    for (const dropExpr of expr.$.deferredDropExpressions) {
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
