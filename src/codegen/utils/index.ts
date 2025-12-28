import { Emitter } from "../../emitter";
import {
  BuiltinFunctions,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
} from "../../expr";
import { FunctionValue, FuncValueId } from "../../function-value";
import {
  ArrayType,
  DynType,
  EnumType,
  EnumVariant,
  extractFutureModuleFromType,
  FunctionType,
  isEnumType,
  isFunctionSpecializable,
  isObjectType,
  IsoType,
  isPtrType,
  isSliceType,
  isStructType,
  PtrType,
  SliceType,
  SomeType,
  StructType,
  Type,
  TypeId,
  typeImplementsFn,
  typeImplementsFuture,
  TypeTag,
  typeToString,
} from "../../types";
import { isNumberValue, ModuleValue } from "../../value";
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
  arrayStructTypes: Map<string, { childType: string; length: number }>;

  /**
   * Slice struct types that need to be generated
   */
  sliceStructTypes: Map<string, { childType: string }>;

  /**
   * Iso struct types that need to be generated
   * Maps Iso type C name to info about the child type and option type
   */
  isoTypes?: Map<
    string,
    {
      childTypeCName: string;
      isoType: IsoType;
      optionTypeCName?: string;
      structGenerated?: boolean;
      createGenerated?: boolean;
      extractGenerated?: boolean;
      disposeGenerated?: boolean;
    }
  >;

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
   * Closure-to-capture type mapping for generating dispose functions
   * Maps closure type ID to its closure type, closure C name, capture type, and capture C name
   */
  closureCaptureMap: Map<
    string,
    {
      closureType: FunctionType;
      closureCName: string;
      captureType: StructType;
      captureCName: string;
    }
  >;

  /**
   * Impl(Fn(...)) closure dispatch map.
   *
   * For static-dispatch closures, the runtime value is the resolvedConcreteType
   * (typically a capture struct). Calls should dispatch directly to the
   * generated closure implementation function for that concrete type.
   */
  implClosureCallMap: Map<
    TypeId,
    {
      functionCName: string;
      callTypeId: TypeId;
    }
  >;

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
   * Enable debug logging for GC and reference counting operations
   */
  debugGc: boolean;

  /**
   * Enable debug logging for parallel worker thread operations
   */
  debugParallelism: boolean;

  /**
   * Enable debug logging for async/await state machine operations
   */
  debugAsyncAwait: boolean;

  /**
   * Memory allocator to use: 'mimalloc' (default) or 'libc'
   */
  allocator: "mimalloc" | "libc";

  /**
   * Track dyn() usage for generating box types, wrappers, and vtables
   * Each entry represents a concrete type used with a specific dyn module
   */
  dynImpls: Map<
    string,
    {
      dynType: DynType;
      concreteType: Type;
      /**
       * The actual type stored in Dyn.data (must be an object type, e.g. Box(T) or a user object).
       * This can differ from concreteType when Dyn wraps Box(T):
       * - concreteType = T
       * - dataType = Box(T)
       */
      dataType: Type;
      moduleValue: ModuleValue;
    }
  >;

  /**
   * Current loop label for handling break/continue in nested match expressions
   * This is used to generate goto statements when match expressions inside loops
   * need to break or continue the loop (not just the switch statement)
   */
  currentLoopLabel?: string;
}

/**
 * Sanitize a string to be a valid C identifier
 * Replaces any character that's not alphanumeric or underscore with its Unicode code point
 * This ensures unique identifiers for operators like * and +
 * Also avoids conflicts with C keywords and common macros
 */
