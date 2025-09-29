import {
  ClosureType,
  DynType,
  EnumType,
  FunctionType,
  isClosureType,
  isDynType,
  isEnumType,
  isFunctionType,
  isStructType,
  isTupleType,
  isUnionType,
  StructType,
  TupleType,
  typeContainsSomeType,
  typeToString,
  UnionType,
} from "../../types";
import {
  canOptimizeAsNullablePointer,
  canOptimizeAsSimpleEnum,
  CodeGenContext,
  getEnumVariantCName,
  getTypeString,
  sanitizeForCIdentifier,
} from "../utils";

/**
 * Generate type declarations for all collected types
 */
export function generateTypeDeclarations(context: CodeGenContext): void {
  // Always generate atomic reference counter header for ref structs and ref enums
  context.emitter
    .emitDeclarationLine(`// Atomic reference counter header for ref structs and ref enums
// Per-thread GC with stop-the-world collection for better scalability
#define YO_GC_TRACKED     0x01  // Object is tracked by GC (might participate in cycles)  
#define YO_GC_DISPOSED    0x02  // Object has been disposed by GC (prevents double-free)
#define YO_GC_SCANNING    0x04  // Object is being scanned by GC (trial deletion phase)
#define YO_GC_MARKED      0x08  // Object marked during GC trial deletion
#define YO_GC_DISPOSING   0x10  // Object is currently being disposed (prevents races)

// Forward declaration of GC object for linked list
struct yo_gc_object;

// Thread synchronization for stop-the-world GC
#ifndef YO_THREAD_SYNC_TYPE
#if defined(__linux__) || defined(__APPLE__) || defined(__FreeBSD__) || defined(__NetBSD__) || defined(__OpenBSD__)
  #include <pthread.h>
  #define YO_THREAD_SYNC_TYPE pthread_mutex_t
  #define YO_THREAD_SYNC_INIT PTHREAD_MUTEX_INITIALIZER
  #define YO_COND_TYPE pthread_cond_t
  #define YO_COND_INIT PTHREAD_COND_INITIALIZER
  #define yo_mutex_lock(m) pthread_mutex_lock(m)
  #define yo_mutex_unlock(m) pthread_mutex_unlock(m)
  #define yo_cond_wait(c, m) pthread_cond_wait(c, m)
  #define yo_cond_broadcast(c) pthread_cond_broadcast(c)
#elif defined(_WIN32)
  #include <windows.h>
  #define YO_THREAD_SYNC_TYPE CRITICAL_SECTION
  #define YO_COND_TYPE CONDITION_VARIABLE
  #define yo_mutex_lock(m) EnterCriticalSection(m)
  #define yo_mutex_unlock(m) LeaveCriticalSection(m)
  #define yo_cond_wait(c, m) SleepConditionVariableCS(c, m, INFINITE)
  #define yo_cond_broadcast(c) WakeAllConditionVariable(c)
#else
  #error "Unsupported platform for threading"
#endif
#endif

// Per-thread GC state
typedef struct yo_thread_gc_state {
  struct yo_ref_header_t* tracked_objects;    // Head of this thread's tracked objects list
  size_t tracked_count;                       // Number of objects tracked by this thread
  size_t thread_id;                          // Thread identifier
  _Atomic(int) gc_paused;                    // Flag indicating if this thread is paused for GC
  struct yo_thread_gc_state* next;           // Next thread in global thread list
} yo_thread_gc_state_t;

typedef struct {
  _Atomic(size_t) ref_count;                             // Atomic reference count for thread safety
  _Atomic(uint8_t) gc_flags;                             // GC state flags (atomic for thread safety)
  struct yo_gc_object* gc_next;                          // Next object in thread-local GC tracking list
  void (*dispose_fn)(void*);                             // Dispose function for this object type (immutable after construction)
  void (*traverse_fn)(void*, void (*visit)(void*));     // Traversal function for GC marking (immutable after construction)
} yo_ref_header_t;
`);

  // Forward declarations - generate struct and enum forward declarations first
  for (const typeId in context.types) {
    const { type, cName } = context.types[typeId]!;
    if (typeContainsSomeType(type)) {
      continue; // Skip types that contain `SomeType` as they are not concrete types
    }

    if (isStructType(type)) {
      context.emitter.emitDeclarationLine(
        `typedef struct ${cName}_struct ${cName}; // Forward declaration`
      );
    } else if (isEnumType(type)) {
      context.emitter.emitDeclarationLine(
        `typedef struct ${cName}_struct ${cName}; // Forward declaration`
      );
    }
  }

  // Add blank line after forward declarations
  context.emitter.emitDeclarationLine("");

  // Generate array struct types after forward declarations
  generateArrayStructDeclarations(context);

  // Generate slice struct types
  generateSliceStructDeclarations(context);

  // Generate types in dependency order: enums first, then structs, then others
  // This handles circular dependencies where structs contain enums by value

  // First pass: Generate enum declarations (they can be used by value in structs)
  for (const typeId in context.types) {
    const { type, cName } = context.types[typeId]!;
    if (typeContainsSomeType(type)) {
      continue; // Skip types that contain `SomeType` as they are not concrete types
    }

    if (isEnumType(type)) {
      generateEnumDeclaration(type, cName, context);
    }
  }

  // Second pass: Generate struct and other type declarations
  for (const typeId in context.types) {
    const { type, cName } = context.types[typeId]!;
    if (typeContainsSomeType(type)) {
      continue; // Skip types that contain `SomeType` as they are not concrete types
    }

    if (isStructType(type)) {
      generateStructDeclaration(type, cName, context);
    } else if (isClosureType(type)) {
      generateClosureDeclaration(type, cName, context);
    } else if (isDynType(type)) {
      generateDynDeclaration(type, cName, context);
    } else if (isUnionType(type)) {
      generateUnionDeclaration(type, cName, context);
    } else if (isTupleType(type)) {
      // For tuples, we can generate a struct-like declaration
      generateTupleDeclaration(type, cName, context);
    }
    // Note: isEnumType is handled in the first pass above
  }
}

