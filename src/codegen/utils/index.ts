import { Emitter } from "../../emitter";
import {
  type Environment,
  getVariablesFromEnv,
  type Variable,
} from "../../env";
import { isIoAsyncCall } from "../../evaluator/async/await-analysis";
import {
  extractFutureTraitFromType,
  typeImplementsFn,
  typeImplementsFuture,
} from "../../evaluator/trait-checking";
import {
  BuiltinFunctions,
  type Expr,
  exprIsAtom,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  type FnCallExpr,
} from "../../expr";
import type { FunctionValue, FuncValueId } from "../../function-value";
import type { TargetInfo } from "../../target";
import type {
  ArrayType,
  DynType,
  EnumType,
  EnumVariant,
  FunctionType,
  IsoType,
  PtrType,
  SomeType,
  StructType,
  Type,
  TypeField,
  TypeId,
} from "../../types/definitions";
import {
  isEnumType,
  isReferenceStructType,
  isPtrType,
  isSomeType,
  isStructType,
} from "../../types/guards";
import { TypeTag } from "../../types/tags";
import { typeToString } from "../../types/utils";
import { isNumberValue, type TraitValue } from "../../value";
import { BuiltinYoInlineFunctions } from "../constants";

export interface CodeGenContext {
  /**
   * Collected types that need to be generated
   */
  types: Record<TypeId, { type: Type; cName: string }>;

  /**
   * Collected functions that need to be generated
   */
  functions: Record<
    FuncValueId,
    {
      value: FunctionValue;
      cName: string;
      effectStateMachineInfo?: unknown;
    }
  >;

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
   * Mapping from temp variable names to their async state machine struct names
   * This is used to preserve the correct Future state machine type when binding temp variables
   */
  tempVarAsyncStructNames?: Map<string, string>;

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
      /** The Fn call type — used to determine evidence parameters for spawn wrappers */
      callType?: FunctionType;
      /** Captured field names consumed by own() inside the closure body.
       *  Used by spawn wrapper to NULL these fields before dropping the capture struct. */
      consumedCaptures?: string[];
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
   * Compilation target info (arch, os, abi)
   */
  targetInfo: TargetInfo;

  /**
   * Memory allocator to use: 'mimalloc' (default) or 'libc'
   */
  allocator: "mimalloc" | "libc";

  /**
   * Track dyn() usage for generating box types, wrappers, and vtables
   * Each entry represents a concrete type used with a specific dyn trait
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
      traitValues: TraitValue[];
    }
  >;

  /**
   * Current loop label for handling break/continue in nested match expressions
   * This is used to generate goto statements when match expressions inside loops
   * need to break or continue the loop (not just the switch statement)
   */
  currentLoopLabel?: string;

  /**
   * Current continue label for 3-argument while loops with step
   * When continue is executed, it should jump to this label (which is before the step)
   */
  currentContinueLabel?: string;

  /**
   * Track when we're inside a match expression (which compiles to a switch in C)
   * This is needed because break inside a switch breaks the switch, not an outer loop
   */
  insideMatch?: boolean;

  /**
   * Track typeid static declarations that need to be generated.
   * Maps type ID string to the C variable name for the static.
   */
  typeIdStatics?: Map<string, string>;

  /**
   * When true, at least one object type can form RC cycles and needs GC tracking.
   * When false, GC infrastructure is omitted: __yo_ref_header_t is smaller (no gc_flags,
   * gc_mark, gc_next, gc_prev, traverse_fn), __yo_decr_rc skips GC checks, and all
   * GC runtime functions (register, unregister, collect) become no-ops.
   */
  needsCycleGC?: boolean;

  /**
   * When !needsCycleGC, maps dispose function C names to sequential integer type IDs.
   * Used to replace indirect dispose_fn calls with a switch-based dispatch table,
   * which compiles to WASM br_table instead of expensive call_indirect.
   * Type ID 0 is reserved for "no dispose needed" (NULL dispose_fn).
   */
  disposeTypeIds?: Map<string, number>;

