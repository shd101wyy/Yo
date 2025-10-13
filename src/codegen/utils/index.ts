import { Emitter } from "../../emitter";
import { exprIsFunctionCall, exprIsFunctionCallOf } from "../../expr";
import { FunctionValue, FuncValueId } from "../../function-value";
import {
  ArrayType,
  EnumType,
  EnumVariant,
  FunctionType,
  isFunctionSpecializable,
  isMutPtrType,
  isObjectType,
  isSliceType,
  isStructType,
  MutPtrType,
  SliceType,
  Type,
  TypeId,
  TypeTag,
  typeToString,
} from "../../types";
import { isNumberValue } from "../../value";
import { BuiltinYoInlineFunctions } from "../constants";

export interface CodeGenContext {
  /**
   * Collected types that need to be generated
   */
  types: Record<TypeId, { type: Type; cName: string }>;

  /**
   * Collected functions that need to be generated
   */
  functions: Record<FuncValueId, { value: FunctionValue; cName: string }>;

  /**
   * Extern functions
   */
  externFunctions: Record<
    TypeId,
    { type: FunctionType; cName: string; cInclude?: string }
  >;

  /**
   * Array struct types that need to be generated
   */
  arrayStructTypes: Map<string, { elementType: string; length: number }>;

  /**
   * Slice struct types that need to be generated
   */
  sliceStructTypes: Map<string, { elementType: string }>;

  /**
   * Spawned function signatures that need task wrapper generation for cooperative multitasking
   * Maps signature string (based on parameter types + return type) to the signature info
   */
  spawnedFunctionSignatures: Map<
    string,
    { parameterTypes: Type[]; returnType: Type }
  >;

  /**
   * Spawned closure signatures that need task wrapper generation for cooperative multitasking
   * Maps signature string to the closure type
   */
  spawnedClosureSignatures: Map<string, { closureType: Type }>;

  /**
   * track the current function being generated for recur
   */
  currentFunctionName: string;

  /**
   * C header files that need to be included.
   * Default:
   *   - <stdbool.h>
   *   - <stdint.h>
   *   - <stddef.h>
   *   - <stdarg.h>
   */
  cIncludes: Set<string>;

  /**
   * Emitter for generating C code
   */
  emitter: Emitter;

  /**
   * Enable debug logging for Biased Reference Counting operations
   */
  debugBrc: boolean;

  /**
   * Enable debug logging for cooperative task scheduler operations
   */
  debugConcurrency: boolean;

  /**
   * Enable debug logging for async/await state machine operations
   */
  debugAsyncAwait: boolean;
}

/**
 * Sanitize a string to be a valid C identifier
 * Replaces any character that's not alphanumeric or underscore with its Unicode code point
 * This ensures unique identifiers for operators like * and +
 */
export function sanitizeForCIdentifier(str: string): string {
  return str.replace(/[^a-zA-Z0-9_]/g, (char) => {
    return `_u${char.charCodeAt(0)}_`;
  });
}

/**
 * Check if a type should avoid const qualifier even when not mutable
 * This is needed for object types that need to support reference counting operations
 */
export function shouldAvoidConst(type: Type): boolean {
  return isObjectType(type);
}

/**
 * Convert a Yo type to C type string
 */