/**
 * Generate array struct type declarations
 */
export function generateArrayStructDeclarations(context: CodeGenContext): void {
  const emitter = context.emitter;
  for (const [
    arrayTypeName,
    { elementType, length },
  ] of context.arrayStructTypes) {
    emitter.emitDeclarationLine(`typedef struct { // Array wrapper struct`);
    emitter.emitDeclarationLine(`  ${elementType} data[${length}];`);
    emitter.emitDeclarationLine(`} ${arrayTypeName};`);
    emitter.emitDeclarationLine("");
  }
}

/**
 * Generate slice struct type declarations
 */
export function generateSliceStructDeclarations(context: CodeGenContext): void {
  const emitter = context.emitter;
  for (const [sliceTypeName, { elementType }] of context.sliceStructTypes) {
    emitter.emitDeclarationLine(`typedef struct { // Slice wrapper struct`);
    emitter.emitDeclarationLine(`  ${elementType}* data;`);
    emitter.emitDeclarationLine(`  size_t length;`);
    emitter.emitDeclarationLine(`} ${sliceTypeName};`);
    emitter.emitDeclarationLine("");
  }
}

/**
 * Generate a closure declaration with vtable for dynamic dispatch
 */
export function generateClosureDeclaration(
  closureType: ClosureType,
  cName: string,
  context: CodeGenContext
): void {
  const emitter = context.emitter;

  // Generate the capture data structure first (if there are captures)
  const captureType = closureType.captureType;

  if (isStructType(captureType) && captureType.elements.length > 0) {
    // Check if the capture type already exists in the context (it should have been collected)
    const existingCaptureTypeEntry = Object.values(context.types).find(
      (entry) => entry.type === captureType
    );

    if (!existingCaptureTypeEntry) {
      // If capture type doesn't exist, we need to generate it inline
      // This shouldn't normally happen if collection is working properly
      const captureStructName = `${cName}_capture`;
      emitter.emitDeclarationLine(
        `typedef struct { // Capture data for ${typeToString(closureType)}`
      );

      for (const element of captureType.elements) {
        const fieldTypeStr = getTypeString(element.type, context);
        const fieldName = sanitizeForCIdentifier(element.label);
        emitter.emitDeclarationLine(`  ${fieldTypeStr} ${fieldName};`);
      }

      emitter.emitDeclarationLine(`} ${captureStructName};`);
      emitter.emitDeclarationLine("");
    }
    // If it already exists, we don't need to generate it again - just reference it
  }

  // Generate vtable structure for the closure's dynamic dispatch
  // The vtable contains function pointers for call, dispose, drop, and dup methods
  const vtableName = `${cName}_vtable`;

  emitter.emitDeclarationLine(
    `typedef struct { // Vtable for ${typeToString(closureType)}`
  );

  // Generate the call function pointer
  const callType = closureType.callType;
  const returnTypeStr = getTypeString(callType.return.type, context);

  // Generate the complete parameter list for the call function pointer
  const paramList = callType.parameters
    .map((param) => {
      const paramTypeStr = getTypeString(param.type, context);
      const paramName = sanitizeForCIdentifier(param.label);
      return `${paramTypeStr} ${paramName}`;
    })
    .join(", ");

  // Call function takes closure pointer as first parameter, then user parameters
  emitter.emitDeclarationLine(
    `  ${returnTypeStr} (*call)(void* self${paramList ? ", " + paramList : ""}); // Call function pointer`
  );

  // Dispose function to handle closure cleanup
  emitter.emitDeclarationLine(
    `  void (*dispose)(void* self); // Dispose closure function pointer`
  );

  emitter.emitDeclarationLine(`} ${vtableName};`);
  emitter.emitDeclarationLine("");

  // Generate the closure structure with vtable and captured data pointer
  emitter.emitDeclarationLine(
    `typedef struct { // ${closureType.typeName || "Closure"} : ${typeToString(closureType)} (reference counted)`
  );
  emitter.emitDeclarationLine(
    `  yo_ref_header_t header; // Reference count header`
  );
  emitter.emitDeclarationLine(`  ${vtableName} vtable; // Function pointers`);

  // Data field is always void* to allow different capture types for same closure type
  emitter.emitDeclarationLine(`  void* data; // Captured data`);

  emitter.emitDeclarationLine(`} ${cName};`);
  emitter.emitDeclarationLine(""); // Add blank line for readability
}

