import { BuiltinFunctions } from "../../expr";
import { isTargetMacos, isTargetWindows } from "../../target";
import type {
  EnumType,
  FunctionType,
  FutureTraitType,
  PtrType,
  StructType,
  TupleType,
  Type,
  UnionType,
} from "../../types/definitions";
import {
  isDynType,
  isEnumType,
  isFunctionType,
  isFutureTraitType,
  isPtrType,
  isSomeType,
  isStructType,
  isTupleType,
  isUnionType,
  isUnitType,
} from "../../types/guards";
import {
  typeContainsSomeType,
  typeToString,
  typeUsesSmallRcHeader,
} from "../../types/utils";

/**
 * Local helper: struct whose only SomeType content lives inside function-typed
 * fields. Such structs are concrete at C level (the fn-ptr fields are
 * type-erased) and should still be emitted as typedefs.
 *
 * Recursive: also accepts struct-typed fields whose own SomeType content is
 * confined to nested fn-ptr fields. This is what lets effect-bundle structs
 * like `IoExn :: struct(io : Io, exn : Exception)` register a C typedef.
 */
function structSomeTypeIsOnlyInFunctionFieldsLocal(
  type: StructType,
  visited: Set<string> = new Set()
): boolean {
  if (visited.has(type.id)) return true;
  visited.add(type.id);
  for (const field of type.fields) {
    if (isFunctionType(field.type)) continue;
    if (
      isStructType(field.type) &&
      structSomeTypeIsOnlyInFunctionFieldsLocal(field.type, visited)
    ) {
      continue;
    }
    if (typeContainsSomeType(field.type)) return false;
  }
  return true;
}

