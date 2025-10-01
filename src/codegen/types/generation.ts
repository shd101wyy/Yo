import {
  ChanType,
  ClosureType,
  DynType,
  EnumType,
  FunctionType,
  isChanType,
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
  // Always generate atomic reference counter header for objects and ref enums
  const debugBrcDefine = context.debugBrc
    ? "#define YO_DEBUG_BRC 1"
    : "// #define YO_DEBUG_BRC 1";

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

// Fast thread ID function using platform-specific inline assembly (inspired by Python/mimalloc)
static inline size_t yo_get_thread_id(void) {
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

// Thread synchronization for stop-the-world GC
#ifndef YO_THREAD_SYNC_TYPE
#if defined(_WIN32)
  // Windows: Use C11 threads.h for better compatibility
  #include <threads.h>
  #define YO_THREAD_SYNC_TYPE mtx_t
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

// Thread type definitions for spawn/thread_wait functionality
// Include platform-specific thread headers
#if defined(_WIN32)
#include <windows.h>
#endif

// Base thread data structure with vtable for dynamic dispatch
typedef struct yo_thread_data_vtable {
  void (*execute_fn)(void* self);              // Execute the thread function
  void* (*get_result_fn)(void* self);          // Get the result (properly typed)
  void (*dispose_fn)(void* self);              // Clean up thread data
} yo_thread_data_vtable_t;

typedef struct yo_thread_data_base {
  yo_thread_data_vtable_t* vtable;             // VTable for polymorphic thread operations
  _Atomic(int) joined;                         // Whether the thread has been joined (1 = joined, 0 = not joined)
  struct yo_thread* thread_object;             // Back-pointer to the yo_thread_t object
} yo_thread_data_base_t;

typedef struct yo_thread {
  yo_ref_header_t header;                      // Reference count header (ARC type)
#if defined(_WIN32)
  HANDLE handle;                               // Windows thread handle
#else
  pthread_t handle;                            // POSIX thread handle
#endif
  size_t thread_id;                            // Thread ID (for GC tracking)
  yo_thread_data_base_t* data;                 // Thread execution data (base type)
} yo_thread_t;

// Thread function prototypes
yo_thread_t* yo_thread_spawn(void (*func)(void*), void* args, size_t result_size);
void* yo_thread_wait(yo_thread_t* thread);
void yo_thread_cleanup(yo_thread_t* thread);

// ARC functions for Thread type (will be specialized for each thread type)
void __yo_dispose_yo_thread_t(void* self);

// Thread wrapper function for proper result handling
#if defined(_WIN32)
DWORD WINAPI yo_thread_wrapper(LPVOID param);
#else
void* yo_thread_wrapper(void* param);
#endif
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
    } else if (isChanType(type)) {
      generateChanDeclaration(type, cName, context);
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

/**
 * Generate a channel declaration for buffered/unbuffered channels
 */
export function generateChanDeclaration(
  chanType: ChanType,
  cName: string,
  context: CodeGenContext
): void {
  const emitter = context.emitter;
  const elementTypeStr = getTypeString(chanType.elementType, context);

  emitter.emitDeclarationLine(
    `typedef struct { // ${chanType.typeName || "Chan"} : ${typeToString(chanType)} (reference counted)`
  );
  emitter.emitDeclarationLine(
    `  yo_ref_header_t header; // Reference count header`
  );

  // Core channel fields
  emitter.emitDeclarationLine(
    `  ${elementTypeStr}* buffer; // Buffer for elements`
  );
  emitter.emitDeclarationLine(
    `  size_t capacity; // Maximum number of elements`
  );
  emitter.emitDeclarationLine(`  size_t size; // Current number of elements`);
  emitter.emitDeclarationLine(`  size_t head; // Index of first element`);
  emitter.emitDeclarationLine(
    `  size_t tail; // Index where next element will be added`
  );
  emitter.emitDeclarationLine(`  _Atomic(int) closed; // Channel closed flag`);

  // Synchronization for thread safety
  emitter.emitDeclarationLine(`#if defined(_WIN32)`);
  emitter.emitDeclarationLine(
    `  CRITICAL_SECTION mutex; // Windows critical section`
  );
  emitter.emitDeclarationLine(
    `  CONDITION_VARIABLE send_cond; // Condition for send operations`
  );
  emitter.emitDeclarationLine(
    `  CONDITION_VARIABLE recv_cond; // Condition for receive operations`
  );
  emitter.emitDeclarationLine(`#else`);
  emitter.emitDeclarationLine(`  pthread_mutex_t mutex; // POSIX mutex`);
  emitter.emitDeclarationLine(
    `  pthread_cond_t send_cond; // Condition for send operations`
  );
  emitter.emitDeclarationLine(
    `  pthread_cond_t recv_cond; // Condition for receive operations`
  );
  emitter.emitDeclarationLine(`#endif`);

  emitter.emitDeclarationLine(`} ${cName};`);
  emitter.emitDeclarationLine(""); // Add blank line for readability
}
