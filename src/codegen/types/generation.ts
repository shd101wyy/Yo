import {
  ClosureType,
  DynType,
  EnumType,
  FunctionType,
  FutureType,
  isClosureType,
  isDynType,
  isEnumType,
  isFunctionType,
  isFutureType,
  isStructType,
  isTupleType,
  isUnionType,
  isUnitType,
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
 * Topologically sort enums to ensure dependencies are generated before dependents.
 * This handles cases like: Result(unit, ArrayListError) depends on ArrayListError
 */
function topologicalSortEnums(
  enums: Array<{ typeId: string; type: EnumType; cName: string }>,
  context: CodeGenContext
): Array<{ type: EnumType; cName: string }> {
  // Build dependency graph and reverse mapping
  const typeIdToData = new Map(enums.map((e) => [e.typeId, e]));
  const cNameToTypeId = new Map(enums.map((e) => [e.cName, e.typeId]));

  // Build reverse dependency graph (dependents -> dependencies)
  const dependencies = new Map<string, Set<string>>();

  for (const { typeId, type } of enums) {
    dependencies.set(typeId, new Set());

    // Check each variant's elements for enum type dependencies
    for (const variant of type.variants) {
      if (variant.elements) {
        for (const element of variant.elements) {
          if (isEnumType(element.type)) {
            // Find the typeId for this enum dependency
            const depCName = getTypeString(element.type, context);
            const depTypeId = cNameToTypeId.get(depCName);
            // If this enum depends on another enum in our set, record it
            if (
              depTypeId &&
              depTypeId !== typeId &&
              typeIdToData.has(depTypeId)
            ) {
              dependencies.get(typeId)!.add(depTypeId);
            }
          }
        }
      }
    }
  }

  // Calculate in-degrees (number of dependencies each enum has)
  // An enum with in-degree 0 has no dependencies and can be generated first
  const inDegree = new Map<string, number>();
  for (const [typeId, deps] of dependencies) {
    inDegree.set(typeId, deps.size);
  }

  // Start with enums that have no dependencies (in-degree 0)
  const queue: string[] = [];
  for (const [typeId, degree] of inDegree) {
    if (degree === 0) {
      queue.push(typeId);
    }
  }

  const sorted: Array<{ type: EnumType; cName: string }> = [];

  while (queue.length > 0) {
    const typeId = queue.shift()!;
    const enumData = typeIdToData.get(typeId)!;
    sorted.push({ type: enumData.type, cName: enumData.cName });

    // For each enum that depends on this enum, decrement its in-degree
    // (this enum is now generated, so it's no longer a dependency)
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

  // If we didn't sort all enums, there's a cycle - just return in original order
  if (sorted.length < enums.length) {
    return enums;
  }

  return sorted;
}

/**
 * Generate type declarations for all collected types
 */
export function generateTypeDeclarations(context: CodeGenContext): void {
  // Always generate atomic reference counter header for objects and ref enums
  const debugBrcDefine = context.debugBrc
    ? "#define YO_DEBUG_BRC 1"
    : "// #define YO_DEBUG_BRC 1";

  const debugConcurrencyDefine = context.debugConcurrency
    ? "#define YO_DEBUG_CONCURRENCY 1"
    : "// #define YO_DEBUG_CONCURRENCY 1";

  const debugAsyncAwaitDefine = context.debugAsyncAwait
    ? "#define YO_DEBUG_ASYNC_AWAIT 1"
    : "// #define YO_DEBUG_ASYNC_AWAIT 1";

  context.emitter
    .emitDeclarationLine(`// Biased Reference Counting (BRC) header for objects and ref enums
// Per-thread GC with stop-the-world collection for better scalability

// Debug flag for BRC operations - use --debug-brc flag to enable
${debugBrcDefine}

#ifdef YO_DEBUG_BRC
  #define BRC_DEBUG(...) fprintf(stderr, "BRC: " __VA_ARGS__)
#else
  #define BRC_DEBUG(...)
#endif

// Debug flag for concurrency operations - use --debug-concurrency flag to enable
${debugConcurrencyDefine}

#ifdef YO_DEBUG_CONCURRENCY
  #define CONCURRENCY_DEBUG(...) fprintf(stderr, __VA_ARGS__)
#else
  #define CONCURRENCY_DEBUG(...)
#endif

// Debug flag for async/await operations - use --debug-async-await flag to enable
${debugAsyncAwaitDefine}

#ifdef YO_DEBUG_ASYNC_AWAIT
  #define ASYNC_DEBUG(...) fprintf(stderr, "ASYNC: " __VA_ARGS__)
#else
  #define ASYNC_DEBUG(...)
#endif

// Fast thread ID function using platform-specific inline assembly (inspired by Python/mimalloc)
static inline size_t __yo_get_thread_id(void) {
    uintptr_t tid;
#if defined(_MSC_VER) && defined(_M_X64)
    tid = __readgsqword(48);
#elif defined(_MSC_VER) && defined(_M_IX86)
    tid = __readfsdword(24);
#elif defined(_MSC_VER) && defined(_M_ARM64)
    tid = __getReg(18);
#elif defined(__i386__)
    __asm__("movl %%gs:0, %0" : "=r" (tid));  // 32-bit always uses GS
#elif defined(__MACH__) && defined(__x86_64__)
    __asm__("movq %%gs:0, %0" : "=r" (tid));  // x86_64 macOSX uses GS
#elif defined(__x86_64__)
    __asm__("movq %%fs:0, %0" : "=r" (tid));  // x86_64 Linux, BSD uses FS
#elif defined(__arm__)
    __asm__ ("mrc p15, 0, %0, c13, c0, 3\\nbic %0, %0, #3" : "=r" (tid));
#elif defined(__aarch64__) && defined(__APPLE__)
    __asm__ ("mrs %0, tpidrro_el0" : "=r" (tid));
#elif defined(__aarch64__)
    __asm__ ("mrs %0, tpidr_el0" : "=r" (tid));
#else
    // Fallback to standard library calls for unsupported platforms
    #if defined(__linux__) || defined(__APPLE__) || defined(__FreeBSD__) || defined(__NetBSD__) || defined(__OpenBSD__)
        tid = (uintptr_t)pthread_self();
    #elif defined(_WIN32)
        tid = (uintptr_t)GetCurrentThreadId();
    #else
        tid = 0;  // Ultimate fallback
    #endif
#endif
    return (size_t)tid;
}

// BRC bit field definitions for split biased/shared words

// Biased word bit fields (32 bits, non-atomic)
#define BRC_BIASED_COUNTER_BITS    14
#define BRC_BIASED_COUNTER_MASK    ((1U << BRC_BIASED_COUNTER_BITS) - 1)
#define BRC_BIASED_COUNTER_SHIFT   0

#define BRC_GC_FLAGS_BITS          2   // GC flags in biased word (owner thread access)
#define BRC_GC_FLAGS_MASK          ((1U << BRC_GC_FLAGS_BITS) - 1)
#define BRC_GC_FLAGS_SHIFT         14

#define BRC_BIASED_RESERVED_BITS   16  // Reserved space in biased word (increased from 13)
#define BRC_BIASED_RESERVED_SHIFT  (BRC_GC_FLAGS_SHIFT + BRC_GC_FLAGS_BITS)

// Shared word bit fields (32 bits, atomic)
#define BRC_SHARED_COUNTER_BITS    14
#define BRC_SHARED_COUNTER_MASK    ((1U << BRC_SHARED_COUNTER_BITS) - 1)
#define BRC_SHARED_COUNTER_SHIFT   0
#define BRC_SHARED_COUNTER_SIGN_BIT (1U << (BRC_SHARED_COUNTER_BITS - 1))

#define BRC_FLAGS_BITS             2   // BRC flags in shared word 
#define BRC_FLAGS_MASK             ((1U << BRC_FLAGS_BITS) - 1)
#define BRC_FLAGS_SHIFT            14

#define BRC_SHARED_RESERVED_BITS   16  // Reserved space in shared word
#define BRC_SHARED_RESERVED_SHIFT  (BRC_FLAGS_SHIFT + BRC_FLAGS_BITS)

// BRC and GC flag definitions
// BRC flags (bits 14-15 of shared word) - atomic access required
#define BRC_FLAG_MERGED            0x1  // Object has been merged from biased to shared state
#define BRC_FLAG_QUEUED            0x2  // Object has been queued to owner thread (shared counter went negative)

// Convenience aliases for common flag combinations
#define BRC_NO_BIAS                0x0  // Object is biased (default state)
#define BRC_UNBIASED               BRC_FLAG_MERGED  // Object is unbiased (merged/shared)

// GC flags (bits 0-1 of biased GC flags field) - owner thread access only
#define YO_GC_TRACKED              0x01  // Object is tracked by GC (might participate in cycles)
#define YO_GC_TRIAL_DECREMENTED    0x02  // Biased counter was decremented during trial deletion (vs shared counter)

// Biased word manipulation macros (non-atomic, owner thread only)
#define BRC_GET_BIASED_COUNTER(biased_word) \
  ((biased_word >> BRC_BIASED_COUNTER_SHIFT) & BRC_BIASED_COUNTER_MASK)

#define BRC_SET_BIASED_COUNTER(biased_word, count) \
  ((biased_word & ~(BRC_BIASED_COUNTER_MASK << BRC_BIASED_COUNTER_SHIFT)) | \
   ((count & BRC_BIASED_COUNTER_MASK) << BRC_BIASED_COUNTER_SHIFT))

#define BRC_GET_GC_FLAGS(biased_word) \
  ((biased_word >> BRC_GC_FLAGS_SHIFT) & BRC_GC_FLAGS_MASK)

#define BRC_SET_GC_FLAGS(biased_word, flags) \
  ((biased_word & ~(BRC_GC_FLAGS_MASK << BRC_GC_FLAGS_SHIFT)) | \
   (((uint32_t)(flags) & BRC_GC_FLAGS_MASK) << BRC_GC_FLAGS_SHIFT))

// Shared word manipulation macros (atomic access)
#define BRC_GET_SHARED_COUNTER(shared_word) \
  ((int16_t)((shared_word >> BRC_SHARED_COUNTER_SHIFT) & BRC_SHARED_COUNTER_MASK))

#define BRC_SET_SHARED_COUNTER(shared_word, count) \
  ((shared_word & ~(BRC_SHARED_COUNTER_MASK << BRC_SHARED_COUNTER_SHIFT)) | \
   (((uint32_t)(count) & BRC_SHARED_COUNTER_MASK) << BRC_SHARED_COUNTER_SHIFT))

#define BRC_GET_FLAGS(shared_word) \
  ((shared_word >> BRC_FLAGS_SHIFT) & BRC_FLAGS_MASK)

#define BRC_SET_FLAGS(shared_word, flags) \
  ((shared_word & ~(BRC_FLAGS_MASK << BRC_FLAGS_SHIFT)) | \
   (((uint32_t)(flags) & BRC_FLAGS_MASK) << BRC_FLAGS_SHIFT))

#define BRC_HAS_FLAG(shared_word, flag) \
  ((BRC_GET_FLAGS(shared_word) & (flag)) != 0)

#define BRC_SET_FLAG(shared_word, flag) \
  BRC_SET_FLAGS(shared_word, BRC_GET_FLAGS(shared_word) | (flag))

#define BRC_CLEAR_FLAG(shared_word, flag) \
  BRC_SET_FLAGS(shared_word, BRC_GET_FLAGS(shared_word) & ~(flag))

// Convenience macros for GC flag operations (non-atomic, owner thread only)
#define YO_GC_HAS_FLAG(biased_word, flag)    ((BRC_GET_GC_FLAGS(biased_word) & (flag)) != 0)
#define YO_GC_SET_FLAG(biased_word, flag)    BRC_SET_GC_FLAGS(biased_word, BRC_GET_GC_FLAGS(biased_word) | (flag))
#define YO_GC_CLEAR_FLAG(biased_word, flag)  BRC_SET_GC_FLAGS(biased_word, BRC_GET_GC_FLAGS(biased_word) & ~(flag))

// Forward declare yo_thread_gc_state_t for use in yo_ref_header_t

// Thread synchronization for stop-the-world GC
#ifndef YO_THREAD_SYNC_TYPE
#if defined(_WIN32)
  // Windows: Use C11 threads.h for better compatibility
  #include <threads.h>
  #define YO_THREAD_SYNC_TYPE mtx_t
  #define YO_THREAD_SYNC_LOCK(m) mtx_lock(m)
  #define YO_THREAD_SYNC_UNLOCK(m) mtx_unlock(m)
  #define YO_COND_TYPE cnd_t
  #define yo_mutex_lock(m) mtx_lock(m)
  #define yo_mutex_unlock(m) mtx_unlock(m)
  #define yo_cond_wait(c, m) cnd_wait(c, m)
  #define yo_cond_broadcast(c) cnd_broadcast(c)
#elif defined(__linux__) || defined(__APPLE__) || defined(__FreeBSD__) || defined(__NetBSD__) || defined(__OpenBSD__)
  // Unix-like systems: Use pthreads (more reliable, especially on macOS)
  #include <pthread.h>
  #define YO_THREAD_SYNC_TYPE pthread_mutex_t
  #define YO_THREAD_SYNC_INIT PTHREAD_MUTEX_INITIALIZER
  #define YO_THREAD_SYNC_LOCK(m) pthread_mutex_lock(m)
  #define YO_THREAD_SYNC_UNLOCK(m) pthread_mutex_unlock(m)
  #define YO_COND_TYPE pthread_cond_t
  #define YO_COND_INIT PTHREAD_COND_INITIALIZER
  #define yo_mutex_lock(m) pthread_mutex_lock(m)
  #define yo_mutex_unlock(m) pthread_mutex_unlock(m)
  #define yo_cond_wait(c, m) pthread_cond_wait(c, m)
  #define yo_cond_broadcast(c) pthread_cond_broadcast(c)
#else
  #error "Unsupported platform for threading"
#endif
#endif

// Forward declare yo_thread_gc_state_t for use in yo_ref_header_t
typedef struct yo_thread_gc_state yo_thread_gc_state_t;

// Reference counting header - must be defined before yo_thread_gc_state_t
typedef struct yo_ref_header_t {
  // Biased Reference Counting fields
  size_t owner_thread_id;                                // Thread ID that owns this object (0 = no owner/shared)
  uint32_t biased_word;                                 // Biased counter + GC flags (non-atomic, owner thread only)
  _Atomic(uint32_t) shared_word;                        // Shared counter + BRC flags (atomic access)
  
  // Biased word format (32 bits):
  // Bits 0-13:   Biased counter (14 bits) - non-atomic access by owner thread only
  // Bits 14-15:  GC flags (2 bits) - non-atomic access by owner thread only  
  // Bits 16-31:  Reserved (16 bits) - for future use
  
  // Shared word format (32 bits):
  // Bits 0-13:   Shared counter (14 bits) - atomic access, can be negative (signed)
  // Bits 14-15:  BRC flags (2 bits) - merged (bit 0), queued (bit 1) (atomic access)
  // Bits 16-31:  Reserved (16 bits) - for future use
  
  // GC object management fields (doubly-linked list for O(1) deletion)
  struct yo_ref_header_t* gc_next;                      // Next object in thread-local GC tracking list
  struct yo_ref_header_t* gc_prev;                      // Previous object in thread-local GC tracking list
  void (*dispose_fn)(void*);                             // Dispose function for this object type (immutable after construction)
  void (*traverse_fn)(void*, void (*visit)(void*));     // Traversal function for GC marking (immutable after construction)
} yo_ref_header_t;

// Per-thread GC state - defined after yo_ref_header_t so it can use complete type
struct yo_thread_gc_state {
  yo_ref_header_t* tracked_objects;          // Head of this thread's tracked objects list
  size_t tracked_count;                      // Number of objects tracked by this thread
  size_t thread_id;                          // Thread identifier
  _Atomic(int) gc_paused;                    // Flag indicating if this thread is paused for GC
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

    if (isStructType(type)) {
      // Skip forward declaration for newtypes since they're just typedefs
      if (type.isNewtype && type.elements.length === 1) {
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
  // Order: simple enums -> structs -> complex enums -> nullable enums -> other types
  // This ensures that structs are available before enums that contain them by value

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

  // Second pass: Generate struct declarations
  // These must come before complex enums because enums may contain structs by value
  for (const typeId in context.types) {
    const { type, cName } = context.types[typeId]!;
    if (typeContainsSomeType(type)) {
      continue; // Skip types that contain `SomeType` as they are not concrete types
    }

    if (isStructType(type)) {
      generateStructDeclaration(type, cName, context);
    }
  }

  // Third pass: Generate complex enum declarations (not optimized as simple enum)
  // These may contain structs by value or references to simple enums
  // We need to sort them topologically to ensure enum dependencies are generated first
  const complexEnums: Array<{ typeId: string; type: EnumType; cName: string }> =
    [];
  for (const typeId in context.types) {
    const { type, cName } = context.types[typeId]!;
    if (typeContainsSomeType(type)) {
      continue; // Skip types that contain `SomeType` as they are not concrete types
    }

    if (
      isEnumType(type) &&
      !canOptimizeAsSimpleEnum(type) &&
      !canOptimizeAsNullablePointer(type)
    ) {
      complexEnums.push({ typeId, type, cName });
    }
  }

  // Topologically sort complex enums by dependencies
  const sorted = topologicalSortEnums(complexEnums, context);
  for (const { type, cName } of sorted) {
    generateEnumDeclaration(type, cName, context);
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

    if (isClosureType(type)) {
      // Pass undefined for captureType since this is just the type declaration
      // Actual capture types are handled during closure construction in expressions/generation.ts
      generateClosureDeclaration(type, cName, undefined, context);
    } else if (isDynType(type)) {
      generateDynDeclaration(type, cName, context);
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
  captureType: StructType | undefined,
  context: CodeGenContext
): void {
  const emitter = context.emitter;

  // Note: Capture type is no longer part of ClosureType.
  // It's passed as a separate parameter and stored in expr.$.captureType during closure construction.
  // Generate the capture data structure first (if there are captures)
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

  // Handle newtypes as zero-cost abstractions using typedef
  if (structType.isNewtype && structType.elements.length === 1) {
    const underlyingType = structType.elements[0]!.type;
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
      // Filter out unit type elements - they don't need to be stored
      const nonUnitElements = variant.elements.filter(
        (element) => !isUnitType(element.type)
      );

      // Only generate struct if there are non-unit fields
      if (nonUnitElements.length > 0) {
        // Variant has data - create a struct for its fields using just the variant name
        const variantStructName = variant.name;
        emitter.emitDeclarationLine(`  struct {`);

        for (const element of nonUnitElements) {
          const fieldTypeStr = getTypeString(element.type, context);
          const fieldName = sanitizeForCIdentifier(element.label);
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
  const elementTypeStr = getTypeString(futureType.elementType, context);
  const isUnit = isUnitType(futureType.elementType);

  emitter.emitDeclarationLine(
    `typedef struct { // ${futureType.typeName || "Future"} : ${typeToString(futureType)} (reference counted)`
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

  emitter.emitDeclarationLine(`} ${cName};`);
  emitter.emitDeclarationLine(""); // Add blank line for readability
}
