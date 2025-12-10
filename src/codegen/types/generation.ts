import {
  DynType,
  EnumType,
  extractFnModuleFromType,
  FunctionType,
  FutureType,
  isDynType,
  isEnumType,
  isFnModuleType,
  isFunctionType,
  isFutureType,
  isStructType,
  isTupleType,
  isUnionType,
  isUnitType,
  StructType,
  TupleType,
  typeContainsSomeType,
  typeImplementsFn,
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
  // Always generate atomic reference counter header for objects and ref enums
  const debugGcDefine = context.debugGc
    ? "#define YO_DEBUG_GC 1"
    : "// #define YO_DEBUG_GC 1";

  const debugParallelismDefine = context.debugParallelism
    ? "#define YO_DEBUG_PARALLELISM 1"
    : "// #define YO_DEBUG_PARALLELISM 1";

  const debugAsyncAwaitDefine = context.debugAsyncAwait
    ? "#define YO_DEBUG_ASYNC_AWAIT 1"
    : "// #define YO_DEBUG_ASYNC_AWAIT 1";

  context.emitter
    .emitDeclarationLine(`// Non-atomic Reference Counting with Thread-Local Cycle Collection
// Based on QuickJS trial deletion algorithm
// See CYCLE_COLLECTION.md for design details

// Debug flag for GC operations - use --debug-gc flag to enable
${debugGcDefine}

#ifdef YO_DEBUG_GC
  #define GC_DEBUG(...) fprintf(stderr, "GC: " __VA_ARGS__)
#else
  #define GC_DEBUG(...)
#endif

// Debug flag for parallelism operations - use --debug-parallelism flag to enable
${debugParallelismDefine}

#ifdef YO_DEBUG_PARALLELISM
  #define PARALLELISM_DEBUG(...) fprintf(stderr, __VA_ARGS__)
#else
  #define PARALLELISM_DEBUG(...)
#endif

// Debug flag for async/await operations - use --debug-async-await flag to enable
${debugAsyncAwaitDefine}

#ifdef YO_DEBUG_ASYNC_AWAIT
  #define ASYNC_DEBUG(...) fprintf(stderr, "ASYNC: " __VA_ARGS__)
#else
  #define ASYNC_DEBUG(...)
#endif

// GC mark states for QuickJS-style trial deletion cycle collection
typedef enum {
  YO_GC_UNMARKED = 0,      // Object not yet processed
  YO_GC_CANDIDATE = 1,     // Object is a candidate for cycle collection
  YO_GC_TRIAL_DELETED = 2, // Object has been trial-deleted (RC decremented)
  YO_GC_LIVE = 3,          // Object is reachable (RC > 0 after trial deletion)
  YO_GC_GARBAGE = 4        // Object is garbage (RC = 0 after trial deletion)
} yo_gc_mark_t;

// GC flags
#define YO_GC_TRACKED              0x01  // Object is tracked by GC (might participate in cycles)

// Thread synchronization for stop-the-world GC
#ifndef YO_THREAD_SYNC_TYPE
#if defined(_WIN32)
  // Windows: Use native Windows APIs for better compatibility
  #include <windows.h>
  #include <process.h>
  typedef CRITICAL_SECTION YO_THREAD_SYNC_TYPE;
  typedef CONDITION_VARIABLE YO_COND_TYPE;
  typedef HANDLE YO_THREAD_TYPE;
  #define YO_THREAD_SYNC_INIT {0}
  #define YO_THREAD_SYNC_LOCK(m) EnterCriticalSection(m)
  #define YO_THREAD_SYNC_UNLOCK(m) LeaveCriticalSection(m)
  #define YO_COND_INIT CONDITION_VARIABLE_INIT
  #define yo_mutex_init(m) InitializeCriticalSection(m)
  #define yo_mutex_destroy(m) DeleteCriticalSection(m)
  #define yo_mutex_lock(m) EnterCriticalSection(m)
  #define yo_mutex_unlock(m) LeaveCriticalSection(m)
  #define yo_cond_init(c) InitializeConditionVariable(c)
  #define yo_cond_destroy(c) ((void)0)
  #define yo_cond_wait(c, m) SleepConditionVariableCS(c, m, INFINITE)
  #define yo_cond_signal(c) WakeConditionVariable(c)
  #define yo_cond_broadcast(c) WakeAllConditionVariable(c)
  #define yo_thread_create(t, func, arg) (*(t) = (HANDLE)_beginthreadex(NULL, 0, (unsigned (__stdcall*)(void*))func, arg, 0, NULL), *(t) != NULL ? 0 : -1)
  #define yo_thread_join(t) (WaitForSingleObject(t, INFINITE), CloseHandle(t), 0)
  #define yo_thread_self() ((uintptr_t)GetCurrentThreadId())
#elif defined(__linux__) || defined(__APPLE__) || defined(__FreeBSD__) || defined(__NetBSD__) || defined(__OpenBSD__)
  // Unix-like systems: Use pthreads (more reliable, especially on macOS)
  #include <pthread.h>
  #include <unistd.h>
  #include <sys/syscall.h>
  typedef pthread_mutex_t YO_THREAD_SYNC_TYPE;
  typedef pthread_cond_t YO_COND_TYPE;
  typedef pthread_t YO_THREAD_TYPE;
  #define YO_THREAD_SYNC_INIT PTHREAD_MUTEX_INITIALIZER
  #define YO_THREAD_SYNC_LOCK(m) pthread_mutex_lock(m)
  #define YO_THREAD_SYNC_UNLOCK(m) pthread_mutex_unlock(m)
  #define YO_COND_INIT PTHREAD_COND_INITIALIZER
  #define yo_mutex_init(m) pthread_mutex_init(m, NULL)
  #define yo_mutex_destroy(m) pthread_mutex_destroy(m)
  #define yo_mutex_lock(m) pthread_mutex_lock(m)
  #define yo_mutex_unlock(m) pthread_mutex_unlock(m)
  #define yo_cond_init(c) pthread_cond_init(c, NULL)
  #define yo_cond_destroy(c) pthread_cond_destroy(c)
  #define yo_cond_wait(c, m) pthread_cond_wait(c, m)
  #define yo_cond_signal(c) pthread_cond_signal(c)
  #define yo_cond_broadcast(c) pthread_cond_broadcast(c)
  #define yo_thread_create(t, func, arg) pthread_create(t, NULL, func, arg)
  #define yo_thread_join(t) pthread_join(t, NULL)
  #define yo_thread_self() ((uintptr_t)pthread_self())
#else
  #error "Unsupported platform for threading"
#endif
#endif

YO_THREAD_SYNC_TYPE yo_mutex_create(void);
YO_COND_TYPE yo_cond_create(void);
/**
 * Create and initialize a mutex (stack-allocated value)
 * Returns an initialized mutex that can be used with yo_mutex_lock/unlock
 */
YO_THREAD_SYNC_TYPE yo_mutex_create(void) {
  YO_THREAD_SYNC_TYPE mutex;
  yo_mutex_init(&mutex);
  return mutex;
}

/**
 * Create and initialize a condition variable (stack-allocated value)
 * Returns an initialized condition variable that can be used with yo_cond_wait/signal/broadcast
 */
YO_COND_TYPE yo_cond_create(void) {
  YO_COND_TYPE cond;
  yo_cond_init(&cond);
  return cond;
}

// Forward declare yo_thread_gc_state_t for use in yo_ref_header_t
typedef struct yo_thread_gc_state yo_thread_gc_state_t;

// Reference counting header - simple non-atomic RC with cycle collection support
// Thread-local: each object is owned by the thread that created it
typedef struct yo_ref_header_t {
  // Simple reference count (non-atomic, thread-local)
  size_t ref_count;
  
  // GC cycle collection fields
  uint8_t gc_flags;                                     // GC tracking flags
  yo_gc_mark_t gc_mark;                                 // GC mark state for trial deletion
  
  // GC object management fields (doubly-linked list for O(1) deletion)
  struct yo_ref_header_t* gc_next;                      // Next object in thread-local GC tracking list
  struct yo_ref_header_t* gc_prev;                      // Previous object in thread-local GC tracking list
  void (*dispose_fn)(void*);                            // Dispose function for this object type (immutable after construction)
  void (*traverse_fn)(void*, void (*visit)(void*));     // Traversal function for GC marking (immutable after construction)
} yo_ref_header_t;

// Per-thread GC state - defined after yo_ref_header_t so it can use complete type
struct yo_thread_gc_state {
  yo_ref_header_t* tracked_objects;          // Head of this thread's tracked objects list
  size_t tracked_count;                      // Number of objects tracked by this thread
  size_t thread_id;                          // Thread identifier (for debugging)
  size_t alloc_count;                        // Allocations since last collection
  yo_thread_gc_state_t* next;                // Next thread in global thread list
  yo_thread_gc_state_t* prev;                // Previous thread in global thread list (for O(1) removal)
};

// Generic Future type - used by async runtime for type-agnostic operations
// All concrete Future types share this same layout for common fields
typedef struct {
  yo_ref_header_t header;
  _Atomic(yo_future_state_t) state;
  void* state_machine;
  void (*state_machine_dispose_fn)(void*);
  void (*resume_fn)(void*);
  _Atomic(void*) continuation_fn;
  _Atomic(void*) continuation_sm;
  _Atomic(bool) detached;
  // Note: concrete Future types may have additional fields (e.g., result) after this
} yo_future_generic_t;
`);

  // Forward declarations - generate struct and enum forward declarations first
  for (const typeId in context.types) {
    const { type, cName } = context.types[typeId]!;
    if (typeContainsSomeType(type)) {
      continue; // Skip types that contain `SomeType` as they are not concrete types
    }

    if (isFutureType(type)) {
      // Forward declaration for Future types (they don't use _struct pattern)
      context.emitter.emitDeclarationLine(
        `typedef struct ${cName}_struct ${cName}; // Forward declaration`
      );
    } else if (isStructType(type)) {
      // Skip forward declaration for newtypes since they're just typedefs
      if (type.isNewtype && type.fields.length === 1) {
        continue;
      }
      context.emitter.emitDeclarationLine(
        `typedef struct ${cName}_struct ${cName}; // Forward declaration`
      );
    } else if (isEnumType(type)) {
      // Skip forward declaration for enums optimized as nullable pointers or simple enums
      // since they don't use the struct form
      const nullablePointerType = canOptimizeAsNullablePointer(type);
      const simpleEnumOptimizable = canOptimizeAsSimpleEnum(type);
      if (!nullablePointerType && !simpleEnumOptimizable) {
        context.emitter.emitDeclarationLine(
          `typedef struct ${cName}_struct ${cName}; // Forward declaration`
        );
      }
    }
  }

  // Add blank line after forward declarations
  context.emitter.emitDeclarationLine("");

  // Generate array struct types after forward declarations
  generateArrayStructDeclarations(context);

  // Generate slice struct types
  generateSliceStructDeclarations(context);

  // Generate types in dependency order
  // Complex dependency rules:
  // 1. Enums used by-value in structs must be defined before those structs
  // 2. Structs used by-pointer in enums can be forward declared
  // 3. Enums used by-value in enums must be defined before those enums

  // Strategy:
  // - First: Generate simple enums (leaf types)
  // - Then: Topologically sort structs and complex enums together
  //   - If struct S contains enum E by value, E must be defined before S
  //   - If enum E contains struct S by pointer, S can be forward declared (no dependency)
  //   - If enum E contains enum E2 by value, E2 must be defined before E

  // First pass: Generate simple enum declarations (optimized as simple enum) first
  // These are leaf types that can be used by other types
  for (const typeId in context.types) {
    const { type, cName } = context.types[typeId]!;
    if (typeContainsSomeType(type)) {
      continue; // Skip types that contain `SomeType` as they are not concrete types
    }

    if (isEnumType(type) && canOptimizeAsSimpleEnum(type)) {
      generateEnumDeclaration(type, cName, context);
    }
  }

  // Second pass: Collect structs and complex enums for topological sorting
  const structsAndEnums: Array<{
    typeId: string;
    type: StructType | EnumType;
    cName: string;
    isStruct: boolean;
  }> = [];

  for (const typeId in context.types) {
    const { type, cName } = context.types[typeId]!;
    if (typeContainsSomeType(type)) {
      continue;
    }

    if (isStructType(type)) {
      structsAndEnums.push({ typeId, type, cName, isStruct: true });
    } else if (
      isEnumType(type) &&
      !canOptimizeAsSimpleEnum(type) &&
      !canOptimizeAsNullablePointer(type)
    ) {
      structsAndEnums.push({ typeId, type, cName, isStruct: false });
    }
  }

  // Build dependency graph
  // An edge from A to B means B must be defined before A
  const dependencies = new Map<string, Set<string>>();
  const typeIdToData = new Map(structsAndEnums.map((e) => [e.typeId, e]));
  const cNameToTypeId = new Map(
    structsAndEnums.map((e) => [e.cName, e.typeId])
  );

  for (const { typeId, type, isStruct } of structsAndEnums) {
    dependencies.set(typeId, new Set());

    if (isStruct && isStructType(type)) {
      // Check if struct contains enums by value
      for (const field of type.fields) {
        if (isEnumType(field.type)) {
          const depCName = getTypeString(field.type, context);
          const depTypeId = cNameToTypeId.get(depCName);
          // If this struct depends on an enum in our set, record it
          if (
            depTypeId &&
            depTypeId !== typeId &&
            typeIdToData.has(depTypeId)
          ) {
            dependencies.get(typeId)!.add(depTypeId);
          }
        }
      }
    } else if (!isStruct && isEnumType(type)) {
      // Check if enum contains other enums or structs by value
      for (const variant of type.variants) {
        if (variant.fields) {
          for (const field of variant.fields) {
            // Enums by value need to be defined first
            if (isEnumType(field.type)) {
              const depCName = getTypeString(field.type, context);
              const depTypeId = cNameToTypeId.get(depCName);
              if (
                depTypeId &&
                depTypeId !== typeId &&
                typeIdToData.has(depTypeId)
              ) {
                dependencies.get(typeId)!.add(depTypeId);
              }
            }
            // Note: Structs by pointer (object types) don't create dependencies
            // because they use forward declarations
          }
        }
      }
    }
  }

  // Topological sort using Kahn's algorithm
  const inDegree = new Map<string, number>();
  for (const [typeId, deps] of dependencies) {
    inDegree.set(typeId, deps.size);
  }

  const queue: string[] = [];
  for (const [typeId, degree] of inDegree) {
    if (degree === 0) {
      queue.push(typeId);
    }
  }

  const sortedTypes: Array<{
    type: StructType | EnumType;
    cName: string;
    isStruct: boolean;
  }> = [];

  while (queue.length > 0) {
    const typeId = queue.shift()!;
    const typeData = typeIdToData.get(typeId)!;
    sortedTypes.push({
      type: typeData.type,
      cName: typeData.cName,
      isStruct: typeData.isStruct,
    });

    // Decrement in-degree for types that depend on this type
    for (const [otherTypeId, otherDeps] of dependencies) {
      if (otherDeps.has(typeId)) {
        const newDegree = (inDegree.get(otherTypeId) || 1) - 1;
        inDegree.set(otherTypeId, newDegree);
        if (newDegree === 0) {
          queue.push(otherTypeId);
        }
      }
    }
  }

  // If we didn't sort all types, there's a cycle - just append remaining in original order
  if (sortedTypes.length < structsAndEnums.length) {
    for (const item of structsAndEnums) {
      if (!sortedTypes.find((t) => t.cName === item.cName)) {
        sortedTypes.push({
          type: item.type,
          cName: item.cName,
          isStruct: item.isStruct,
        });
      }
    }
  }

  // Generate types in sorted order
  for (const { type, cName, isStruct } of sortedTypes) {
    if (isStruct && isStructType(type)) {
      generateStructDeclaration(type, cName, context);
    } else if (!isStruct && isEnumType(type)) {
      generateEnumDeclaration(type, cName, context);
    }
  }

  // Fourth pass: Generate nullable pointer optimized enums
  for (const typeId in context.types) {
    const { type, cName } = context.types[typeId]!;
    if (typeContainsSomeType(type)) {
      continue; // Skip types that contain `SomeType` as they are not concrete types
    }

    if (isEnumType(type) && canOptimizeAsNullablePointer(type)) {
      generateEnumDeclaration(type, cName, context);
    }
  }

  // Fifth pass: Generate other type declarations (closures, dyn, unions, tuples, futures)
  for (const typeId in context.types) {
    const { type, cName } = context.types[typeId]!;
    if (typeContainsSomeType(type)) {
      continue; // Skip types that contain `SomeType` as they are not concrete types
    }

    if (isDynType(type)) {
      generateDynDeclaration(type, cName, context);
    } else if (typeImplementsFn(type)) {
      // Pass undefined for captureType since this is just the type declaration
      // Actual capture types are handled during closure construction in expressions/generation.ts
      const fnModule = extractFnModuleFromType(type)!;

      generateClosureDeclaration(
        fnModule.isFn.callType,
        cName,
        undefined,
        context
      );
    } else if (isUnionType(type)) {
      generateUnionDeclaration(type, cName, context);
    } else if (isTupleType(type)) {
      // For tuples, we can generate a struct-like declaration
      generateTupleDeclaration(type, cName, context);
    } else if (isFutureType(type)) {
      generateFutureDeclaration(type, cName, context);
    }
    // Note: isEnumType and isStructType are handled in the passes above
  }
}