  /**
   * Next available type ID for disposeTypeIds. Starts at 1 (0 = no dispose).
   */
  nextDisposeTypeId?: number;

  /**
   * When true, compiling as a library (no main() wrapper, exported functions use plain names).
   */
  isLibrary?: boolean;

  /**
   * Set to true when any asm block uses intel_syntax.
   * Signals that `-masm=intel` must be passed to the C compiler.
   */
  needsIntelAsmSyntax?: boolean;

  /**
   * Module-level mutable variable initialization expressions.
   * These are `:=` expressions at module scope that need to be emitted
   * in `__yo_user_main` before calling the user's main function.
   */
  moduleLevelInitExprs?: Expr[];

  /**
   * The module ID of the current module being compiled (e.g., "yo3818ce2d").
   * Used in library mode to distinguish user-defined exports from std library functions.
   */
  currentModuleId?: string;

  /**
   * Maps exported label names to their funcIds.
   * Used in library mode to give exported functions stable, non-mangled C names.
   */
  exportedFunctionLabels?: Map<FuncValueId, string>;
}

export function isComptimeOnlyStructField(
  field: TypeField,
  _ownerType: StructType
): boolean {
  return field.isCompileTimeOnly === true;
}

export function getRuntimeStructFields(structType: StructType): TypeField[] {
  return structType.fields.filter(
    (field) => !isComptimeOnlyStructField(field, structType)
  );
}

/**
 * Sanitize a string to be a valid C identifier
 * Replaces any character that's not alphanumeric or underscore with its Unicode code point
 * This ensures unique identifiers for operators like * and +
 * Also avoids conflicts with C keywords and common macros
 */
export function sanitizeForCIdentifier(str: string, isExternC = false): string {
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
  if (!isExternC && cReservedWords.has(sanitized)) {
    sanitized = "__yo_c_reserved_" + sanitized;
  }

  return sanitized;
}

/**
 * Check if a type should avoid const qualifier even when not mutable
 * This is needed for object types that need to support reference counting operations
 */
export function shouldAvoidConst(type: Type): boolean {
  return isReferenceStructType(type);
}

/**
 * Convert a Yo type to C type string
 */