export function getTypeString(
  type: Type | undefined,
  context: CodeGenContext
): string {
  if (!type) return "int32_t"; // fallback

  switch (type.tag) {
    case TypeTag.Unit:
      return "void";
    case TypeTag.Void:
      // Void is an opaque/DST type in Yo - it can only exist behind a pointer
      // When used directly (which shouldn't happen), we'll use void for C
      return "void";
    case TypeTag.Boolean:
      return "bool";
    case TypeTag.Usize:
      return "size_t"; // C size type
    case TypeTag.Isize:
      return "intptr_t"; // C pointer difference type
    case TypeTag.U8:
      return "uint8_t";
    case TypeTag.I8:
      return "int8_t";
    case TypeTag.U16:
      return "uint16_t";
    case TypeTag.I16:
      return "int16_t";
    case TypeTag.U32:
      return "uint32_t";
    case TypeTag.I32:
      return "int32_t";
    case TypeTag.U64:
      return "uint64_t";
    case TypeTag.I64:
      return "int64_t";
    case TypeTag.F32:
      return "float";
    case TypeTag.F64:
      return "double";
    case TypeTag.ComptInt:
      // compt_int is a compile-time integer with infinite precision
      // For C generation, we'll use a reasonable default like int64_t
      // In a more sophisticated implementation, we might analyze the actual value
      return "int64_t";
    case TypeTag.ComptFloat:
      return "double"; // For compt_float, we can use double
    case TypeTag.ComptString:
      return "uint8_t*"; // For compt_string, we use C string (char* or uint8_t*)

    case TypeTag.Char:
      return "char"; // C char type
    case TypeTag.Short:
      return "short"; // C short type
    case TypeTag.UShort:
      return "unsigned short"; // C unsigned short type
    case TypeTag.Int:
      return "int"; // C int type
    case TypeTag.UInt:
      return "unsigned int"; // C unsigned int type
    case TypeTag.Long:
      return "long"; // C long type
    case TypeTag.ULong:
      return "unsigned long"; // C unsigned long type
    case TypeTag.LongLong:
      return "long long"; // C long long type
    case TypeTag.ULongLong:
      return "unsigned long long"; // C unsigned long long type
    case TypeTag.LongDouble:
      return "long double"; // C long double type
    case TypeTag.Tuple:
    case TypeTag.Struct:
    case TypeTag.Union:
    case TypeTag.Enum: {
      // Check if this enum can be optimized as a nullable pointer
      if (type.tag === TypeTag.Enum) {
        const nullablePointerType = canOptimizeAsNullablePointer(
          type as EnumType
        );
        if (nullablePointerType) {
          // Return the pointer type directly without looking up in context.types
          return getTypeString(nullablePointerType, context);
        }
      }

      let kind: "tuple" | "struct" | "union" | "enum";
      switch (type.tag) {
        case TypeTag.Tuple:
          kind = "tuple";
          break;
        case TypeTag.Struct:
          kind = "struct";
          break;
        case TypeTag.Union:
          kind = "union";
          break;
        case TypeTag.Enum:
          kind = "enum";
          break;
        default:
          throw new Error("Unreachable");
      }

      const cTypeName = context.types[type.id]?.cName;
      if (!cTypeName) {
        throw new Error(
          `No C type name found for ${kind} ${typeToString(type)}`
        );
      }

      // For reference semantics structs/enums, return pointer type
      if (
        (type.tag === TypeTag.Struct || type.tag === TypeTag.Enum) &&
        isStructType(type) &&
        type.isReferenceSemantics
      ) {
        return `${cTypeName}*`;
      } else {
        return cTypeName;
      }
    }
    // Function type (function pointer)
    case TypeTag.Function: {
      // For function pointers, use a simple void* fallback for now
      // This will be handled properly by generateFunctionPrototype when needed
      return "void*";
    }
    // Closure type
    case TypeTag.Closure: {
      // const closureType = type as ClosureType;
      // A closure is represented as a struct containing:
      // 1. Function pointer for the call function
      // 2. Capture data (if any)

      // For now, use the existing type registration system
      const cTypeName = context.types[type.id]?.cName;
      if (!cTypeName) {
        throw new Error(
          `No C type name found for closure ${typeToString(type)}`
        );
      }
      // Closures are reference-counted, so return pointer type
      return `${cTypeName}*`;
    }

    // Dynamic dispatch type
    case TypeTag.Dyn: {
      // Use the registered C type name
      const cTypeName = context.types[type.id]?.cName;
      if (!cTypeName) {
        throw new Error(
          `No C type name found for dynamic dispatch type ${typeToString(type)}`
        );
      }
      // Dynamic dispatch types are reference-counted, so return pointer type
      return `${cTypeName}*`;
    }

    // Fixed size array
    case TypeTag.Array: {
      const arrayType = type as ArrayType;
      const elementType = arrayType.elementType;
      const length = arrayType.length;
      if (isNumberValue(length)) {
        // Generate struct wrapper for arrays to make them returnable by value
        const elementTypeString = getTypeString(elementType, context);
        const arrayTypeName = `Array_${sanitizeForCIdentifier(elementTypeString)}_${length.value}`;

        // Register the array type if not already registered
        if (!context.arrayStructTypes.has(arrayTypeName)) {
          context.arrayStructTypes.set(arrayTypeName, {
            elementType: elementTypeString,
            length: length.value,
          });
        }

        return arrayTypeName;
      }
      break;
    }
    case TypeTag.Slice: {
      // Generate slice struct type name: Slice_ElementType
      const sliceType = type as SliceType;
      const elementTypeStr = sanitizeForCIdentifier(
        getTypeString(sliceType.elementType, context)
      );
      const sliceTypeName = `Slice_${elementTypeStr}`;

      // Register the slice type
      if (!context.sliceStructTypes.has(sliceTypeName)) {
        context.sliceStructTypes.set(sliceTypeName, {
          elementType: getTypeString(sliceType.elementType, context),
        });
      }

      return sliceTypeName;
    }

    // SomeType (used for Self references in modules/traits)
    case TypeTag.SomeType:
      // In dynamic dispatch contexts, Self should be void*
      return "void*";

    // Future type
    case TypeTag.Future: {
      // Use the registered C type name
      const cTypeName = context.types[type.id]?.cName;
      if (!cTypeName) {
        throw new Error(
          `No C type name found for future ${typeToString(type)}`
        );
      }
      // Future types are reference-counted, so return pointer type
      return `${cTypeName}*`;
    }

    // Pointer type (mutable or immutable)
    case TypeTag.MutPtr: {
      const ptrType = type as MutPtrType;
      const baseType = ptrType.type;
      const isMutable = isMutPtrType(type);

      // Special handling for pointer-to-slice: in Rust-like semantics,
      // *[T] (pointer to slice) IS the fat pointer struct, not a pointer to fat pointer
      if (isSliceType(baseType)) {
        const sliceType = baseType as SliceType;
        const elementTypeString = getTypeString(sliceType.elementType, context);
        const sliceTypeName = `Slice_${sanitizeForCIdentifier(elementTypeString)}`;

        // Register the slice type if not already registered
        if (!context.sliceStructTypes.has(sliceTypeName)) {
          context.sliceStructTypes.set(sliceTypeName, {
            elementType: elementTypeString,
          });
        }

        // Return the slice struct type directly, not a pointer to it
        return sliceTypeName;
      }

      const baseTypeStr = getTypeString(baseType, context);
      if (isMutable) {
        return `${baseTypeStr}*`; // Mutable pointer
      } else {
        return `${baseTypeStr}* const`; // Immutable pointer
      }
    }
  }

  return `// Unknown type: ${typeToString(type)}`; // fallback
}