/**
 * Generate a struct declaration
 */
export function generateStructDeclaration(
  structType: StructType,
  cName: string,
  context: CodeGenContext
): void {
  const emitter = context.emitter;

  if (structType.isReferenceSemantics) {
    // For ref struct, generate a struct with the common reference header
    emitter.emitDeclarationLine(
      `struct ${cName}_struct { // ${structType.typeName} : ${typeToString(structType)} (reference counted)`
    );
    emitter.emitDeclarationLine(
      `  yo_ref_header_t header; // Reference count header`
    );

    for (const element of structType.elements) {
      const fieldTypeStr = getTypeString(element.type, context);
      const fieldName = sanitizeForCIdentifier(element.label);
      emitter.emitDeclarationLine(`  ${fieldTypeStr} ${fieldName};`);
    }

    emitter.emitDeclarationLine(`};`);
  } else {
    // For regular struct, generate as before
    emitter.emitDeclarationLine(
      `struct ${cName}_struct { // ${structType.typeName} : ${typeToString(structType)}`
    );

    for (const element of structType.elements) {
      const fieldTypeStr = getTypeString(element.type, context);
      const fieldName = sanitizeForCIdentifier(element.label);
      emitter.emitDeclarationLine(`  ${fieldTypeStr} ${fieldName};`);
    }

    emitter.emitDeclarationLine(`};`);
  }

  emitter.emitDeclarationLine(""); // Add blank line for readability
}

/**
 * Generate a tuple declaration
 */
export function generateTupleDeclaration(
  tupleType: TupleType,
  cName: string,
  context: CodeGenContext
): void {
  const emitter = context.emitter;
  emitter.emitDeclarationLine(
    `typedef struct { // ${tupleType.typeName} : ${typeToString(tupleType)}`
  );

  for (const element of tupleType.elements) {
    const fieldTypeStr = getTypeString(element.type, context);
    const fieldName = element.label.match(/^\d+$/)
      ? `_${element.label}`
      : sanitizeForCIdentifier(element.label);
    emitter.emitDeclarationLine(`  ${fieldTypeStr} ${fieldName};`);
  }

  emitter.emitDeclarationLine(`} ${cName};`);
  emitter.emitDeclarationLine(""); // Add blank line for readability
}