export function sanitizeForCIdentifier(str: string): string {
  // C keywords and common macros that should be avoided
  const cReservedWords = new Set([
    // C keywords
    "auto",
    "break",
    "case",
    "char",
    "const",
    "continue",
    "default",
    "do",
    "double",
    "else",
    "enum",
    "extern",
    "float",
    "for",
    "goto",
    "if",
    "inline",
    "int",
    "long",
    "register",
    "restrict",
    "return",
    "short",
    "signed",
    "sizeof",
    "static",
    "struct",
    "switch",
    "typedef",
    "union",
    "unsigned",
    "void",
    "volatile",
    "while",
    // C11 keywords
    "_Alignas",
    "_Alignof",
    "_Atomic",
    "_Bool",
    "_Complex",
    "_Generic",
    "_Imaginary",
    "_Noreturn",
    "_Static_assert",
    "_Thread_local",
    // Common standard library macros that expand to complex expressions
    "errno", // expands to (*__errno_location()) or similar
    "stdin",
    "stdout",
    "stderr", // FILE* macros
    "NULL",
    "true",
    "false", // common macros
  ]);

  let sanitized = str.replace(/[^a-zA-Z0-9_]/g, (char) => {
    return `_u${char.charCodeAt(0)}_`;
  });

  // If the result is a C reserved word or macro, append underscore
  if (cReservedWords.has(sanitized)) {
    sanitized = "__yo_c_reserved_" + sanitized;
  }

  return sanitized;
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

  if (type.isExtern && type.externName) {
    return type.externName;
  }

  switch (type.tag) {
    case TypeTag.Unit:
      return "void";
    case TypeTag.Void:
      // Void is an opaque/DST type in Yo - it can only exist behind a pointer
      // When used directly (which shouldn't happen), we'll use void for C
      return "void";
    case TypeTag.Bool:
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
    //case TypeTag.Closure: {
    //  // const closureType = type as ClosureType;
    //  // A closure is represented as a struct containing:
    //  // 1. Function pointer for the call function
    //  // 2. Capture data (if any)
    //
    //  // For now, use the existing type registration system
    //  const cTypeName = context.types[type.id]?.cName;
    //  if (!cTypeName) {
    //    throw new Error(
    //      `No C type name found for closure ${typeToString(type)}`
    //    );
    //  }
    //  // Closures are reference-counted, so return pointer type
    //  return `${cTypeName}*`;
    //}

    // Dynamic dispatch type
    case TypeTag.Dyn: {
      // Use the registered C type name
      const cTypeName = context.types[type.id]?.cName;
      if (!cTypeName) {
        throw new Error(
          `No C type name found for dynamic dispatch type ${typeToString(type)}`
        );
      }
      // Dyn is a value type (struct with data pointer and vtable pointer)
      // It's passed by value, not by pointer
      return cTypeName;
    }

    // Fixed size array
    case TypeTag.Array: {
      const arrayType = type as ArrayType;
      const childType = arrayType.childType;
      const length = arrayType.length;
      if (isNumberValue(length)) {
        // Generate struct wrapper for arrays to make them returnable by value
        const elementTypeString = getTypeString(childType, context);
        const arrayTypeName = `Array_${sanitizeForCIdentifier(elementTypeString)}_${length.value}`;

        // Register the array type if not already registered
        if (!context.arrayStructTypes.has(arrayTypeName)) {
          context.arrayStructTypes.set(arrayTypeName, {
            childType: elementTypeString,
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
        getTypeString(sliceType.childType, context)
      );
      const sliceTypeName = `Slice_${elementTypeStr}`;

      // Register the slice type
      if (!context.sliceStructTypes.has(sliceTypeName)) {
        context.sliceStructTypes.set(sliceTypeName, {
          childType: getTypeString(sliceType.childType, context),
        });
      }

      return sliceTypeName;
    }

    // SomeType (used for Impl(...) or Self references in modules/traits)
    case TypeTag.SomeType: {
      const someType = type as SomeType;

      // For Impl(Future(...)), use the FutureModuleType's C name (state machine struct)
      // Check this BEFORE resolvedConcreteType because the capture struct is an implementation detail
      if (typeImplementsFuture(someType)) {
        const futureModule = extractFutureModuleFromType(someType);
        if (futureModule) {
          const cTypeName = context.types[futureModule.id]?.cName;
          if (cTypeName) {
            // Impl futures are heap-backed state machines.
            // Use pointer type so the address is stable across suspension and returns.
            return `${cTypeName}*`;
          }
        }
      }

      // For Impl(Fn(...)), use the resolvedConcreteType (the capture struct)
      // The FnModuleType is the interface, but the runtime representation is the capture struct
      if (typeImplementsFn(someType)) {
        if (someType.resolvedConcreteType) {
          // Impl closures are VALUE types - use the capture struct directly
          return getTypeString(someType.resolvedConcreteType, context);
        }
      }

      // If this SomeType has a resolved concrete type, use it
      // (for types that don't have special handling above)
      if (someType.resolvedConcreteType) {
        return getTypeString(someType.resolvedConcreteType, context);
      }

      // Fallback for generic Self references in dynamic dispatch contexts
      return "void*";
    }

    // Future type
    // OUTDATED - Future is now a module type
    /// case TypeTag.Future: {
    ///   // Use the registered C type name
    ///   const cTypeName = context.types[type.id]?.cName;
    ///   if (!cTypeName) {
    ///     throw new Error(
    ///       `No C type name found for future ${typeToString(type)}`
    ///     );
    ///   }
    ///   // Future types are reference-counted, so return pointer type
    ///   return `${cTypeName}*`;
    /// }

    // Pointer type (mutable or immutable)
    case TypeTag.Ptr: {
      const ptrType = type as PtrType;
      const childType = ptrType.childType;

      // NOTE: In Yo, PtrType represents a borrow like `*(T)`.
      // For reference-semantics types (objects), the value is already a pointer in C,
      // so a borrow should NOT introduce another level of indirection.

      // Special handling for pointer-to-slice: in Rust-like semantics,
      // *[T] (pointer to slice) IS the fat pointer struct, not a pointer to fat pointer
      if (isSliceType(childType)) {
        const sliceType = childType as SliceType;
        const elementTypeString = getTypeString(sliceType.childType, context);
        const sliceTypeName = `Slice_${sanitizeForCIdentifier(elementTypeString)}`;

        // Register the slice type if not already registered
        if (!context.sliceStructTypes.has(sliceTypeName)) {
          context.sliceStructTypes.set(sliceTypeName, {
            childType: elementTypeString,
          });
        }

        // Return the slice struct type directly, not a pointer to it
        return sliceTypeName;
      }

      const baseTypeStr = getTypeString(childType, context);

      // Borrowing an object type should keep the same C type (already a pointer)
      if (isObjectType(childType)) {
        return `${baseTypeStr}*`;
      }
      // Borrowing an enum that is represented as a pointer (nullable pointer optimization)
      // should also keep the same C type string.
      if (
        isEnumType(childType) &&
        canOptimizeAsNullablePointer(childType as EnumType)
      ) {
        return baseTypeStr;
      }

      // For value types, a borrow is a pointer to the value.
      return `${baseTypeStr}*`;
    }

    // Iso type (atomic reference-counted isolated value)
    case TypeTag.Iso: {
      const isoType = type as IsoType;
      const childType = isoType.childType;
      const childTypeCName = getTypeString(childType, context);

      // Create a clean type name without pointer symbols
      // For Box(i32) which is yo_struct_id31868*, we want Iso_yo_struct_id31868
      const cleanChildTypeName = childTypeCName.replace(/\*/g, "").trim();
      const isoTypeName = `Iso_${sanitizeForCIdentifier(cleanChildTypeName)}`;

      // Register the Iso type for generation
      if (!context.isoTypes) {
        context.isoTypes = new Map();
      }
      if (!context.isoTypes.has(isoTypeName)) {
        context.isoTypes.set(isoTypeName, { childTypeCName, isoType });
      }

      // Iso types are reference-counted pointers
      return isoTypeName;
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
  // Sanitize the variable name to avoid C reserved words/macros like errno
  const sanitizedVarName = sanitizeForCIdentifier(varName);
  // For all types (including arrays), use the consistent struct wrapper approach
  return `${getTypeString(type, context)} ${sanitizedVarName}`;
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
 *
 * NOTE: We exclude __yo_as (casts) from inlining because they may have complex
 * argument expressions that need proper parameter substitution.
 */
export function isFunctionValueWithOnlyBuiltinYoInlineFunctionCall(
  functionValue: FunctionValue
): string | null {
  const body = functionValue.body;
  let operatorName: string | null = null;

  if (
    exprIsFunctionCall(body) &&
    exprIsFunctionCallOf(body, "begin") &&
    body.args.length === 1 &&
    exprIsFunctionCall(body.args[0]!) &&
    exprIsFunctionCallOf(body.args[0]!, BuiltinYoInlineFunctions)
  ) {
    operatorName = body.args[0]!.func.token.value;
  } else if (
    exprIsFunctionCall(body) &&
    exprIsFunctionCallOf(body, BuiltinYoInlineFunctions)
  ) {
    operatorName = body.func.token.value;
  }

  // Don't inline __yo_as - it needs proper function call handling for complex arguments
  if (operatorName && BuiltinFunctions.__yo_as.includes(operatorName)) {
    return null;
  }

  return operatorName;
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
    if (!variant.fields || variant.fields.length === 0) {
      // Variant with no fields (like None)
      if (emptyVariant) {
        return null; // More than one empty variant
      }
      emptyVariant = variant;
    } else if (variant.fields.length === 1) {
      // Variant with exactly one element
      const childType = variant.fields[0]!.type;

      // Check if it's a pointer/reference type
      if (isPtrType(childType)) {
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
  if (emptyVariant && pointerVariant && pointerVariant.fields) {
    return pointerVariant.fields[0]!.type;
  }

  return null;
}

/**
 * Check if an enum can be optimized as a simple C enum.
 * Returns true if all variants have no data members.
 */
export function canOptimizeAsSimpleEnum(enumType: EnumType): boolean {
  // All variants must have no fields
  for (const variant of enumType.variants) {
    if (variant.fields && variant.fields.length > 0) {
      return false; // Has data members
    }
  }
  return enumType.variants.length > 0; // Must have at least one variant
}