export function getTypeString(
  type: Type | undefined,
  context: CodeGenContext
): string {
  if (!type) return "int32_t"; // fallback

  // Only use externName for C extern types (e.g., libc_FILE)
  // Not for Yo extern variables (__yo_argc, __yo_argv) - their types are normal Yo types
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
    case TypeTag.ComptimeInt:
      // comptime_int is a compile-time integer with infinite precision
      // For C generation, we'll use a reasonable default like int32_t
      // In a more sophisticated implementation, we might analyze the actual value
      return "int32_t";
    case TypeTag.ComptimeFloat:
      return "double"; // For comptime_float, we can use double
    case TypeTag.ComptimeString:
      // At runtime, comptime_str values materialize as the builtin str.
      return "__yo_str";

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
          `No C type name found for ${kind} ${typeToString(type)} (id=${type.id})`
        );
      }

      // For reference-semantics structs (objects) and enums (ref(enum(…))),
      // return a pointer type — the value is a heap-allocated RC handle.
      if (
        (isStructType(type) && type.isReferenceSemantics) ||
        (isEnumType(type) && type.isReferenceSemantics)
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
            length:
              typeof length.value === "bigint"
                ? Number(length.value)
                : length.value,
          });
        }

        return arrayTypeName;
      }
      break;
    }
    case TypeTag.Str: {
      // Builtin static string view — canonical fat pointer typedef emitted
      // in the C preamble.
      return "__yo_str";
    }
    // SomeType (used for Impl(...) or Self references in modules/traits)
    case TypeTag.SomeType: {
      const someType = type as SomeType;

      // For Impl(Future(...)), handle different cases:
      // 1. Impl(Concrete(extern_type), Future(T)) - use extern_type's C name
      // 2. Async blocks - use the registered SomeType's cName (state machine struct)
      // 3. Fallback - use __yo_io_future_t for unregistered extern futures
      if (typeImplementsFuture(someType)) {
        // Check for Concrete(extern_type) - resolvedConcreteType will be an extern type
        if (someType.resolvedConcreteType?.isExtern) {
          const externTypeName = getTypeString(
            someType.resolvedConcreteType,
            context
          );
          // Extern futures are heap-backed - use pointer type
          return `${externTypeName}*`;
        }

        // First try the SomeType's own ID - each async block creates a fresh SomeType
        // with a unique ID, and we register the state machine struct under that ID.
        const someTypeCName = context.types[someType.id]?.cName;
        if (someTypeCName) {
          // Impl futures are heap-backed state machines.
          // Use pointer type so the address is stable across suspension and returns.
          return `${someTypeCName}*`;
        }

        // Check resolvedConcreteType BEFORE the FutureTraitType fallback.
        // When a function returns Impl(Future(T)), the function's return SomeType
        // has a different ID than the async block's SomeType. But resolvedConcreteType
        // may point to the async block's SomeType or its capture struct, allowing us
        // to find the correct state machine struct name.

        // resolvedConcreteType is itself a SomeType with Impl(Future(T)):
        // e.g., when a function wraps an async block and its return type's
        // resolvedConcreteType points to the async block's own SomeType.
        if (
          someType.resolvedConcreteType &&
          isSomeType(someType.resolvedConcreteType) &&
          typeImplementsFuture(someType.resolvedConcreteType)
        ) {
          const innerSomeType = someType.resolvedConcreteType;
          const innerCName = context.types[innerSomeType.id]?.cName;
          if (innerCName) {
            return `${innerCName}*`;
          }
        }

        // resolvedConcreteType matches a registered async block's capture struct:
        // This happens when a function returns an async block - the function's return
        // type is a fresh SomeType, but its resolvedConcreteType points to the async
        // block's capture struct.
        if (
          someType.resolvedConcreteType &&
          isStructType(someType.resolvedConcreteType)
        ) {
          const captureStructId = someType.resolvedConcreteType.id;
          // Search through all registered types to find a state machine that uses this capture struct
          for (const [_typeId, typeEntry] of Object.entries(context.types)) {
            if (
              isSomeType(typeEntry.type) &&
              typeImplementsFuture(typeEntry.type)
            ) {
              // Check if this registered Future type has the same capture struct
              if (
                typeEntry.type.resolvedConcreteType &&
                isStructType(typeEntry.type.resolvedConcreteType) &&
                typeEntry.type.resolvedConcreteType.id === captureStructId
              ) {
                // Found a matching async block - use its state machine type
                return `${typeEntry.cName}*`;
              }
            }
          }
        }

        // Fallback: try the FutureTraitType (for extern futures only)
        // NOTE: This must come AFTER resolvedConcreteType checks above, because
        // the FutureTraitType is shared across all async blocks with the same
        // output type and would return a generic trait type name instead of the
        // specific state machine struct.
        const futureModule = extractFutureTraitFromType(someType);
        if (futureModule) {
          const cTypeName = context.types[futureModule.id]?.cName;
          if (cTypeName) {
            // Impl futures are heap-backed state machines.
            // Use pointer type so the address is stable across suspension and returns.
            return `${cTypeName}*`;
          }
        }

        // No fallback - all Impl(Future) types must have a concrete type
        throw new Error(
          `Impl(Future) type has no registered concrete type. ` +
            `SomeType ID: ${someType.id}, FutureModule: ${futureModule?.id ?? "none"}. ` +
            `Ensure async blocks are properly analyzed and their state machine types are registered.\n` +
            `resolvedConcreteType: ${someType.resolvedConcreteType?.id ?? "none"}\n` +
            `registered type IDs: ${Object.keys(context.types)
              .filter((k) => k.startsWith("sometype"))
              .join(", ")}`
        );
      }

      // For Impl(Fn(...)), use the resolvedConcreteType (the capture struct)
      // The FnTraitType is the interface, but the runtime representation is the capture struct
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
    // OUTDATED - Future is now a trait type
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

      const baseTypeStr = getTypeString(childType, context);

      // Borrowing an object type should keep the same C type (already a pointer)
      if (isReferenceStructType(childType)) {
        return `${baseTypeStr}*`;
      }
      // Borrowing an enum that is represented as a pointer (nullable pointer optimization)
      // needs an extra level of indirection, same as object types.
      if (
        isEnumType(childType) &&
        canOptimizeAsNullablePointer(childType as EnumType)
      ) {
        return `${baseTypeStr}*`;
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
      // For Box(i32) which is __yo_struct_id31868*, we want Iso___yo_struct_id31868
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
 * Check if a function is for compile-time only
 */
export function isComptimeFunction(functionValue: FunctionValue): boolean {
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
  // Helper: look through `unsafe(expr)` transparently — it's a pure
  // compile-time marker; codegen lowers it to its inner expression.
  // A function body shaped like `unsafe(__yo_op_add(a, b))` is
  // structurally equivalent to `__yo_op_add(a, b)` for inlining
  // purposes. See plans/MEMORY_SAFETY.md.
  const unwrapUnsafe = (e: Expr): Expr =>
    exprIsFunctionCall(e) &&
    exprIsFunctionCallOf(e, BuiltinFunctions.unsafe) &&
    e.args.length === 1
      ? e.args[0]!
      : e;

  const body = unwrapUnsafe(functionValue.body);

  let operatorName: string | null = null;

  if (
    exprIsFunctionCall(body) &&
    exprIsFunctionCallOf(body, "begin") &&
    body.args.length === 1
  ) {
    const inner = unwrapUnsafe(body.args[0]!);
    if (
      exprIsFunctionCall(inner) &&
      exprIsFunctionCallOf(inner, BuiltinYoInlineFunctions)
    ) {
      operatorName = inner.func.token.value;
    }
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

/**
 * Get the actual variable name to use in generated code.
 * For anonymous function parameters, uses the actual parameter name (not the alias).
 * The parameterAlias field is not used for C code generation - both the function
 * signature and body should use the actual variable name consistently.
 *
 * @param variableName The variable name to look up
 * @param env The environment containing the variable
 * @returns The name to use in generated code, sanitized for C
 */
export function getVariableNameForCodegen(
  variableName: string,
  env: Environment | undefined
): string {
  if (!env) {
    return sanitizeForCIdentifier(variableName);
  }

  const variables = getVariablesFromEnv(env, variableName);
  if (variables.length > 0) {
    const variable = variables[variables.length - 1]!;
    const varName = sanitizeForCIdentifier(
      variable.name,
      variable.type.isExtern === "c"
    );
    // If the env lookup returns a generated C name (fn_*_*),
    // prefer the original variable name. This handles the case
    // where a module-level function shadows a local variable.
    if (varName !== variableName && /^fn_/.test(varName)) {
      return sanitizeForCIdentifier(variableName);
    }
    return varName;
  }

  return sanitizeForCIdentifier(variableName);
}

export function getDeferredDupTargetAtomName(
  dupExpr: Expr
): string | undefined {
  // Form 1: ___dup(varName) — pre-evaluation form
  if (exprIsFunctionCall(dupExpr) && dupExpr.args.length >= 1) {
    const firstArg = dupExpr.args[0];
    if (firstArg && exprIsAtom(firstArg)) {
      return firstArg.token.value;
    }
  }
  // Form 2: (varName.___dup)() — post-evaluation method-style form
  if (
    exprIsFunctionCall(dupExpr) &&
    dupExpr.args.length === 0 &&
    exprIsFunctionCall(dupExpr.func) &&
    exprIsFunctionCallOf(dupExpr.func, ".", 2) &&
    exprIsAtom(dupExpr.func.args[0]!) &&
    exprIsAtom(dupExpr.func.args[1]!) &&
    dupExpr.func.args[1]!.token.value === BuiltinFunctions.___dup[0]
  ) {
    return dupExpr.func.args[0]!.token.value;
  }
  return undefined;
}

/**
 * Extract the variable name from a drop expression.
 * Drop expressions are of the form `___drop(varName)`.
 * Returns the variable name if the expression is a valid drop expression, undefined otherwise.
 */
export function getDeferredDropTargetAtomName(
  dropExpr: Expr
): string | undefined {
  // Check if it's XXX.drop();
  if (
    exprIsFunctionCall(dropExpr) &&
    dropExpr.args.length === 0 &&
    exprIsFunctionCall(dropExpr.func) &&
    exprIsFunctionCallOf(dropExpr.func, ".", 2) &&
    exprIsAtom(dropExpr.func.args[1]!) &&
    dropExpr.func.args[1]!.token.value === BuiltinFunctions.___drop[0] &&
    exprIsAtom(dropExpr.func.args[0]!)
  ) {
    return dropExpr.func.args[0]!.token.value;
  }

  // Check if it's normal ___drop(varName);
  if (
    !exprIsFunctionCall(dropExpr) ||
    !exprIsFunctionCallOf(dropExpr, BuiltinFunctions.___drop) ||
    dropExpr.args.length < 1
  ) {
    return;
  }
  const firstArg = dropExpr.args[0];
  if (!firstArg || !exprIsAtom(firstArg)) {
    return;
  }
  return firstArg.token.value;
}

/**
 * Resolve the identity (Variable.id) of the variable a drop expression
 * targets. The drop expression was evaluated in the scope-exit environment
 * of the scope that owns the variable, where the target is the latest
 * binding of its name. Resolving the id there lets cleanup sites
 * distinguish the actual target from same-named shadowing bindings (e.g.
 * a match-arm payload borrow) that are in scope at the cleanup point —
 * emitting the drop against a shadowing borrow double-frees its payload.
 */
export function getDeferredDropTargetVariable(
  dropExpr: Expr
): Variable | undefined {
  let atom: Expr | undefined;
  // varName.drop() form (method call syntax)
  if (
    exprIsFunctionCall(dropExpr) &&
    dropExpr.args.length === 0 &&
    exprIsFunctionCall(dropExpr.func) &&
    exprIsFunctionCallOf(dropExpr.func, ".", 2) &&
    exprIsAtom(dropExpr.func.args[1]!) &&
    dropExpr.func.args[1]!.token.value === BuiltinFunctions.___drop[0] &&
    exprIsAtom(dropExpr.func.args[0]!)
  ) {
    atom = dropExpr.func.args[0]!;
  } else if (
    exprIsFunctionCall(dropExpr) &&
    exprIsFunctionCallOf(dropExpr, BuiltinFunctions.___drop) &&
    dropExpr.args.length >= 1 &&
    dropExpr.args[0] &&
    exprIsAtom(dropExpr.args[0])
  ) {
    // ___drop(varName) form
    atom = dropExpr.args[0];
  }
  if (!atom?.$?.env) return undefined;
  const variables = getVariablesFromEnv(atom.$.env, atom.token.value);
  if (variables.length === 0) return undefined;
  return variables[variables.length - 1];
}

export function isDeferredDropForClosureCapture(
  dropExpr: Expr,
  currentClosureCaptures: readonly string[] | undefined
): boolean {
  const targetVarName = getDeferredDropTargetAtomName(dropExpr);
  return (
    targetVarName !== undefined &&
    currentClosureCaptures?.includes(targetVarName) === true
  );
}

/**
 * Find async blocks in an expression that might be returned.
 * Returns the first async block found in the function body.
 * For functions returning Impl(Future(T)), any async block in the body
 * could potentially be the return value, so we return the first one we find.
 */
export function findReturnedAsyncBlock(
  expr: Expr | undefined
): Expr | undefined {
  if (!expr) return undefined;

  // If this is an async block itself, return it
  if (isIoAsyncCall(expr)) {
    return expr;
  }

  // Recursively search in function call arguments
  if (exprIsFunctionCall(expr)) {
    const funcCallExpr = expr as FnCallExpr;
    for (const arg of funcCallExpr.args) {
      const found = findReturnedAsyncBlock(arg);
      if (found) return found;
    }
  }

  return undefined;
}