/**
 * Generate a union declaration
 */
export function generateUnionDeclaration(
  unionType: UnionType,
  cName: string,
  context: CodeGenContext
): void {
  const emitter = context.emitter;
  // Generate C union (not tagged union)
  emitter.emitDeclarationLine(
    `typedef union { // ${unionType.typeName} : ${typeToString(unionType)}`
  );

  for (const element of unionType.elements) {
    const fieldTypeStr = getTypeString(element.type, context);
    const fieldName = sanitizeForCIdentifier(element.label);
    emitter.emitDeclarationLine(`  ${fieldTypeStr} ${fieldName};`);
  }

  emitter.emitDeclarationLine(`} ${cName};`);
  emitter.emitDeclarationLine(""); // Add blank line for readability
}

/**
 * Generate an enum declaration (tagged union)
 */
export function generateEnumDeclaration(
  enumType: EnumType,
  cName: string,
  context: CodeGenContext
): void {
  const emitter = context.emitter;

  // Check if this enum can be optimized as a nullable pointer
  const nullablePointerType = canOptimizeAsNullablePointer(enumType);
  if (nullablePointerType) {
    // Generate a simple typedef for the pointer type
    const pointerTypeStr = getTypeString(nullablePointerType, context);
    emitter.emitDeclarationLine(
      `typedef ${pointerTypeStr} ${cName}; // ${enumType.typeName} : ${typeToString(enumType)} (optimized as nullable pointer)`
    );
    emitter.emitDeclarationLine(""); // Add blank line for readability
    return;
  }

  // Check if this enum can be optimized as a simple C enum
  const simpleEnumOptimizable = canOptimizeAsSimpleEnum(enumType);
  if (simpleEnumOptimizable) {
    // Generate a simple enum declaration
    emitter.emitDeclarationLine(
      `typedef enum { // ${enumType.typeName} : ${typeToString(enumType)} (optimized as simple enum)`
    );

    for (let i = 0; i < enumType.variants.length; i++) {
      const variant = enumType.variants[i];
      if (variant) {
        // Use fully mangled names for enum tags to avoid global scope conflicts
        const tagName = getEnumVariantCName(enumType, variant.name, context);
        const comma = i < enumType.variants.length - 1 ? "," : "";
        emitter.emitDeclarationLine(`  ${tagName} = ${i}${comma}`);
      }
    }

    emitter.emitDeclarationLine(`} ${cName};`);
    emitter.emitDeclarationLine(""); // Add blank line for readability
    return;
  }

  // Generate tag enum for discriminant
  const tagEnumName = `${cName}_tag`;
  emitter.emitDeclarationLine(`typedef enum {`);

  for (let i = 0; i < enumType.variants.length; i++) {
    const variant = enumType.variants[i];
    if (variant) {
      // Use fully mangled names for enum tags to avoid global scope conflicts
      const tagName = getEnumVariantCName(enumType, variant.name, context);
      const comma = i < enumType.variants.length - 1 ? "," : "";
      emitter.emitDeclarationLine(`  ${tagName} = ${i}${comma}`);
    }
  }

  emitter.emitDeclarationLine(`} ${tagEnumName};`);
  emitter.emitDeclarationLine("");

  // Generate union for variant data
  const variantUnionName = `${cName}_data`;
  emitter.emitDeclarationLine(`typedef union {`);

  for (const variant of enumType.variants) {
    if (variant.elements && variant.elements.length > 0) {
      // Variant has data - create a struct for its fields using just the variant name
      const variantStructName = variant.name;
      emitter.emitDeclarationLine(`  struct {`);

      for (const element of variant.elements) {
        const fieldTypeStr = getTypeString(element.type, context);
        const fieldName = sanitizeForCIdentifier(element.label);
        emitter.emitDeclarationLine(`    ${fieldTypeStr} ${fieldName};`);
      }

      emitter.emitDeclarationLine(`  } ${variantStructName};`);
    }
  }

  emitter.emitDeclarationLine(`} ${variantUnionName};`);
  emitter.emitDeclarationLine("");

  // Generate the main tagged union struct
  emitter.emitDeclarationLine(
    `struct ${cName}_struct { // ${enumType.typeName} : ${typeToString(enumType)}`
  );

  emitter.emitDeclarationLine(`  ${tagEnumName} tag;`);
  emitter.emitDeclarationLine(`  ${variantUnionName} data;`);

  emitter.emitDeclarationLine(`};`);
  emitter.emitDeclarationLine(""); // Add blank line for readability
}