/** Enum whose only SomeType is in function-typed variant fields. */
function enumSomeTypeIsOnlyInFunctionFieldsLocal(
  type: EnumType,
  visited: Set<string> = new Set()
): boolean {
  if (visited.has(type.id)) return true;
  visited.add(type.id);
  for (const variant of type.variants) {
    if (!variant.fields) continue;
    for (const field of variant.fields) {
      if (isFunctionType(field.type)) continue;
      if (
        isStructType(field.type) &&
        structSomeTypeIsOnlyInFunctionFieldsLocal(field.type, visited)
      ) {
        continue;
      }
      if (typeContainsSomeType(field.type)) return false;
    }
  }
  return true;
}
import {
  canOptimizeAsNullablePointer,
  canOptimizeAsSimpleEnum,
  type CodeGenContext,
  getRuntimeStructFields,
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
    ? "#define __YO_DEBUG_GC 1"
    : "// #define __YO_DEBUG_GC 1";

  const debugParallelismDefine = context.debugParallelism
    ? "#define __YO_DEBUG_PARALLELISM 1"
    : "// #define __YO_DEBUG_PARALLELISM 1";

  const debugAsyncAwaitDefine = context.debugAsyncAwait
    ? "#define __YO_DEBUG_ASYNC_AWAIT 1"
    : "// #define __YO_DEBUG_ASYNC_AWAIT 1";

  context.emitter
    .emitDeclarationLine(`// Non-atomic Reference Counting with Thread-Local Cycle Collection
// Based on QuickJS trial deletion algorithm
// See CYCLE_COLLECTION.md for design details

// Debug flag for GC operations - use --debug-gc flag to enable
${debugGcDefine}

#ifdef __YO_DEBUG_GC
  #define GC_DEBUG(...) fprintf(stderr, "GC: " __VA_ARGS__)
#else
  #define GC_DEBUG(...)
#endif

// Debug flag for parallelism operations - use --debug-parallelism flag to enable
${debugParallelismDefine}

#ifdef __YO_DEBUG_PARALLELISM
  #define PARALLELISM_DEBUG(...) fprintf(stderr, __VA_ARGS__)
#else
  #define PARALLELISM_DEBUG(...)
#endif

// Debug flag for async/await operations - use --debug-async-await flag to enable
${debugAsyncAwaitDefine}

#ifdef __YO_DEBUG_ASYNC_AWAIT
  #define ASYNC_DEBUG(...) fprintf(stderr, "ASYNC: " __VA_ARGS__)
#else
  #define ASYNC_DEBUG(...)
#endif

// GC mark states for QuickJS-style trial deletion cycle collection
typedef enum {
  __YO_GC_UNMARKED = 0,      // Object not yet processed
  __YO_GC_CANDIDATE = 1,     // Object is a candidate for cycle collection
  __YO_GC_TRIAL_DELETED = 2, // Object has been trial-deleted (RC decremented)
  __YO_GC_LIVE = 3,          // Object is reachable (RC > 0 after trial deletion)
  __YO_GC_GARBAGE = 4        // Object is garbage (RC = 0 after trial deletion)
} __yo_gc_mark_t;

// GC flags
#define __YO_GC_TRACKED              0x01  // Object is tracked by GC (might participate in cycles)
#define __YO_GC_BUFFERED             0x02  // Object is in the possible-roots buffer (Bacon-Rajan candidate)
`);

  // Thread synchronization — emit only target-specific types and macros
  if (isTargetWindows(context.targetInfo)) {
    context.emitter
      .emitDeclarationLine(`// Thread synchronization for stop-the-world GC (Windows)
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef _WINSOCKAPI_
#define _WINSOCKAPI_
#endif
#include <windows.h>
#include <process.h>
typedef CRITICAL_SECTION __YO_THREAD_SYNC_TYPE;
typedef CONDITION_VARIABLE __YO_COND_TYPE;
typedef HANDLE __YO_THREAD_TYPE;
#define __YO_THREAD_SYNC_INIT {0}
#define __YO_THREAD_SYNC_LOCK(m) EnterCriticalSection(m)
#define __YO_THREAD_SYNC_UNLOCK(m) LeaveCriticalSection(m)
#define __YO_COND_INIT CONDITION_VARIABLE_INIT
#define __yo_mutex_init(m) InitializeCriticalSection(m)
#define __yo_mutex_destroy(m) DeleteCriticalSection(m)
#define __yo_mutex_lock(m) EnterCriticalSection(m)
#define __yo_mutex_unlock(m) LeaveCriticalSection(m)
#define __yo_cond_init(c) InitializeConditionVariable(c)
#define __yo_cond_destroy(c) ((void)0)
#define __yo_cond_wait(c, m) SleepConditionVariableCS(c, m, INFINITE)
#define __yo_cond_signal(c) WakeConditionVariable(c)
#define __yo_cond_broadcast(c) WakeAllConditionVariable(c)
#define __yo_raw_thread_create(t, func, arg) (*(t) = (HANDLE)_beginthreadex(NULL, 0, func, arg, 0, NULL), *(t) != NULL ? 0 : -1)
#define __yo_raw_thread_join(t) (WaitForSingleObject(t, INFINITE), CloseHandle(t), 0)
#define __yo_thread_self() ((uintptr_t)GetCurrentThreadId())`);
  } else {
    // POSIX (Linux, macOS, FreeBSD, etc.)
    context.emitter
      .emitDeclarationLine(`// Thread synchronization for stop-the-world GC (POSIX)
#include <pthread.h>
#include <unistd.h>
#include <sys/syscall.h>
${
  isTargetMacos(context.targetInfo)
    ? `#include <sys/types.h>
#include <sys/sysctl.h>`
    : ""
}
typedef pthread_mutex_t __YO_THREAD_SYNC_TYPE;
typedef pthread_cond_t __YO_COND_TYPE;
typedef pthread_t __YO_THREAD_TYPE;
#define __YO_THREAD_SYNC_INIT PTHREAD_MUTEX_INITIALIZER
#define __YO_THREAD_SYNC_LOCK(m) pthread_mutex_lock(m)
#define __YO_THREAD_SYNC_UNLOCK(m) pthread_mutex_unlock(m)
#define __YO_COND_INIT PTHREAD_COND_INITIALIZER
#define __yo_mutex_init(m) pthread_mutex_init(m, NULL)
#define __yo_mutex_destroy(m) pthread_mutex_destroy(m)
#define __yo_mutex_lock(m) pthread_mutex_lock(m)
#define __yo_mutex_unlock(m) pthread_mutex_unlock(m)
#define __yo_cond_init(c) pthread_cond_init(c, NULL)
#define __yo_cond_destroy(c) pthread_cond_destroy(c)
#define __yo_cond_wait(c, m) pthread_cond_wait(c, m)
#define __yo_cond_signal(c) pthread_cond_signal(c)
#define __yo_cond_broadcast(c) pthread_cond_broadcast(c)
#define __yo_raw_thread_create(t, func, arg) pthread_create(t, NULL, func, arg)
#define __yo_raw_thread_join(t) pthread_join(t, NULL)
#define __yo_thread_self() ((uintptr_t)pthread_self())`);
  }

  // Thread handle type and helper functions
  context.emitter.emitDeclarationLine(`
// Thread handle type for parallelism - value type, stack allocated
// Contains the OS thread handle (pthread_t or HANDLE)
typedef struct __yo_thread_t {
  __YO_THREAD_TYPE handle;
} __yo_thread_t;

// Thread callback type for spawn
typedef void (*__yo_thread_fn)(void* closure);

static __YO_THREAD_SYNC_TYPE __yo_mutex_create(void);
static __YO_COND_TYPE __yo_cond_create(void);

// Phase C (THREAD_SAFETY): Thin wrappers that forward to the C11 _Generic
// macros in <stdatomic.h> for atomic_int load/store/exchange. Declared via
// extern("Yo", ...) in std/libc/stdatomic.yo.
#include <stdatomic.h>
static inline int __yo_atomic_load_int(_Atomic int* obj, memory_order order) {
  return atomic_load_explicit(obj, order);
}
static inline void __yo_atomic_store_int(_Atomic int* obj, int desired, memory_order order) {
  atomic_store_explicit(obj, desired, order);
}
static inline int __yo_atomic_exchange_int(_Atomic int* obj, int desired, memory_order order) {
  return atomic_exchange_explicit(obj, desired, order);
}
static inline bool __yo_atomic_compare_exchange_int(
  _Atomic int* obj, int* expected, int desired,
  memory_order success, memory_order failure
) {
  return atomic_compare_exchange_strong_explicit(obj, expected, desired, success, failure);
}

// Phase C: size_t atomic wrappers (for AtomicUsize)
static inline size_t __yo_atomic_load_size_t(_Atomic size_t* obj, memory_order order) {
  return atomic_load_explicit(obj, order);
}
static inline void __yo_atomic_store_size_t(_Atomic size_t* obj, size_t desired, memory_order order) {
  atomic_store_explicit(obj, desired, order);
}
static inline size_t __yo_atomic_exchange_size_t(_Atomic size_t* obj, size_t desired, memory_order order) {
  return atomic_exchange_explicit(obj, desired, order);
}
static inline bool __yo_atomic_compare_exchange_size_t(
  _Atomic size_t* obj, size_t* expected, size_t desired,
  memory_order success, memory_order failure
) {
  return atomic_compare_exchange_strong_explicit(obj, expected, desired, success, failure);
}

// Phase C: long-long atomic wrappers (for AtomicI64)
static inline long long __yo_atomic_load_llong(_Atomic long long* obj, memory_order order) {
  return atomic_load_explicit(obj, order);
}
static inline void __yo_atomic_store_llong(_Atomic long long* obj, long long desired, memory_order order) {
  atomic_store_explicit(obj, desired, order);
}
static inline long long __yo_atomic_exchange_llong(_Atomic long long* obj, long long desired, memory_order order) {
  return atomic_exchange_explicit(obj, desired, order);
}
static inline bool __yo_atomic_compare_exchange_llong(
  _Atomic long long* obj, long long* expected, long long desired,
  memory_order success, memory_order failure
) {
  return atomic_compare_exchange_strong_explicit(obj, expected, desired, success, failure);
}

// Phase C: signed narrow atomic wrappers
static inline int8_t __yo_atomic_load_schar(_Atomic signed char* obj, memory_order order) {
  return atomic_load_explicit(obj, order);
}
static inline void __yo_atomic_store_schar(_Atomic signed char* obj, int8_t desired, memory_order order) {
  atomic_store_explicit(obj, desired, order);
}
static inline int8_t __yo_atomic_exchange_schar(_Atomic signed char* obj, int8_t desired, memory_order order) {
  return atomic_exchange_explicit(obj, desired, order);
}
static inline bool __yo_atomic_compare_exchange_schar(
  _Atomic signed char* obj, int8_t* expected, int8_t desired,
  memory_order success, memory_order failure
) { return atomic_compare_exchange_strong_explicit(obj, expected, desired, success, failure); }

static inline int16_t __yo_atomic_load_short(_Atomic short* obj, memory_order order) {
  return atomic_load_explicit(obj, order);
}
static inline void __yo_atomic_store_short(_Atomic short* obj, int16_t desired, memory_order order) {
  atomic_store_explicit(obj, desired, order);
}
static inline int16_t __yo_atomic_exchange_short(_Atomic short* obj, int16_t desired, memory_order order) {
  return atomic_exchange_explicit(obj, desired, order);
}
static inline bool __yo_atomic_compare_exchange_short(
  _Atomic short* obj, int16_t* expected, int16_t desired,
  memory_order success, memory_order failure
) { return atomic_compare_exchange_strong_explicit(obj, expected, desired, success, failure); }

// Phase C: unsigned atomic wrappers
static inline uint8_t __yo_atomic_load_uchar(_Atomic unsigned char* obj, memory_order order) {
  return atomic_load_explicit(obj, order);
}
static inline void __yo_atomic_store_uchar(_Atomic unsigned char* obj, uint8_t desired, memory_order order) {
  atomic_store_explicit(obj, desired, order);
}
static inline uint8_t __yo_atomic_exchange_uchar(_Atomic unsigned char* obj, uint8_t desired, memory_order order) {
  return atomic_exchange_explicit(obj, desired, order);
}
static inline bool __yo_atomic_compare_exchange_uchar(
  _Atomic unsigned char* obj, uint8_t* expected, uint8_t desired,
  memory_order success, memory_order failure
) { return atomic_compare_exchange_strong_explicit(obj, expected, desired, success, failure); }

static inline uint16_t __yo_atomic_load_ushort(_Atomic unsigned short* obj, memory_order order) {
  return atomic_load_explicit(obj, order);
}
static inline void __yo_atomic_store_ushort(_Atomic unsigned short* obj, uint16_t desired, memory_order order) {
  atomic_store_explicit(obj, desired, order);
}
static inline uint16_t __yo_atomic_exchange_ushort(_Atomic unsigned short* obj, uint16_t desired, memory_order order) {
  return atomic_exchange_explicit(obj, desired, order);
}
static inline bool __yo_atomic_compare_exchange_ushort(
  _Atomic unsigned short* obj, uint16_t* expected, uint16_t desired,
  memory_order success, memory_order failure
) { return atomic_compare_exchange_strong_explicit(obj, expected, desired, success, failure); }

static inline uint32_t __yo_atomic_load_uint(_Atomic unsigned int* obj, memory_order order) {
  return atomic_load_explicit(obj, order);
}
static inline void __yo_atomic_store_uint(_Atomic unsigned int* obj, uint32_t desired, memory_order order) {
  atomic_store_explicit(obj, desired, order);
}
static inline uint32_t __yo_atomic_exchange_uint(_Atomic unsigned int* obj, uint32_t desired, memory_order order) {
  return atomic_exchange_explicit(obj, desired, order);
}
static inline bool __yo_atomic_compare_exchange_uint(
  _Atomic unsigned int* obj, uint32_t* expected, uint32_t desired,
  memory_order success, memory_order failure
) { return atomic_compare_exchange_strong_explicit(obj, expected, desired, success, failure); }

static inline uint64_t __yo_atomic_load_ullong(_Atomic unsigned long long* obj, memory_order order) {
  return atomic_load_explicit(obj, order);
}
static inline void __yo_atomic_store_ullong(_Atomic unsigned long long* obj, uint64_t desired, memory_order order) {
  atomic_store_explicit(obj, desired, order);
}
static inline uint64_t __yo_atomic_exchange_ullong(_Atomic unsigned long long* obj, uint64_t desired, memory_order order) {
  return atomic_exchange_explicit(obj, desired, order);
}
static inline bool __yo_atomic_compare_exchange_ullong(
  _Atomic unsigned long long* obj, uint64_t* expected, uint64_t desired,
  memory_order success, memory_order failure
) { return atomic_compare_exchange_strong_explicit(obj, expected, desired, success, failure); }

// Phase C: isize wrapper
static inline ptrdiff_t __yo_atomic_load_ptrdiff(_Atomic ptrdiff_t* obj, memory_order order) {
  return atomic_load_explicit(obj, order);
}
static inline void __yo_atomic_store_ptrdiff(_Atomic ptrdiff_t* obj, ptrdiff_t desired, memory_order order) {
  atomic_store_explicit(obj, desired, order);
}
static inline ptrdiff_t __yo_atomic_exchange_ptrdiff(_Atomic ptrdiff_t* obj, ptrdiff_t desired, memory_order order) {
  return atomic_exchange_explicit(obj, desired, order);
}
static inline bool __yo_atomic_compare_exchange_ptrdiff(
  _Atomic ptrdiff_t* obj, ptrdiff_t* expected, ptrdiff_t desired,
  memory_order success, memory_order failure
) { return atomic_compare_exchange_strong_explicit(obj, expected, desired, success, failure); }

/**
 * Create and initialize a mutex (stack-allocated value)
 * Returns an initialized mutex that can be used with __yo_mutex_lock/unlock
 */
static __YO_THREAD_SYNC_TYPE __yo_mutex_create(void) {
  __YO_THREAD_SYNC_TYPE mutex;
  __yo_mutex_init(&mutex);
  return mutex;
}

/**
 * Create and initialize a condition variable (stack-allocated value)
 * Returns an initialized condition variable that can be used with __yo_cond_wait/signal/broadcast
 */
static __YO_COND_TYPE __yo_cond_create(void) {
  __YO_COND_TYPE cond;
  __yo_cond_init(&cond);
  return cond;
}

// Forward declare __yo_thread_gc_state_t for use in __yo_ref_header_t
typedef struct __yo_thread_gc_state __yo_thread_gc_state_t;
`);

  // Conditionally emit header struct: smaller when no types need cycle GC
  if (context.needsCycleGC) {
    context.emitter.emitDeclarationLine(`
// Reference counting header - non-atomic RC with cycle collection support
typedef struct __yo_ref_header_t {
  // Packed into one 8-byte word (P2 memory): ref_count u32 (4B refs is far more
  // than addressable memory can hold), gc_mark/gc_flags as bytes, borrow_count u16.
  // Shrinks the header 64 -> 56 B, saving ~8 B on every RC object (~40M in the
  // self-compile ⇒ ~0.3 GB). gc_mark holds __yo_gc_mark_t values 0..4.
  uint32_t ref_count;
  uint8_t gc_flags;
  uint8_t gc_mark;
  uint16_t borrow_count;  // Law-of-Exclusivity flag: # of live interior refs into this object
  // dispose_fn sits IMMEDIATELY after the packed word so the small header
  // below is a strict PREFIX of this one: __yo_decr_rc reads flags and
  // dispose_fn at the same offsets for both layouts, branch-free.
  void (*dispose_fn)(void*);
  void (*traverse_fn)(void*, void (*visit)(void*));
  struct __yo_ref_header_t* gc_next;
  struct __yo_ref_header_t* gc_prev;
  struct __yo_ref_header_t* roots_next;  // Bacon-Rajan possible-roots intrusive list (O(1) unlink at free)
  struct __yo_ref_header_t* roots_prev;
} __yo_ref_header_t;

// Small RC header (16 B) for cycle-INCAPABLE, non-atomic types — the ones
// whose constructors never __yo_gc_register. Every GC visitor early-returns
// on !(gc_flags & __YO_GC_TRACKED), so these objects' traverse_fn and GC
// list pointers were never read; this drops them (56 -> 16 B on the
// majority class — see plans/backlog/RC_HEADER_SPLIT.md). A strict prefix
// of __yo_ref_header_t: generic code (__yo_incr_rc/__yo_decr_rc, borrow
// checks, visitor flag reads) casts every object to __yo_ref_header_t* and
// touches only the shared prefix on untracked objects.
typedef struct __yo_ref_header_small_t {
  uint32_t ref_count;
  uint8_t gc_flags;
  uint8_t gc_mark;
  uint16_t borrow_count;
  void (*dispose_fn)(void*);
} __yo_ref_header_small_t;

// Per-thread GC state
struct __yo_thread_gc_state {
  __yo_ref_header_t* tracked_objects;
  size_t tracked_count;
  size_t thread_id;
  size_t alloc_count;
  __yo_ref_header_t* possible_roots;   // Bacon-Rajan: head of the possible-roots list (objects decremented to non-zero)
  size_t possible_roots_count;         // length of possible_roots (collection trigger)
  __yo_ref_header_t** gc_white;        // scratch buffer: white (garbage) objects gathered during a collection
  size_t gc_white_count;
  size_t gc_white_cap;
  __yo_thread_gc_state_t* next;
  __yo_thread_gc_state_t* prev;
};`);
  } else {
    context.emitter.emitDeclarationLine(`
// Lightweight reference counting header — no cycle detection fields
// Uses type_id dispatch instead of function pointer for dispose (faster in WASM: br_table vs call_indirect)
typedef struct __yo_ref_header_t {
  uint32_t ref_count;     // u32 (4B refs >> addressable memory); matches the atomic-RC casts
  uint16_t type_id;
  uint16_t borrow_count;  // Law-of-Exclusivity flag (fits in existing tail padding: 0 extra bytes)
} __yo_ref_header_t;`);
  }

  context.emitter.emitDeclarationLine(`
// Generic Future type - used by async runtime for type-agnostic operations
// All concrete Future types share this same layout for common fields
typedef struct {
  __yo_ref_header_t header;
  __yo_future_state_t state;
  void* state_machine;
  void (*state_machine_dispose_fn)(void*);
  void (*resume_fn)(void*);
  void* continuation_fn;
  void* continuation_sm;
  bool detached;
  // Note: concrete Future types may have additional fields (e.g., result) after this
} __yo_future_generic_t;

// Generic I/O Future type for extern "Yo" functions returning Impl Future(T)
// This has the same layout as async state machines (state, result, continuation_fn, continuation_sm)
// so the await codegen can access ->state and ->result uniformly
typedef struct __yo_io_future_t {
  __yo_ref_header_t header;                       // Reference counting (must be first)
  _Atomic int state;                            // Future state (0 = pending, -1 = completed)
  int32_t result;                               // The result value (bytes read/written or -errno)
  _Atomic(void (*)(void*)) continuation_fn;     // Continuation function
  _Atomic(void*) continuation_sm;               // Continuation state machine
} __yo_io_future_t;

// Forward declarations will be added here if needed
`);

  // Forward declarations - generate struct and enum forward declarations first
  for (const typeId in context.types) {
    const { type, cName } = context.types[typeId]!;
    if (typeContainsSomeType(type)) {
      // Exception: struct or enum whose SomeType is only inside function-typed
      // fields (effect records like Io, Exception, or Option(FnType)).
      if (
        !(
          isStructType(type) && structSomeTypeIsOnlyInFunctionFieldsLocal(type)
        ) &&
        !(isEnumType(type) && enumSomeTypeIsOnlyInFunctionFieldsLocal(type))
      ) {
        continue; // Skip types that contain `SomeType` as they are not concrete types
      }
    }

    // Skip forward declarations for extern C types — the C header provides them
    if (type.isExtern === "c" && type.externName) {
      continue;
    }

    if (isFutureTraitType(type)) {
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

  // Generate the builtin str type
  generateStrTypeDeclaration(context);

  // Generate Iso types
  generateIsoTypeDeclarations(context);

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
    // Skip extern C types — the C header provides their definition
    if (type.isExtern === "c" && type.externName) {
      continue;
    }

    if (isEnumType(type) && canOptimizeAsSimpleEnum(type)) {
      generateEnumDeclaration(type, cName, context);
    }
  }

  // Second pass: Collect structs, complex enums, and tuples for topological sorting
  const structsAndEnumsAndTuples: Array<{
    typeId: string;
    type: StructType | EnumType | TupleType;
    cName: string;
    kind: "struct" | "enum" | "tuple";
  }> = [];

  for (const typeId in context.types) {
    const { type, cName } = context.types[typeId]!;
    if (typeContainsSomeType(type)) {
      // Exception: struct or enum whose only SomeType source is its
      // function-typed fields (e.g., Io, Exception with generic fn-ptr
      // fields, or Option(EvaluateExprRawFn) with fn-typed variant field).
      if (
        !(
          isStructType(type) && structSomeTypeIsOnlyInFunctionFieldsLocal(type)
        ) &&
        !(isEnumType(type) && enumSomeTypeIsOnlyInFunctionFieldsLocal(type))
      ) {
        continue;
      }
    }
    // Skip extern C types — the C header provides their definition
    if (type.isExtern === "c" && type.externName) {
      continue;
    }

    if (isStructType(type)) {
      structsAndEnumsAndTuples.push({ typeId, type, cName, kind: "struct" });
    } else if (
      isEnumType(type) &&
      !canOptimizeAsSimpleEnum(type) &&
      !canOptimizeAsNullablePointer(type)
    ) {
      structsAndEnumsAndTuples.push({ typeId, type, cName, kind: "enum" });
    } else if (isTupleType(type)) {
      structsAndEnumsAndTuples.push({ typeId, type, cName, kind: "tuple" });
    }
  }

  // Build dependency graph
  // An edge from A to B means B must be defined before A
  const dependencies = new Map<string, Set<string>>();
  const typeIdToData = new Map(
    structsAndEnumsAndTuples.map((e) => [e.typeId, e])
  );
  const cNameToTypeId = new Map(
    structsAndEnumsAndTuples.map((e) => [e.cName, e.typeId])
  );

  // Helper function to extract the pointee type from a field type
  // Handles: PtrType, and enums optimized as nullable pointers (e.g., Option(*(T)))
  function extractPointeeNewtypeFromFieldType(
    fieldType: Type
  ): StructType | null {
    // Case 1: Direct pointer type (e.g., *(String))
    if (isPtrType(fieldType)) {
      const ptrType = fieldType as PtrType;
      const pointeeType = ptrType.childType;
      if (isStructType(pointeeType) && pointeeType.isNewtype) {
        return pointeeType;
      }
    }
    // Case 2: Enum optimized as nullable pointer (e.g., Option(*(String)))
    else if (isEnumType(fieldType)) {
      const nullablePtrType = canOptimizeAsNullablePointer(
        fieldType as EnumType
      );
      if (nullablePtrType && isPtrType(nullablePtrType)) {
        const ptrType = nullablePtrType as PtrType;
        const pointeeType = ptrType.childType;
        if (isStructType(pointeeType) && pointeeType.isNewtype) {
          return pointeeType;
        }
      }
    }
    return null;
  }

  for (const { typeId, type, kind } of structsAndEnumsAndTuples) {
    dependencies.set(typeId, new Set());

    if (kind === "struct" && isStructType(type)) {
      // Check if struct contains enums or value structs by value
      for (const field of type.fields) {
        // Resolve SomeType to concrete type if possible
        let fieldType = field.type;
        if (isSomeType(fieldType) && fieldType.resolvedConcreteType) {
          fieldType = fieldType.resolvedConcreteType;
        }

        // First, check for pointer-to-newtype dependencies (including nullable pointer optimized enums)
        // This handles cases like: ?*(String) which becomes String* in C
        const pointeeNewtype = extractPointeeNewtypeFromFieldType(fieldType);
        if (pointeeNewtype) {
          const depCName = getTypeString(pointeeNewtype, context);
          const depTypeId = cNameToTypeId.get(depCName);
          if (
            depTypeId &&
            depTypeId !== typeId &&
            typeIdToData.has(depTypeId)
          ) {
            dependencies.get(typeId)!.add(depTypeId);
          }
        }

        if (isEnumType(fieldType)) {
          // Skip enums that are optimized as nullable pointers - they don't need to be defined first
          // since they become simple pointer types in C
          if (!canOptimizeAsNullablePointer(fieldType as EnumType)) {
            const depCName = getTypeString(fieldType, context);
            const depTypeId = cNameToTypeId.get(depCName);
            if (
              depTypeId &&
              depTypeId !== typeId &&
              typeIdToData.has(depTypeId)
            ) {
              dependencies.get(typeId)!.add(depTypeId);
            }
          }
        }
        // Newtypes (typedef aliases) need to be defined first, even when behind a pointer
        // because we use the typedef name (not struct name) in the pointer declaration
        else if (isStructType(fieldType) && fieldType.isNewtype) {
          const depCName = getTypeString(fieldType, context);
          const depTypeId = cNameToTypeId.get(depCName);
          if (
            depTypeId &&
            depTypeId !== typeId &&
            typeIdToData.has(depTypeId)
          ) {
            dependencies.get(typeId)!.add(depTypeId);
          }
        }
        // Value structs (non-object, non-newtype) need to be defined first
        else if (
          isStructType(fieldType) &&
          !fieldType.isReferenceSemantics &&
          !fieldType.isNewtype
        ) {
          const depCName = getTypeString(fieldType, context);
          const depTypeId = cNameToTypeId.get(depCName);
          if (
            depTypeId &&
            depTypeId !== typeId &&
            typeIdToData.has(depTypeId)
          ) {
            dependencies.get(typeId)!.add(depTypeId);
          }
        }
        // Tuples used by value need to be defined first
        else if (isTupleType(fieldType)) {
          const depCName = getTypeString(fieldType, context);
          const depTypeId = cNameToTypeId.get(depCName);
          if (
            depTypeId &&
            depTypeId !== typeId &&
            typeIdToData.has(depTypeId)
          ) {
            dependencies.get(typeId)!.add(depTypeId);
          }
        }
      }
    } else if (kind === "enum" && isEnumType(type)) {
      // Check if enum contains other enums or structs by value
      for (const variant of type.variants) {
        if (variant.fields) {
          for (const field of variant.fields) {
            // Resolve SomeType to concrete type if possible
            let fieldType = field.type;
            if (isSomeType(fieldType) && fieldType.resolvedConcreteType) {
              fieldType = fieldType.resolvedConcreteType;
            }
            // Enums by value need to be defined first
            if (isEnumType(fieldType)) {
              const depCName = getTypeString(fieldType, context);
              const depTypeId = cNameToTypeId.get(depCName);
              if (
                depTypeId &&
                depTypeId !== typeId &&
                typeIdToData.has(depTypeId)
              ) {
                dependencies.get(typeId)!.add(depTypeId);
              }
            }
            // Newtypes (value types) need to be defined first
            else if (isStructType(fieldType) && fieldType.isNewtype) {
              const depCName = getTypeString(fieldType, context);
              const depTypeId = cNameToTypeId.get(depCName);
              if (
                depTypeId &&
                depTypeId !== typeId &&
                typeIdToData.has(depTypeId)
              ) {
                dependencies.get(typeId)!.add(depTypeId);
              }
            }
            // Tuples used by value need to be defined first
            else if (isTupleType(fieldType)) {
              const depCName = getTypeString(fieldType, context);
              const depTypeId = cNameToTypeId.get(depCName);
              if (
                depTypeId &&
                depTypeId !== typeId &&
                typeIdToData.has(depTypeId)
              ) {
                dependencies.get(typeId)!.add(depTypeId);
              }
            }
            // Value structs (non-object, non-newtype) used by value need to be defined first
            else if (
              isStructType(fieldType) &&
              !fieldType.isReferenceSemantics &&
              !fieldType.isNewtype
            ) {
              const depCName = getTypeString(fieldType, context);
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
    } else if (kind === "tuple" && isTupleType(type)) {
      // Check if tuple contains other tuples, structs, or enums by value
      for (const field of type.fields) {
        // Resolve SomeType to concrete type if possible
        let fieldType = field.type;
        if (isSomeType(fieldType) && fieldType.resolvedConcreteType) {
          fieldType = fieldType.resolvedConcreteType;
        }
        // Nested tuples need to be defined first
        if (isTupleType(fieldType)) {
          const depCName = getTypeString(fieldType, context);
          const depTypeId = cNameToTypeId.get(depCName);
          if (
            depTypeId &&
            depTypeId !== typeId &&
            typeIdToData.has(depTypeId)
          ) {
            dependencies.get(typeId)!.add(depTypeId);
          }
        }
        // Enums by value need to be defined first
        else if (isEnumType(fieldType)) {
          const depCName = getTypeString(fieldType, context);
          const depTypeId = cNameToTypeId.get(depCName);
          if (
            depTypeId &&
            depTypeId !== typeId &&
            typeIdToData.has(depTypeId)
          ) {
            dependencies.get(typeId)!.add(depTypeId);
          }
        }
        // Newtypes (value types) need to be defined first
        else if (isStructType(fieldType) && fieldType.isNewtype) {
          const depCName = getTypeString(fieldType, context);
          const depTypeId = cNameToTypeId.get(depCName);
          if (
            depTypeId &&
            depTypeId !== typeId &&
            typeIdToData.has(depTypeId)
          ) {
            dependencies.get(typeId)!.add(depTypeId);
          }
        }
        // Value structs (non-object, non-newtype) need to be defined first
        else if (
          isStructType(fieldType) &&
          !fieldType.isReferenceSemantics &&
          !fieldType.isNewtype
        ) {
          const depCName = getTypeString(fieldType, context);
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
    type: StructType | EnumType | TupleType;
    cName: string;
    kind: "struct" | "enum" | "tuple";
  }> = [];

  while (queue.length > 0) {
    const typeId = queue.shift()!;
    const typeData = typeIdToData.get(typeId)!;
    sortedTypes.push({
      type: typeData.type,
      cName: typeData.cName,
      kind: typeData.kind,
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
  if (sortedTypes.length < structsAndEnumsAndTuples.length) {
    for (const item of structsAndEnumsAndTuples) {
      if (!sortedTypes.find((t) => t.cName === item.cName)) {
        sortedTypes.push({
          type: item.type,
          cName: item.cName,
          kind: item.kind,
        });
      }
    }
  }

  // Generate Dyn type forward declarations before struct/enum types
  // since enums (e.g., Option(Dyn(Error))) may contain Dyn types by value
  generateDynForwardDeclarations(context);

  // Generate types in sorted order
  for (const { type, cName, kind } of sortedTypes) {
    if (kind === "struct" && isStructType(type)) {
      generateStructDeclaration(type, cName, context);
    } else if (kind === "enum" && isEnumType(type)) {
      generateEnumDeclaration(type, cName, context);
    } else if (kind === "tuple" && isTupleType(type)) {
      generateTupleDeclaration(type, cName, context);
    }
  }

  // Fourth pass: Generate nullable pointer optimized enums
  for (const typeId in context.types) {
    const { type, cName } = context.types[typeId]!;
    if (typeContainsSomeType(type)) {
      if (
        !(
          isStructType(type) && structSomeTypeIsOnlyInFunctionFieldsLocal(type)
        ) &&
        !(isEnumType(type) && enumSomeTypeIsOnlyInFunctionFieldsLocal(type))
      ) {
        continue;
      }
    }
    // Skip extern C types — the C header provides their definition
    if (type.isExtern === "c" && type.externName) {
      continue;
    }

    if (isEnumType(type) && canOptimizeAsNullablePointer(type)) {
      generateEnumDeclaration(type, cName, context);
    }
  }

  // Fifth pass: Generate other type declarations (closures, dyn, unions, futures)
  for (const typeId in context.types) {
    const { type, cName } = context.types[typeId]!;
    if (typeContainsSomeType(type)) {
      continue; // Skip types that contain `SomeType` as they are not concrete types
    }
    // Skip extern C types — the C header provides their definition
    if (type.isExtern === "c" && type.externName) {
      continue;
    }

    if (isDynType(type)) {
      generateDynDeclaration(type, cName, context);
    } else if (isUnionType(type)) {
      generateUnionDeclaration(type, cName, context);
    } else if (isFutureTraitType(type)) {
      generateFutureTraitDeclaration(type, cName, context);
    }
    // Note: Tuples are now handled in the topologically sorted third pass
    // Note: isEnumType and isStructType are handled in the passes above
  }
}

function generateFutureTraitDeclaration(
  type: FutureTraitType,
  cName: string,
  context: CodeGenContext
): void {
  const emitter = context.emitter;
  const resultType = type.isFuture.outputType;
  const resultTypeCName = getTypeString(resultType, context);

  emitter.emitDeclarationLine(
    `struct ${cName}_struct { // Generic Future interface for ${typeToString(type)}`
  );
  emitter.emitDeclarationLine(`  __yo_ref_header_t header;`);
  emitter.emitDeclarationLine(
    `  int state;  // 0 = cold, -1 = completed, -2 = aborted`
  );
  if (isUnitType(resultType)) {
    emitter.emitDeclarationLine(`  uint8_t result;`);
  } else {
    emitter.emitDeclarationLine(`  ${resultTypeCName} result;`);
  }
  emitter.emitDeclarationLine(`  void (*continuation_fn)(void*);`);
  emitter.emitDeclarationLine(`  void* continuation_sm;`);
  emitter.emitDeclarationLine(`  void (*__yo_resume_fn)(void*);`);
  emitter.emitDeclarationLine(
    `  void (*__yo_set_effect_fn)(void*, const char*, void*);`
  );
  emitter.emitDeclarationLine(`};`);
  emitter.emitDeclarationLine("");
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
 * Generate the builtin `str` type declaration
 */
export function generateStrTypeDeclaration(context: CodeGenContext): void {
  const emitter = context.emitter;
  // str — builtin static string view (always emitted; trivially small).
  emitter.emitDeclarationLine(
    `typedef struct { // str: builtin static string view`
  );
  emitter.emitDeclarationLine(`  const uint8_t* ptr;`);
  emitter.emitDeclarationLine(`  size_t len;`);
  emitter.emitDeclarationLine(`} __yo_str;`);
  emitter.emitDeclarationLine("");
}

/**
 * Generate Iso struct type declarations and helper functions
 */
export function generateIsoTypeDeclarations(context: CodeGenContext): void {
  const emitter = context.emitter;
  if (!context.isoTypes) return;

  // Generate Iso struct types and constructor declarations
  for (const [isoTypeName, isoInfo] of context.isoTypes) {
    const { childTypeCName, structGenerated } = isoInfo;

    // Skip if struct already generated
    if (structGenerated) continue;

    // Generate Iso struct type
    emitter.emitDeclarationLine(`typedef struct { // Iso wrapper struct`);
    emitter.emitDeclarationLine(
      `  __yo_ref_header_t header; // Atomic RC header`
    );
    emitter.emitDeclarationLine(`  _Atomic bool extracted; // Extraction flag`);
    emitter.emitDeclarationLine(`  ${childTypeCName} value; // Inner value`);
    emitter.emitDeclarationLine(`} ${isoTypeName}_struct;`);
    emitter.emitDeclarationLine(
      `typedef ${isoTypeName}_struct* ${isoTypeName};`
    );
    emitter.emitDeclarationLine("");

    // Generate constructor function declaration
    emitter.emitDeclarationLine(
      `${isoTypeName} __yo_create_iso_${isoTypeName}(${childTypeCName} value);`
    );
    emitter.emitDeclarationLine("");

    // Mark struct as generated
    isoInfo.structGenerated = true;
  }

  // Generate extract function declarations and implementations
  for (const [isoTypeName, isoInfo] of context.isoTypes) {
    const { childTypeCName, extractGenerated } = isoInfo;

    // Skip if already generated
    if (extractGenerated) continue;

    // Generate extract function declaration
    emitter.emitDeclarationLine(
      `${childTypeCName} __yo_iso_extract_${isoTypeName}(${isoTypeName} iso);`
    );
  }

  // Generate dispose function declarations for Iso types
  // __yo_iso_dispose_ is called from the evaluator-generated ___dispose function
  // __yo_dispose_iso_ is the internal one called when RC hits 0 (via dispose_fn pointer)
  for (const [isoTypeName, isoInfo] of context.isoTypes) {
    const { structGenerated } = isoInfo;
    if (!structGenerated) continue;

    emitter.emitDeclarationLine(
      `void __yo_iso_dispose_${isoTypeName}(${isoTypeName} iso);`
    );
    emitter.emitDeclarationLine(
      `static void __yo_dispose_iso_${isoTypeName}(void* ptr);`
    );
  }

  // Generate constructor function implementations
  for (const [isoTypeName, isoInfo] of context.isoTypes) {
    const { childTypeCName, createGenerated } = isoInfo;

    // Skip if constructor already generated
    if (createGenerated) continue;

    const isoDisposeName = `__yo_dispose_iso_${isoTypeName}`;
    let isoDisposeAssignment: string;
    if (context.needsCycleGC) {
      isoDisposeAssignment = `  iso->header.dispose_fn = ${isoDisposeName};`;
    } else {
      if (!context.disposeTypeIds) {
        context.disposeTypeIds = new Map();
        context.nextDisposeTypeId = 1;
      }
      let typeId = context.disposeTypeIds.get(isoDisposeName);
      if (typeId === undefined) {
        typeId = context.nextDisposeTypeId!;
        context.nextDisposeTypeId = typeId + 1;
        context.disposeTypeIds.set(isoDisposeName, typeId);
      }
      isoDisposeAssignment = `  iso->header.type_id = ${typeId};`;
    }
    const isoGcInit = context.needsCycleGC
      ? `\n  iso->header.gc_mark = __YO_GC_UNMARKED;\n  iso->header.gc_flags = 0;`
      : "";

    emitter.emitLine(`
${isoTypeName} __yo_create_iso_${isoTypeName}(${childTypeCName} value) {
  ${isoTypeName} iso = (${isoTypeName})__yo_malloc(sizeof(${isoTypeName}_struct));
  iso->header.ref_count = 1;
  iso->header.borrow_count = 0;${isoGcInit}
${isoDisposeAssignment}
  atomic_store(&iso->extracted, false);
  iso->value = value;
  return iso;
}`);

    // Mark as generated
    isoInfo.createGenerated = true;
  }

  // Generate dispose function implementations for Iso types
  // The dispose function drops the inner value if it hasn't been extracted
  for (const [isoTypeName, isoInfo] of context.isoTypes) {
    const { isoType, createGenerated, disposeGenerated } = isoInfo;
    if (!createGenerated || !isoType || disposeGenerated) continue;

    // Determine how to drop the inner value based on its type
    const childType = isoType.childType;
    let dropInnerCode: string;

    // Check if the child type has a ___drop function we should call
    const dropFn = childType.trait?.fields.find(
      (f) => f.label === BuiltinFunctions.___drop[0]
    );

    if (dropFn?.assignedValue && context.functions) {
      // Find the C function name for the drop function
      const funcId = (dropFn.assignedValue as { funcId: string }).funcId;
      const funcEntry = context.functions[funcId];
      if (funcEntry?.cName) {
        dropInnerCode = `${funcEntry.cName}(iso->value);`;
      } else {
        // Fallback: use __yo_decr_rc for object types
        dropInnerCode = `__yo_decr_rc((void*)iso->value);`;
      }
    } else {
      // Default: use __yo_decr_rc for reference types
      dropInnerCode = `__yo_decr_rc((void*)iso->value);`;
    }

    // Public dispose function - called from evaluator-generated ___dispose
    emitter.emitLine(`
void __yo_iso_dispose_${isoTypeName}(${isoTypeName} iso) {
  // Only drop inner value if it wasn't extracted
  if (!atomic_load(&iso->extracted)) {
    ${dropInnerCode}
  }
}`);

    // Internal dispose function - called when RC hits 0 via dispose_fn pointer
    emitter.emitLine(`
static void __yo_dispose_iso_${isoTypeName}(void* ptr) {
  __yo_iso_dispose_${isoTypeName}((${isoTypeName})ptr);
}`);

    // Mark as generated
    isoInfo.disposeGenerated = true;
  }

  // Generate extract function implementations
  for (const [isoTypeName, isoInfo] of context.isoTypes) {
    const { childTypeCName, isoType, extractGenerated } = isoInfo;

    // Skip if already generated
    if (extractGenerated || !isoType) continue;

    emitter.emitLine(`
${childTypeCName} __yo_iso_extract_${isoTypeName}(${isoTypeName} iso) {
  // Atomically check and set extracted flag
  bool was_extracted = atomic_exchange(&iso->extracted, true);
  if (was_extracted) {
    fprintf(stderr, "panic: Iso::extract() called on already-extracted Iso\\n");
    abort();
  }
    return iso->value;
}`);

    // Mark extract as generated
    isoInfo.extractGenerated = true;
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

  // For Impl closures, we use true static dispatch with a direct function pointer
  // No vtable is needed - the call function pointer is embedded directly in the struct
  // Impl closures are VALUE TYPES (like Rust closures) - no reference counting
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

  // Generate the closure structure with direct call function pointer (static dispatch)
  // Impl closures are value types - no __yo_ref_header_t, stack-allocated
  // IMPORTANT: Use named-struct form to match our forward declaration pattern.
  emitter.emitDeclarationLine(
    `struct ${cName}_struct { // Impl Closure : ${typeToString(functionType)} (static dispatch, value type)`
  );
  // Direct function pointer for static dispatch (no vtable indirection)
  emitter.emitDeclarationLine(
    `  ${returnTypeStr} (*call)(void* self${paramList ? ", " + paramList : ""}); // Direct call function pointer`
  );
  // Data field is always void* to allow different capture types for same closure type
  emitter.emitDeclarationLine(
    `  void* data; // Captured data (pointer to stack-allocated capture struct)`
  );
  // Dispose function pointer for cleanup when closure goes out of scope
  emitter.emitDeclarationLine(
    `  void (*dispose)(void* self); // Dispose function for cleanup`
  );

  emitter.emitDeclarationLine(`};`);
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
    const runtimeFields = getRuntimeStructFields(structType);
    // For object, generate a struct with the common reference header
    const atomicTag = structType.isAtomicRc ? " atomic" : "";
    emitter.emitDeclarationLine(
      `struct ${cName}_struct { // ${structType.typeName} : ${typeToString(structType)} (${atomicTag ? "atomic " : ""}reference counted)`
    );
    if (
      typeUsesSmallRcHeader(
        structType,
        context.needsCycleGC ?? false,
        structType.env
      )
    ) {
      emitter.emitDeclarationLine(
        `  __yo_ref_header_small_t header; // Small RC header (cycle-incapable type)`
      );
    } else {
      emitter.emitDeclarationLine(
        `  __yo_ref_header_t header; // ${atomicTag ? "Atomic r" : "R"}eference count header`
      );
    }

    for (const field of runtimeFields) {
      const fieldTypeStr = getTypeString(field.type, context);
      const fieldName = sanitizeForCIdentifier(field.label);
      emitter.emitDeclarationLine(`  ${fieldTypeStr} ${fieldName};`);
    }

    emitter.emitDeclarationLine(`};`);
  } else {
    const runtimeFields = getRuntimeStructFields(structType);
    // For regular struct, generate as before
    emitter.emitDeclarationLine(
      `struct ${cName}_struct { // ${structType.typeName} : ${typeToString(structType)}`
    );

    for (const field of runtimeFields) {
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

  if (tupleType.fields.length === 0) {
    // Unit type (zero-sized type in Rust)
    // C doesn't support zero-sized structs in standard C11
    // Use a dummy byte to make it valid C (will be optimized away by compiler)
    emitter.emitDeclarationLine(`  uint8_t _dummy; // zero-sized type marker`);
  } else {
    for (let i = 0; i < tupleType.fields.length; i++) {
      const field = tupleType.fields[i]!;
      const fieldTypeStr = getTypeString(field.type, context);
      // Tuples always use numeric field names _0, _1, _2... in C
      const fieldName = `_${i}`;
      emitter.emitDeclarationLine(`  ${fieldTypeStr} ${fieldName};`);
    }
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
        const discriminant = variant.discriminant ?? BigInt(i);
        emitter.emitDeclarationLine(`  ${tagName} = ${discriminant}${comma}`);
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
      const discriminant = variant.discriminant ?? BigInt(i);
      emitter.emitDeclarationLine(`  ${tagName} = ${discriminant}${comma}`);
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

  // Generate the main tagged union struct. A reference-semantics enum
  // (`ref(enum(…))`) is a heap-allocated, RC-managed handle (like an object):
  // prepend the reference-count header, and the `${cName}` typedef is a pointer
  // to this struct (see the forward-declaration site). Mirrors the struct
  // reference-semantics layout. plans/REF_REFERENCE_SEMANTICS.md Phase 3.
  if (enumType.isReferenceSemantics) {
    const atomicTag = enumType.isAtomicRc ? "atomic " : "";
    emitter.emitDeclarationLine(
      `struct ${cName}_struct { // ${enumType.typeName} : ${typeToString(enumType)} (${atomicTag}reference counted)`
    );
    if (
      typeUsesSmallRcHeader(
        enumType,
        context.needsCycleGC ?? false,
        enumType.env
      )
    ) {
      emitter.emitDeclarationLine(
        `  __yo_ref_header_small_t header; // Small RC header (cycle-incapable type)`
      );
    } else {
      emitter.emitDeclarationLine(
        `  __yo_ref_header_t header; // ${enumType.isAtomicRc ? "Atomic r" : "R"}eference count header`
      );
    }
    emitter.emitDeclarationLine(`  ${tagEnumName} tag;`);
    emitter.emitDeclarationLine(`  ${variantUnionName} data;`);
    emitter.emitDeclarationLine(`};`);
    emitter.emitDeclarationLine("");
    return;
  }

  emitter.emitDeclarationLine(
    `struct ${cName}_struct { // ${enumType.typeName} : ${typeToString(enumType)}`
  );

  emitter.emitDeclarationLine(`  ${tagEnumName} tag;`);
  emitter.emitDeclarationLine(`  ${variantUnionName} data;`);

  emitter.emitDeclarationLine(`};`);
  emitter.emitDeclarationLine("");
}

// Re-export dyn functions from dyn.ts
export {
  generateDynBoxTypes,
  generateDynDeclaration,
  generateDynForwardDeclarations,
} from "./dyn";

// Import for internal use
import { generateDynDeclaration, generateDynForwardDeclarations } from "./dyn";