/**
 * Get C type string for variable declarations (handles arrays correctly)
 */
export function getVariableTypeString(
  type: Type,
  varName: string,
  context: CodeGenContext
): string {
  // For all types (including arrays), use the consistent struct wrapper approach
  return `${getTypeString(type, context)} ${varName}`;
}

/**
 * Generate enum variant C name
 */
export function getEnumVariantCName(
  enumType: EnumType,
  variantName: string,
  context: CodeGenContext
): string {
  const enumCName = context.types[enumType.id]?.cName;
  if (!enumCName) {
    throw new Error(
      `No C type name found for enum ${enumType.typeName} (${typeToString(enumType)})`
    );
  }
  return `${enumCName.toUpperCase()}_${variantName.toUpperCase()}`;
}

/**
 * Check if a function is generic (has compile-time type parameters)
 */
export function isGenericFunction(functionValue: FunctionValue): boolean {
  return isFunctionSpecializable(functionValue.type);
}

/**
 * Check if a function is for compile-time only
 */
export function isComptFunction(functionValue: FunctionValue): boolean {
  return functionValue.type.return.isCompileTimeOnly;
}

/**
 * Check if a function value only has body that calls the builtin
 * __yo_op_xxx functions, which are just wrappers around C operators,etc.
 * We can convert them to inline C operator calls directly
 */
export function isFunctionValueWithOnlyBuiltinYoInlineFunctionCall(
  functionValue: FunctionValue
): string | null {
  const body = functionValue.body;
  if (
    exprIsFunctionCall(body) &&
    exprIsFunctionCallOf(body, "begin") &&
    body.args.length === 1 &&
    exprIsFunctionCall(body.args[0]!) &&
    exprIsFunctionCallOf(body.args[0]!, BuiltinYoInlineFunctions)
  ) {
    return body.args[0]!.func.token.value; // Return the operator name
  } else if (
    exprIsFunctionCall(body) &&
    exprIsFunctionCallOf(body, BuiltinYoInlineFunctions)
  ) {
    return body.func.token.value; // Return the operator name
  } else {
    return null;
  }
}

/**
 * Check if an enum can be optimized as a nullable pointer.
 * Returns the pointer type if optimization is possible, null otherwise.
 */
export function canOptimizeAsNullablePointer(enumType: EnumType): Type | null {
  // Must have exactly 2 variants
  if (enumType.variants.length !== 2) {
    return null;
  }

  let emptyVariant: EnumVariant | null = null;
  let pointerVariant: EnumVariant | null = null;

  // Check each variant
  for (const variant of enumType.variants) {
    if (!variant.elements || variant.elements.length === 0) {
      // Variant with no elements (like None)
      if (emptyVariant) {
        return null; // More than one empty variant
      }
      emptyVariant = variant;
    } else if (variant.elements.length === 1) {
      // Variant with exactly one element
      const elementType = variant.elements[0]!.type;

      // Check if it's a pointer/reference type
      if (isMutPtrType(elementType)) {
        if (pointerVariant) {
          return null; // More than one pointer variant
        }
        pointerVariant = variant;
      } else {
        return null; // Not a pointer/reference type
      }
    } else {
      return null; // Variant has more than one element
    }
  }

  // Must have exactly one empty variant and one pointer variant
  if (emptyVariant && pointerVariant && pointerVariant.elements) {
    return pointerVariant.elements[0]!.type;
  }

  return null;
}

/**
 * Check if an enum can be optimized as a simple C enum.
 * Returns true if all variants have no data members.
 */
export function canOptimizeAsSimpleEnum(enumType: EnumType): boolean {
  // All variants must have no elements
  for (const variant of enumType.variants) {
    if (variant.elements && variant.elements.length > 0) {
      return false; // Has data members
    }
  }
  return enumType.variants.length > 0; // Must have at least one variant
}