/**
 * Generate a dynamic dispatch declaration
 */
export function generateDynDeclaration(
  dynType: DynType,
  cName: string,
  context: CodeGenContext
): void {
  const emitter = context.emitter;

  // Generate vtable structure for the dynamic dispatch
  // The vtable contains function pointers for each method in the module
  const vtableName = `${cName}_vtable`;

  emitter.emitDeclarationLine(
    `typedef struct { // Vtable for ${typeToString(dynType)}`
  );

  // Generate function pointers in the correct order: base module methods first, then user module methods
  const processedMethods = new Set<string>();

  // Process modules in the order they appear in dynType.moduleTypes
  for (const moduleType of dynType.moduleTypes) {
    for (const element of moduleType.elements) {
      // Skip 'Self' type declarations as they're not methods
      if (element.label === "Self") {
        continue;
      }

      // Avoid duplicate methods from different modules
      if (processedMethods.has(element.label)) {
        continue;
      }
      processedMethods.add(element.label);

      // Generate function pointer for this method
      const methodName = sanitizeForCIdentifier(element.label);

      // Check if this element is a function type
      if (isFunctionType(element.type)) {
        const functionType = element.type as FunctionType;

        // Only include methods whose first parameter is of type Self
        if (functionType.parameters.length > 0) {
          const firstParam = functionType.parameters[0];
          if (firstParam && firstParam.label === "self") {
            // FIXME: ^ This way is not sufficient judging if this function is a method.
            // This is a method that should be included in the vtable
            const returnTypeStr = getTypeString(
              functionType.return.type,
              context
            );

            // Generate the complete parameter list for the function pointer
            const paramList = functionType.parameters
              .map((param, index) => {
                if (index === 0) {
                  // First parameter (self) is always void* in vtable
                  return "void* self";
                } else {
                  // Other parameters use their actual types
                  const paramTypeStr = getTypeString(param.type, context);
                  const paramName = sanitizeForCIdentifier(param.label);
                  return `${paramTypeStr} ${paramName}`;
                }
              })
              .join(", ");

            emitter.emitDeclarationLine(
              `  ${returnTypeStr} (*${methodName})(${paramList}); // Method pointer for ${element.label}`
            );
          }
          // Skip functions that don't have 'self' as first parameter
        }
      } else {
        // For non-function elements, treat as data members (shouldn't happen for trait methods)
        const elementTypeStr = getTypeString(element.type, context);
        emitter.emitDeclarationLine(
          `  ${elementTypeStr} ${methodName}; // Non-function member ${element.label}`
        );
      }
    }
  }

  // Add the dispose function pointer for dyn object cleanup (like closures)
  emitter.emitDeclarationLine(
    `  void (*dispose)(void* self); // Dispose function for dyn object`
  );

  emitter.emitDeclarationLine(`} ${vtableName};`);
  emitter.emitDeclarationLine("");

  // Generate the dynamic dispatch object structure
  // Contains vtable pointer + actual data pointer
  emitter.emitDeclarationLine(
    `typedef struct { // ${dynType.typeName || "Dyn"} : ${typeToString(dynType)} (reference counted)`
  );
  emitter.emitDeclarationLine(
    `  yo_ref_header_t header; // Reference count header`
  );
  emitter.emitDeclarationLine(`  ${vtableName} vtable; // Function pointers`);
  emitter.emitDeclarationLine(`  void* data; // Actual object data`);
  emitter.emitDeclarationLine(`} ${cName};`);
  emitter.emitDeclarationLine(""); // Add blank line for readability
}