/**
 * Generate array struct type declarations
 */
export function generateArrayStructDeclarations(context: CodeGenContext): void {
  const emitter = context.emitter;
  for (const [
    arrayTypeName,
    { childType, length },
  ] of context.arrayStructTypes) {
    emitter.emitDeclarationLine(`typedef struct { // Array wrapper struct`);
    emitter.emitDeclarationLine(`  ${childType} data[${length}];`);
    emitter.emitDeclarationLine(`} ${arrayTypeName};`);
    emitter.emitDeclarationLine("");
  }
}

/**
 * Generate slice struct type declarations
 */
export function generateSliceStructDeclarations(context: CodeGenContext): void {
  const emitter = context.emitter;
  for (const [sliceTypeName, { childType }] of context.sliceStructTypes) {
    emitter.emitDeclarationLine(`typedef struct { // Slice wrapper struct`);
    emitter.emitDeclarationLine(`  ${childType}* data;`);
    emitter.emitDeclarationLine(`  size_t length;`);
    emitter.emitDeclarationLine(`} ${sliceTypeName};`);
    emitter.emitDeclarationLine("");
  }
}

/**
 * Generate a closure declaration with vtable for dynamic dispatch
 */
export function generateClosureDeclaration(
  functionType: FunctionType,
  cName: string,
  captureType: StructType | undefined,
  context: CodeGenContext
): void {
  const emitter = context.emitter;

  // Note: Capture type is no longer part of ClosureType.
  // It's passed as a separate parameter and stored in expr.$.captureType during closure construction.
  // Generate the capture data structure first (if there are captures)
  if (isStructType(captureType) && captureType.fields.length > 0) {
    // Check if the capture type already exists in the context (it should have been collected)
    const existingCaptureTypeEntry = Object.values(context.types).find(
      (entry) => entry.type === captureType
    );

    if (!existingCaptureTypeEntry) {
      // If capture type doesn't exist, we need to generate it inline
      // This shouldn't normally happen if collection is working properly
      const captureStructName = `${cName}_capture`;
      emitter.emitDeclarationLine(
        `typedef struct { // Capture data for ${typeToString(functionType)}`
      );

      for (const field of captureType.fields) {
        const fieldTypeStr = getTypeString(field.type, context);
        const fieldName = sanitizeForCIdentifier(field.label);
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
    `typedef struct { // Vtable for ${typeToString(functionType)}`
  );

  // Generate the call function pointer
  const callType = functionType;
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

  emitter.emitDeclarationLine(`} ${vtableName};`);
  emitter.emitDeclarationLine("");

  // Generate the closure structure with vtable and captured data pointer
  emitter.emitDeclarationLine(
    `typedef struct { // ${"Closure"} : ${typeToString(functionType)} (reference counted)`
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

  // Handle newtypes as zero-cost abstractions using typedef
  if (structType.isNewtype && structType.fields.length === 1) {
    const underlyingType = structType.fields[0]!.type;
    const underlyingTypeStr = getTypeString(underlyingType, context);
    emitter.emitDeclarationLine(
      `typedef ${underlyingTypeStr} ${cName}; // ${structType.typeName} : ${typeToString(structType)} (newtype - zero-cost abstraction)`
    );
    emitter.emitDeclarationLine(""); // Add blank line for readability
    return;
  }

  if (structType.isReferenceSemantics) {
    // For object, generate a struct with the common reference header
    emitter.emitDeclarationLine(
      `struct ${cName}_struct { // ${structType.typeName} : ${typeToString(structType)} (reference counted)`
    );
    emitter.emitDeclarationLine(
      `  yo_ref_header_t header; // Reference count header`
    );

    for (const field of structType.fields) {
      const fieldTypeStr = getTypeString(field.type, context);
      const fieldName = sanitizeForCIdentifier(field.label);
      emitter.emitDeclarationLine(`  ${fieldTypeStr} ${fieldName};`);
    }

    emitter.emitDeclarationLine(`};`);
  } else {
    // For regular struct, generate as before
    emitter.emitDeclarationLine(
      `struct ${cName}_struct { // ${structType.typeName} : ${typeToString(structType)}`
    );

    for (const field of structType.fields) {
      const fieldTypeStr = getTypeString(field.type, context);
      const fieldName = sanitizeForCIdentifier(field.label);
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

  for (const field of tupleType.fields) {
    const fieldTypeStr = getTypeString(field.type, context);
    const fieldName = field.label.match(/^\d+$/)
      ? `_${field.label}`
      : sanitizeForCIdentifier(field.label);
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

  for (const field of unionType.fields) {
    const fieldTypeStr = getTypeString(field.type, context);
    const fieldName = sanitizeForCIdentifier(field.label);
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
    if (variant.fields && variant.fields.length > 0) {
      // Filter out unit type fields - they don't need to be stored
      const nonUnitElements = variant.fields.filter(
        (field) => !isUnitType(field.type)
      );

      // Only generate struct if there are non-unit fields
      if (nonUnitElements.length > 0) {
        // Variant has data - create a struct for its fields using just the variant name
        const variantStructName = variant.name;
        emitter.emitDeclarationLine(`  struct {`);

        for (const field of nonUnitElements) {
          const fieldTypeStr = getTypeString(field.type, context);
          const fieldName = sanitizeForCIdentifier(field.label);
          emitter.emitDeclarationLine(`    ${fieldTypeStr} ${fieldName};`);
        }

        emitter.emitDeclarationLine(`  } ${variantStructName};`);
      }
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

  // Check if this dyn type contains an FnModuleType (i.e., Dyn(Fn(...)))
  const isFnDyn = dynType.requiredModules.some((m) => isFnModuleType(m));

  // Process modules in the order they appear in dynType.requiredModules
  for (const moduleType of dynType.requiredModules) {
    // Handle FnModuleType specially - it has isFn which represents the "call" method
    if (isFnModuleType(moduleType)) {
      const functionType = moduleType.isFn.callType;
      const returnTypeStr = getTypeString(functionType.return.type, context);

      // Generate the complete parameter list for the call function pointer
      const paramList = functionType.parameters
        .map((param) => {
          const paramTypeStr = getTypeString(param.type, context);
          const paramName = sanitizeForCIdentifier(param.label);
          return `${paramTypeStr} ${paramName}`;
        })
        .join(", ");

      // Call function takes void* self as first parameter, then user parameters
      emitter.emitDeclarationLine(
        `  ${returnTypeStr} (*call)(void* self${paramList ? ", " + paramList : ""}); // Call function pointer`
      );
      processedMethods.add("call");
      continue;
    }

    for (const field of moduleType.fields) {
      // Skip 'Self' type declarations as they're not methods
      if (field.label === "Self") {
        continue;
      }

      // For Fn dyn types (Dyn(Fn(...))), skip internal ARC methods (___dup, ___drop, ___dispose)
      // These are handled by the header's dispose_fn, not the vtable
      if (isFnDyn && field.label.startsWith("___")) {
        continue;
      }

      // Avoid duplicate methods from different modules
      if (processedMethods.has(field.label)) {
        continue;
      }
      processedMethods.add(field.label);

      // Generate function pointer for this method
      const methodName = sanitizeForCIdentifier(field.label);

      // Check if this field is a function type
      if (isFunctionType(field.type)) {
        const functionType = field.type as FunctionType;

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
              `  ${returnTypeStr} (*${methodName})(${paramList}); // Method pointer for ${field.label}`
            );
          }
          // Skip functions that don't have 'self' as first parameter
        }
      } else {
        // For non-function fields, treat as data members (shouldn't happen for trait methods)
        const elementTypeStr = getTypeString(field.type, context);
        emitter.emitDeclarationLine(
          `  ${elementTypeStr} ${methodName}; // Non-function member ${field.label}`
        );
      }
    }
  }

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

/**
 * Generate a Future declaration for stackless async/await
 * Future is a reference-counted struct that holds an async task result
 */
export function generateFutureDeclaration(
  futureType: FutureType,
  cName: string,
  context: CodeGenContext
): void {
  const emitter = context.emitter;
  const elementTypeStr = getTypeString(futureType.childType, context);
  const isUnit = isUnitType(futureType.childType);

  emitter.emitDeclarationLine(
    `struct ${cName}_struct { // ${futureType.typeName || "Future"} : ${typeToString(futureType)} (GC managed)`
  );
  emitter.emitDeclarationLine(
    `  yo_ref_header_t header; // Reference count header`
  );

  // Future state (atomic for thread-safe access across threads)
  emitter.emitDeclarationLine(
    `  _Atomic(yo_future_state_t) state; // Future state (PENDING/RUNNING/COMPLETED/ERROR) - atomic for cross-thread access`
  );

  // Pointer to state machine (if this Future is backed by a state machine)
  emitter.emitDeclarationLine(
    `  void* state_machine; // Pointer to state machine that created this Future (freed when Future is disposed)`
  );

  // Dispose function for the state machine (called before freeing state_machine)
  emitter.emitDeclarationLine(
    `  void (*state_machine_dispose_fn)(void*); // Dispose function to clean up state machine variables before freeing`
  );

  // Resume function for this Future's state machine (for lazy spawning)
  emitter.emitDeclarationLine(
    `  void (*resume_fn)(void*); // Resume function for this Future's state machine (for lazy spawn on await)`
  );

  // Continuation callback and state machine for async notification
  emitter.emitDeclarationLine(
    `  _Atomic(void*) continuation_fn; // Resume function to call when Future completes (NULL if no continuation)`
  );
  emitter.emitDeclarationLine(
    `  _Atomic(void*) continuation_sm; // State machine to resume when Future completes (the AWAITING state machine)`
  );

  // Detached flag - set when Future is dropped while still RUNNING
  emitter.emitDeclarationLine(
    `  _Atomic(bool) detached; // True if Future was dropped while RUNNING (should be freed when completed)`
  );

  // Only include result field if not unit/void
  if (!isUnit) {
    emitter.emitDeclarationLine(
      `  ${elementTypeStr} result; // The result value (only valid when state=COMPLETED)`
    );
  }

  emitter.emitDeclarationLine(`};`);
  emitter.emitDeclarationLine(`typedef struct ${cName}_struct ${cName};`);
  emitter.emitDeclarationLine(""); // Add blank line for readability
}
