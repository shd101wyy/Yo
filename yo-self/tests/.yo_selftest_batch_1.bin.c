#define _DEFAULT_SOURCE
#define _GNU_SOURCE  // Needed for sched_getcpu() on Linux

#include <stdio.h>
#include <stdatomic.h>
#include <errno.h>
#include <stdint.h>
#include <string.h>
#include <stdbool.h>
#include <fcntl.h>
#include <stdarg.h>
#include <stdlib.h>
#include <stddef.h>
#include <unistd.h>
#include <sys/stat.h>
#include <sys/random.h>

// Using libc allocator
#define __yo_malloc malloc
#define __yo_calloc calloc
#define __yo_realloc realloc
#define __yo_free free
#define __yo_aligned_alloc aligned_alloc
#define __yo_aligned_free free


// Module (self-hosted codegen)

// Future state enum - shared by all Future types
typedef enum {
  __YO_FUTURE_RUNNING = 0,
  __YO_FUTURE_COMPLETED = 1,
  __YO_FUTURE_ERROR = 2
} __yo_future_state_t;

// Non-atomic Reference Counting with Thread-Local Cycle Collection
// Based on QuickJS trial deletion algorithm
// See CYCLE_COLLECTION.md for design details

// Debug flag for GC operations - use --debug-gc flag to enable
// #define __YO_DEBUG_GC 1

#ifdef __YO_DEBUG_GC
  #define GC_DEBUG(...) fprintf(stderr, "GC: " __VA_ARGS__)
#else
  #define GC_DEBUG(...)
#endif

// Debug flag for parallelism operations - use --debug-parallelism flag to enable
// #define __YO_DEBUG_PARALLELISM 1

#ifdef __YO_DEBUG_PARALLELISM
  #define PARALLELISM_DEBUG(...) fprintf(stderr, __VA_ARGS__)
#else
  #define PARALLELISM_DEBUG(...)
#endif

// Debug flag for async/await operations - use --debug-async-await flag to enable
// #define __YO_DEBUG_ASYNC_AWAIT 1

#ifdef __YO_DEBUG_ASYNC_AWAIT
  #define ASYNC_DEBUG(...) fprintf(stderr, "ASYNC: " __VA_ARGS__)
#else
  #define ASYNC_DEBUG(...)
#endif

// GC mark states for QuickJS-style trial deletion cycle collection
typedef enum {
  __YO_GC_UNMARKED = 0,
  __YO_GC_CANDIDATE = 1,
  __YO_GC_TRIAL_DELETED = 2,
  __YO_GC_LIVE = 3,
  __YO_GC_GARBAGE = 4
} __yo_gc_mark_t;

// GC flags
#define __YO_GC_TRACKED              0x01
#define __YO_GC_BUFFERED             0x02

// Thread synchronization for stop-the-world GC (POSIX)
#include <pthread.h>
#include <unistd.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/sysctl.h>
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
#define __yo_thread_self() ((uintptr_t)pthread_self())

// Thread handle type for parallelism - value type, stack allocated
typedef struct __yo_thread_t {
  __YO_THREAD_TYPE handle;
} __yo_thread_t;

// Thread callback type for spawn
typedef void (*__yo_thread_fn)(void* closure);

static __YO_THREAD_SYNC_TYPE __yo_mutex_create(void);
static __YO_COND_TYPE __yo_cond_create(void);

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

static __YO_THREAD_SYNC_TYPE __yo_mutex_create(void) {
  __YO_THREAD_SYNC_TYPE mutex;
  __yo_mutex_init(&mutex);
  return mutex;
}

static __YO_COND_TYPE __yo_cond_create(void) {
  __YO_COND_TYPE cond;
  __yo_cond_init(&cond);
  return cond;
}

// Forward declare __yo_thread_gc_state_t for use in __yo_ref_header_t
typedef struct __yo_thread_gc_state __yo_thread_gc_state_t;


// Reference counting header - non-atomic RC with cycle collection support
typedef struct __yo_ref_header_t {
  // Packed into one 8-byte word (P2 memory): ref_count u32 (4B refs >> addressable
  // memory), gc_mark/gc_flags as bytes, borrow_count u16. Shrinks the header 64 -> 56 B,
  // saving ~8 B/object; e.g. ArrayList 88 -> 80 crosses the 96 -> 80 malloc class
  // (~0.4 GB at self-compile scale). gc_mark holds __yo_gc_mark_t values 0..4.
  uint32_t ref_count;
  uint8_t gc_flags;
  uint8_t gc_mark;
  uint16_t borrow_count;
  struct __yo_ref_header_t* gc_next;
  struct __yo_ref_header_t* gc_prev;
  struct __yo_ref_header_t* roots_next;  // Bacon-Rajan possible-roots intrusive list (O(1) unlink at free)
  struct __yo_ref_header_t* roots_prev;
  void (*dispose_fn)(void*);
  void (*traverse_fn)(void*, void (*visit)(void*));
} __yo_ref_header_t;

// Per-thread GC state
struct __yo_thread_gc_state {
  __yo_ref_header_t* tracked_objects;
  size_t tracked_count;
  size_t thread_id;
  size_t alloc_count;
  __yo_ref_header_t* possible_roots;   // Bacon-Rajan: head of the possible-roots list
  size_t possible_roots_count;         // length of possible_roots (collection trigger)
  __yo_ref_header_t** gc_white;        // scratch buffer: white (garbage) objects gathered during a collection
  size_t gc_white_count;
  size_t gc_white_cap;
  __yo_thread_gc_state_t* next;
  __yo_thread_gc_state_t* prev;
};

// Generic Future type - used by async runtime for type-agnostic operations
typedef struct {
  __yo_ref_header_t header;
  __yo_future_state_t state;
  void* state_machine;
  void (*state_machine_dispose_fn)(void*);
  void (*resume_fn)(void*);
  void* continuation_fn;
  void* continuation_sm;
  bool detached;
} __yo_future_generic_t;

// Generic I/O Future type for extern "Yo" functions returning Impl Future(T)
typedef struct __yo_io_future_t {
  __yo_ref_header_t header;
  _Atomic int state;
  int32_t result;
  _Atomic(void (*)(void*)) continuation_fn;
  _Atomic(void*) continuation_sm;
} __yo_io_future_t;

// Forward declarations will be added here if needed

typedef struct __yo_t30_struct __yo_t30; // Forward declaration
typedef struct __yo_t18_struct __yo_t18; // Forward declaration
typedef struct __yo_t40_struct __yo_t40; // Forward declaration
typedef struct __yo_t29_struct __yo_t29; // Forward declaration
typedef struct __yo_t24_struct __yo_t24; // Forward declaration
typedef struct __yo_t9_struct __yo_t9; // Forward declaration
typedef struct __yo_t28_struct __yo_t28; // Forward declaration
typedef struct __yo_t15_struct __yo_t15; // Forward declaration
typedef struct __yo_t33_struct __yo_t33; // Forward declaration
typedef struct __yo_t34_struct __yo_t34; // Forward declaration
typedef struct __yo_t21_struct __yo_t21; // Forward declaration
typedef struct __yo_t13_struct __yo_t13; // Forward declaration
typedef struct __yo_t43_struct __yo_t43; // Forward declaration
typedef struct __yo_t19_struct __yo_t19; // Forward declaration
typedef struct __yo_t4_struct __yo_t4; // Forward declaration
typedef struct __yo_t11_struct __yo_t11; // Forward declaration
typedef struct __yo_t14_struct __yo_t14; // Forward declaration
typedef struct __yo_t6_struct __yo_t6; // Forward declaration
typedef struct __yo_t16_struct __yo_t16; // Forward declaration
typedef struct __yo_t20_struct __yo_t20; // Forward declaration
typedef struct __yo_t23_struct __yo_t23; // Forward declaration
typedef struct __yo_t31_struct __yo_t31; // Forward declaration
typedef struct __yo_t2_struct __yo_t2; // Forward declaration
typedef struct __yo_t22_struct __yo_t22; // Forward declaration
typedef struct __yo_t27_struct __yo_t27; // Forward declaration
typedef struct __yo_t36_struct __yo_t36; // Forward declaration
typedef struct __yo_t7_struct __yo_t7; // Forward declaration
typedef struct __yo_t35_struct __yo_t35; // Forward declaration
typedef struct __yo_t12_struct __yo_t12; // Forward declaration
typedef struct __yo_t0_struct __yo_t0; // Forward declaration

typedef struct { // str: builtin static string view
  const uint8_t* ptr;
  size_t len;
} __yo_str;

typedef enum { // AllocError : AllocError (optimized as simple enum)
  __YO_T8_OUTOFMEMORY = 0,
  __YO_T8_INVALIDSIZE = 1,
  __YO_T8_INVALIDALIGNMENT = 2,
  __YO_T8_INVALIDPOINTER = 3
} __yo_t8;

typedef enum {
  __YO_T30_NONE = 0,
  __YO_T30_SOME = 1
} __yo_t30_tag;

typedef union {
  struct {
    int32_t value;
  } Some;
} __yo_t30_data;

struct __yo_t30_struct { //  : <enum:enum_yo_id_4422>
  __yo_t30_tag tag;
  __yo_t30_data data;
};

struct __yo_t40_struct { //  : <struct:struct_yo_id_5365>
  __yo_str Linux;
  __yo_str Macos;
  __yo_str Windows;
  __yo_str FreeBSD;
  __yo_str Emscripten;
  __yo_str Wasi;
};

typedef enum {
  __YO_T29_NONE = 0,
  __YO_T29_SOME = 1
} __yo_t29_tag;

typedef union {
  struct {
    __yo_t28* value;
  } Some;
} __yo_t29_data;

struct __yo_t29_struct { //  : <enum:enum_yo_id_9762>
  __yo_t29_tag tag;
  __yo_t29_data data;
};

struct __yo_t24_struct { //  : <struct:struct_yo_id_3822> (reference counted)
  __yo_ref_header_t header; // Reference count header
  size_t* _ptr;
  size_t _length;
  size_t _capacity;
};

struct __yo_t15_struct { //  : <struct:struct_yo_id_5904>
  uint8_t** ptr;
  size_t len;
};

typedef enum {
  __YO_T33_OK = 0,
  __YO_T33_ERR = 1
} __yo_t33_tag;

typedef union {
  struct {
    void* value;
  } Ok;
  struct {
    void* error;
  } Err;
} __yo_t33_data;

struct __yo_t33_struct { //  : <enum:enum_yo_id_2709>
  __yo_t33_tag tag;
  __yo_t33_data data;
};

typedef enum {
  __YO_T13_INVALIDUTF8 = 0,
  __YO_T13_INDEXOUTOFBOUNDS = 1
} __yo_t13_tag;

typedef union {
  struct {
    size_t index;
    size_t length;
  } IndexOutOfBounds;
} __yo_t13_data;

struct __yo_t13_struct { // StringError : StringError
  __yo_t13_tag tag;
  __yo_t13_data data;
};

struct __yo_t43_struct { //  : <struct:struct_yo_id_3115> (reference counted)
  __yo_ref_header_t header; // Reference count header
  void** _ptr;
  size_t _length;
  size_t _capacity;
};

struct __yo_t19_struct { // Path : Path (reference counted)
  __yo_ref_header_t header; // Reference count header
  __yo_t16* _segments;
  bool _is_absolute;
};

typedef enum {
  __YO_T4_NONE = 0,
  __YO_T4_SOME = 1
} __yo_t4_tag;

typedef union {
  struct {
    void* value;
  } Some;
} __yo_t4_data;

struct __yo_t4_struct { //  : <enum:enum_yo_id_2453>
  __yo_t4_tag tag;
  __yo_t4_data data;
};

typedef enum {
  __YO_T11_NONE = 0,
  __YO_T11_SOME = 1
} __yo_t11_tag;

typedef union {
  struct {
    __yo_t0* value;
  } Some;
} __yo_t11_data;

struct __yo_t11_struct { //  : <enum:enum_yo_id_3280>
  __yo_t11_tag tag;
  __yo_t11_data data;
};

struct __yo_t14_struct { //  : <struct:struct_yo_id_2164>
  void** ptr;
  size_t len;
};

typedef enum {
  __YO_T20_NONE = 0,
  __YO_T20_SOME = 1
} __yo_t20_tag;

typedef union {
  struct {
    uint8_t value;
  } Some;
} __yo_t20_data;

struct __yo_t20_struct { //  : <enum:enum_yo_id_3135>
  __yo_t20_tag tag;
  __yo_t20_data data;
};

typedef enum {
  __YO_T23_NONE = 0,
  __YO_T23_SOME = 1
} __yo_t23_tag;

typedef union {
  struct {
    size_t value;
  } Some;
} __yo_t23_data;

struct __yo_t23_struct { //  : <enum:enum_yo_id_3202>
  __yo_t23_tag tag;
  __yo_t23_data data;
};

struct __yo_t31_struct { //  : <struct:struct_yo_id_9852> (reference counted)
  __yo_ref_header_t header; // Reference count header
  __yo_t28** _ptr;
  size_t _length;
  size_t _capacity;
};

struct __yo_t2_struct { //  : <struct:struct_yo_id_3111> (reference counted)
  __yo_ref_header_t header; // Reference count header
  void** _ptr;
  size_t _length;
  size_t _capacity;
};

struct __yo_t22_struct { //  : <struct:struct_yo_id_3296>
  uint8_t* ptr;
  size_t len;
};

struct __yo_t36_struct { // Io : Io
  void* async;
  void* await;
  void* state;
  void* spawn;
};

typedef enum {
  __YO_T7_ALLOCERROR = 0,
  __YO_T7_INDEXOUTOFBOUNDS = 1,
  __YO_T7_EMPTYLIST = 2
} __yo_t7_tag;

typedef union {
  struct {
    __yo_t8 error;
  } AllocError;
  struct {
    size_t index;
    size_t length;
  } IndexOutOfBounds;
} __yo_t7_data;

struct __yo_t7_struct { // ArrayListError : ArrayListError
  __yo_t7_tag tag;
  __yo_t7_data data;
};

struct __yo_t0_struct { //  : <struct:struct_yo_id_3275> (reference counted)
  __yo_ref_header_t header; // Reference count header
  uint8_t* _ptr;
  size_t _length;
  size_t _capacity;
};

typedef uint8_t* __yo_t46; // GcTracer : GcTracer (newtype - zero-cost abstraction)

typedef uint32_t __yo_t26; // rune : rune (newtype - zero-cost abstraction)

typedef __yo_t11 __yo_t10; // String : String (newtype - zero-cost abstraction)

typedef enum {
  __YO_T6_OK = 0,
  __YO_T6_ERR = 1
} __yo_t6_tag;

typedef union {
  struct {
    __yo_t7 error;
  } Err;
} __yo_t6_data;

struct __yo_t6_struct { //  : <enum:enum_yo_id_3132>
  __yo_t6_tag tag;
  __yo_t6_data data;
};

typedef enum {
  __YO_T27_NONE = 0,
  __YO_T27_SOME = 1
} __yo_t27_tag;

typedef union {
  struct {
    __yo_t26 value;
  } Some;
} __yo_t27_data;

struct __yo_t27_struct { //  : <enum:enum_yo_id_2979>
  __yo_t27_tag tag;
  __yo_t27_data data;
};

typedef enum {
  __YO_T18_OK = 0,
  __YO_T18_ERR = 1
} __yo_t18_tag;

typedef union {
  struct {
    __yo_t19* value;
  } Ok;
  struct {
    __yo_t10 error;
  } Err;
} __yo_t18_data;

struct __yo_t18_struct { //  : <enum:enum_yo_id_5983>
  __yo_t18_tag tag;
  __yo_t18_data data;
};

typedef enum {
  __YO_T9_NONE = 0,
  __YO_T9_SOME = 1
} __yo_t9_tag;

typedef union {
  struct {
    __yo_t10 value;
  } Some;
} __yo_t9_data;

struct __yo_t9_struct { //  : <enum:enum_yo_id_4333>
  __yo_t9_tag tag;
  __yo_t9_data data;
};

struct __yo_t28_struct { // SemVer : SemVer (reference counted)
  __yo_ref_header_t header; // Reference count header
  __yo_t10 tag;
  int32_t major;
  int32_t minor;
  int32_t patch;
};

typedef enum {
  __YO_T21_OK = 0,
  __YO_T21_ERR = 1
} __yo_t21_tag;

typedef union {
  struct {
    __yo_t10 error;
  } Err;
} __yo_t21_data;

struct __yo_t21_struct { //  : <enum:enum_yo_id_6003>
  __yo_t21_tag tag;
  __yo_t21_data data;
};

struct __yo_t16_struct { //  : <struct:struct_yo_id_3320> (reference counted)
  __yo_ref_header_t header; // Reference count header
  __yo_t10* _ptr;
  size_t _length;
  size_t _capacity;
};

typedef enum {
  __YO_T12_OK = 0,
  __YO_T12_ERR = 1
} __yo_t12_tag;

typedef union {
  struct {
    __yo_t10 value;
  } Ok;
  struct {
    __yo_t13 error;
  } Err;
} __yo_t12_data;

struct __yo_t12_struct { //  : <enum:enum_yo_id_3287>
  __yo_t12_tag tag;
  __yo_t12_data data;
};

typedef enum {
  __YO_T34_GIT = 0,
  __YO_T34_PATH = 1
} __yo_t34_tag;

typedef union {
  struct {
    __yo_t10 name;
    __yo_t10 url;
    __yo_t9 pinned_ref;
  } Git;
  struct {
    __yo_t10 name;
    __yo_t10 rel_path;
  } Path;
} __yo_t34_data;

struct __yo_t34_struct { // ParsedPackage : ParsedPackage
  __yo_t34_tag tag;
  __yo_t34_data data;
};

typedef enum {
  __YO_T35_OK = 0,
  __YO_T35_ERR = 1
} __yo_t35_tag;

typedef union {
  struct {
    __yo_t34 value;
  } Ok;
  struct {
    __yo_t10 error;
  } Err;
} __yo_t35_data;

struct __yo_t35_struct { //  : <enum:enum_yo_id_9926>
  __yo_t35_tag tag;
  __yo_t35_data data;
};

typedef __yo_t28** __yo_t32; //  : <enum:enum_yo_id_9855> (optimized as nullable pointer)

typedef void* __yo_t5; //  : <enum:enum_yo_id_3085> (optimized as nullable pointer)

typedef size_t* __yo_t25; //  : <enum:enum_yo_id_3825> (optimized as nullable pointer)

typedef __yo_t10* __yo_t17; //  : <enum:enum_yo_id_3323> (optimized as nullable pointer)

typedef void** __yo_t3; //  : <enum:enum_yo_id_2501> (optimized as nullable pointer)

typedef void** __yo_t44; //  : <enum:enum_yo_id_3118> (optimized as nullable pointer)

typedef char* __yo_t39; //  : <enum:enum_yo_id_3096> (optimized as nullable pointer)

typedef uint8_t* __yo_t1; //  : <enum:enum_yo_id_3278> (optimized as nullable pointer)


// Command-line arguments (initialized in main)
typedef struct { uint8_t** data; size_t length; } Slice_uint8_t_u42_;
static int32_t __yo_argc;
static uint8_t** __yo_argv;
static Slice_uint8_t_u42_ __yo_args;

// Function declarations
/// Extern functions

/// Object constructors
static inline void __yo_decr_rc(void* ptr); // Decrement reference count
static inline void* __yo_incr_rc(void* ptr); // Increment reference count
static void __yo_gc_register(void* ptr); // Register object for cycle detection
static void __yo_gc_unregister(void* ptr); // Unregister object from cycle detection
static void __yo_gc_collect(); // Thorough full-heap cycle collection (explicit Gc.collect())
static void __yo_gc_collect_incremental(); // Bacon-Rajan incremental collection (auto-trigger)
static void __yo_gc_add_root(void* ptr); // Bacon-Rajan: buffer a possible cycle root
static void __yo_gc_remove_root(void* ptr); // Bacon-Rajan: unbuffer a possible cycle root
static void __yo_gc_init_thread(); // Initialize thread-local GC state (for worker threads)
static void __yo_cleanup_thread_gc(); // Clean up thread-local GC state
static void __yo_init_process_cleanup(void); // Initialize process cleanup
static __yo_t24* __yo_new___yo_t24(size_t* _ptr, size_t _length, size_t _capacity); // Constructor
static __yo_t28* __yo_new___yo_t28(__yo_t10 tag, int32_t major, int32_t minor, int32_t patch); // Constructor
static __yo_t43* __yo_new___yo_t43(void** _ptr, size_t _length, size_t _capacity); // Constructor
static __yo_t19* __yo_new___yo_t19(__yo_t16* _segments, bool _is_absolute); // Constructor
static __yo_t16* __yo_new___yo_t16(__yo_t10* _ptr, size_t _length, size_t _capacity); // Constructor
static __yo_t31* __yo_new___yo_t31(__yo_t28** _ptr, size_t _length, size_t _capacity); // Constructor
static __yo_t2* __yo_new___yo_t2(void** _ptr, size_t _length, size_t _capacity); // Constructor
static __yo_t0* __yo_new___yo_t0(uint8_t* _ptr, size_t _length, size_t _capacity); // Constructor

/// Closure constructors

/// Capture dispose functions

/// Dyn type constructors

/// Regular functions
static inline void yo_id_3141_rtparam0_R_gs_yo_id_3109_R_struct_yo_id_9715_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_i32_i32_i32_ret_unit(__yo_t31* self);
static inline bool yo_id_122_bool_id_bool_rtparam0_bool_ret_bool(bool self);
static inline __yo_t9 yo_id_5948(__yo_t10 name);
static inline void yo_id_12133(__yo_t24* self);
static inline bool yo_id_3743(__yo_t10 self, __yo_t10 substr, size_t from_index);
static inline __yo_t21 yo_id_6004(__yo_t19* path);
static inline bool yo_id_4019(uint8_t byte);
static inline bool yo_id_9750(__yo_t10 s);
static inline bool yo_id_3903(__yo_t10 self, __yo_t10 suffix, size_t end_position);
static inline __yo_t0* yo_id_3124__ret_R_gs_yo_id_3109_u8();
static inline __yo_t9 yo_id_3136_rtparam0_R_gs_yo_id_3109_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_ret_enum_yo_id_3135_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8(__yo_t16* self);
static inline __yo_t18 yo_id_5984();
static inline size_t yo_id_3119_rtparam0_R_gs_yo_id_3109_u8_ret_usize(__yo_t0* self);
static inline void yo_id_3168_rtparam0_R_gs_yo_id_3109_R_struct_yo_id_9715_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_i32_i32_i32_rtparam1_struct_yo_id_10___u8__ret_unit(__yo_t31* self, __yo_t46 tracer);
static inline int32_t yo_id_9831(__yo_t28* a, __yo_t28* b);
static inline void yo_id_12158(__yo_t31* self);
static inline __yo_t23 yo_id_3138_rtparam0_R_gs_yo_id_3109_usize_rtparam1_usize_ret_enum_yo_id_3135_usize(__yo_t24* self, size_t index);
static inline bool fn_yo_id_3045(__yo_t26 a, __yo_t26 b);
static inline __yo_t10 yo_id_4027(__yo_t10 self);
static inline void yo_id_12_usize_id_usize_rtparam0_struct_yo_id_10___u8__rtparam1___usize__ret_unit(__yo_t46 self, size_t* slot);
static inline __yo_t10 yo_id_3607(__yo_t10 self, __yo_t10 other);
static inline __yo_t16* yo_id_5913();
static inline __yo_t10 yo_id_3356(__yo_str slice);
static inline void yo_id_3141_rtparam0_R_gs_yo_id_3109_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_ret_unit(__yo_t16* self);
static inline __yo_t27 yo_id_3595(__yo_t10 self, size_t index);
static inline void yo_id_12144(__yo_t16* self);
static inline void yo_id_3163_rtparam0_R_gs_yo_id_3109_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_ret_unit(__yo_t16* self);
static inline bool fn_yo_id_3038(__yo_t26 a, __yo_t26 b);
static inline bool yo_id_4217(__yo_t10 self, __yo_t10 haystack, size_t end_position);
static inline __yo_t23 yo_id_3814(__yo_t10 self, __yo_t10 substr, size_t from_index);
static inline void yo_id_3168_rtparam0_R_gs_yo_id_3109_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam1_struct_yo_id_10___u8__ret_unit(__yo_t16* self, __yo_t46 tracer);
static inline __yo_t0* yo_id_3433(__yo_t10 self);
static inline __yo_t6 yo_id_3133_rtparam0_R_gs_yo_id_3109_u8_rtparam1_u8_ret_enum_yo_id_3132_unit_enum_yo_id_3108_enum_yo_id_3055_usize_usize(__yo_t0* self, uint8_t value);
static inline __yo_t10* yo_id_2456_rtparam0_enum_yo_id_3323___struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8__ret___struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_(__yo_t10* self);
static inline void yo_id_4578(__yo_t10 msg);
static inline int32_t yo_id_5908();
static inline void yo_id_12_String_id_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam0_struct_yo_id_10___u8__rtparam1___struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8__ret_unit(__yo_t46 self, __yo_t10* slot);
static inline void yo_id_3163_rtparam0_R_gs_yo_id_3109_u8_ret_unit(__yo_t0* self);
static inline void yo_id_3168_rtparam0_R_gs_yo_id_3109_usize_rtparam1_struct_yo_id_10___u8__ret_unit(__yo_t24* self, __yo_t46 tracer);
static inline __yo_t10 yo_id_3337();
static inline bool yo_id_4220(__yo_t10 self, __yo_t10 haystack, size_t from_index);
static inline bool yo_id_10015(__yo_t10 content, __yo_t10 name);
static inline bool yo_id_5963(__yo_t10 name, __yo_t10 value, bool overwrite);
static inline void yo_id_3163_rtparam0_R_gs_yo_id_3109_usize_ret_unit(__yo_t24* self);
static inline __yo_t16* yo_id_4232(__yo_t10 self, __yo_t10 haystack);
static inline __yo_t19* yo_id_5032(__yo_t10 path_str);
static inline size_t yo_id_3414(__yo_t10 self);
static inline __yo_t9 yo_id_3138_rtparam0_R_gs_yo_id_3109_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam1_usize_ret_enum_yo_id_3135_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8(__yo_t16* self, size_t index);
static inline __yo_t27 yo_id_2991(uint32_t value);
static inline bool yo_id_4278_String_id_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam0_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam1_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam2_usize_ret_bool(__yo_t10 self, __yo_t10 suffix, size_t end_position);
static inline size_t yo_id_3119_rtparam0_R_gs_yo_id_3109_usize_ret_usize(__yo_t24* self);
static inline __yo_t27 yo_id_3454(__yo_t10 self, size_t byte_index);
static inline __yo_t16* yo_id_4285_String_id_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam0_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam1_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_ret_R_gs_yo_id_3109_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8(__yo_t10 self, __yo_t10 separator);
static inline uint8_t* yo_id_3122_rtparam0_R_gs_yo_id_3109_u8_ret_enum_yo_id_3118___u8_(__yo_t0* self);
static inline size_t yo_id_3669(__yo_t10 self);
static inline __yo_t23 yo_id_4228(__yo_t10 self, __yo_t10 haystack, size_t from_index);
static inline __yo_t6 yo_id_3133_rtparam0_R_gs_yo_id_3109_usize_rtparam1_usize_ret_enum_yo_id_3132_unit_enum_yo_id_3108_enum_yo_id_3055_usize_usize(__yo_t24* self, size_t value);
static inline size_t yo_id_3119_rtparam0_R_gs_yo_id_3109_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_ret_usize(__yo_t16* self);
static inline bool yo_id_4436(uint8_t byte);
static inline __yo_t10 yo_id_10071(__yo_t16* dep_names);
static inline uint8_t** yo_id_5910();
static inline bool yo_id_4277_String_id_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam0_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam1_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam2_usize_ret_bool(__yo_t10 self, __yo_t10 prefix, size_t position);
static inline void yo_id_12_u8_id_u8_rtparam0_struct_yo_id_10___u8__rtparam1___u8__ret_unit(__yo_t46 self, uint8_t* slot);
static inline __yo_t10 yo_id_4105(__yo_t10 self, __yo_t10 other);
static inline bool fn_yo_id_3049(__yo_t26 a, __yo_t26 b);
static inline void yo_id_4582(bool flag, __yo_t10 msg);
static inline __yo_t15 yo_id_5905();
static inline void yo_id_12140(__yo_t28* self);
static inline __yo_t28** yo_id_2456_rtparam0_enum_yo_id_9855___R_struct_yo_id_9715_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_i32_i32_i32__ret___R_struct_yo_id_9715_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_i32_i32_i32_(__yo_t28** self);
static inline __yo_t29 yo_id_3138_rtparam0_R_gs_yo_id_3109_R_struct_yo_id_9715_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_i32_i32_i32_rtparam1_usize_ret_enum_yo_id_3135_R_struct_yo_id_9715_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_i32_i32_i32(__yo_t31* self, size_t index);
static inline void yo_id_3141_rtparam0_R_gs_yo_id_3109_u8_ret_unit(__yo_t0* self);
static inline void yo_id_5001_str_id_str_rtparam0_str_ret_unit(__yo_str msg);
static inline bool yo_id_9717(__yo_t10 spec);
static inline __yo_t30 yo_id_4441(__yo_t10 self);
static inline __yo_t16* yo_id_3747(__yo_t10 self, __yo_t10 separator);
static inline __yo_t16* yo_id_3130_rtparam0_usize_ret_R_gs_yo_id_3109_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8(size_t cap);
static inline void yo_id_5002_str_id_str_rtparam0_bool_rtparam1_comptime_str_ret_unit(bool flag, __yo_str msg);
static inline __yo_t10 yo_id_3963(__yo_t10 self, __yo_t10 search_value, __yo_t10 new_value);
static inline __yo_t20 yo_id_3138_rtparam0_R_gs_yo_id_3109_u8_rtparam1_usize_ret_enum_yo_id_3135_u8(__yo_t0* self, size_t index);
static inline void yo_id_3148_rtparam0_R_gs_yo_id_3109_u8_rtparam1_usize_ret_unit(__yo_t0* self, size_t min_cap);
static inline __yo_t23 yo_id_4281_String_id_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam0_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam1_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam2_usize_ret_enum_yo_id_3135_usize(__yo_t10 self, __yo_t10 substr, size_t from_index);
static inline __yo_t0* yo_id_3130_rtparam0_usize_ret_R_gs_yo_id_3109_u8(size_t cap);
static inline bool yo_id_3427(__yo_t10 self);
static inline size_t yo_id_3119_rtparam0_R_gs_yo_id_3109_R_struct_yo_id_9715_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_i32_i32_i32_ret_usize(__yo_t31* self);
static inline void yo_id_3141_rtparam0_R_gs_yo_id_3109_usize_ret_unit(__yo_t24* self);
static inline __yo_t10 yo_id_3684(__yo_t10 self, size_t start, size_t end);
static inline uint8_t* yo_id_3444(__yo_t10 self);
void __yo_user_main();
static inline bool yo_id_4111(__yo_t10 self, __yo_t10 other);
static inline void yo_id_3168_rtparam0_R_gs_yo_id_3109_u8_rtparam1_struct_yo_id_10___u8__ret_unit(__yo_t0* self, __yo_t46 tracer);
static inline bool yo_id_4133(__yo_t10 self, __yo_str other);
static inline __yo_t10 yo_id_4871(__yo_t10* self);
static inline __yo_t10 yo_id_2712_rtparam0_enum_yo_id_3287_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_enum_yo_id_3272_usize_usize_ret_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8(__yo_t12 self);
static inline uint8_t* yo_id_2456_rtparam0_enum_yo_id_3118___u8__ret___u8_(uint8_t* self);
static inline __yo_t23 yo_id_4224(__yo_t10 self, __yo_t10 haystack, size_t from_index);
static inline __yo_t10 yo_id_10277(__yo_t10 content, __yo_t10 dep_line);
static inline __yo_t6 yo_id_3133_rtparam0_R_gs_yo_id_3109_R_struct_yo_id_9715_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_i32_i32_i32_rtparam1_R_struct_yo_id_9715_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_i32_i32_i32_ret_enum_yo_id_3132_unit_enum_yo_id_3108_enum_yo_id_3055_usize_usize(__yo_t31* self, __yo_t28* value);
static inline bool yo_id_4214(__yo_t10 self, __yo_t10 haystack, size_t position);
static inline void yo_id_12172(__yo_t0* self);
static inline void yo_id_12_SemVer_id_R_struct_yo_id_9715_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_i32_i32_i32_rtparam0_struct_yo_id_10___u8__rtparam1___R_struct_yo_id_9715_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_i32_i32_i32__ret_unit(__yo_t46 self, __yo_t28** slot);
static inline __yo_t0* yo_id_3393(__yo_t10 self);
static inline __yo_t10 yo_id_4873(__yo_str* self);
static inline uint8_t* yo_id_3158_rtparam0_R_gs_yo_id_3109_u8_rtparam1_usize_ret___u8_(__yo_t0** self, size_t idx);
static inline __yo_t6 yo_id_3133_rtparam0_R_gs_yo_id_3109_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam1_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_ret_enum_yo_id_3132_unit_enum_yo_id_3108_enum_yo_id_3055_usize_usize(__yo_t16* self, __yo_t10 value);
static inline __yo_t10 yo_id_9731(__yo_t10 url);
static inline bool yo_id_4279_String_id_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam0_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam1_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam2_usize_ret_bool(__yo_t10 self, __yo_t10 substr, size_t from_index);
static inline __yo_t23 yo_id_4283_String_id_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam0_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam1_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam2_usize_ret_enum_yo_id_3135_usize(__yo_t10 self, __yo_t10 substr, size_t from_index);
static inline __yo_t23 yo_id_3716(__yo_t10 self, __yo_t10 substr, size_t from_index);
static inline __yo_t16* yo_id_10027(__yo_t10 content);
static inline bool yo_id_3872(__yo_t10 self, __yo_t10 prefix, size_t position);
static inline __yo_t12 yo_id_3383(uint8_t* cstr);
static inline void yo_id_3149_rtparam0_R_gs_yo_id_3109_u8_rtparam1___u8__rtparam2_usize_ret_unit(__yo_t0* self, uint8_t* src, size_t count);
static inline __yo_t10 fn_yo_id_5312(__yo_t19** self);
static inline __yo_t24* yo_id_3124__ret_R_gs_yo_id_3109_usize();
static inline __yo_t16* yo_id_3124__ret_R_gs_yo_id_3109_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8();
static inline __yo_t29 yo_id_9763(__yo_t10 tag);
static inline __yo_t31* yo_id_3124__ret_R_gs_yo_id_3109_R_struct_yo_id_9715_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_i32_i32_i32();
static inline __yo_t10 yo_id_4570(__yo_t10* self);
static inline __yo_t10 yo_id_10154(__yo_t10 content);
static inline __yo_t9 yo_id_9846(__yo_t10 text);
static inline __yo_t22 yo_id_3439(__yo_t10 self);
static inline __yo_t35 yo_id_9927(__yo_t10 spec);
static inline void yo_id_12142(__yo_t19* self);
static inline void yo_id_3163_rtparam0_R_gs_yo_id_3109_R_struct_yo_id_9715_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_i32_i32_i32_ret_unit(__yo_t31* self);
static inline void* yo_id_2456_rtparam0_enum_yo_id_2455___void__ret___void_(void* self);
/// Closure vtable instances

static _Thread_local int __yo_effect_escaped = 0;  // Thread-local flag for effect record unwind detection
static _Thread_local _Alignas(16) char __yo_unwind_value[64];  // Thread-local buffer for unwind value storage

// Function implementations

// ============================================================================
// File System Helper Functions
// ============================================================================
// These functions help extract fields from struct stat, which has platform-specific layout.

#include <sys/types.h>
#include <sys/stat.h>
#include <dirent.h>
#include <string.h>

#include <sys/dirent.h>
#include <unistd.h>


// Get size of stat buffer (for allocation)
static size_t __yo_stat_buf_size(void) {
  return sizeof(struct stat);
}

// Extract fields from struct stat
static int64_t __yo_stat_size(void* statbuf) {
  return (int64_t)((struct stat*)statbuf)->st_size;
}

static uint32_t __yo_stat_mode(void* statbuf) {
  return (uint32_t)((struct stat*)statbuf)->st_mode;
}

static int64_t __yo_stat_mtime(void* statbuf) {
  return (int64_t)((struct stat*)statbuf)->st_mtime;
}

static int64_t __yo_stat_atime(void* statbuf) {
  return (int64_t)((struct stat*)statbuf)->st_atime;
}

static int64_t __yo_stat_ctime(void* statbuf) {
  return (int64_t)((struct stat*)statbuf)->st_ctime;
}

static uint32_t __yo_stat_uid(void* statbuf) {
  return (uint32_t)((struct stat*)statbuf)->st_uid;
}

static uint32_t __yo_stat_gid(void* statbuf) {
  return (uint32_t)((struct stat*)statbuf)->st_gid;
}

static uint64_t __yo_stat_ino(void* statbuf) {
  return (uint64_t)((struct stat*)statbuf)->st_ino;
}

static uint64_t __yo_stat_dev(void* statbuf) {
  return (uint64_t)((struct stat*)statbuf)->st_dev;
}

static uint64_t __yo_stat_nlink(void* statbuf) {
  return (uint64_t)((struct stat*)statbuf)->st_nlink;
}

// Extract fields from struct dirent
static const char* __yo_dirent_name(void* entry) {
  return ((struct dirent*)entry)->d_name;
}

static uint8_t __yo_dirent_type(void* entry) {
  return ((struct dirent*)entry)->d_type;
}

#include <copyfile.h>
#include <sys/socket.h>  // macOS sendfile()

// Fallback for platforms where sendfile cannot handle all fd combinations
static int32_t __yo_sendfile_fallback_copy(int32_t out_fd, int32_t in_fd, int64_t offset, size_t count) {
  unsigned char buffer[8192];
  size_t total = 0;

  while (total < count) {
  size_t remaining = count - total;
  size_t chunk = remaining < sizeof(buffer) ? remaining : sizeof(buffer);

  ssize_t nread = pread(in_fd, buffer, chunk, (off_t)(offset + (int64_t)total));
  if (nread < 0) {
    return -errno;
  }
  if (nread == 0) {
    break;
  }

  size_t written = 0;
  while (written < (size_t)nread) {
    ssize_t nwrite = write(out_fd, buffer + written, (size_t)nread - written);
    if (nwrite < 0) {
      return -errno;
    }
    written += (size_t)nwrite;
  }

  total += (size_t)nread;
  }

  return (int32_t)total;
}


// ============================================================================
// Synchronous Operations (POSIX-only) - no IoFuture overhead
// ============================================================================

static int32_t __yo_sync_access(int32_t dirfd, const char* path, int32_t mode) {
  int result;
  if (dirfd == -100) {  // AT_FDCWD
  result = access(path, mode);
  } else {
  result = faccessat(dirfd, path, mode, 0);
  }
  return (result < 0) ? -errno : 0;
}

static int32_t __yo_sync_realpath(const char* path, char* resolved) {
  char* result = realpath(path, resolved);
  return result ? 0 : -errno;
}

static int32_t __yo_sync_mkdtemp(char* template) {
  char* result = mkdtemp(template);
  return result ? 0 : -errno;
}

static int32_t __yo_sync_mkstemp(char* template) {
  int fd = mkstemp(template);
  return (fd < 0) ? -errno : fd;
}


static int32_t __yo_sync_copyfile(const char* src, const char* dst, int32_t flags) {
  copyfile_flags_t cf_flags = COPYFILE_ALL;
  if (flags & 1) cf_flags |= COPYFILE_EXCL;
  if (flags & 2) cf_flags |= COPYFILE_CLONE;
  if (flags & 4) cf_flags |= COPYFILE_CLONE_FORCE;

  int result = copyfile(src, dst, NULL, cf_flags);
  return (result < 0) ? -errno : 0;
}


static int32_t __yo_sync_sendfile(int32_t out_fd, int32_t in_fd, int64_t offset, size_t count) {
  off_t len = (off_t)count;
  int result = sendfile(in_fd, out_fd, (off_t)offset, &len, NULL, 0);
  if (result < 0) {
  if (errno == ENOTSOCK || errno == EINVAL || errno == ENOSYS) {
    return __yo_sendfile_fallback_copy(out_fd, in_fd, offset, count);
  }
  return -errno;
  }
  return (int32_t)len;
}


static int32_t __yo_sync_utime(const char* path, int64_t atime_sec, int64_t atime_nsec,
                             int64_t mtime_sec, int64_t mtime_nsec) {
  struct timespec times[2];
  times[0].tv_sec = (time_t)atime_sec;
  times[0].tv_nsec = (long)atime_nsec;
  times[1].tv_sec = (time_t)mtime_sec;
  times[1].tv_nsec = (long)mtime_nsec;
  int result = utimensat(AT_FDCWD, path, times, 0);
  return (result < 0) ? -errno : 0;
}

static int32_t __yo_sync_futime(int32_t fd, int64_t atime_sec, int64_t atime_nsec,
                              int64_t mtime_sec, int64_t mtime_nsec) {
  struct timespec times[2];
  times[0].tv_sec = (time_t)atime_sec;
  times[0].tv_nsec = (long)atime_nsec;
  times[1].tv_sec = (time_t)mtime_sec;
  times[1].tv_nsec = (long)mtime_nsec;
  int result = futimens(fd, times);
  return (result < 0) ? -errno : 0;
}

static int32_t __yo_sync_lutime(const char* path, int64_t atime_sec, int64_t atime_nsec,
                              int64_t mtime_sec, int64_t mtime_nsec) {
  struct timespec times[2];
  times[0].tv_sec = (time_t)atime_sec;
  times[0].tv_nsec = (long)atime_nsec;
  times[1].tv_sec = (time_t)mtime_sec;
  times[1].tv_nsec = (long)mtime_nsec;
  int result = utimensat(AT_FDCWD, path, times, AT_SYMLINK_NOFOLLOW);
  return (result < 0) ? -errno : 0;
}

// Statfs support
#include <sys/statvfs.h>

static int32_t __yo_sync_statfs(const char* path, void* buf) {
  int result = statvfs(path, (struct statvfs*)buf);
  return (result < 0) ? -errno : 0;
}

static size_t __yo_statfs_buf_size(void) {
  return sizeof(struct statvfs);
}

static uint64_t __yo_statfs_type(void* buf) {
  (void)buf;
  return 0;
}

static uint64_t __yo_statfs_bsize(void* buf) {
  return (uint64_t)((struct statvfs*)buf)->f_bsize;
}

static uint64_t __yo_statfs_blocks(void* buf) {
  return (uint64_t)((struct statvfs*)buf)->f_blocks;
}

static uint64_t __yo_statfs_bfree(void* buf) {
  return (uint64_t)((struct statvfs*)buf)->f_bfree;
}

static uint64_t __yo_statfs_bavail(void* buf) {
  return (uint64_t)((struct statvfs*)buf)->f_bavail;
}

static uint64_t __yo_statfs_files(void* buf) {
  return (uint64_t)((struct statvfs*)buf)->f_files;
}

static uint64_t __yo_statfs_ffree(void* buf) {
  return (uint64_t)((struct statvfs*)buf)->f_ffree;
}


// ============================================================================
// Signal Operations
// ============================================================================
#include <signal.h>

static void (*__yo_signal_handlers[32])(void*) = {NULL};
static void* __yo_signal_handler_data[32] = {NULL};

static void __yo_signal_trampoline(int signum) {
  if (signum >= 0 && signum < 32 && __yo_signal_handlers[signum]) {
  __yo_signal_handlers[signum](__yo_signal_handler_data[signum]);
  }
}

static int32_t __yo_signal_start(int32_t signum, void* handler) {
  if (signum < 0 || signum >= 32) return -EINVAL;
  
  __yo_signal_handlers[signum] = (void (*)(void*))handler;
  
  struct sigaction sa;
  memset(&sa, 0, sizeof(sa));
  sa.sa_handler = __yo_signal_trampoline;
  sigemptyset(&sa.sa_mask);
  sa.sa_flags = SA_RESTART;
  
  if (sigaction(signum, &sa, NULL) < 0) {
  return -errno;
  }
  return 0;
}

static int32_t __yo_signal_stop(int32_t signum) {
  if (signum < 0 || signum >= 32) return -EINVAL;
  
  __yo_signal_handlers[signum] = NULL;
  __yo_signal_handler_data[signum] = NULL;
  
  struct sigaction sa;
  memset(&sa, 0, sizeof(sa));
  sa.sa_handler = SIG_DFL;
  sigemptyset(&sa.sa_mask);
  
  if (sigaction(signum, &sa, NULL) < 0) {
  return -errno;
  }
  return 0;
}

static int32_t __yo_kill(int32_t pid, int32_t signum) {
  int result = kill((pid_t)pid, signum);
  return (result < 0) ? -errno : 0;
}


// ============================================================================
// TTY Operations
// ============================================================================
#include <termios.h>
#include <sys/ioctl.h>

static struct termios __yo_orig_termios;
static bool __yo_termios_saved = false;

static int32_t __yo_tty_init(int32_t fd) {
  if (!__yo_termios_saved) {
  if (tcgetattr(fd, &__yo_orig_termios) < 0) {
    return -errno;
  }
  __yo_termios_saved = true;
  }
  return 0;
}

static int32_t __yo_tty_set_mode(int32_t fd, int32_t mode) {
  struct termios t;
  if (tcgetattr(fd, &t) < 0) return -errno;
  
  switch (mode) {
  case 0:  // TTY_MODE_NORMAL
    t = __yo_orig_termios;
    break;
  case 1:  // TTY_MODE_RAW
    t.c_iflag &= ~(BRKINT | ICRNL | INPCK | ISTRIP | IXON);
    t.c_oflag &= ~(OPOST);
    t.c_cflag |= (CS8);
    t.c_lflag &= ~(ECHO | ICANON | IEXTEN | ISIG);
    t.c_cc[VMIN] = 1;
    t.c_cc[VTIME] = 0;
    break;
  case 2:  // TTY_MODE_IO (Unix binary mode)
    t.c_iflag &= ~(ICRNL | IXON);
    t.c_oflag &= ~(OPOST);
    break;
  default:
    return -EINVAL;
  }
  
  if (tcsetattr(fd, TCSAFLUSH, &t) < 0) return -errno;
  return 0;
}

static int32_t __yo_tty_reset_mode(void) {
  if (__yo_termios_saved) {
  if (tcsetattr(STDIN_FILENO, TCSAFLUSH, &__yo_orig_termios) < 0) {
    return -errno;
  }
  }
  return 0;
}

static int32_t __yo_tty_get_winsize(int32_t fd, int32_t* width, int32_t* height) {
  struct winsize ws;
  if (ioctl(fd, TIOCGWINSZ, &ws) < 0) {
  return -errno;
  }
  *width = ws.ws_col;
  *height = ws.ws_row;
  return 0;
}

static int32_t __yo_isatty(int32_t fd) {
  return isatty(fd) ? 1 : 0;
}


// ============================================================================
// Platform-specific sync helpers (macOS)
// ============================================================================

#include <fcntl.h>
#include <unistd.h>
#include <sys/stat.h>
#include <sys/utsname.h>
#include <sys/mman.h>
#include <sys/file.h>
#include <sys/uio.h>
#include <time.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <arpa/inet.h>
#include <sys/un.h>

// ============================================================================
// Synchronous FD Operations (macOS) - no IoFuture overhead
// ============================================================================

static int32_t __yo_sync_pipe(int32_t* pipefd) {
  int result = pipe((int*)pipefd);
  return (result < 0) ? -errno : 0;
}

static int32_t __yo_sync_dup(int32_t oldfd) {
  int result = dup(oldfd);
  return (result < 0) ? -errno : result;
}

static int32_t __yo_sync_dup2(int32_t oldfd, int32_t newfd) {
  int result = dup2(oldfd, newfd);
  return (result < 0) ? -errno : result;
}

static int64_t __yo_sync_lseek(int32_t fd, int64_t offset, int32_t whence) {
  off_t result = lseek(fd, (off_t)offset, whence);
  return (result < 0) ? (int64_t)(-errno) : (int64_t)result;
}

static int32_t __yo_sync_fallocate(int32_t fd, int32_t mode, int64_t offset, int64_t length) {
  if (offset < 0 || length < 0) return -EINVAL;

  uint64_t target_u = (uint64_t)offset + (uint64_t)length;
  if (target_u > 0x7FFFFFFFFFFFFFFFULL) return -EINVAL;
  off_t target = (off_t)target_u;
  if ((uint64_t)target != target_u) return -EINVAL;

  fstore_t store;
  memset(&store, 0, sizeof(store));
  store.fst_flags = F_ALLOCATECONTIG;
  store.fst_posmode = F_VOLPOSMODE;
  store.fst_offset = (off_t)offset;
  store.fst_length = (off_t)length;

  int result = fcntl(fd, F_PREALLOCATE, &store);
  if (result < 0) {
    store.fst_flags = F_ALLOCATEALL;
    result = fcntl(fd, F_PREALLOCATE, &store);
  }
  if (result < 0) {
    int alloc_errno = errno;

    // Some filesystems may not support F_PREALLOCATE. Keep a best-effort
    // fallocate behavior for basic allocation modes.
    if (alloc_errno == ENOTSUP || alloc_errno == EOPNOTSUPP || alloc_errno == ENOSYS || alloc_errno == EINVAL) {
      // FALLOC_FL_KEEP_SIZE = 0x01
      if ((mode & 0x01) != 0) {
        return 0;
      }
      if (ftruncate(fd, target) < 0) return -errno;
      return 0;
    }

    return -alloc_errno;
  }

  // FALLOC_FL_KEEP_SIZE = 0x01
  if ((mode & 0x01) == 0) {
    struct stat st;
    if (fstat(fd, &st) < 0) return -errno;
    if (st.st_size < target) {
      if (ftruncate(fd, target) < 0) return -errno;
    }
  }

  return 0;
}

static int32_t __yo_sync_fcntl_getfl(int32_t fd) {
  int result = fcntl(fd, F_GETFL, 0);
  return (result < 0) ? -errno : result;
}

static int32_t __yo_sync_fcntl_setfl(int32_t fd, int32_t flags) {
  int result = fcntl(fd, F_SETFL, flags);
  return (result < 0) ? -errno : 0;
}

static int32_t __yo_sync_fcntl_getfd(int32_t fd) {
  int result = fcntl(fd, F_GETFD, 0);
  return (result < 0) ? -errno : result;
}

static int32_t __yo_sync_fcntl_setfd(int32_t fd, int32_t flags) {
  int result = fcntl(fd, F_SETFD, flags);
  return (result < 0) ? -errno : 0;
}

static int32_t __yo_sync_flock(int32_t fd, int32_t operation) {
  int result = flock(fd, operation);
  return (result < 0) ? -errno : 0;
}

static int32_t __yo_sync_readv(int32_t fd, void* iov, int32_t iovcnt) {
  ssize_t result = readv(fd, (const struct iovec*)iov, (int)iovcnt);
  return (result < 0) ? -errno : (int32_t)result;
}

static int32_t __yo_sync_writev(int32_t fd, void* iov, int32_t iovcnt) {
  ssize_t result = writev(fd, (const struct iovec*)iov, (int)iovcnt);
  return (result < 0) ? -errno : (int32_t)result;
}

static int32_t __yo_sync_preadv(int32_t fd, void* iov, int32_t iovcnt, int64_t offset) {
  struct iovec* vec = (struct iovec*)iov;
  ssize_t total = 0;
  off_t current = (off_t)offset;

  for (int32_t i = 0; i < iovcnt; i++) {
    if (vec[i].iov_len == 0) continue;
    ssize_t n = pread(fd, vec[i].iov_base, vec[i].iov_len, current);
    if (n < 0) {
      return (total > 0) ? (int32_t)total : -errno;
    }
    total += n;
    if ((size_t)n < vec[i].iov_len) {
      break;
    }
    current += (off_t)n;
  }

  return (int32_t)total;
}

static int32_t __yo_sync_pwritev(int32_t fd, void* iov, int32_t iovcnt, int64_t offset) {
  struct iovec* vec = (struct iovec*)iov;
  ssize_t total = 0;
  off_t current = (off_t)offset;

  for (int32_t i = 0; i < iovcnt; i++) {
    if (vec[i].iov_len == 0) continue;
    ssize_t n = pwrite(fd, vec[i].iov_base, vec[i].iov_len, current);
    if (n < 0) {
      return (total > 0) ? (int32_t)total : -errno;
    }
    total += n;
    if ((size_t)n < vec[i].iov_len) {
      break;
    }
    current += (off_t)n;
  }

  return (int32_t)total;
}

static size_t __yo_iovec_size(void) {
  return sizeof(struct iovec);
}

static void __yo_iovec_set(void* iov, size_t index, void* base, size_t len) {
  struct iovec* vec = (struct iovec*)iov;
  vec[index].iov_base = base;
  vec[index].iov_len = len;
}

static int32_t __yo_sync_fadvise(int32_t fd, int64_t offset, int64_t len, int32_t advice) {
  (void)fd;
  (void)offset;
  (void)len;
  (void)advice;
  // No direct equivalent on macOS; treat as advisory no-op.
  return 0;
}

static int32_t __yo_sync_madvise(uint8_t* addr, size_t length, int32_t advice) {
  int result = madvise((void*)addr, length, advice);
  return (result < 0) ? -errno : 0;
}

static uint8_t* __yo_sync_mmap(uint8_t* addr, size_t length, int32_t prot, int32_t flags, int32_t fd, int64_t offset) {
  void* result = mmap((void*)addr, length, prot, flags, fd, (off_t)offset);
  if (result == MAP_FAILED) {
    return (uint8_t*)(intptr_t)(-errno);
  }
  return (uint8_t*)result;
}

static bool __yo_sync_mmap_is_error(uint8_t* addr) {
  intptr_t value = (intptr_t)addr;
  return (value < 0) && (value >= -65535);
}

static int32_t __yo_sync_mmap_errno(uint8_t* addr) {
  intptr_t value = (intptr_t)addr;
  if ((value < 0) && (value >= -65535)) {
    return (int32_t)(-value);
  }
  return 0;
}

static int32_t __yo_sync_munmap(uint8_t* addr, size_t length) {
  int result = munmap((void*)addr, length);
  return (result < 0) ? -errno : 0;
}

static int32_t __yo_sync_mprotect(uint8_t* addr, size_t length, int32_t prot) {
  int result = mprotect((void*)addr, length, prot);
  return (result < 0) ? -errno : 0;
}

static int32_t __yo_sync_msync(uint8_t* addr, size_t length, int32_t flags) {
  int result = msync((void*)addr, length, flags);
  return (result < 0) ? -errno : 0;
}

static int32_t __yo_sync_fchmod(int32_t fd, uint32_t mode) {
  int result = fchmod(fd, (mode_t)mode);
  return (result < 0) ? -errno : 0;
}

static int32_t __yo_sync_fchmodat(int32_t dirfd, const char* path, uint32_t mode, int32_t flags) {
  int result;
  if (dirfd == -100) {
    result = chmod(path, (mode_t)mode);
  } else {
    result = fchmodat(dirfd, path, (mode_t)mode, flags);
  }
  return (result < 0) ? -errno : 0;
}

static int32_t __yo_sync_fchown(int32_t fd, uint32_t uid, uint32_t gid) {
  int result = fchown(fd, (uid_t)uid, (gid_t)gid);
  return (result < 0) ? -errno : 0;
}

static int32_t __yo_sync_fchownat(int32_t dirfd, const char* path, uint32_t uid, uint32_t gid, int32_t flags) {
  int result;
  if (dirfd == -100) {
    if (flags & AT_SYMLINK_NOFOLLOW) {
      result = lchown(path, (uid_t)uid, (gid_t)gid);
    } else {
      result = chown(path, (uid_t)uid, (gid_t)gid);
    }
  } else {
    result = fchownat(dirfd, path, (uid_t)uid, (gid_t)gid, flags);
  }
  return (result < 0) ? -errno : 0;
}

static int32_t __yo_sync_readlinkat(int32_t dirfd, const char* path, char* buf, size_t bufsize) {
  ssize_t result;
  if (dirfd == -100) {
    result = readlink(path, buf, bufsize);
  } else {
    result = readlinkat(dirfd, path, buf, bufsize);
  }
  return (result < 0) ? -errno : (int32_t)result;
}

// Sync getsockname - get local socket address
static int32_t __yo_sync_getsockname(int32_t sockfd, void* addr, uint32_t* addrlen) {
  socklen_t len = (socklen_t)(*addrlen);
  int result = getsockname(sockfd, (struct sockaddr*)addr, &len);
  if (result < 0) {
    return -errno;
  }
  *addrlen = (uint32_t)len;
  return 0;
}

// Sync getpeername - get remote peer address
static int32_t __yo_sync_getpeername(int32_t sockfd, void* addr, uint32_t* addrlen) {
  socklen_t len = (socklen_t)(*addrlen);
  int result = getpeername(sockfd, (struct sockaddr*)addr, &len);
  if (result < 0) {
    return -errno;
  }
  *addrlen = (uint32_t)len;
  return 0;
}

// Sync setsockopt - set socket option value
static int32_t __yo_sync_setsockopt(int32_t sockfd, int32_t level, int32_t optname,
                                     const void* optval, uint32_t optlen) {
  int result = setsockopt(sockfd, level, optname, optval, (socklen_t)optlen);
  return (result < 0) ? -errno : 0;
}

// Sync getsockopt - get socket option value
static int32_t __yo_sync_getsockopt(int32_t sockfd, int32_t level, int32_t optname,
                                     void* optval, uint32_t* optlen) {
  socklen_t len = (socklen_t)(*optlen);
  int result = getsockopt(sockfd, level, optname, optval, &len);
  if (result < 0) {
    return -errno;
  }
  *optlen = (uint32_t)len;
  return 0;
}

// Sync socketpair - create a connected socket pair
static int32_t __yo_sync_socketpair(int32_t domain, int32_t sock_type, int32_t protocol, int32_t* sv) {
  int result = socketpair(domain, sock_type, protocol, (int*)sv);
  return (result < 0) ? -errno : 0;
}

// Sync clock_gettime - read current clock time
static int32_t __yo_sync_clock_gettime(int32_t clock_id, int64_t* sec, int64_t* nsec) {
  struct timespec ts;
  int result = clock_gettime((clockid_t)clock_id, &ts);
  if (result < 0) {
    return -errno;
  }
  *sec = (int64_t)ts.tv_sec;
  *nsec = (int64_t)ts.tv_nsec;
  return 0;
}

// Sync uname - system identification
static int32_t __yo_sync_uname(void* buf) {
  int result = uname((struct utsname*)buf);
  return (result < 0) ? -errno : 0;
}

// Sync gethostname - read host name
static int32_t __yo_sync_gethostname(char* name, size_t len) {
  int result = gethostname(name, len);
  if (result < 0) {
    return -errno;
  }
  if (len > 0) {
    name[len - 1] = '\0';
  }
  return 0;
}

// Sync umask - set process file mode creation mask
static int32_t __yo_sync_umask(int32_t mask) {
  mode_t prev = umask((mode_t)mask);
  return (int32_t)prev;
}

// ============================================================================
// Socket Address Helpers (macOS)
// ============================================================================

static size_t __yo_sockaddr_in_size(void) {
  return sizeof(struct sockaddr_in);
}

static size_t __yo_sockaddr_in6_size(void) {
  return sizeof(struct sockaddr_in6);
}

static size_t __yo_sockaddr_un_size(void) {
  return sizeof(struct sockaddr_un);
}

static size_t __yo_sockaddr_storage_size(void) {
  return sizeof(struct sockaddr_storage);
}

static void __yo_sockaddr_set_family(void* addr, uint16_t family) {
  ((struct sockaddr*)addr)->sa_family = family;
}

static uint16_t __yo_sockaddr_get_family(void* addr) {
  return ((struct sockaddr*)addr)->sa_family;
}

static void __yo_sockaddr_in_set_port(void* addr, uint16_t port) {
  ((struct sockaddr_in*)addr)->sin_port = htons(port);
}

static uint16_t __yo_sockaddr_in_get_port(void* addr) {
  return ntohs(((struct sockaddr_in*)addr)->sin_port);
}

static void __yo_sockaddr_in_set_addr(void* addr, uint32_t ip) {
  ((struct sockaddr_in*)addr)->sin_addr.s_addr = ip;
}

static uint32_t __yo_sockaddr_in_get_addr(void* addr) {
  return ((struct sockaddr_in*)addr)->sin_addr.s_addr;
}

static void __yo_sockaddr_in6_set_port(void* addr, uint16_t port) {
  ((struct sockaddr_in6*)addr)->sin6_port = htons(port);
}

static uint16_t __yo_sockaddr_in6_get_port(void* addr) {
  return ntohs(((struct sockaddr_in6*)addr)->sin6_port);
}

static void __yo_sockaddr_in6_set_addr(void* addr, const void* ip) {
  memcpy(&((struct sockaddr_in6*)addr)->sin6_addr, ip, 16);
}

static void __yo_sockaddr_in6_get_addr(void* addr, void* out) {
  memcpy(out, &((struct sockaddr_in6*)addr)->sin6_addr, 16);
}

static void __yo_sockaddr_un_set_path(void* addr, const char* path) {
  strncpy(((struct sockaddr_un*)addr)->sun_path, path, sizeof(((struct sockaddr_un*)addr)->sun_path) - 1);
}

static char* __yo_sockaddr_un_get_path(void* addr) {
  return ((struct sockaddr_un*)addr)->sun_path;
}

static int32_t __yo_inet_pton(int32_t af, const char* src, void* dst) {
  return inet_pton(af, src, dst);
}

static char* __yo_inet_ntop(int32_t af, const void* src, char* dst, uint32_t size) {
  return (char*)inet_ntop(af, src, dst, (socklen_t)size);
}

static uint16_t __yo_htons(uint16_t hostshort) {
  return htons(hostshort);
}

static uint16_t __yo_ntohs(uint16_t netshort) {
  return ntohs(netshort);
}

static uint32_t __yo_htonl(uint32_t hostlong) {
  return htonl(hostlong);
}

static uint32_t __yo_ntohl(uint32_t netlong) {
  return ntohl(netlong);
}

// Synchronous file operations
static int32_t __yo_file_open(const char* path, int32_t flags, int32_t mode) {
  int fd = open(path, flags, mode);
  int result = fd >= 0 ? fd : -errno;
  ASYNC_DEBUG("[Io] open(%s, 0x%x, 0%o) = %d\n", path, flags, mode, result);
  return result;
}

static void __yo_file_close(int32_t fd) {
  ASYNC_DEBUG("[Io] close(%d)\n", fd);
  close(fd);
}

static int64_t __yo_file_size(int32_t fd) {
  struct stat st;
  if (fstat(fd, &st) < 0) {
    int result = -errno;
    ASYNC_DEBUG("[Io] fstat(%d) failed: %d\n", fd, result);
    return result;
  }
  ASYNC_DEBUG("[Io] fstat(%d) = %lld bytes\n", fd, (long long)st.st_size);
  return st.st_size;
}

// On macOS, we use struct stat instead of struct statx
// These functions wrap struct stat access to match the Linux statx API
static size_t __yo_statx_buf_size(void) {
  return sizeof(struct stat);
}

static int64_t __yo_statx_size(void* statxbuf) {
  return (int64_t)((struct stat*)statxbuf)->st_size;
}

static uint32_t __yo_statx_mode(void* statxbuf) {
  return (uint32_t)((struct stat*)statxbuf)->st_mode;
}

static int64_t __yo_statx_mtime_sec(void* statxbuf) {
  return (int64_t)((struct stat*)statxbuf)->st_mtimespec.tv_sec;
}

static uint32_t __yo_statx_mtime_nsec(void* statxbuf) {
  return (uint32_t)((struct stat*)statxbuf)->st_mtimespec.tv_nsec;
}

static int64_t __yo_statx_atime_sec(void* statxbuf) {
  return (int64_t)((struct stat*)statxbuf)->st_atimespec.tv_sec;
}

static uint32_t __yo_statx_atime_nsec(void* statxbuf) {
  return (uint32_t)((struct stat*)statxbuf)->st_atimespec.tv_nsec;
}

static int64_t __yo_statx_ctime_sec(void* statxbuf) {
  return (int64_t)((struct stat*)statxbuf)->st_ctimespec.tv_sec;
}

static uint32_t __yo_statx_ctime_nsec(void* statxbuf) {
  return (uint32_t)((struct stat*)statxbuf)->st_ctimespec.tv_nsec;
}

static int64_t __yo_statx_btime_sec(void* statxbuf) {
  return (int64_t)((struct stat*)statxbuf)->st_birthtimespec.tv_sec;
}

static uint32_t __yo_statx_btime_nsec(void* statxbuf) {
  return (uint32_t)((struct stat*)statxbuf)->st_birthtimespec.tv_nsec;
}

static uint32_t __yo_statx_uid(void* statxbuf) {
  return (uint32_t)((struct stat*)statxbuf)->st_uid;
}

static uint32_t __yo_statx_gid(void* statxbuf) {
  return (uint32_t)((struct stat*)statxbuf)->st_gid;
}

static uint64_t __yo_statx_ino(void* statxbuf) {
  return (uint64_t)((struct stat*)statxbuf)->st_ino;
}

static uint64_t __yo_statx_dev_major(void* statxbuf) {
  return (uint64_t)major(((struct stat*)statxbuf)->st_dev);
}

static uint64_t __yo_statx_dev_minor(void* statxbuf) {
  return (uint64_t)minor(((struct stat*)statxbuf)->st_dev);
}

static uint64_t __yo_statx_nlink(void* statxbuf) {
  return (uint64_t)((struct stat*)statxbuf)->st_nlink;
}

static uint64_t __yo_statx_blksize(void* statxbuf) {
  return (uint64_t)((struct stat*)statxbuf)->st_blksize;
}

static uint64_t __yo_statx_blocks(void* statxbuf) {
  return (uint64_t)((struct stat*)statxbuf)->st_blocks;
}



// Law of Exclusivity (Swift-style runtime backstop). An interior 'ref'
// into a container's storage (e.g. xs(i)) increments the container's
// borrow_count for the borrow's lifetime; a container operation that
// could reallocate/free that storage asserts borrow_count == 0. This
// turns the one statically-unprovable interior-ref residual (a container
// reached through a global and grown while borrowed) into a deterministic
// panic instead of a use-after-free. Cost: a same-cache-line load + a
// predicted-not-taken branch (measured ~0% even on a tight push loop).
static inline void __yo_borrow_acquire(void* ptr) {
  if (ptr == NULL) return;
  ((__yo_ref_header_t*)ptr)->borrow_count++;
}
static inline void __yo_borrow_release(void* ptr) {
  if (ptr == NULL) return;
  ((__yo_ref_header_t*)ptr)->borrow_count--;
}
static inline void __yo_borrow_assert_unborrowed(void* ptr) {
  if (ptr == NULL) return;
  if (((__yo_ref_header_t*)ptr)->borrow_count != 0) {
    fprintf(stderr, "panic: container operation while an interior reference (a 'ref' into an element/field) borrows from it\n");
    abort();
  }
}
// Non-atomic reference counting functions (thread-local)
// Flag to prevent double RC decrements during GC collection.
// When set, __yo_decr_rc skips all tracked objects because the GC
// already accounts for their references via trial deletion.
static _Thread_local int __yo_gc_collecting = 0;

// GC tracking state + thresholds (declared here so __yo_decr_rc, below, can buffer
// possible cycle roots and trigger collection — Bacon-Rajan).
static _Thread_local __yo_thread_gc_state_t* __yo_current_thread_gc = NULL;  // Current thread's GC state
static size_t __yo_gc_min_threshold = 256;       // Minimum / configured collection threshold (floor)
static size_t __yo_gc_collect_threshold = 256;   // Incremental: collect when possible_roots reaches this
static size_t __yo_gc_full_threshold = 256;      // Full: allocation-driven full-heap scan when tracked_count reaches this (adaptive Nx-live)
static size_t __yo_gc_full_pct = 200;            // Full-scan growth factor as a percent of post-collection live (default 200 = 2x-live). Lower to cap peak memory on constrained boxes; raise for fewer (but larger) scans. Env: YO_GC_FULL_PCT.

static inline void __yo_decr_rc(void* ptr) {
  if (ptr == NULL) return;
  __yo_ref_header_t* header = (__yo_ref_header_t*)ptr;

  // FAST PATH: untracked objects (their type cannot form reference cycles).
  // No thread-local reads, no cycle bookkeeping: untracked objects are never
  // registered, never BUFFERED, and never trial-deleted by the collector
  // (its visitors skip non-TRACKED headers), so the collecting-skip,
  // remove_root and unregister calls below are all no-ops for them. On Darwin
  // every _Thread_local read is a _tlv_get_addr call, so keeping TLS out of
  // this path measurably matters (profiled: __yo_decr_rc was 54% of a
  // self-compile, with the TLS reads a further 10%).
  if (!(header->gc_flags & __YO_GC_TRACKED)) {
    GC_DEBUG("Decr: ptr=%p RC=%zu->%zu\n", ptr, (size_t)header->ref_count, (size_t)(header->ref_count - 1));
    if (header->ref_count == 1) {
      GC_DEBUG("Decr: Deallocating ptr=%p (last ref)\n", ptr);
      if (header->dispose_fn) {
        header->dispose_fn(ptr);
      }
      __yo_free(ptr);
    } else {
      header->ref_count--;
    }
    return;
  }

  // Tracked object. During GC collection, skip it: the GC handles tracked
  // objects' lifecycle via trial deletion — decrementing here would
  // double-count the reference removal.
  if (__yo_gc_collecting) {
    GC_DEBUG("Decr: Skipping ptr=%p (GC collecting, tracked)\n", ptr);
    return;
  }

  GC_DEBUG("Decr: ptr=%p RC=%zu->%zu\n", ptr, (size_t)header->ref_count, (size_t)(header->ref_count - 1));

  if (header->ref_count == 1) {
    // Last reference - deallocate immediately (acyclic garbage).
    GC_DEBUG("Decr: Deallocating ptr=%p (last ref)\n", ptr);
    // Bacon-Rajan: if buffered as a possible cycle root, unlink first (O(1)).
    if (header->gc_flags & __YO_GC_BUFFERED) {
      __yo_gc_remove_root(ptr);
    }
    __yo_gc_unregister(ptr);
    if (header->dispose_fn) {
      header->dispose_fn(ptr);
    }
    __yo_free(ptr);
  } else {
    // More than one reference - just decrement. The object's RC dropped but it
    // is not freed → it is a possible root of a garbage CYCLE (Bacon-Rajan):
    // buffer it for the next collection. Already-buffered objects (the steady
    // state for hot objects) only need recoloring — a byte write on the header
    // cache line this decrement already dirtied; the buffering + the
    // collection-threshold check live in __yo_gc_add_root (the count can only
    // cross the threshold when it grows there).
    header->ref_count--;
    if (header->gc_flags & __YO_GC_BUFFERED) {
      header->gc_mark = __YO_GC_CANDIDATE;
    } else {
      __yo_gc_add_root(ptr);
    }
  }
}

static inline void* __yo_incr_rc(void* ptr) {
  if (ptr == NULL) return NULL;
  __yo_ref_header_t* header = (__yo_ref_header_t*)ptr;
  header->ref_count++;
  GC_DEBUG("Incr: ptr=%p RC=%zu\n", ptr, (size_t)header->ref_count);
  return ptr;
}

// Atomic reference counting functions for Iso types (thread-safe)
// Memory ordering follows the standard Arc pattern (Rust, Swift, C++ shared_ptr):
//   - Increment: relaxed (no ordering needed for new reference creation)
//   - Decrement: acq_rel (acquire on last drop to see all prior writes; release to publish our writes)
//   - rc() check: acquire (see all prior writes before acting on uniqueness)
static void* __yo_incr_rc_atomic(void* ptr) {
  if (ptr == NULL) return NULL;
  __yo_ref_header_t* header = (__yo_ref_header_t*)ptr;
  atomic_fetch_add_explicit((_Atomic uint32_t*)&header->ref_count, 1, memory_order_relaxed);
  return ptr;
}

static void __yo_decr_rc_atomic(void* ptr) {
  if (ptr == NULL) return;
  __yo_ref_header_t* header = (__yo_ref_header_t*)ptr;
  uint32_t old_count = atomic_fetch_sub_explicit((_Atomic uint32_t*)&header->ref_count, 1, memory_order_acq_rel);

  if (old_count == 1) {
    // Last reference - deallocate
    // Note: No GC tracking needed for Iso types (they don't participate in cycles)
    if (header->dispose_fn) {
      header->dispose_fn(ptr);
    }
    __yo_free(ptr);
  }
}
// Per-thread GC tracking state for cycle collection
// (__yo_current_thread_gc + thresholds are declared earlier, before __yo_decr_rc)
static __yo_thread_gc_state_t* __yo_all_thread_gcs = NULL;  // Global list of all thread GC states (for cleanup)
static __YO_THREAD_SYNC_TYPE __yo_thread_list_mutex = __YO_THREAD_SYNC_INIT;
// Thread cleanup infrastructure
static pthread_key_t __yo_thread_cleanup_key = (pthread_key_t)(-1);
static pthread_once_t __yo_thread_cleanup_once = PTHREAD_ONCE_INIT;

static void __yo_pthread_cleanup(void* value) {
  if (value != NULL) {
    __yo_cleanup_thread_gc();
  }
}

static void __yo_init_thread_cleanup_key(void) {
  pthread_key_create(&__yo_thread_cleanup_key, __yo_pthread_cleanup);
}
// Initialize thread-local GC state
static void __yo_init_thread_gc() {
  if (__yo_current_thread_gc != NULL) return;

  pthread_once(&__yo_thread_cleanup_once, __yo_init_thread_cleanup_key);
  if (__yo_thread_cleanup_key != (pthread_key_t)(-1)) {
    pthread_setspecific(__yo_thread_cleanup_key, (void*)1);
  }

  __yo_init_process_cleanup();

  __yo_current_thread_gc = (__yo_thread_gc_state_t*)__yo_malloc(sizeof(__yo_thread_gc_state_t));
  __yo_current_thread_gc->tracked_objects = NULL;
  __yo_current_thread_gc->tracked_count = 0;
  __yo_current_thread_gc->thread_id = __yo_thread_self();
  __yo_current_thread_gc->alloc_count = 0;
  __yo_current_thread_gc->possible_roots = NULL;
  __yo_current_thread_gc->possible_roots_count = 0;
  __yo_current_thread_gc->gc_white = NULL;
  __yo_current_thread_gc->gc_white_count = 0;
  __yo_current_thread_gc->gc_white_cap = 0;

  // One-time: honor YO_GC_THRESHOLD to raise or DISABLE the cycle collector.
  // For allocation-heavy, short-lived runs (e.g. the compiler itself, which
  // builds a large mostly-live graph and exits), repeated full-heap trial
  // deletion is near-quadratic overhead the OS reclaims at exit anyway. A value
  // of 0 disables auto-collection (threshold = SIZE_MAX); any other value sets
  // both the live threshold and the adaptive floor. Default (env unset) keeps
  // the adaptive 256 behavior. Mirrors the YO_MAIN_STACK_MB knob.
  {
    static int __yo_gc_thr_env_read = 0;
    if (!__yo_gc_thr_env_read) {
      __yo_gc_thr_env_read = 1;
      const char* __yo_gc_thr = getenv("YO_GC_THRESHOLD");
      if (__yo_gc_thr != NULL) {
        unsigned long long __yo_gc_thr_v = strtoull(__yo_gc_thr, NULL, 10);
        __yo_gc_collect_threshold = (__yo_gc_thr_v == 0ULL) ? (size_t)-1 : (size_t)__yo_gc_thr_v;
        __yo_gc_min_threshold = __yo_gc_collect_threshold;
      }
      // YO_GC_FULL_PCT: full-scan growth factor as a percent of live (default 200
      // = 2x-live). Lower (e.g. 130) caps peak memory on constrained boxes at the
      // cost of more frequent full scans; must be > 100 to make progress.
      const char* __yo_gc_full = getenv("YO_GC_FULL_PCT");
      if (__yo_gc_full != NULL) {
        unsigned long long __yo_gc_full_v = strtoull(__yo_gc_full, NULL, 10);
        if (__yo_gc_full_v > 100ULL) __yo_gc_full_pct = (size_t)__yo_gc_full_v;
      }
    }
  }

  // Add to global thread list (for cleanup coordination)
  __yo_mutex_lock(&__yo_thread_list_mutex);
  __yo_current_thread_gc->next = __yo_all_thread_gcs;
  __yo_current_thread_gc->prev = NULL;
  if (__yo_all_thread_gcs != NULL) {
    __yo_all_thread_gcs->prev = __yo_current_thread_gc;
  }
  __yo_all_thread_gcs = __yo_current_thread_gc;
  __yo_mutex_unlock(&__yo_thread_list_mutex);
}

// Public function to initialize thread-local GC (for worker threads)
static void __yo_gc_init_thread() {
  __yo_init_thread_gc();
}
static void __yo_gc_register(void* ptr) {
  __yo_ref_header_t* header = (__yo_ref_header_t*)ptr;

  if (__yo_current_thread_gc == NULL) {
    __yo_init_thread_gc();
  }

  GC_DEBUG("GC Register: ptr=%p\n", ptr);

  // Check if already tracked
  if (header->gc_flags & __YO_GC_TRACKED) {
    return;
  }

  header->gc_flags |= __YO_GC_TRACKED;
  header->gc_mark = __YO_GC_UNMARKED;

  // Add to thread-local tracking list
  header->gc_next = __yo_current_thread_gc->tracked_objects;
  header->gc_prev = NULL;
  if (__yo_current_thread_gc->tracked_objects != NULL) {
    __yo_current_thread_gc->tracked_objects->gc_prev = header;
  }
  __yo_current_thread_gc->tracked_objects = header;
  __yo_current_thread_gc->tracked_count++;
  // Allocation-driven FULL collection. The incremental (Bacon-Rajan) path in
  // __yo_decr_rc reclaims cheap decrement-rooted cycles, but CANNOT see cycles
  // formed by a move into a self/child field (no decrement event) — those would
  // leak unboundedly. So a full-heap scan still runs when the tracked set grows
  // past an adaptive 2x-live threshold: this bounds memory and reclaims
  // move-formed cycles. See issues/yo-gc-full-heap-scan-bottleneck.md.
  if (!__yo_gc_collecting && __yo_current_thread_gc->tracked_count >= __yo_gc_full_threshold) {
    __yo_gc_collect();
    size_t nt = (__yo_current_thread_gc->tracked_count * __yo_gc_full_pct) / 100;
    if (nt <= __yo_current_thread_gc->tracked_count) nt = __yo_current_thread_gc->tracked_count + 1;
    if (nt < 256) nt = 256;
    __yo_gc_full_threshold = nt;
  }
}

static void __yo_gc_unregister(void* ptr) {
  __yo_ref_header_t* header = (__yo_ref_header_t*)ptr;

  if (__yo_current_thread_gc == NULL) {
    return;
  }

  if (!(header->gc_flags & __YO_GC_TRACKED)) {
    return;
  }

  // Remove from tracking list (O(1) with doubly-linked list)
  if (header->gc_prev != NULL) {
    header->gc_prev->gc_next = header->gc_next;
  } else {
    __yo_current_thread_gc->tracked_objects = header->gc_next;
  }

  if (header->gc_next != NULL) {
    header->gc_next->gc_prev = header->gc_prev;
  }

  __yo_current_thread_gc->tracked_count--;
  header->gc_flags &= ~__YO_GC_TRACKED;
}
// Bacon-Rajan: buffer a possible cycle root (decremented to non-zero).
static void __yo_gc_add_root(void* ptr) {
  __yo_ref_header_t* h = (__yo_ref_header_t*)ptr;
  // Flag check BEFORE the thread-local read: already-buffered only needs a
  // recolor, and on Darwin every _Thread_local read is a _tlv_get_addr call.
  if (h->gc_flags & __YO_GC_BUFFERED) { h->gc_mark = __YO_GC_CANDIDATE; return; }
  __yo_thread_gc_state_t* gc = __yo_current_thread_gc;  // single TLS read
  if (gc == NULL) return;
  h->gc_flags |= __YO_GC_BUFFERED;
  h->gc_mark = __YO_GC_CANDIDATE;
  h->roots_next = gc->possible_roots;
  h->roots_prev = NULL;
  if (gc->possible_roots != NULL) {
    gc->possible_roots->roots_prev = h;
  }
  gc->possible_roots = h;
  gc->possible_roots_count++;
  // Incremental collection trigger. The possible-roots count only grows here,
  // so the threshold can only be crossed here — checking it on every tracked
  // decrement (as before) was pure overhead. decr_rc never calls add_root
  // while collecting (tracked decrements are skipped), so the guard is
  // belt-and-braces for any other caller.
  if (!__yo_gc_collecting && gc->possible_roots_count >= __yo_gc_collect_threshold) {
    __yo_gc_collect_incremental();
  }
}

// Bacon-Rajan: unlink a possible root (O(1), called at free or during collection).
static void __yo_gc_remove_root(void* ptr) {
  __yo_ref_header_t* h = (__yo_ref_header_t*)ptr;
  if (__yo_current_thread_gc == NULL) return;
  if (!(h->gc_flags & __YO_GC_BUFFERED)) return;
  if (h->roots_prev != NULL) h->roots_prev->roots_next = h->roots_next;
  else __yo_current_thread_gc->possible_roots = h->roots_next;
  if (h->roots_next != NULL) h->roots_next->roots_prev = h->roots_prev;
  h->roots_next = NULL;
  h->roots_prev = NULL;
  h->gc_flags &= ~__YO_GC_BUFFERED;
  __yo_current_thread_gc->possible_roots_count--;
}

// MarkGray: color the subgraph gray, trial-decrementing internal (tracked) refs.
static void __yo_gc_mark_gray(__yo_ref_header_t* s);
static void __yo_gc_mark_gray_visitor(void* ptr) {
  if (ptr == NULL) return;
  __yo_ref_header_t* h = (__yo_ref_header_t*)ptr;
  if (!(h->gc_flags & __YO_GC_TRACKED)) return;
  if (h->ref_count > 0) h->ref_count--;
  __yo_gc_mark_gray(h);
}
static void __yo_gc_mark_gray(__yo_ref_header_t* s) {
  if (s->gc_mark == __YO_GC_TRIAL_DELETED) return;
  s->gc_mark = __YO_GC_TRIAL_DELETED;
  if (s->traverse_fn) s->traverse_fn(s, __yo_gc_mark_gray_visitor);
}

// ScanBlack: a live object — restore the trial decrements over its subgraph.
static void __yo_gc_scan_black(__yo_ref_header_t* s);
static void __yo_gc_scan_black_visitor(void* ptr) {
  if (ptr == NULL) return;
  __yo_ref_header_t* h = (__yo_ref_header_t*)ptr;
  if (!(h->gc_flags & __YO_GC_TRACKED)) return;
  h->ref_count++;
  if (h->gc_mark != __YO_GC_UNMARKED) __yo_gc_scan_black(h);
}
static void __yo_gc_scan_black(__yo_ref_header_t* s) {
  s->gc_mark = __YO_GC_UNMARKED;
  if (s->traverse_fn) s->traverse_fn(s, __yo_gc_scan_black_visitor);
}

// Scan: gray object with RC>0 is live (ScanBlack); otherwise it is white garbage.
static void __yo_gc_scan(__yo_ref_header_t* s);
static void __yo_gc_scan_visitor(void* ptr) {
  if (ptr == NULL) return;
  __yo_gc_scan((__yo_ref_header_t*)ptr);
}
static void __yo_gc_scan(__yo_ref_header_t* s) {
  if (s->gc_mark != __YO_GC_TRIAL_DELETED) return;
  if (s->ref_count > 0) {
    __yo_gc_scan_black(s);
  } else {
    s->gc_mark = __YO_GC_GARBAGE;
    if (s->traverse_fn) s->traverse_fn(s, __yo_gc_scan_visitor);
  }
}

// GatherWhite: collect the white subgraph into the scratch array (do NOT free yet,
// so a member's dispose never dereferences an already-freed sibling).
static void __yo_gc_gather_white(__yo_ref_header_t* s);
static void __yo_gc_gather_white_visitor(void* ptr) {
  if (ptr == NULL) return;
  __yo_gc_gather_white((__yo_ref_header_t*)ptr);
}
static void __yo_gc_gather_white(__yo_ref_header_t* s) {
  if (!(s->gc_flags & __YO_GC_TRACKED)) return;
  if (s->gc_mark != __YO_GC_GARBAGE) return;
  s->gc_mark = __YO_GC_LIVE; // gathered sentinel (stops re-visit)
  __yo_thread_gc_state_t* gc = __yo_current_thread_gc;
  if (gc->gc_white_count == gc->gc_white_cap) {
    size_t ncap = gc->gc_white_cap == 0 ? 64 : gc->gc_white_cap * 2;
    gc->gc_white = (__yo_ref_header_t**)realloc(gc->gc_white, ncap * sizeof(__yo_ref_header_t*));
    gc->gc_white_cap = ncap;
  }
  gc->gc_white[gc->gc_white_count++] = s;
  if (s->traverse_fn) s->traverse_fn(s, __yo_gc_gather_white_visitor);
}

// INCREMENTAL collection (Bacon-Rajan): processes ONLY the possible-roots buffer
// and the subgraph reachable from it. Auto-trigger path (the compiler's hot path).
// Adaptive frequency: a pass that reclaims nothing grows the trigger threshold x4
// (capped) so a dense, cycle-poor heap stops thrashing; a productive pass resets to
// the floor. Cycles formed by a MOVE into a self/child field (codegen elides the
// incr+decr, so no PossibleRoot event) are reclaimed by the full collector below.
static void __yo_gc_collect_incremental() {
  __yo_thread_gc_state_t* gc = __yo_current_thread_gc;
  if (gc == NULL || gc->possible_roots == NULL) return;
  __yo_gc_collecting = 1;

  for (__yo_ref_header_t* s = gc->possible_roots; s != NULL; s = s->roots_next) {
    if (s->gc_mark == __YO_GC_CANDIDATE) __yo_gc_mark_gray(s);
  }
  for (__yo_ref_header_t* s = gc->possible_roots; s != NULL; s = s->roots_next) {
    __yo_gc_scan(s);
  }
  gc->gc_white_count = 0;
  while (gc->possible_roots != NULL) {
    __yo_ref_header_t* root = gc->possible_roots;
    __yo_gc_remove_root(root);
    __yo_gc_gather_white(root);
  }
  size_t nwhite = gc->gc_white_count;
  for (size_t i = 0; i < nwhite; i++) {
    if (gc->gc_white[i]->dispose_fn) gc->gc_white[i]->dispose_fn(gc->gc_white[i]);
  }
  for (size_t i = 0; i < nwhite; i++) {
    __yo_gc_unregister(gc->gc_white[i]);
    __yo_free(gc->gc_white[i]);
  }
  gc->gc_white_count = 0;
  __yo_gc_collecting = 0;

  if (__yo_gc_collect_threshold != (size_t)-1) {
    // Heap-PROPORTIONAL trigger: collect again only once the possible-roots buffer
    // grows to ~the live-object count, so on a large heap collections stay rare
    // (each is ~O(heap)) while memory stays bounded (≈2x live). A pass that
    // reclaims nothing backs off a further ×4 (cycle-poor workload); the floor is
    // __yo_gc_min_threshold (or the env-pinned value).
    size_t base = gc->tracked_count;
    if (base < __yo_gc_min_threshold) base = __yo_gc_min_threshold;
    if (nwhite == 0) base = (base < (((size_t)-1) / 4)) ? base * 4 : ((size_t)-1) / 2;
    __yo_gc_collect_threshold = base;
  }
}

// Full-heap trial-deletion visitor (for the thorough collector below).
static void __yo_gc_trial_delete_visitor(void* ptr) {
  if (ptr == NULL) return;
  __yo_ref_header_t* header = (__yo_ref_header_t*)ptr;
  if (!(header->gc_flags & __YO_GC_TRACKED)) return;
  if (header->ref_count > 0) header->ref_count--;
}
static void __yo_gc_scan_restore_visitor(void* ptr) {
  if (ptr == NULL) return;
  __yo_ref_header_t* header = (__yo_ref_header_t*)ptr;
  if (!(header->gc_flags & __YO_GC_TRACKED)) return;
  header->ref_count++;
  if (header->gc_mark == __YO_GC_GARBAGE) {
    header->gc_mark = __YO_GC_UNMARKED;
    if (header->traverse_fn) header->traverse_fn(ptr, __yo_gc_scan_restore_visitor);
  }
}

// THOROUGH collection: full-heap trial-deletion mark-sweep over ALL tracked
// objects. O(all tracked) — NOT the auto path; backs explicit Gc.collect() and
// reclaims cycles the incremental path cannot see. Clears the possible-roots
// buffer first (it supersedes incremental bookkeeping).
static void __yo_gc_collect() {
  __yo_thread_gc_state_t* gc = __yo_current_thread_gc;
  if (gc == NULL) return;
  while (gc->possible_roots != NULL) {
    __yo_gc_remove_root(gc->possible_roots);
  }
  __yo_ref_header_t* head = gc->tracked_objects;
  if (head == NULL) return;
  __yo_gc_collecting = 1;

  for (__yo_ref_header_t* obj = head; obj != NULL; obj = obj->gc_next) obj->gc_mark = __YO_GC_CANDIDATE;
  for (__yo_ref_header_t* obj = head; obj != NULL; obj = obj->gc_next) {
    if (obj->traverse_fn) obj->traverse_fn(obj, __yo_gc_trial_delete_visitor);
  }
  for (__yo_ref_header_t* obj = head; obj != NULL; obj = obj->gc_next) {
    obj->gc_mark = (obj->ref_count == 0) ? __YO_GC_GARBAGE : __YO_GC_LIVE;
  }
  for (__yo_ref_header_t* obj = head; obj != NULL; obj = obj->gc_next) {
    if (obj->gc_mark == __YO_GC_LIVE) {
      obj->gc_mark = __YO_GC_UNMARKED;
      if (obj->traverse_fn) obj->traverse_fn(obj, __yo_gc_scan_restore_visitor);
    }
  }
  for (__yo_ref_header_t* obj = head; obj != NULL; obj = obj->gc_next) {
    if (obj->gc_mark == __YO_GC_GARBAGE && obj->dispose_fn) obj->dispose_fn(obj);
  }
  __yo_ref_header_t* current = head;
  __yo_ref_header_t* prev = NULL;
  while (current != NULL) {
    __yo_ref_header_t* next = current->gc_next;
    if (current->gc_mark == __YO_GC_GARBAGE) {
      if (prev == NULL) gc->tracked_objects = next; else prev->gc_next = next;
      if (next != NULL) next->gc_prev = prev;
      gc->tracked_count--;
      __yo_free(current);
      current = next;
    } else {
      current->gc_mark = __YO_GC_UNMARKED;
      prev = current;
      current = next;
    }
  }
  __yo_gc_collecting = 0;
}

static size_t __yo_gc_tracked_count() {
  if (__yo_current_thread_gc == NULL) return 0;
  return __yo_current_thread_gc->tracked_count;
}
// Clean up thread-local GC state
static void __yo_cleanup_thread_gc() {
  __yo_mutex_lock(&__yo_thread_list_mutex);

  __yo_thread_gc_state_t* my_gc_state = __yo_current_thread_gc;

  if (my_gc_state == NULL) {
    __yo_mutex_unlock(&__yo_thread_list_mutex);
    return;
  }

  GC_DEBUG("CleanupThread: tracked_count=%zu\n", my_gc_state->tracked_count);

  // Force dispose all remaining tracked objects. dispose_fn side effects can
  // drop the LAST reference on other tracked objects — without the collecting
  // flag, __yo_decr_rc would free + unlink them mid-walk and the walk would
  // free them again (double free). With the flag set, __yo_decr_rc skips
  // tracked objects entirely, so every tracked object is disposed and freed
  // exactly once by this walk. Left set: the thread is exiting, and any later
  // decrement on tracked memory would be use-after-free.
  __yo_gc_collecting = 1;
  __yo_ref_header_t* current = my_gc_state->tracked_objects;
  while (current != NULL) {
    __yo_ref_header_t* next = current->gc_next;

    GC_DEBUG("CleanupThread: Disposing object ptr=%p\n", current);
    if (current->dispose_fn) {
      current->dispose_fn(current);
    }
    __yo_free(current);

    current = next;
  }

  // Remove from global list
  if (my_gc_state->prev != NULL) {
    my_gc_state->prev->next = my_gc_state->next;
  } else {
    __yo_all_thread_gcs = my_gc_state->next;
  }

  if (my_gc_state->next != NULL) {
    my_gc_state->next->prev = my_gc_state->prev;
  }

  __yo_mutex_unlock(&__yo_thread_list_mutex);

  __yo_free(my_gc_state);
  __yo_current_thread_gc = NULL;
}
// Process cleanup
static void __yo_process_cleanup(void) {
  GC_DEBUG("ProcessCleanup: Called\n");

  if (__yo_current_thread_gc != NULL) {
    __yo_gc_collect();
    __yo_cleanup_thread_gc();
  }

  if (__yo_thread_cleanup_key != (pthread_key_t)(-1)) {
    pthread_key_delete(__yo_thread_cleanup_key);
  }
}
static void __yo_init_process_cleanup(void) {
  static bool cleanup_initialized = false;
  if (cleanup_initialized) return;
  cleanup_initialized = true;
  atexit(__yo_process_cleanup);
}
static void __yo_traverse___yo_t24(void* ptr, void (*visit)(void*)) {
  __yo_t24* obj = (__yo_t24*)ptr;
  yo_id_3168_rtparam0_R_gs_yo_id_3109_usize_rtparam1_struct_yo_id_10___u8__ret_unit(obj, (void*)visit);
}

static void __yo_traverse___yo_t28(void* ptr, void (*visit)(void*)) {
  __yo_t28* obj = (__yo_t28*)ptr;
  switch (obj->tag.tag) {
  case __YO_T11_SOME:
  if (obj->tag.data.Some.value) { ((void(*)(void*))visit)(obj->tag.data.Some.value); }
    break;
  }
}

static void __yo_traverse___yo_t43(void* ptr, void (*visit)(void*)) {
  __yo_t43* obj = (__yo_t43*)ptr;
}

static void __yo_traverse___yo_t19(void* ptr, void (*visit)(void*)) {
  __yo_t19* obj = (__yo_t19*)ptr;
  if (obj->_segments) { ((void(*)(void*))visit)(obj->_segments); }
}

static void __yo_traverse___yo_t16(void* ptr, void (*visit)(void*)) {
  __yo_t16* obj = (__yo_t16*)ptr;
  yo_id_3168_rtparam0_R_gs_yo_id_3109_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam1_struct_yo_id_10___u8__ret_unit(obj, (void*)visit);
}

static void __yo_traverse___yo_t31(void* ptr, void (*visit)(void*)) {
  __yo_t31* obj = (__yo_t31*)ptr;
  yo_id_3168_rtparam0_R_gs_yo_id_3109_R_struct_yo_id_9715_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_i32_i32_i32_rtparam1_struct_yo_id_10___u8__ret_unit(obj, (void*)visit);
}

static void __yo_traverse___yo_t2(void* ptr, void (*visit)(void*)) {
  __yo_t2* obj = (__yo_t2*)ptr;
}

static void __yo_traverse___yo_t0(void* ptr, void (*visit)(void*)) {
  __yo_t0* obj = (__yo_t0*)ptr;
  yo_id_3168_rtparam0_R_gs_yo_id_3109_u8_rtparam1_struct_yo_id_10___u8__ret_unit(obj, (void*)visit);
}

static __yo_t24* __yo_new___yo_t24(size_t* _ptr, size_t _length, size_t _capacity) {
  __yo_t24* obj = (__yo_t24*)__yo_malloc(sizeof(__yo_t24));
  obj->header.ref_count = 1;  // Start with one reference
  obj->header.borrow_count = 0;  // Law-of-Exclusivity: no live interior borrows yet
  obj->header.gc_flags = 0;
  obj->header.gc_mark = __YO_GC_UNMARKED;
  obj->header.gc_next = NULL;
  obj->header.gc_prev = NULL;
  obj->header.dispose_fn = (void(*)(void*))yo_id_12133;
  obj->header.traverse_fn = __yo_traverse___yo_t24;
  obj->_ptr = _ptr;
  obj->_length = _length;
  obj->_capacity = _capacity;
  return obj;
}

static __yo_t28* __yo_new___yo_t28(__yo_t10 tag, int32_t major, int32_t minor, int32_t patch) {
  __yo_t28* obj = (__yo_t28*)__yo_malloc(sizeof(__yo_t28));
  obj->header.ref_count = 1;  // Start with one reference
  obj->header.borrow_count = 0;  // Law-of-Exclusivity: no live interior borrows yet
  obj->header.gc_flags = 0;
  obj->header.gc_mark = __YO_GC_UNMARKED;
  obj->header.gc_next = NULL;
  obj->header.gc_prev = NULL;
  obj->header.dispose_fn = (void(*)(void*))yo_id_12140;
  obj->header.traverse_fn = __yo_traverse___yo_t28;
  obj->tag = tag;
  obj->major = major;
  obj->minor = minor;
  obj->patch = patch;
  return obj;
}

static __yo_t43* __yo_new___yo_t43(void** _ptr, size_t _length, size_t _capacity) {
  __yo_t43* obj = (__yo_t43*)__yo_malloc(sizeof(__yo_t43));
  obj->header.ref_count = 1;  // Start with one reference
  obj->header.borrow_count = 0;  // Law-of-Exclusivity: no live interior borrows yet
  obj->header.gc_flags = 0;
  obj->header.gc_mark = __YO_GC_UNMARKED;
  obj->header.gc_next = NULL;
  obj->header.gc_prev = NULL;
  obj->header.dispose_fn = NULL;
  obj->header.traverse_fn = __yo_traverse___yo_t43;
  obj->_ptr = _ptr;
  obj->_length = _length;
  obj->_capacity = _capacity;
  __yo_gc_register(obj);
  return obj;
}

static __yo_t19* __yo_new___yo_t19(__yo_t16* _segments, bool _is_absolute) {
  __yo_t19* obj = (__yo_t19*)__yo_malloc(sizeof(__yo_t19));
  obj->header.ref_count = 1;  // Start with one reference
  obj->header.borrow_count = 0;  // Law-of-Exclusivity: no live interior borrows yet
  obj->header.gc_flags = 0;
  obj->header.gc_mark = __YO_GC_UNMARKED;
  obj->header.gc_next = NULL;
  obj->header.gc_prev = NULL;
  obj->header.dispose_fn = (void(*)(void*))yo_id_12142;
  obj->header.traverse_fn = __yo_traverse___yo_t19;
  obj->_segments = _segments;
  obj->_is_absolute = _is_absolute;
  return obj;
}

static __yo_t16* __yo_new___yo_t16(__yo_t10* _ptr, size_t _length, size_t _capacity) {
  __yo_t16* obj = (__yo_t16*)__yo_malloc(sizeof(__yo_t16));
  obj->header.ref_count = 1;  // Start with one reference
  obj->header.borrow_count = 0;  // Law-of-Exclusivity: no live interior borrows yet
  obj->header.gc_flags = 0;
  obj->header.gc_mark = __YO_GC_UNMARKED;
  obj->header.gc_next = NULL;
  obj->header.gc_prev = NULL;
  obj->header.dispose_fn = (void(*)(void*))yo_id_12144;
  obj->header.traverse_fn = __yo_traverse___yo_t16;
  obj->_ptr = _ptr;
  obj->_length = _length;
  obj->_capacity = _capacity;
  return obj;
}

static __yo_t31* __yo_new___yo_t31(__yo_t28** _ptr, size_t _length, size_t _capacity) {
  __yo_t31* obj = (__yo_t31*)__yo_malloc(sizeof(__yo_t31));
  obj->header.ref_count = 1;  // Start with one reference
  obj->header.borrow_count = 0;  // Law-of-Exclusivity: no live interior borrows yet
  obj->header.gc_flags = 0;
  obj->header.gc_mark = __YO_GC_UNMARKED;
  obj->header.gc_next = NULL;
  obj->header.gc_prev = NULL;
  obj->header.dispose_fn = (void(*)(void*))yo_id_12158;
  obj->header.traverse_fn = __yo_traverse___yo_t31;
  obj->_ptr = _ptr;
  obj->_length = _length;
  obj->_capacity = _capacity;
  return obj;
}

static __yo_t2* __yo_new___yo_t2(void** _ptr, size_t _length, size_t _capacity) {
  __yo_t2* obj = (__yo_t2*)__yo_malloc(sizeof(__yo_t2));
  obj->header.ref_count = 1;  // Start with one reference
  obj->header.borrow_count = 0;  // Law-of-Exclusivity: no live interior borrows yet
  obj->header.gc_flags = 0;
  obj->header.gc_mark = __YO_GC_UNMARKED;
  obj->header.gc_next = NULL;
  obj->header.gc_prev = NULL;
  obj->header.dispose_fn = NULL;
  obj->header.traverse_fn = __yo_traverse___yo_t2;
  obj->_ptr = _ptr;
  obj->_length = _length;
  obj->_capacity = _capacity;
  __yo_gc_register(obj);
  return obj;
}

static __yo_t0* __yo_new___yo_t0(uint8_t* _ptr, size_t _length, size_t _capacity) {
  __yo_t0* obj = (__yo_t0*)__yo_malloc(sizeof(__yo_t0));
  obj->header.ref_count = 1;  // Start with one reference
  obj->header.borrow_count = 0;  // Law-of-Exclusivity: no live interior borrows yet
  obj->header.gc_flags = 0;
  obj->header.gc_mark = __YO_GC_UNMARKED;
  obj->header.gc_next = NULL;
  obj->header.gc_prev = NULL;
  obj->header.dispose_fn = (void(*)(void*))yo_id_12172;
  obj->header.traverse_fn = __yo_traverse___yo_t0;
  obj->_ptr = _ptr;
  obj->_length = _length;
  obj->_capacity = _capacity;
  return obj;
}

static inline void yo_id_3141_rtparam0_R_gs_yo_id_3109_R_struct_yo_id_9715_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_i32_i32_i32_ret_unit(__yo_t31* self) {
  { // begin block
    if (((self->_length) > (0ULL))) {
      size_t i = 0ULL;
      __yo_t28** _file____User_temp_14279 = yo_id_2456_rtparam0_enum_yo_id_9855___R_struct_yo_id_9715_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_i32_i32_i32__ret___R_struct_yo_id_9715_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_i32_i32_i32_(self->_ptr);
      __yo_t28** base_ptr = _file____User_temp_14279;
      while (true) {
        if (!(((i) < (self->_length)))) {
          break;
        }
        { // begin block (loop body)
        __yo_t28** _file____User_temp_14284 = (base_ptr + i);
        __yo_t28** element_ptr = _file____User_temp_14284;
        __yo_decr_rc((void*)((*element_ptr)));
        } // end begin block (loop body)
      continue_yo_id_12180:;
        i = ((i) + (1ULL));
      }
      loop_yo_id_12179:;
    }
    else {
    }
  } // end begin block
}
static inline bool yo_id_122_bool_id_bool_rtparam0_bool_ret_bool(bool self) {
  return (!(self));
}
static inline __yo_t9 yo_id_5948(__yo_t10 name) {
  __yo_t0* _file____User_temp_6333 = yo_id_3393(name);
  uint8_t* _file____User_temp_6334 = yo_id_3122_rtparam0_R_gs_yo_id_3109_u8_ret_enum_yo_id_3118___u8_(_file____User_temp_6333);
  uint8_t* _file____User_temp_6339 = yo_id_2456_rtparam0_enum_yo_id_3118___u8__ret___u8_(_file____User_temp_6334);
  uint8_t* name_cstr = _file____User_temp_6339;
  char* val_ptr = getenv(((char*)(name_cstr)));
  __yo_t9 _file____User_temp_6346;
  if (val_ptr != NULL) {
    char* ptr = val_ptr;
    __yo_t12 _file____User_temp_6342 = yo_id_3383(((uint8_t*)(ptr)));
    __yo_t10 _file____User_temp_6343 = yo_id_2712_rtparam0_enum_yo_id_3287_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_enum_yo_id_3272_usize_usize_ret_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8(_file____User_temp_6342);
    __yo_t9 _file____User_temp_6345 = (__yo_t9){ .tag = __YO_T9_SOME, .data = { .Some = { .value = _file____User_temp_6343 } } };
switch ((_file____User_temp_6342).tag) {
  case __YO_T12_OK: {
switch (((_file____User_temp_6342).data.Ok.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_6342).data.Ok.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
    _file____User_temp_6346 = _file____User_temp_6345;
  } else {
    _file____User_temp_6346 = (__yo_t9){ .tag = __YO_T9_NONE };
  }
  __yo_t9 __yo_scope_ret = _file____User_temp_6346;
  __yo_decr_rc((void*)(_file____User_temp_6333));
  return __yo_scope_ret;
}
static inline void yo_id_12133(__yo_t24* self) {
  yo_id_3163_rtparam0_R_gs_yo_id_3109_usize_ret_unit(self);
}
static inline bool yo_id_3743(__yo_t10 self, __yo_t10 substr, size_t from_index) {
  bool _file____User_temp_2300;
  __yo_t23 _file____User_temp_2297 = yo_id_3716(self, substr, from_index);
  switch ((_file____User_temp_2297).tag) {
  case __YO_T23_SOME: {
    _file____User_temp_2300 = true;
    break;
  }
  case __YO_T23_NONE: {
    _file____User_temp_2300 = false;
    break;
  }
  }
  return _file____User_temp_2300;
}
static inline __yo_t21 yo_id_6004(__yo_t19* path) {
  __yo_t21 _file____User_temp_6416;
  { // begin block
    __yo_t10 _file____User_temp_6397 = fn_yo_id_5312((&(path)));
    __yo_t10 path_str = _file____User_temp_6397;
    __yo_t0* _file____User_temp_6402 = yo_id_3393(path_str);
    uint8_t* _file____User_temp_6403 = yo_id_3122_rtparam0_R_gs_yo_id_3109_u8_ret_enum_yo_id_3118___u8_(_file____User_temp_6402);
    uint8_t* _file____User_temp_6404 = yo_id_2456_rtparam0_enum_yo_id_3118___u8__ret___u8_(_file____User_temp_6403);
    uint8_t* path_cstr = _file____User_temp_6404;
    int result = chdir(((char*)(path_cstr)));
    __yo_t21 _file____User_temp_6415;
    if (((result) != (((int)(0))))) {
      __yo_str __yo_ref_spill_0 = (__yo_str){ .ptr = (const uint8_t*)"Failed to change directory to: ", .len = 31 };
      __yo_t10 _file____User_temp_6408 = yo_id_4873((&(__yo_ref_spill_0)));
      __yo_t10 _file____User_temp_6409 = yo_id_4871((&(path_str)));
      __yo_t10 _file____User_temp_6410 = yo_id_4105(_file____User_temp_6408, _file____User_temp_6409);
      __yo_t21 _file____User_temp_6412 = (__yo_t21){ .tag = __YO_T21_ERR, .data = { .Err = { .error = _file____User_temp_6410 } } };
switch ((_file____User_temp_6408).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_6408).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_6409).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_6409).data.Some.value));
    break;
  }
  default: break;
}
      _file____User_temp_6415 = _file____User_temp_6412;
    }
    else {
      _file____User_temp_6415 = (__yo_t21){ .tag = __YO_T21_OK };
    }
    _file____User_temp_6416 = _file____User_temp_6415;
switch ((path_str).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((path_str).data.Some.value));
    break;
  }
  default: break;
}
    __yo_decr_rc((void*)(_file____User_temp_6402));
  } // end begin block
  _file____User_temp_6416 = _file____User_temp_6416;
  return _file____User_temp_6416;
}
static inline bool yo_id_4019(uint8_t byte) {
  bool __yo_sc_yo_id_12181 = true;
  if (!(((byte) == (12)))) {
    __yo_sc_yo_id_12181 = ((byte) == (11));
  }
  return (((byte) == (32)) || (((byte) == (9)) || (((byte) == (10)) || (((byte) == (13)) || __yo_sc_yo_id_12181))));
}
static inline bool yo_id_9750(__yo_t10 s) {
  size_t _file____User_temp_11530 = yo_id_3414(s);
  size_t n = _file____User_temp_11530;
  if (((n) == (0ULL))) {
    bool _file____User_temp_11535 = false;
    return _file____User_temp_11535;
  }
  else {
  }
  size_t i = 0ULL;
  bool ok = true;
  while (true) {
    bool __yo_sc_yo_id_12183 = false;
    if (((i) < (n))) {
      __yo_sc_yo_id_12183 = ok;
    }
    if (!(__yo_sc_yo_id_12183)) {
      break;
    }
    { // begin block (loop body)
    __yo_t27 _file____User_temp_11541 = yo_id_3595(s, i);
    switch ((_file____User_temp_11541).tag) {
    case __YO_T27_NONE: {
      bool _file____User_temp_11542 = ok; // Save old value for later use
      ok = false;
      _file____User_temp_11542;
      break;
    }
    case __YO_T27_SOME: {
      __yo_t26 c = _file____User_temp_11541.data.Some.value;
      bool __yo_sc_yo_id_12184 = true;
      __yo_t26 _file____User_temp_11545 = ((__yo_t26)(48U));
      __yo_effect_escaped = 0;
      bool _file____User_temp_11546 = fn_yo_id_3045((__yo_t26)(c), (__yo_t26)(_file____User_temp_11545));
      if (__yo_effect_escaped) {
        return (bool){0};
      }
      if (!(_file____User_temp_11546)) {
        __yo_t26 _file____User_temp_11547 = ((__yo_t26)(57U));
        __yo_effect_escaped = 0;
        bool _file____User_temp_11548 = fn_yo_id_3049((__yo_t26)(c), (__yo_t26)(_file____User_temp_11547));
        if (__yo_effect_escaped) {
          return (bool){0};
        }
        __yo_sc_yo_id_12184 = _file____User_temp_11548;
      }
      if (__yo_sc_yo_id_12184) {
        bool _file____User_temp_11550 = ok; // Save old value for later use
        ok = false;
      }
      else {
      }
      break;
    }
    }
    size_t _file____User_temp_11557 = i; // Save old value for later use
    i = ((i) + (1ULL));
    _file____User_temp_11557;
    } // end begin block (loop body)
  }
  loop_yo_id_12182:;
  return ok;
}
static inline bool yo_id_3903(__yo_t10 self, __yo_t10 suffix, size_t end_position) {
  size_t _file____User_temp_2763;
  __yo_t11 _file____User_temp_2759 = suffix;
__yo_t11 temp_dup_enum_yo_id_12185 = _file____User_temp_2759;
switch ((temp_dup_enum_yo_id_12185).tag) {
  case __YO_T11_SOME: {
    (temp_dup_enum_yo_id_12185).data.Some.value = ((__yo_t0*)__yo_incr_rc((void*)((temp_dup_enum_yo_id_12185).data.Some.value)));
    break;
  }
  default: break;
}
  temp_dup_enum_yo_id_12185;
  switch ((_file____User_temp_2759).tag) {
  case __YO_T11_SOME: {
    __yo_t0* b = _file____User_temp_2759.data.Some.value;
    size_t _file____User_temp_2761 = yo_id_3119_rtparam0_R_gs_yo_id_3109_u8_ret_usize(b);
    _file____User_temp_2763 = _file____User_temp_2761;
    break;
  }
  case __YO_T11_NONE: {
    _file____User_temp_2763 = 0ULL;
    break;
  }
  }
  size_t suffix_bytes = _file____User_temp_2763;
  size_t _file____User_temp_2769;
  __yo_t11 _file____User_temp_2765 = self;
__yo_t11 temp_dup_enum_yo_id_12186 = _file____User_temp_2765;
switch ((temp_dup_enum_yo_id_12186).tag) {
  case __YO_T11_SOME: {
    (temp_dup_enum_yo_id_12186).data.Some.value = ((__yo_t0*)__yo_incr_rc((void*)((temp_dup_enum_yo_id_12186).data.Some.value)));
    break;
  }
  default: break;
}
  temp_dup_enum_yo_id_12186;
  switch ((_file____User_temp_2765).tag) {
  case __YO_T11_SOME: {
    __yo_t0* b = _file____User_temp_2765.data.Some.value;
    size_t _file____User_temp_2767 = yo_id_3119_rtparam0_R_gs_yo_id_3109_u8_ret_usize(b);
    _file____User_temp_2769 = _file____User_temp_2767;
    break;
  }
  case __YO_T11_NONE: {
    _file____User_temp_2769 = 0ULL;
    break;
  }
  }
  size_t self_bytes = _file____User_temp_2769;
  bool _file____User_temp_2843;
  if (((suffix_bytes) == (0ULL))) {
    _file____User_temp_2843 = true;
  }
  else {
    bool _file____User_temp_2842;
    __yo_t11 _file____User_temp_2774 = self;
__yo_t11 temp_dup_enum_yo_id_12187 = _file____User_temp_2774;
switch ((temp_dup_enum_yo_id_12187).tag) {
  case __YO_T11_SOME: {
    (temp_dup_enum_yo_id_12187).data.Some.value = ((__yo_t0*)__yo_incr_rc((void*)((temp_dup_enum_yo_id_12187).data.Some.value)));
    break;
  }
  default: break;
}
    temp_dup_enum_yo_id_12187;
    switch ((_file____User_temp_2774).tag) {
    case __YO_T11_NONE: {
      _file____User_temp_2842 = false;
      break;
    }
    case __YO_T11_SOME: {
      __yo_t0* self_al = _file____User_temp_2774.data.Some.value;
      bool _file____User_temp_2840;
      __yo_t11 _file____User_temp_2777 = suffix;
__yo_t11 temp_dup_enum_yo_id_12188 = _file____User_temp_2777;
switch ((temp_dup_enum_yo_id_12188).tag) {
  case __YO_T11_SOME: {
    (temp_dup_enum_yo_id_12188).data.Some.value = ((__yo_t0*)__yo_incr_rc((void*)((temp_dup_enum_yo_id_12188).data.Some.value)));
    break;
  }
  default: break;
}
      temp_dup_enum_yo_id_12188;
      switch ((_file____User_temp_2777).tag) {
      case __YO_T11_NONE: {
        _file____User_temp_2840 = true;
        break;
      }
      case __YO_T11_SOME: {
        __yo_t0* suffix_al = _file____User_temp_2777.data.Some.value;
        size_t _file____User_temp_2779 = yo_id_3414(self);
        size_t string_char_len = _file____User_temp_2779;
        size_t _file____User_temp_2787;
        if (((end_position) == (-1ULL))) {
          _file____User_temp_2787 = string_char_len;
        }
        else {
          if (((end_position) > (string_char_len))) {
            _file____User_temp_2787 = string_char_len;
          }
          else {
            _file____User_temp_2787 = end_position;
          }
        }
        size_t effective_end = _file____User_temp_2787;
        size_t char_index = 0ULL;
        size_t byte_index = 0ULL;
        size_t end_byte_index = self_bytes;
        while (true) {
          if (!(((byte_index) < (self_bytes)))) {
            break;
          }
          { // begin block (loop body)
          __yo_t20 _file____User_temp_2790 = yo_id_3138_rtparam0_R_gs_yo_id_3109_u8_rtparam1_usize_ret_enum_yo_id_3135_u8(self_al, byte_index);
          __yo_t20 byte_opt = _file____User_temp_2790;
          switch ((byte_opt).tag) {
          case __YO_T20_SOME: {
            uint8_t byte = byte_opt.data.Some.value;
            bool __yo_sc_yo_id_12191 = true;
            if (!(((byte) < (128)))) {
              __yo_sc_yo_id_12191 = ((byte) >= (192));
            }
            bool is_start = __yo_sc_yo_id_12191;
            if (is_start) {
              if (((char_index) == (effective_end))) {
                size_t _file____User_temp_2795 = end_byte_index; // Save old value for later use
                end_byte_index = byte_index;
                goto loop_yo_id_12189;
              }
              else {
                size_t _file____User_temp_2798 = char_index; // Save old value for later use
                char_index = ((char_index) + (1ULL));
              }
            }
            else {
            }
            break;
          }
          case __YO_T20_NONE: {
            break;
          }
          }
          } // end begin block (loop body)
        continue_yo_id_12190:;
          byte_index = ((byte_index) + (1ULL));
        }
        loop_yo_id_12189:;
        bool _file____User_temp_2837;
        if (((suffix_bytes) > (end_byte_index))) {
          _file____User_temp_2837 = false;
        }
        else {
          size_t _file____User_temp_2813 = ((end_byte_index) - (suffix_bytes));
          size_t offset = _file____User_temp_2813;
          size_t i = 0ULL;
          bool matches = true;
          while (true) {
            if (!(((i) < (suffix_bytes)))) {
              break;
            }
            { // begin block (loop body)
            __yo_t20 _file____User_temp_2817 = yo_id_3138_rtparam0_R_gs_yo_id_3109_u8_rtparam1_usize_ret_enum_yo_id_3135_u8(self_al, ((offset) + (i)));
            __yo_t20 self_byte_opt = _file____User_temp_2817;
            __yo_t20 _file____User_temp_2818 = yo_id_3138_rtparam0_R_gs_yo_id_3109_u8_rtparam1_usize_ret_enum_yo_id_3135_u8(suffix_al, i);
            __yo_t20 suffix_byte_opt = _file____User_temp_2818;
            switch ((self_byte_opt).tag) {
            case __YO_T20_SOME: {
              uint8_t self_byte = self_byte_opt.data.Some.value;
              switch ((suffix_byte_opt).tag) {
              case __YO_T20_SOME: {
                uint8_t suffix_byte = suffix_byte_opt.data.Some.value;
                if (((self_byte) != (suffix_byte))) {
                  bool _file____User_temp_2821 = matches; // Save old value for later use
                  matches = false;
                  goto loop_yo_id_12192;
                }
                else {
                }
                break;
              }
              case __YO_T20_NONE: {
                bool _file____User_temp_2826 = matches; // Save old value for later use
                matches = false;
                _file____User_temp_2826;
                goto loop_yo_id_12192;
                break;
              }
              }
              break;
            }
            case __YO_T20_NONE: {
              bool _file____User_temp_2830 = matches; // Save old value for later use
              matches = false;
              _file____User_temp_2830;
              goto loop_yo_id_12192;
              break;
            }
            }
            } // end begin block (loop body)
          continue_yo_id_12193:;
            i = ((i) + (1ULL));
          }
          loop_yo_id_12192:;
          // Drop local variables before early return
switch ((_file____User_temp_2759).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_2759).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_2765).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_2765).data.Some.value));
    break;
  }
  default: break;
}
          return matches;
        }
        _file____User_temp_2840 = _file____User_temp_2837;
        break;
      }
      }
switch ((_file____User_temp_2777).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_2777).data.Some.value));
    break;
  }
  default: break;
}
      _file____User_temp_2842 = _file____User_temp_2840;
      break;
    }
    }
switch ((_file____User_temp_2774).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_2774).data.Some.value));
    break;
  }
  default: break;
}
    _file____User_temp_2843 = _file____User_temp_2842;
  }
  bool __yo_scope_ret = _file____User_temp_2843;
switch ((_file____User_temp_2759).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_2759).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_2765).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_2765).data.Some.value));
    break;
  }
  default: break;
}
  return __yo_scope_ret;
}
static inline __yo_t0* yo_id_3124__ret_R_gs_yo_id_3109_u8() {
  __yo_t0* _file____User_temp_1454 = __yo_new___yo_t0(NULL, 0ULL, 0ULL);
  return _file____User_temp_1454;
}
static inline __yo_t9 yo_id_3136_rtparam0_R_gs_yo_id_3109_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_ret_enum_yo_id_3135_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8(__yo_t16* self) {
  __yo_t9 _file____User_temp_4815;
  if (((self->_length) == (0ULL))) {
    _file____User_temp_4815 = (__yo_t9){ .tag = __YO_T9_NONE };
  }
  else {
    size_t _file____User_temp_4801 = self->_length; // Save old value for later use
    self->_length = ((self->_length) - (1ULL));
    __yo_t9 _file____User_temp_4812;
    __yo_t10* _file____User_temp_4803 = self->_ptr;
    if (_file____User_temp_4803 != NULL) {
      __yo_t10* _ptr = _file____User_temp_4803;
      __yo_t10* _file____User_temp_4806 = (_ptr + self->_length);
      __yo_t10* last_element_ptr = _file____User_temp_4806;
      __yo_t10 _file____User_temp_4807 = (*last_element_ptr);
__yo_t11 temp_dup_enum_yo_id_12194 = _file____User_temp_4807;
switch ((temp_dup_enum_yo_id_12194).tag) {
  case __YO_T11_SOME: {
    (temp_dup_enum_yo_id_12194).data.Some.value = ((__yo_t0*)__yo_incr_rc((void*)((temp_dup_enum_yo_id_12194).data.Some.value)));
    break;
  }
  default: break;
}
      temp_dup_enum_yo_id_12194;
      __yo_t10 last_element = _file____User_temp_4807;
switch (((*last_element_ptr)).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((*last_element_ptr)).data.Some.value));
    break;
  }
  default: break;
}
__yo_t11 temp_dup_enum_yo_id_12195 = last_element;
switch ((temp_dup_enum_yo_id_12195).tag) {
  case __YO_T11_SOME: {
    (temp_dup_enum_yo_id_12195).data.Some.value = ((__yo_t0*)__yo_incr_rc((void*)((temp_dup_enum_yo_id_12195).data.Some.value)));
    break;
  }
  default: break;
}
      temp_dup_enum_yo_id_12195;
      __yo_t9 _file____User_temp_4810 = (__yo_t9){ .tag = __YO_T9_SOME, .data = { .Some = { .value = last_element } } };
switch ((last_element).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((last_element).data.Some.value));
    break;
  }
  default: break;
}
      _file____User_temp_4812 = _file____User_temp_4810;
    } else {
      _file____User_temp_4812 = (__yo_t9){ .tag = __YO_T9_NONE };
    }
    _file____User_temp_4815 = _file____User_temp_4812;
  }
  return _file____User_temp_4815;
}
static inline __yo_t18 yo_id_5984() {
  __yo_t18 _file____User_temp_6392;
  { // begin block
    size_t buf_size = 4096ULL;
    void* _file____User_temp_6379 = yo_id_2456_rtparam0_enum_yo_id_2455___void__ret___void_(__yo_malloc(buf_size));
    char* buf = ((char*)(_file____User_temp_6379));
    char* result_ptr = getcwd(buf, buf_size);
    __yo_t18 _file____User_temp_6391;
    if (result_ptr != NULL) {
      char* ptr = result_ptr;
      __yo_t12 _file____User_temp_6385 = yo_id_3383(((uint8_t*)(ptr)));
      __yo_t10 _file____User_temp_6386 = yo_id_2712_rtparam0_enum_yo_id_3287_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_enum_yo_id_3272_usize_usize_ret_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8(_file____User_temp_6385);
      __yo_t10 cwd_str = _file____User_temp_6386;
      void* _file____User_temp_6387 = ((void*)(buf));
      __yo_free(_file____User_temp_6387);
      __yo_t19* _file____User_temp_6388 = yo_id_5032(cwd_str);
      __yo_t18 _file____User_temp_6389 = (__yo_t18){ .tag = __YO_T18_OK, .data = { .Ok = { .value = _file____User_temp_6388 } } };
switch ((_file____User_temp_6385).tag) {
  case __YO_T12_OK: {
switch (((_file____User_temp_6385).data.Ok.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_6385).data.Ok.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
switch ((cwd_str).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((cwd_str).data.Some.value));
    break;
  }
  default: break;
}
      _file____User_temp_6391 = _file____User_temp_6389;
    } else {
      void* _file____User_temp_6380 = ((void*)(buf));
      __yo_free(_file____User_temp_6380);
      __yo_str __yo_ref_spill_1 = (__yo_str){ .ptr = (const uint8_t*)"Failed to get current working directory", .len = 39 };
      __yo_t10 _file____User_temp_6381 = yo_id_4873((&(__yo_ref_spill_1)));
      __yo_t18 _file____User_temp_6382 = (__yo_t18){ .tag = __YO_T18_ERR, .data = { .Err = { .error = _file____User_temp_6381 } } };
      _file____User_temp_6391 = _file____User_temp_6382;
    }
    _file____User_temp_6392 = _file____User_temp_6391;
  } // end begin block
  _file____User_temp_6392 = _file____User_temp_6392;
  return _file____User_temp_6392;
}
static inline size_t yo_id_3119_rtparam0_R_gs_yo_id_3109_u8_ret_usize(__yo_t0* self) {
  size_t _file____User_temp_1469 = self->_length;
  return _file____User_temp_1469;
}
static inline void yo_id_3168_rtparam0_R_gs_yo_id_3109_R_struct_yo_id_9715_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_i32_i32_i32_rtparam1_struct_yo_id_10___u8__ret_unit(__yo_t31* self, __yo_t46 tracer) {
  __yo_t28** _file____User_temp_14165 = self->_ptr;
  if (_file____User_temp_14165 != NULL) {
    __yo_t28** base = _file____User_temp_14165;
    size_t i = 0ULL;
    while (true) {
      if (!(((i) < (self->_length)))) {
        break;
      }
      { // begin block (loop body)
      yo_id_12_SemVer_id_R_struct_yo_id_9715_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_i32_i32_i32_rtparam0_struct_yo_id_10___u8__rtparam1___R_struct_yo_id_9715_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_i32_i32_i32__ret_unit(tracer, (base + i));
      size_t _file____User_temp_14175 = i; // Save old value for later use
      i = ((i) + (1ULL));
      _file____User_temp_14175;
      } // end begin block (loop body)
    }
    loop_yo_id_12196:;
  } else {
  }
}
static inline int32_t yo_id_9831(__yo_t28* a, __yo_t28* b) {
  int32_t _file____User_temp_11740;
  if (((a->major) != (b->major))) {
    int32_t _file____User_temp_11697;
    if (((a->major) > (b->major))) {
      _file____User_temp_11697 = 1;
    }
    else {
      _file____User_temp_11697 = -1;
    }
    _file____User_temp_11740 = _file____User_temp_11697;
  }
  else {
    int32_t _file____User_temp_11738;
    if (((a->minor) != (b->minor))) {
      int32_t _file____User_temp_11715;
      if (((a->minor) > (b->minor))) {
        _file____User_temp_11715 = 1;
      }
      else {
        _file____User_temp_11715 = -1;
      }
      _file____User_temp_11738 = _file____User_temp_11715;
    }
    else {
      int32_t _file____User_temp_11736;
      if (((a->patch) != (b->patch))) {
        int32_t _file____User_temp_11733;
        if (((a->patch) > (b->patch))) {
          _file____User_temp_11733 = 1;
        }
        else {
          _file____User_temp_11733 = -1;
        }
        _file____User_temp_11736 = _file____User_temp_11733;
      }
      else {
        _file____User_temp_11736 = 0;
      }
      _file____User_temp_11738 = _file____User_temp_11736;
    }
    _file____User_temp_11740 = _file____User_temp_11738;
  }
  return _file____User_temp_11740;
}
static inline void yo_id_12158(__yo_t31* self) {
  yo_id_3163_rtparam0_R_gs_yo_id_3109_R_struct_yo_id_9715_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_i32_i32_i32_ret_unit(self);
}
static inline __yo_t23 yo_id_3138_rtparam0_R_gs_yo_id_3109_usize_rtparam1_usize_ret_enum_yo_id_3135_usize(__yo_t24* self, size_t index) {
  __yo_t23 _file____User_temp_2606;
  if (((index) >= (self->_length))) {
    _file____User_temp_2606 = (__yo_t23){ .tag = __YO_T23_NONE };
  }
  else {
    __yo_t23 _file____User_temp_2604;
    size_t* _file____User_temp_2597 = self->_ptr;
    if (_file____User_temp_2597 != NULL) {
      size_t* _ptr = _file____User_temp_2597;
      __yo_t23 _file____User_temp_2602 = (__yo_t23){ .tag = __YO_T23_SOME, .data = { .Some = { .value = (*(_ptr + index)) } } };
      _file____User_temp_2604 = _file____User_temp_2602;
    } else {
      _file____User_temp_2604 = (__yo_t23){ .tag = __YO_T23_NONE };
    }
    _file____User_temp_2606 = _file____User_temp_2604;
  }
  return _file____User_temp_2606;
}
static inline bool fn_yo_id_3045(__yo_t26 a, __yo_t26 b) {
  return ((a) < (b));
}
static inline __yo_t10 yo_id_4027(__yo_t10 self) {
  __yo_t10 _file____User_temp_3159;
  __yo_t11 _file____User_temp_3098 = self;
__yo_t11 temp_dup_enum_yo_id_12197 = _file____User_temp_3098;
switch ((temp_dup_enum_yo_id_12197).tag) {
  case __YO_T11_SOME: {
    (temp_dup_enum_yo_id_12197).data.Some.value = ((__yo_t0*)__yo_incr_rc((void*)((temp_dup_enum_yo_id_12197).data.Some.value)));
    break;
  }
  default: break;
}
  temp_dup_enum_yo_id_12197;
  switch ((_file____User_temp_3098).tag) {
  case __YO_T11_NONE: {
    _file____User_temp_3159 = ((__yo_t10)((__yo_t11){ .tag = __YO_T11_NONE }));
    break;
  }
  case __YO_T11_SOME: {
    __yo_t0* al = _file____User_temp_3098.data.Some.value;
    size_t _file____User_temp_3101 = yo_id_3119_rtparam0_R_gs_yo_id_3109_u8_ret_usize(al);
    size_t total_bytes = _file____User_temp_3101;
    if (((total_bytes) == (0ULL))) {
      __yo_t10 _file____User_temp_3105 = ((__yo_t10)((__yo_t11){ .tag = __YO_T11_NONE }));
      return _file____User_temp_3105;
    }
    else {
    }
    size_t start_idx = 0ULL;
    while (true) {
      if (!(((start_idx) < (total_bytes)))) {
        break;
      }
      { // begin block (loop body)
      uint8_t b = (*yo_id_3158_rtparam0_R_gs_yo_id_3109_u8_rtparam1_usize_ret___u8_(&al, start_idx));
      bool _file____User_temp_3114 = yo_id_4019(b);
      __yo_effect_escaped = 0;
      bool _file____User_temp_3118 = yo_id_122_bool_id_bool_rtparam0_bool_ret_bool((bool)(_file____User_temp_3114));
      if (__yo_effect_escaped) {
        return (__yo_t10){0};
      }
      if (_file____User_temp_3118) {
        goto loop_yo_id_12198;
      }
      else {
      }
      size_t _file____User_temp_3123 = start_idx; // Save old value for later use
      start_idx = ((start_idx) + (1ULL));
      _file____User_temp_3123;
      } // end begin block (loop body)
    }
    loop_yo_id_12198:;
    size_t end_idx = total_bytes;
    while (true) {
      if (!(((end_idx) > (start_idx)))) {
        break;
      }
      { // begin block (loop body)
      uint8_t b = (*yo_id_3158_rtparam0_R_gs_yo_id_3109_u8_rtparam1_usize_ret___u8_(&al, ((end_idx) - (1ULL))));
      bool _file____User_temp_3131 = yo_id_4019(b);
      __yo_effect_escaped = 0;
      bool _file____User_temp_3133 = yo_id_122_bool_id_bool_rtparam0_bool_ret_bool((bool)(_file____User_temp_3131));
      if (__yo_effect_escaped) {
        return (__yo_t10){0};
      }
      if (_file____User_temp_3133) {
        goto loop_yo_id_12199;
      }
      else {
      }
      size_t _file____User_temp_3138 = end_idx; // Save old value for later use
      end_idx = ((end_idx) - (1ULL));
      _file____User_temp_3138;
      } // end begin block (loop body)
    }
    loop_yo_id_12199:;
    if (((start_idx) >= (end_idx))) {
      __yo_t10 _file____User_temp_3143 = ((__yo_t10)((__yo_t11){ .tag = __YO_T11_NONE }));
      return _file____User_temp_3143;
    }
    else {
    }
    size_t count = ((end_idx) - (start_idx));
    __yo_t0* _file____User_temp_3148 = yo_id_3130_rtparam0_usize_ret_R_gs_yo_id_3109_u8((size_t)(count));
    __yo_t0* new_bytes = _file____User_temp_3148;
    uint8_t* _file____User_temp_3150 = yo_id_3122_rtparam0_R_gs_yo_id_3109_u8_ret_enum_yo_id_3118___u8_(al);
    if (_file____User_temp_3150 != NULL) {
      uint8_t* p = _file____User_temp_3150;
      yo_id_3149_rtparam0_R_gs_yo_id_3109_u8_rtparam1___u8__rtparam2_usize_ret_unit(new_bytes, (p + start_idx), count);
    } else {
    }
    ((__yo_t0*)__yo_incr_rc((void*)(new_bytes)));
    __yo_t11 _file____User_temp_3156 = (__yo_t11){ .tag = __YO_T11_SOME, .data = { .Some = { .value = new_bytes } } };
    __yo_t10 _file____User_temp_3157 = ((__yo_t10)(_file____User_temp_3156));
    __yo_decr_rc((void*)(new_bytes));
    _file____User_temp_3159 = _file____User_temp_3157;
    break;
  }
  }
  return _file____User_temp_3159;
}
static inline void yo_id_12_usize_id_usize_rtparam0_struct_yo_id_10___u8__rtparam1___usize__ret_unit(__yo_t46 self, size_t* slot) {
  ((void)0);
}
static inline __yo_t10 yo_id_3607(__yo_t10 self, __yo_t10 other) {
  size_t _file____User_temp_1948;
  __yo_t11 _file____User_temp_1944 = self;
__yo_t11 temp_dup_enum_yo_id_12200 = _file____User_temp_1944;
switch ((temp_dup_enum_yo_id_12200).tag) {
  case __YO_T11_SOME: {
    (temp_dup_enum_yo_id_12200).data.Some.value = ((__yo_t0*)__yo_incr_rc((void*)((temp_dup_enum_yo_id_12200).data.Some.value)));
    break;
  }
  default: break;
}
  temp_dup_enum_yo_id_12200;
  switch ((_file____User_temp_1944).tag) {
  case __YO_T11_SOME: {
    __yo_t0* b = _file____User_temp_1944.data.Some.value;
    size_t _file____User_temp_1946 = yo_id_3119_rtparam0_R_gs_yo_id_3109_u8_ret_usize(b);
    _file____User_temp_1948 = _file____User_temp_1946;
    break;
  }
  case __YO_T11_NONE: {
    _file____User_temp_1948 = 0ULL;
    break;
  }
  }
  size_t self_len = _file____User_temp_1948;
  size_t _file____User_temp_1954;
  __yo_t11 _file____User_temp_1950 = other;
__yo_t11 temp_dup_enum_yo_id_12201 = _file____User_temp_1950;
switch ((temp_dup_enum_yo_id_12201).tag) {
  case __YO_T11_SOME: {
    (temp_dup_enum_yo_id_12201).data.Some.value = ((__yo_t0*)__yo_incr_rc((void*)((temp_dup_enum_yo_id_12201).data.Some.value)));
    break;
  }
  default: break;
}
  temp_dup_enum_yo_id_12201;
  switch ((_file____User_temp_1950).tag) {
  case __YO_T11_SOME: {
    __yo_t0* b = _file____User_temp_1950.data.Some.value;
    size_t _file____User_temp_1952 = yo_id_3119_rtparam0_R_gs_yo_id_3109_u8_ret_usize(b);
    _file____User_temp_1954 = _file____User_temp_1952;
    break;
  }
  case __YO_T11_NONE: {
    _file____User_temp_1954 = 0ULL;
    break;
  }
  }
  size_t other_len = _file____User_temp_1954;
  bool __yo_sc_yo_id_12202 = false;
  if (((self_len) == (0ULL))) {
    __yo_sc_yo_id_12202 = ((other_len) == (0ULL));
  }
  if (__yo_sc_yo_id_12202) {
    __yo_t10 _file____User_temp_1959 = ((__yo_t10)((__yo_t11){ .tag = __YO_T11_NONE }));
    // Drop local variables before early return
switch ((_file____User_temp_1944).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_1944).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_1950).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_1950).data.Some.value));
    break;
  }
  default: break;
}
    return _file____User_temp_1959;
  }
  else {
  }
  __yo_t0* _file____User_temp_1964 = yo_id_3130_rtparam0_usize_ret_R_gs_yo_id_3109_u8((size_t)(((self_len) + (other_len))));
  __yo_t0* new_bytes = _file____User_temp_1964;
  __yo_t11 _file____User_temp_1966 = self;
__yo_t11 temp_dup_enum_yo_id_12203 = _file____User_temp_1966;
switch ((temp_dup_enum_yo_id_12203).tag) {
  case __YO_T11_SOME: {
    (temp_dup_enum_yo_id_12203).data.Some.value = ((__yo_t0*)__yo_incr_rc((void*)((temp_dup_enum_yo_id_12203).data.Some.value)));
    break;
  }
  default: break;
}
  temp_dup_enum_yo_id_12203;
  switch ((_file____User_temp_1966).tag) {
  case __YO_T11_SOME: {
    __yo_t0* b = _file____User_temp_1966.data.Some.value;
    uint8_t* _file____User_temp_1968 = yo_id_3122_rtparam0_R_gs_yo_id_3109_u8_ret_enum_yo_id_3118___u8_(b);
    if (_file____User_temp_1968 != NULL) {
      uint8_t* p = _file____User_temp_1968;
      yo_id_3149_rtparam0_R_gs_yo_id_3109_u8_rtparam1___u8__rtparam2_usize_ret_unit(new_bytes, p, self_len);
    } else {
    }
    break;
  }
  case __YO_T11_NONE: {
    break;
  }
  }
  __yo_t11 _file____User_temp_1977 = other;
__yo_t11 temp_dup_enum_yo_id_12204 = _file____User_temp_1977;
switch ((temp_dup_enum_yo_id_12204).tag) {
  case __YO_T11_SOME: {
    (temp_dup_enum_yo_id_12204).data.Some.value = ((__yo_t0*)__yo_incr_rc((void*)((temp_dup_enum_yo_id_12204).data.Some.value)));
    break;
  }
  default: break;
}
  temp_dup_enum_yo_id_12204;
  switch ((_file____User_temp_1977).tag) {
  case __YO_T11_SOME: {
    __yo_t0* b = _file____User_temp_1977.data.Some.value;
    uint8_t* _file____User_temp_1979 = yo_id_3122_rtparam0_R_gs_yo_id_3109_u8_ret_enum_yo_id_3118___u8_(b);
    if (_file____User_temp_1979 != NULL) {
      uint8_t* p = _file____User_temp_1979;
      yo_id_3149_rtparam0_R_gs_yo_id_3109_u8_rtparam1___u8__rtparam2_usize_ret_unit(new_bytes, p, other_len);
    } else {
    }
    break;
  }
  case __YO_T11_NONE: {
    break;
  }
  }
  ((__yo_t0*)__yo_incr_rc((void*)(new_bytes)));
  __yo_t11 _file____User_temp_1987 = (__yo_t11){ .tag = __YO_T11_SOME, .data = { .Some = { .value = new_bytes } } };
  __yo_t10 _file____User_temp_1988 = ((__yo_t10)(_file____User_temp_1987));
  // Drop local variables before early return
switch ((_file____User_temp_1944).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_1944).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_1950).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_1950).data.Some.value));
    break;
  }
  default: break;
}
  __yo_decr_rc((void*)(new_bytes));
switch ((_file____User_temp_1966).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_1966).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_1977).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_1977).data.Some.value));
    break;
  }
  default: break;
}
  return _file____User_temp_1988;
}
static inline __yo_t16* yo_id_5913() {
  size_t i = 0ULL;
  __yo_effect_escaped = 0;
  int32_t _file____User_temp_6229 = yo_id_5908();
  if (__yo_effect_escaped) {
    return (__yo_t16*){0};
  }
  size_t len = ((size_t)(_file____User_temp_6229));
  __yo_t16* _file____User_temp_6230 = yo_id_3130_rtparam0_usize_ret_R_gs_yo_id_3109_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8((size_t)(len));
  __yo_t16* result = _file____User_temp_6230;
  while (true) {
    if (!(((i) < (len)))) {
      break;
    }
    { // begin block (loop body)
    uint8_t* _file____User_temp_6250 = (*(__yo_argv + i));
    uint8_t* arg_ptr = _file____User_temp_6250;
    __yo_t12 _file____User_temp_6252 = yo_id_3383(arg_ptr);
    __yo_t10 _file____User_temp_6257 = yo_id_2712_rtparam0_enum_yo_id_3287_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_enum_yo_id_3272_usize_usize_ret_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8(_file____User_temp_6252);
    __yo_t10 arg_str = _file____User_temp_6257;
    __yo_t6 _file____User_temp_6322 = yo_id_3133_rtparam0_R_gs_yo_id_3109_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam1_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_ret_enum_yo_id_3132_unit_enum_yo_id_3108_enum_yo_id_3055_usize_usize(result, arg_str);
    _file____User_temp_6322;
    size_t _file____User_temp_6324 = i; // Save old value for later use
    i = ((i) + (1ULL));
    _file____User_temp_6324;
switch ((_file____User_temp_6252).tag) {
  case __YO_T12_OK: {
switch (((_file____User_temp_6252).data.Ok.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_6252).data.Ok.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
switch ((arg_str).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((arg_str).data.Some.value));
    break;
  }
  default: break;
}
    } // end begin block (loop body)
  }
  loop_yo_id_12205:;
  return result;
}
static inline __yo_t10 yo_id_3356(__yo_str slice) {
  size_t _file____User_temp_1481 = (slice.len);
  size_t slen = _file____User_temp_1481;
  if (((slen) == (0ULL))) {
    __yo_t10 _file____User_temp_1485 = ((__yo_t10)((__yo_t11){ .tag = __YO_T11_NONE }));
    return _file____User_temp_1485;
  }
  else {
  }
  __yo_t0* _file____User_temp_1489 = yo_id_3130_rtparam0_usize_ret_R_gs_yo_id_3109_u8((size_t)(slen));
  __yo_t0* bytes = _file____User_temp_1489;
  yo_id_3149_rtparam0_R_gs_yo_id_3109_u8_rtparam1___u8__rtparam2_usize_ret_unit(bytes, ((uint8_t*)slice.ptr), slen);
  ((__yo_t0*)__yo_incr_rc((void*)(bytes)));
  __yo_t11 _file____User_temp_1554 = (__yo_t11){ .tag = __YO_T11_SOME, .data = { .Some = { .value = bytes } } };
  __yo_t10 _file____User_temp_1555 = ((__yo_t10)(_file____User_temp_1554));
  // Drop local variables before early return
  __yo_decr_rc((void*)(bytes));
  return _file____User_temp_1555;
}
static inline void yo_id_3141_rtparam0_R_gs_yo_id_3109_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_ret_unit(__yo_t16* self) {
  { // begin block
    if (((self->_length) > (0ULL))) {
      size_t i = 0ULL;
      __yo_t10* _file____User_temp_14236 = yo_id_2456_rtparam0_enum_yo_id_3323___struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8__ret___struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_(self->_ptr);
      __yo_t10* base_ptr = _file____User_temp_14236;
      while (true) {
        if (!(((i) < (self->_length)))) {
          break;
        }
        { // begin block (loop body)
        __yo_t10* _file____User_temp_14241 = (base_ptr + i);
        __yo_t10* element_ptr = _file____User_temp_14241;
switch (((*element_ptr)).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((*element_ptr)).data.Some.value));
    break;
  }
  default: break;
}
        } // end begin block (loop body)
      continue_yo_id_12207:;
        i = ((i) + (1ULL));
      }
      loop_yo_id_12206:;
    }
    else {
    }
  } // end begin block
}
static inline __yo_t27 yo_id_3595(__yo_t10 self, size_t index) {
  __yo_t11 _file____User_temp_1915 = self;
__yo_t11 temp_dup_enum_yo_id_12208 = _file____User_temp_1915;
switch ((temp_dup_enum_yo_id_12208).tag) {
  case __YO_T11_SOME: {
    (temp_dup_enum_yo_id_12208).data.Some.value = ((__yo_t0*)__yo_incr_rc((void*)((temp_dup_enum_yo_id_12208).data.Some.value)));
    break;
  }
  default: break;
}
  temp_dup_enum_yo_id_12208;
  switch ((_file____User_temp_1915).tag) {
  case __YO_T11_NONE: {
    __yo_t27 _file____User_temp_1916 = (__yo_t27){ .tag = __YO_T27_NONE };
    return _file____User_temp_1916;
    break;
  }
  case __YO_T11_SOME: {
    __yo_t0* al = _file____User_temp_1915.data.Some.value;
    size_t char_count = 0ULL;
    size_t byte_index = 0ULL;
    size_t _file____User_temp_1918 = yo_id_3119_rtparam0_R_gs_yo_id_3109_u8_ret_usize(al);
    size_t total_bytes = _file____User_temp_1918;
    while (true) {
      if (!(((byte_index) < (total_bytes)))) {
        break;
      }
      { // begin block (loop body)
      __yo_t20 _file____User_temp_1921 = yo_id_3138_rtparam0_R_gs_yo_id_3109_u8_rtparam1_usize_ret_enum_yo_id_3135_u8(al, byte_index);
      __yo_t20 byte_opt = _file____User_temp_1921;
      switch ((byte_opt).tag) {
      case __YO_T20_SOME: {
        uint8_t byte = byte_opt.data.Some.value;
        bool __yo_sc_yo_id_12211 = true;
        if (!(((byte) < (128)))) {
          __yo_sc_yo_id_12211 = ((byte) >= (192));
        }
        bool is_start = __yo_sc_yo_id_12211;
        if (is_start) {
          if (((char_count) == (index))) {
            __yo_t27 _file____User_temp_1926 = yo_id_3454(self, byte_index);
            return _file____User_temp_1926;
          }
          else {
            size_t _file____User_temp_1929 = char_count; // Save old value for later use
            char_count = ((char_count) + (1ULL));
          }
        }
        else {
        }
        break;
      }
      case __YO_T20_NONE: {
        break;
      }
      }
      } // end begin block (loop body)
    continue_yo_id_12210:;
      byte_index = ((byte_index) + (1ULL));
    }
    loop_yo_id_12209:;
    __yo_t27 _file____User_temp_1941 = (__yo_t27){ .tag = __YO_T27_NONE };
    return _file____User_temp_1941;
    break;
  }
  }
  return ;
}
static inline void yo_id_12144(__yo_t16* self) {
  yo_id_3163_rtparam0_R_gs_yo_id_3109_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_ret_unit(self);
}
static inline void yo_id_3163_rtparam0_R_gs_yo_id_3109_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_ret_unit(__yo_t16* self) {
  __yo_t10* _file____User_temp_14220 = self->_ptr;
  if (_file____User_temp_14220 != NULL) {
    __yo_t10* _ptr = _file____User_temp_14220;
    yo_id_3141_rtparam0_R_gs_yo_id_3109_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_ret_unit((__yo_t16*)(self));
    size_t _file____User_temp_14253 = self->_length; // Save old value for later use
    self->_length = 0ULL;
    _file____User_temp_14253;
    void* _file____User_temp_14254 = ((void*)(_ptr));
    __yo_borrow_assert_unborrowed((void*)self);
    __yo_free(_file____User_temp_14254);
    __yo_t10* _file____User_temp_14256 = self->_ptr; // Save old value for later use
    self->_ptr = NULL;
    _file____User_temp_14256;
  } else {
  }
}
static inline bool fn_yo_id_3038(__yo_t26 a, __yo_t26 b) {
  return ((a) == (b));
}
static inline bool yo_id_4217(__yo_t10 self, __yo_t10 haystack, size_t end_position) {
  bool _file____User_temp_3414 = yo_id_3903(haystack, self, end_position);
  return _file____User_temp_3414;
}
static inline __yo_t23 yo_id_3814(__yo_t10 self, __yo_t10 substr, size_t from_index) {
  __yo_t23 _file____User_temp_2662;
  bool _file____User_temp_2475 = yo_id_3427(substr);
  if (_file____User_temp_2475) {
    size_t _file____User_temp_2476 = yo_id_3414(self);
    __yo_t23 _file____User_temp_2478 = (__yo_t23){ .tag = __YO_T23_SOME, .data = { .Some = { .value = _file____User_temp_2476 } } };
    _file____User_temp_2662 = _file____User_temp_2478;
  }
  else {
    __yo_t23 _file____User_temp_2661;
    __yo_t11 _file____User_temp_2480 = self;
__yo_t11 temp_dup_enum_yo_id_12212 = _file____User_temp_2480;
switch ((temp_dup_enum_yo_id_12212).tag) {
  case __YO_T11_SOME: {
    (temp_dup_enum_yo_id_12212).data.Some.value = ((__yo_t0*)__yo_incr_rc((void*)((temp_dup_enum_yo_id_12212).data.Some.value)));
    break;
  }
  default: break;
}
    temp_dup_enum_yo_id_12212;
    switch ((_file____User_temp_2480).tag) {
    case __YO_T11_NONE: {
      _file____User_temp_2661 = (__yo_t23){ .tag = __YO_T23_NONE };
      break;
    }
    case __YO_T11_SOME: {
      __yo_t0* self_al = _file____User_temp_2480.data.Some.value;
      __yo_t23 _file____User_temp_2659;
      __yo_t11 _file____User_temp_2483 = substr;
__yo_t11 temp_dup_enum_yo_id_12213 = _file____User_temp_2483;
switch ((temp_dup_enum_yo_id_12213).tag) {
  case __YO_T11_SOME: {
    (temp_dup_enum_yo_id_12213).data.Some.value = ((__yo_t0*)__yo_incr_rc((void*)((temp_dup_enum_yo_id_12213).data.Some.value)));
    break;
  }
  default: break;
}
      temp_dup_enum_yo_id_12213;
      switch ((_file____User_temp_2483).tag) {
      case __YO_T11_NONE: {
        _file____User_temp_2659 = (__yo_t23){ .tag = __YO_T23_NONE };
        break;
      }
      case __YO_T11_SOME: {
        __yo_t0* sub_al = _file____User_temp_2483.data.Some.value;
        size_t _file____User_temp_2485 = yo_id_3119_rtparam0_R_gs_yo_id_3109_u8_ret_usize(self_al);
        size_t self_bytes = _file____User_temp_2485;
        size_t _file____User_temp_2486 = yo_id_3119_rtparam0_R_gs_yo_id_3109_u8_ret_usize(sub_al);
        size_t sub_bytes = _file____User_temp_2486;
        __yo_t23 _file____User_temp_2656;
        if (((sub_bytes) > (self_bytes))) {
          _file____User_temp_2656 = (__yo_t23){ .tag = __YO_T23_NONE };
        }
        else {
          __yo_t24* _file____User_temp_2493 = yo_id_3124__ret_R_gs_yo_id_3109_usize();
          __yo_t24* char_positions = _file____User_temp_2493;
          __yo_t24* _file____User_temp_2496 = yo_id_3124__ret_R_gs_yo_id_3109_usize();
          __yo_t24* byte_positions = _file____User_temp_2496;
          size_t byte_idx = 0ULL;
          size_t char_idx = 0ULL;
          while (true) {
            if (!(((byte_idx) < (self_bytes)))) {
              break;
            }
            { // begin block (loop body)
            __yo_t20 _file____User_temp_2499 = yo_id_3138_rtparam0_R_gs_yo_id_3109_u8_rtparam1_usize_ret_enum_yo_id_3135_u8(self_al, byte_idx);
            __yo_t20 byte_opt = _file____User_temp_2499;
            switch ((byte_opt).tag) {
            case __YO_T20_SOME: {
              uint8_t byte = byte_opt.data.Some.value;
              bool __yo_sc_yo_id_12216 = true;
              if (!(((byte) < (128)))) {
                __yo_sc_yo_id_12216 = ((byte) >= (192));
              }
              bool is_start = __yo_sc_yo_id_12216;
              if (is_start) {
                __yo_t6 _file____User_temp_2566 = yo_id_3133_rtparam0_R_gs_yo_id_3109_usize_rtparam1_usize_ret_enum_yo_id_3132_unit_enum_yo_id_3108_enum_yo_id_3055_usize_usize(char_positions, char_idx);
                __yo_t6 _file____User_temp_2567 = yo_id_3133_rtparam0_R_gs_yo_id_3109_usize_rtparam1_usize_ret_enum_yo_id_3132_unit_enum_yo_id_3108_enum_yo_id_3055_usize_usize(byte_positions, byte_idx);
                size_t _file____User_temp_2569 = char_idx; // Save old value for later use
                char_idx = ((char_idx) + (1ULL));
              }
              else {
              }
              break;
            }
            case __YO_T20_NONE: {
              break;
            }
            }
            } // end begin block (loop body)
          continue_yo_id_12215:;
            byte_idx = ((byte_idx) + (1ULL));
          }
          loop_yo_id_12214:;
          size_t _file____User_temp_2584;
          if (((from_index) >= (char_idx))) {
            _file____User_temp_2584 = char_idx;
          }
          else {
            _file____User_temp_2584 = ((from_index) + (1ULL));
          }
          size_t max_char_index = _file____User_temp_2584;
          __yo_t23 last_match = (__yo_t23){ .tag = __YO_T23_NONE };
          size_t i = 0ULL;
          while (true) {
            size_t _file____User_temp_2588 = yo_id_3119_rtparam0_R_gs_yo_id_3109_usize_ret_usize(char_positions);
            if (!(((i) < (_file____User_temp_2588)))) {
              break;
            }
            { // begin block (loop body)
            __yo_t23 _file____User_temp_2607 = yo_id_3138_rtparam0_R_gs_yo_id_3109_usize_rtparam1_usize_ret_enum_yo_id_3135_usize(char_positions, i);
            __yo_t23 char_pos_opt = _file____User_temp_2607;
            __yo_t23 _file____User_temp_2608 = yo_id_3138_rtparam0_R_gs_yo_id_3109_usize_rtparam1_usize_ret_enum_yo_id_3135_usize(byte_positions, i);
            __yo_t23 byte_pos_opt = _file____User_temp_2608;
            switch ((char_pos_opt).tag) {
            case __YO_T23_SOME: {
              size_t char_pos = char_pos_opt.data.Some.value;
              switch ((byte_pos_opt).tag) {
              case __YO_T23_SOME: {
                size_t byte_pos = byte_pos_opt.data.Some.value;
                if (((char_pos) >= (max_char_index))) {
                  goto loop_yo_id_12217;
                }
                else {
                  if (((((byte_pos) + (sub_bytes))) <= (self_bytes))) {
                    bool matches = true;
                    size_t j = 0ULL;
                    while (true) {
                      if (!(((j) < (sub_bytes)))) {
                        break;
                      }
                      { // begin block (loop body)
                      __yo_t20 _file____User_temp_2619 = yo_id_3138_rtparam0_R_gs_yo_id_3109_u8_rtparam1_usize_ret_enum_yo_id_3135_u8(self_al, ((byte_pos) + (j)));
                      __yo_t20 self_byte_opt = _file____User_temp_2619;
                      __yo_t20 _file____User_temp_2620 = yo_id_3138_rtparam0_R_gs_yo_id_3109_u8_rtparam1_usize_ret_enum_yo_id_3135_u8(sub_al, j);
                      __yo_t20 sub_byte_opt = _file____User_temp_2620;
                      switch ((self_byte_opt).tag) {
                      case __YO_T20_SOME: {
                        uint8_t self_byte = self_byte_opt.data.Some.value;
                        switch ((sub_byte_opt).tag) {
                        case __YO_T20_SOME: {
                          uint8_t sub_byte = sub_byte_opt.data.Some.value;
                          if (((self_byte) != (sub_byte))) {
                            bool _file____User_temp_2623 = matches; // Save old value for later use
                            matches = false;
                            goto loop_yo_id_12219;
                          }
                          else {
                          }
                          break;
                        }
                        case __YO_T20_NONE: {
                          bool _file____User_temp_2628 = matches; // Save old value for later use
                          matches = false;
                          _file____User_temp_2628;
                          goto loop_yo_id_12219;
                          break;
                        }
                        }
                        break;
                      }
                      case __YO_T20_NONE: {
                        bool _file____User_temp_2632 = matches; // Save old value for later use
                        matches = false;
                        _file____User_temp_2632;
                        goto loop_yo_id_12219;
                        break;
                      }
                      }
                      } // end begin block (loop body)
                    continue_yo_id_12220:;
                      j = ((j) + (1ULL));
                    }
                    loop_yo_id_12219:;
                    if (matches) {
                      __yo_t23 _file____User_temp_2639 = last_match; // Save old value for later use
                      __yo_t23 _file____User_temp_2638 = (__yo_t23){ .tag = __YO_T23_SOME, .data = { .Some = { .value = char_pos } } };
                      last_match = _file____User_temp_2638;
                    }
                    else {
                    }
                  }
                  else {
                  }
                }
                break;
              }
              case __YO_T23_NONE: {
                break;
              }
              }
              break;
            }
            case __YO_T23_NONE: {
              break;
            }
            }
            } // end begin block (loop body)
          continue_yo_id_12218:;
            i = ((i) + (1ULL));
          }
          loop_yo_id_12217:;
          // Drop local variables before early return
          __yo_decr_rc((void*)(char_positions));
          __yo_decr_rc((void*)(byte_positions));
          return last_match;
          __yo_decr_rc((void*)(char_positions));
          __yo_decr_rc((void*)(byte_positions));
        }
        _file____User_temp_2659 = _file____User_temp_2656;
        break;
      }
      }
switch ((_file____User_temp_2483).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_2483).data.Some.value));
    break;
  }
  default: break;
}
      _file____User_temp_2661 = _file____User_temp_2659;
      break;
    }
    }
switch ((_file____User_temp_2480).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_2480).data.Some.value));
    break;
  }
  default: break;
}
    _file____User_temp_2662 = _file____User_temp_2661;
  }
  return _file____User_temp_2662;
}
static inline void yo_id_3168_rtparam0_R_gs_yo_id_3109_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam1_struct_yo_id_10___u8__ret_unit(__yo_t16* self, __yo_t46 tracer) {
  __yo_t10* _file____User_temp_14149 = self->_ptr;
  if (_file____User_temp_14149 != NULL) {
    __yo_t10* base = _file____User_temp_14149;
    size_t i = 0ULL;
    while (true) {
      if (!(((i) < (self->_length)))) {
        break;
      }
      { // begin block (loop body)
      yo_id_12_String_id_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam0_struct_yo_id_10___u8__rtparam1___struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8__ret_unit(tracer, (base + i));
      size_t _file____User_temp_14158 = i; // Save old value for later use
      i = ((i) + (1ULL));
      _file____User_temp_14158;
      } // end begin block (loop body)
    }
    loop_yo_id_12221:;
  } else {
  }
}
static inline __yo_t0* yo_id_3433(__yo_t10 self) {
  __yo_t0* _file____User_temp_1709;
  __yo_t11 _file____User_temp_1705 = self;
__yo_t11 temp_dup_enum_yo_id_12222 = _file____User_temp_1705;
switch ((temp_dup_enum_yo_id_12222).tag) {
  case __YO_T11_SOME: {
    (temp_dup_enum_yo_id_12222).data.Some.value = ((__yo_t0*)__yo_incr_rc((void*)((temp_dup_enum_yo_id_12222).data.Some.value)));
    break;
  }
  default: break;
}
  temp_dup_enum_yo_id_12222;
  switch ((_file____User_temp_1705).tag) {
  case __YO_T11_NONE: {
    __yo_t0* _file____User_temp_1707 = yo_id_3124__ret_R_gs_yo_id_3109_u8();
    _file____User_temp_1709 = _file____User_temp_1707;
    break;
  }
  case __YO_T11_SOME: {
    __yo_t0* al = _file____User_temp_1705.data.Some.value;
    __yo_t0* _file____User_temp_1708 = al;
    ((__yo_t0*)__yo_incr_rc((void*)(_file____User_temp_1708)));
    _file____User_temp_1709 = _file____User_temp_1708;
    break;
  }
  }
  return _file____User_temp_1709;
}
static inline __yo_t6 yo_id_3133_rtparam0_R_gs_yo_id_3109_u8_rtparam1_u8_ret_enum_yo_id_3132_unit_enum_yo_id_3108_enum_yo_id_3055_usize_usize(__yo_t0* self, uint8_t value) {
  __yo_t6 _file____User_temp_1654;
  if (((self->_length) >= (self->_capacity))) {
    size_t _file____User_temp_1607;
    if (((self->_capacity) == (0ULL))) {
      _file____User_temp_1607 = 4ULL;
    }
    else {
      _file____User_temp_1607 = ((self->_capacity) * (2ULL));
    }
    size_t new_capacity = _file____User_temp_1607;
    void* _file____User_temp_1615;
    uint8_t* _file____User_temp_1609 = self->_ptr;
    if (_file____User_temp_1609 != NULL) {
      uint8_t* old_ptr = _file____User_temp_1609;
      void* _file____User_temp_1612 = ((void*)(old_ptr));
      __yo_borrow_assert_unborrowed((void*)self);
      _file____User_temp_1615 = __yo_realloc(_file____User_temp_1612, ((1ULL) * (new_capacity)));
    } else {
      _file____User_temp_1615 = __yo_malloc(((1ULL) * (new_capacity)));
    }
    void* new_some_ptr = _file____User_temp_1615;
    __yo_t6 _file____User_temp_1635;
    if (new_some_ptr != NULL) {
      void* new_ptr = new_some_ptr;
      uint8_t* typed_ptr = ((uint8_t*)(new_ptr));
      uint8_t* _file____User_temp_1618 = self->_ptr; // Save old value for later use
      uint8_t* _file____User_temp_1617 = typed_ptr;
      self->_ptr = _file____User_temp_1617;
      _file____User_temp_1618;
      size_t _file____User_temp_1620 = self->_capacity; // Save old value for later use
      self->_capacity = new_capacity;
      _file____User_temp_1620;
      uint8_t* _file____User_temp_1622 = (typed_ptr + self->_length);
      uint8_t* target_ptr = _file____User_temp_1622;
      uint8_t _file____User_temp_1624 = (*target_ptr); // Save old value for later use
      (*target_ptr) = value;
      _file____User_temp_1624;
      size_t _file____User_temp_1629 = self->_length; // Save old value for later use
      self->_length = ((self->_length) + (1ULL));
      _file____User_temp_1629;
      __yo_t6 _file____User_temp_1630 = (__yo_t6){ .tag = __YO_T6_OK };
      _file____User_temp_1635 = _file____User_temp_1630;
    } else {
      _file____User_temp_1635 = (__yo_t6){ .tag = __YO_T6_ERR, .data = { .Err = { .error = (__yo_t7){ .tag = __YO_T7_ALLOCERROR, .data = { .AllocError = { .error = __YO_T8_OUTOFMEMORY } } } } } };
    }
    _file____User_temp_1654 = _file____User_temp_1635;
  }
  else {
    __yo_t6 _file____User_temp_1652;
    uint8_t* _file____User_temp_1638 = self->_ptr;
    if (_file____User_temp_1638 != NULL) {
      uint8_t* _ptr = _file____User_temp_1638;
      uint8_t* _file____User_temp_1640 = (_ptr + self->_length);
      uint8_t* target_ptr = _file____User_temp_1640;
      uint8_t _file____User_temp_1642 = (*target_ptr); // Save old value for later use
      (*target_ptr) = value;
      _file____User_temp_1642;
      size_t _file____User_temp_1647 = self->_length; // Save old value for later use
      self->_length = ((self->_length) + (1ULL));
      _file____User_temp_1647;
      __yo_t6 _file____User_temp_1648 = (__yo_t6){ .tag = __YO_T6_OK };
      _file____User_temp_1652 = _file____User_temp_1648;
    } else {
      fprintf(stderr, "%s\n", "\"ArrayList has capacity but no ptr\"");
      abort();
      _file____User_temp_1652 = (*((__yo_t6*)NULL));
    }
    _file____User_temp_1654 = _file____User_temp_1652;
  }
  return _file____User_temp_1654;
}
static inline __yo_t10* yo_id_2456_rtparam0_enum_yo_id_3323___struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8__ret___struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_(__yo_t10* self) {
  __yo_t10* _file____User_temp_14235;
  if (self != NULL) {
    __yo_t10* value = self;
    _file____User_temp_14235 = value;
  } else {
    fprintf(stderr, "%s\n", "\"Called unwrap on a None value\"");
    abort();
    _file____User_temp_14235 = (*((__yo_t10**)NULL));
  }
  return _file____User_temp_14235;
}
static inline void yo_id_4578(__yo_t10 msg) {
  __yo_t22 _file____User_temp_4092 = yo_id_3439(msg);
  __yo_t22 rb = _file____User_temp_4092;
  size_t _file____User_temp_4094 = rb.len;
  size_t ___ = fwrite(((void*)(rb.ptr)), 1ULL, _file____User_temp_4094, stderr);
  fprintf(stderr, "%s\n", "\"\"");
  abort();
  (*((void*)NULL));
}
static inline int32_t yo_id_5908() {
  return __yo_argc;
}
static inline void yo_id_12_String_id_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam0_struct_yo_id_10___u8__rtparam1___struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8__ret_unit(__yo_t46 self, __yo_t10* slot) {
  switch ((*(slot)).tag) {
  case __YO_T11_SOME:
  if ((*(slot)).data.Some.value) { ((void(*)(void*))self)((*(slot)).data.Some.value); }
    break;
  }
  ((void)0);
}
static inline void yo_id_3163_rtparam0_R_gs_yo_id_3109_u8_ret_unit(__yo_t0* self) {
  uint8_t* _file____User_temp_14306 = self->_ptr;
  if (_file____User_temp_14306 != NULL) {
    uint8_t* _ptr = _file____User_temp_14306;
    yo_id_3141_rtparam0_R_gs_yo_id_3109_u8_ret_unit((__yo_t0*)(self));
    size_t _file____User_temp_14312 = self->_length; // Save old value for later use
    self->_length = 0ULL;
    _file____User_temp_14312;
    void* _file____User_temp_14313 = ((void*)(_ptr));
    __yo_borrow_assert_unborrowed((void*)self);
    __yo_free(_file____User_temp_14313);
    uint8_t* _file____User_temp_14315 = self->_ptr; // Save old value for later use
    self->_ptr = NULL;
    _file____User_temp_14315;
  } else {
  }
}
static inline void yo_id_3168_rtparam0_R_gs_yo_id_3109_usize_rtparam1_struct_yo_id_10___u8__ret_unit(__yo_t24* self, __yo_t46 tracer) {
  size_t* _file____User_temp_14132 = self->_ptr;
  if (_file____User_temp_14132 != NULL) {
    size_t* base = _file____User_temp_14132;
    size_t i = 0ULL;
    while (true) {
      if (!(((i) < (self->_length)))) {
        break;
      }
      { // begin block (loop body)
      yo_id_12_usize_id_usize_rtparam0_struct_yo_id_10___u8__rtparam1___usize__ret_unit(tracer, (base + i));
      size_t _file____User_temp_14142 = i; // Save old value for later use
      i = ((i) + (1ULL));
      _file____User_temp_14142;
      } // end begin block (loop body)
    }
    loop_yo_id_12223:;
  } else {
  }
}
static inline __yo_t10 yo_id_3337() {
  __yo_t10 _file____User_temp_1444 = ((__yo_t10)((__yo_t11){ .tag = __YO_T11_NONE }));
  return _file____User_temp_1444;
}
static inline bool yo_id_4220(__yo_t10 self, __yo_t10 haystack, size_t from_index) {
  bool _file____User_temp_3415 = yo_id_3743(haystack, self, from_index);
  return _file____User_temp_3415;
}
static inline bool yo_id_10015(__yo_t10 content, __yo_t10 name) {
  __yo_t10 _file____User_temp_12024 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)" :: build.dependency(", .len = 21 });
  __yo_t10 _file____User_temp_12025 = yo_id_3607(name, _file____User_temp_12024);
  __yo_t10 git_pat = _file____User_temp_12025;
  __yo_t10 _file____User_temp_12026 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)" :: build.path_dependency(", .len = 26 });
  __yo_t10 _file____User_temp_12027 = yo_id_3607(name, _file____User_temp_12026);
  __yo_t10 path_pat = _file____User_temp_12027;
  bool __yo_sc_yo_id_12224 = true;
  bool _file____User_temp_12030 = yo_id_4279_String_id_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam0_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam1_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam2_usize_ret_bool(content, git_pat, 0ULL);
  if (!(_file____User_temp_12030)) {
    bool _file____User_temp_12031 = yo_id_4279_String_id_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam0_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam1_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam2_usize_ret_bool(content, path_pat, 0ULL);
    __yo_sc_yo_id_12224 = _file____User_temp_12031;
  }
  bool __yo_scope_ret = __yo_sc_yo_id_12224;
switch ((_file____User_temp_12024).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_12024).data.Some.value));
    break;
  }
  default: break;
}
switch ((git_pat).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((git_pat).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_12026).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_12026).data.Some.value));
    break;
  }
  default: break;
}
switch ((path_pat).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((path_pat).data.Some.value));
    break;
  }
  default: break;
}
  return __yo_scope_ret;
}
static inline bool yo_id_5963(__yo_t10 name, __yo_t10 value, bool overwrite) {
  __yo_t0* _file____User_temp_6352 = yo_id_3393(name);
  uint8_t* _file____User_temp_6353 = yo_id_3122_rtparam0_R_gs_yo_id_3109_u8_ret_enum_yo_id_3118___u8_(_file____User_temp_6352);
  uint8_t* _file____User_temp_6354 = yo_id_2456_rtparam0_enum_yo_id_3118___u8__ret___u8_(_file____User_temp_6353);
  uint8_t* name_cstr = _file____User_temp_6354;
  __yo_t0* _file____User_temp_6359 = yo_id_3393(value);
  uint8_t* _file____User_temp_6360 = yo_id_3122_rtparam0_R_gs_yo_id_3109_u8_ret_enum_yo_id_3118___u8_(_file____User_temp_6359);
  uint8_t* _file____User_temp_6361 = yo_id_2456_rtparam0_enum_yo_id_3118___u8__ret___u8_(_file____User_temp_6360);
  uint8_t* value_cstr = _file____User_temp_6361;
  int _file____User_temp_6368;
  { // begin block
    int _file____User_temp_6367;
    if (overwrite) {
      _file____User_temp_6367 = ((int)(1));
    }
    else {
      _file____User_temp_6367 = ((int)(0));
    }
    int overwrite_int = _file____User_temp_6367;
    _file____User_temp_6368 = setenv(((char*)(name_cstr)), ((char*)(value_cstr)), overwrite_int);
  } // end begin block
  _file____User_temp_6368 = _file____User_temp_6368;
  int result = _file____User_temp_6368;
  bool _file____User_temp_6369 = ((result) == (((int)(0))));
  // Drop local variables before early return
  __yo_decr_rc((void*)(_file____User_temp_6352));
  __yo_decr_rc((void*)(_file____User_temp_6359));
  return _file____User_temp_6369;
}
static inline void yo_id_3163_rtparam0_R_gs_yo_id_3109_usize_ret_unit(__yo_t24* self) {
  size_t* _file____User_temp_14199 = self->_ptr;
  if (_file____User_temp_14199 != NULL) {
    size_t* _ptr = _file____User_temp_14199;
    yo_id_3141_rtparam0_R_gs_yo_id_3109_usize_ret_unit((__yo_t24*)(self));
    size_t _file____User_temp_14207 = self->_length; // Save old value for later use
    self->_length = 0ULL;
    _file____User_temp_14207;
    void* _file____User_temp_14208 = ((void*)(_ptr));
    __yo_borrow_assert_unborrowed((void*)self);
    __yo_free(_file____User_temp_14208);
    size_t* _file____User_temp_14210 = self->_ptr; // Save old value for later use
    self->_ptr = NULL;
    _file____User_temp_14210;
  } else {
  }
}
static inline __yo_t16* yo_id_4232(__yo_t10 self, __yo_t10 haystack) {
  __yo_t16* _file____User_temp_3418 = yo_id_3747(haystack, self);
  return _file____User_temp_3418;
}
static inline __yo_t19* yo_id_5032(__yo_t10 path_str) {
  __yo_t16* _file____User_temp_4654 = yo_id_3124__ret_R_gs_yo_id_3109_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8();
  __yo_t16* segments = _file____User_temp_4654;
  bool is_abs = false;
  bool _file____User_temp_4658 = yo_id_3427(path_str);
  if (_file____User_temp_4658) {
    ((__yo_t16*)__yo_incr_rc((void*)(segments)));
    __yo_t19* _file____User_temp_4659 = __yo_new___yo_t19(segments, is_abs);
    // Drop local variables before early return
    __yo_decr_rc((void*)(segments));
    return _file____User_temp_4659;
  }
  else {
  }
  __yo_t10 _file____User_temp_4663 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"\\", .len = 1 });
  __yo_t10 _file____User_temp_4664 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"/", .len = 1 });
  __yo_t10 _file____User_temp_4665 = yo_id_3963(path_str, _file____User_temp_4663, _file____User_temp_4664);
  __yo_t10 normalized = _file____User_temp_4665;
  __yo_t0* _file____User_temp_4666 = yo_id_3433(normalized);
  __yo_t0* bytes = _file____User_temp_4666;
  size_t _file____User_temp_4670 = yo_id_3119_rtparam0_R_gs_yo_id_3109_u8_ret_usize(bytes);
  if (((_file____User_temp_4670) > (0ULL))) {
    __yo_t20 _file____User_temp_4690 = yo_id_3138_rtparam0_R_gs_yo_id_3109_u8_rtparam1_usize_ret_enum_yo_id_3135_u8(bytes, 0ULL);
    __yo_t20 first_byte = _file____User_temp_4690;
    switch ((first_byte).tag) {
    case __YO_T20_SOME: {
      uint8_t b = first_byte.data.Some.value;
      if (((b) == (47))) {
        bool _file____User_temp_4693 = is_abs; // Save old value for later use
        is_abs = true;
      }
      else {
        size_t _file____User_temp_4696 = yo_id_3119_rtparam0_R_gs_yo_id_3109_u8_ret_usize(bytes);
        if (((_file____User_temp_4696) >= (2ULL))) {
          __yo_t20 _file____User_temp_4699 = yo_id_3138_rtparam0_R_gs_yo_id_3109_u8_rtparam1_usize_ret_enum_yo_id_3135_u8(bytes, 1ULL);
          __yo_t20 second_byte_opt = _file____User_temp_4699;
          switch ((second_byte_opt).tag) {
          case __YO_T20_SOME: {
            uint8_t second_byte = second_byte_opt.data.Some.value;
            if (((second_byte) == (58))) {
              bool __yo_sc_yo_id_12225 = false;
              if (((b) >= (65))) {
                __yo_sc_yo_id_12225 = ((b) <= (90));
              }
              bool __yo_sc_yo_id_12226 = false;
              if (((b) >= (97))) {
                __yo_sc_yo_id_12226 = ((b) <= (122));
              }
              bool is_letter = (__yo_sc_yo_id_12225 || __yo_sc_yo_id_12226);
              if (is_letter) {
                bool _file____User_temp_4706 = is_abs; // Save old value for later use
                is_abs = true;
              }
              else {
              }
            }
            else {
            }
            break;
          }
          case __YO_T20_NONE: {
            break;
          }
          }
        }
        else {
        }
      }
      break;
    }
    case __YO_T20_NONE: {
      break;
    }
    }
  }
  else {
  }
  __yo_t10 _file____User_temp_4727 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"/", .len = 1 });
  __yo_t10 sep = _file____User_temp_4727;
  __yo_t16* _file____User_temp_4730 = yo_id_4285_String_id_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam0_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam1_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_ret_R_gs_yo_id_3109_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8(normalized, sep);
  __yo_t16* parts = _file____User_temp_4730;
  size_t i = 0ULL;
  while (true) {
    size_t _file____User_temp_4734 = yo_id_3119_rtparam0_R_gs_yo_id_3109_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_ret_usize(parts);
    if (!(((i) < (_file____User_temp_4734)))) {
      break;
    }
    { // begin block (loop body)
    __yo_t9 _file____User_temp_4754 = yo_id_3138_rtparam0_R_gs_yo_id_3109_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam1_usize_ret_enum_yo_id_3135_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8(parts, i);
    __yo_t9 part_opt = _file____User_temp_4754;
    switch ((part_opt).tag) {
    case __YO_T9_SOME: {
      __yo_t10 part = part_opt.data.Some.value;
      bool _file____User_temp_4756 = yo_id_3427(part);
      if (_file____User_temp_4756) {
      }
      else {
        bool __yo_sc_yo_id_12229 = false;
        size_t _file____User_temp_4759 = yo_id_3414(part);
        if (((_file____User_temp_4759) == (1ULL))) {
          bool _file____User_temp_4768;
          { // begin block
            __yo_t0* _file____User_temp_4762 = yo_id_3433(part);
            __yo_t20 _file____User_temp_4763 = yo_id_3138_rtparam0_R_gs_yo_id_3109_u8_rtparam1_usize_ret_enum_yo_id_3135_u8(_file____User_temp_4762, 0ULL);
            __yo_t20 byte_opt = _file____User_temp_4763;
            bool _file____User_temp_4767;
            switch ((byte_opt).tag) {
            case __YO_T20_SOME: {
              uint8_t b = byte_opt.data.Some.value;
              _file____User_temp_4767 = ((b) == (46));
              break;
            }
            case __YO_T20_NONE: {
              _file____User_temp_4767 = false;
              break;
            }
            }
            _file____User_temp_4768 = _file____User_temp_4767;
            __yo_decr_rc((void*)(_file____User_temp_4762));
          } // end begin block
          __yo_sc_yo_id_12229 = _file____User_temp_4768;
        }
        bool is_dot = __yo_sc_yo_id_12229;
        bool __yo_sc_yo_id_12230 = false;
        size_t _file____User_temp_4770 = yo_id_3414(part);
        if (((_file____User_temp_4770) == (2ULL))) {
          bool _file____User_temp_4786;
          { // begin block
            __yo_t0* _file____User_temp_4773 = yo_id_3433(part);
            __yo_t20 _file____User_temp_4774 = yo_id_3138_rtparam0_R_gs_yo_id_3109_u8_rtparam1_usize_ret_enum_yo_id_3135_u8(_file____User_temp_4773, 0ULL);
            __yo_t20 b0_opt = _file____User_temp_4774;
            __yo_t0* _file____User_temp_4776 = yo_id_3433(part);
            __yo_t20 _file____User_temp_4777 = yo_id_3138_rtparam0_R_gs_yo_id_3109_u8_rtparam1_usize_ret_enum_yo_id_3135_u8(_file____User_temp_4776, 1ULL);
            __yo_t20 b1_opt = _file____User_temp_4777;
            bool _file____User_temp_4785;
            switch ((b0_opt).tag) {
            case __YO_T20_SOME: {
              uint8_t b0 = b0_opt.data.Some.value;
              bool _file____User_temp_4783;
              switch ((b1_opt).tag) {
              case __YO_T20_SOME: {
                uint8_t b1 = b1_opt.data.Some.value;
                bool __yo_sc_yo_id_12231 = false;
                if (((b0) == (46))) {
                  __yo_sc_yo_id_12231 = ((b1) == (46));
                }
                _file____User_temp_4783 = __yo_sc_yo_id_12231;
                break;
              }
              case __YO_T20_NONE: {
                _file____User_temp_4783 = false;
                break;
              }
              }
              _file____User_temp_4785 = _file____User_temp_4783;
              break;
            }
            case __YO_T20_NONE: {
              _file____User_temp_4785 = false;
              break;
            }
            }
            _file____User_temp_4786 = _file____User_temp_4785;
            __yo_decr_rc((void*)(_file____User_temp_4773));
            __yo_decr_rc((void*)(_file____User_temp_4776));
          } // end begin block
          __yo_sc_yo_id_12230 = _file____User_temp_4786;
        }
        bool is_dotdot = __yo_sc_yo_id_12230;
        if (is_dot) {
        }
        else {
          if (is_dotdot) {
            size_t _file____User_temp_4789 = yo_id_3119_rtparam0_R_gs_yo_id_3109_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_ret_usize(segments);
            if (((_file____User_temp_4789) > (0ULL))) {
              __yo_t9 _file____User_temp_4816 = yo_id_3136_rtparam0_R_gs_yo_id_3109_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_ret_enum_yo_id_3135_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8(segments);
switch ((_file____User_temp_4816).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_4816).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_4816).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
            }
            else {
            }
          }
          else {
            __yo_t6 _file____User_temp_4884 = yo_id_3133_rtparam0_R_gs_yo_id_3109_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam1_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_ret_enum_yo_id_3132_unit_enum_yo_id_3108_enum_yo_id_3055_usize_usize(segments, part);
          }
        }
      }
      break;
    }
    case __YO_T9_NONE: {
      break;
    }
    }
switch ((part_opt).tag) {
  case __YO_T9_SOME: {
switch (((part_opt).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((part_opt).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
    } // end begin block (loop body)
  continue_yo_id_12228:;
    i = ((i) + (1ULL));
  }
  loop_yo_id_12227:;
  ((__yo_t16*)__yo_incr_rc((void*)(segments)));
  __yo_t19* _file____User_temp_4895 = __yo_new___yo_t19(segments, is_abs);
  // Drop local variables before early return
  __yo_decr_rc((void*)(segments));
switch ((_file____User_temp_4663).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_4663).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_4664).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_4664).data.Some.value));
    break;
  }
  default: break;
}
switch ((normalized).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((normalized).data.Some.value));
    break;
  }
  default: break;
}
  __yo_decr_rc((void*)(bytes));
switch ((sep).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((sep).data.Some.value));
    break;
  }
  default: break;
}
  __yo_decr_rc((void*)(parts));
  return _file____User_temp_4895;
}
static inline size_t yo_id_3414(__yo_t10 self) {
__yo_t11 _file____User_temp_1657 = self;
__yo_t11 temp_dup_enum_yo_id_12232 = _file____User_temp_1657;
switch ((temp_dup_enum_yo_id_12232).tag) {
  case __YO_T11_SOME: {
    (temp_dup_enum_yo_id_12232).data.Some.value = ((__yo_t0*)__yo_incr_rc((void*)((temp_dup_enum_yo_id_12232).data.Some.value)));
    break;
  }
  default: break;
}
  temp_dup_enum_yo_id_12232;
  __yo_t11 inner = _file____User_temp_1657;
  switch ((inner).tag) {
  case __YO_T11_NONE: {
    size_t _file____User_temp_1658 = 0ULL;
    // Drop local variables before early return
switch ((inner).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((inner).data.Some.value));
    break;
  }
  default: break;
}
    return _file____User_temp_1658;
    break;
  }
  case __YO_T11_SOME: {
    __yo_t0* al = inner.data.Some.value;
    size_t count = 0ULL;
    size_t byte_index = 0ULL;
    size_t _file____User_temp_1660 = yo_id_3119_rtparam0_R_gs_yo_id_3109_u8_ret_usize(al);
    size_t total_bytes = _file____User_temp_1660;
    while (true) {
      if (!(((byte_index) < (total_bytes)))) {
        break;
      }
      { // begin block (loop body)
      __yo_t20 _file____User_temp_1679 = yo_id_3138_rtparam0_R_gs_yo_id_3109_u8_rtparam1_usize_ret_enum_yo_id_3135_u8(al, byte_index);
      __yo_t20 byte_opt = _file____User_temp_1679;
      switch ((byte_opt).tag) {
      case __YO_T20_SOME: {
        uint8_t byte = byte_opt.data.Some.value;
        bool __yo_sc_yo_id_12235 = true;
        if (!(((byte) < (128)))) {
          __yo_sc_yo_id_12235 = ((byte) >= (192));
        }
        if (__yo_sc_yo_id_12235) {
          size_t _file____User_temp_1684 = count; // Save old value for later use
          count = ((count) + (1ULL));
        }
        else {
        }
        break;
      }
      case __YO_T20_NONE: {
        break;
      }
      }
      } // end begin block (loop body)
    continue_yo_id_12234:;
      byte_index = ((byte_index) + (1ULL));
    }
    loop_yo_id_12233:;
    // Drop local variables before early return
switch ((inner).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((inner).data.Some.value));
    break;
  }
  default: break;
}
    return count;
    break;
  }
  }
switch ((inner).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((inner).data.Some.value));
    break;
  }
  default: break;
}
}
static inline __yo_t9 yo_id_3138_rtparam0_R_gs_yo_id_3109_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam1_usize_ret_enum_yo_id_3135_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8(__yo_t16* self, size_t index) {
  __yo_t9 _file____User_temp_4753;
  if (((index) >= (self->_length))) {
    _file____User_temp_4753 = (__yo_t9){ .tag = __YO_T9_NONE };
  }
  else {
    __yo_t9 _file____User_temp_4751;
    __yo_t10* _file____User_temp_4743 = self->_ptr;
    if (_file____User_temp_4743 != NULL) {
      __yo_t10* _ptr = _file____User_temp_4743;
__yo_t10 _file____User_temp_4747 = (*(_ptr + index));
__yo_t11 temp_dup_enum_yo_id_12236 = _file____User_temp_4747;
switch ((temp_dup_enum_yo_id_12236).tag) {
  case __YO_T11_SOME: {
    (temp_dup_enum_yo_id_12236).data.Some.value = ((__yo_t0*)__yo_incr_rc((void*)((temp_dup_enum_yo_id_12236).data.Some.value)));
    break;
  }
  default: break;
}
      temp_dup_enum_yo_id_12236;
      __yo_t9 _file____User_temp_4749 = (__yo_t9){ .tag = __YO_T9_SOME, .data = { .Some = { .value = _file____User_temp_4747 } } };
      _file____User_temp_4751 = _file____User_temp_4749;
    } else {
      _file____User_temp_4751 = (__yo_t9){ .tag = __YO_T9_NONE };
    }
    _file____User_temp_4753 = _file____User_temp_4751;
  }
  return _file____User_temp_4753;
}
static inline __yo_t27 yo_id_2991(uint32_t value) {
  __yo_t27 _file____User_temp_1257;
  bool __yo_sc_yo_id_12237 = true;
  if (!(((value) < (55296U)))) {
    __yo_sc_yo_id_12237 = ((value) > (57343U));
  }
  if ((((value) <= (1114111U)) && __yo_sc_yo_id_12237)) {
    __yo_t26 _file____User_temp_1253 = ((__yo_t26)(value));
    __yo_t27 _file____User_temp_1255 = (__yo_t27){ .tag = __YO_T27_SOME, .data = { .Some = { .value = _file____User_temp_1253 } } };
    _file____User_temp_1257 = _file____User_temp_1255;
  }
  else {
    _file____User_temp_1257 = (__yo_t27){ .tag = __YO_T27_NONE };
  }
  return _file____User_temp_1257;
}
static inline bool yo_id_4278_String_id_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam0_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam1_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam2_usize_ret_bool(__yo_t10 self, __yo_t10 suffix, size_t end_position) {
  bool _file____User_temp_11508 = yo_id_4217(suffix, self, end_position);
  return _file____User_temp_11508;
}
static inline size_t yo_id_3119_rtparam0_R_gs_yo_id_3109_usize_ret_usize(__yo_t24* self) {
  size_t _file____User_temp_2585 = self->_length;
  return _file____User_temp_2585;
}
static inline __yo_t27 yo_id_3454(__yo_t10 self, size_t byte_index) {
__yo_t11 _file____User_temp_1746 = self;
__yo_t11 temp_dup_enum_yo_id_12238 = _file____User_temp_1746;
switch ((temp_dup_enum_yo_id_12238).tag) {
  case __YO_T11_SOME: {
    (temp_dup_enum_yo_id_12238).data.Some.value = ((__yo_t0*)__yo_incr_rc((void*)((temp_dup_enum_yo_id_12238).data.Some.value)));
    break;
  }
  default: break;
}
  temp_dup_enum_yo_id_12238;
  __yo_t11 al = _file____User_temp_1746;
  __yo_t27 _file____User_temp_1912;
  switch ((al).tag) {
  case __YO_T11_NONE: {
    __yo_t27 _file____User_temp_1747 = (__yo_t27){ .tag = __YO_T27_NONE };
    // Drop local variables before early return
switch ((al).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((al).data.Some.value));
    break;
  }
  default: break;
}
    return _file____User_temp_1747;
    break;
  }
  case __YO_T11_SOME: {
    __yo_t0* bytes = al.data.Some.value;
    __yo_t20 _file____User_temp_1749 = yo_id_3138_rtparam0_R_gs_yo_id_3109_u8_rtparam1_usize_ret_enum_yo_id_3135_u8(bytes, byte_index);
    __yo_t20 first_byte_opt = _file____User_temp_1749;
    __yo_t27 _file____User_temp_1910;
    switch ((first_byte_opt).tag) {
    case __YO_T20_SOME: {
      uint8_t first_byte = first_byte_opt.data.Some.value;
      __yo_t27 _file____User_temp_1907;
      if (((first_byte) < (128))) {
        uint32_t codepoint = ((uint32_t)(first_byte));
        __yo_t27 _file____User_temp_1761 = yo_id_2991(codepoint);
        _file____User_temp_1907 = _file____User_temp_1761;
      }
      else {
        bool __yo_sc_yo_id_12239 = false;
        if (((first_byte) >= (192))) {
          __yo_sc_yo_id_12239 = ((first_byte) < (224));
        }
        if (__yo_sc_yo_id_12239) {
          __yo_t20 _file____User_temp_1764 = yo_id_3138_rtparam0_R_gs_yo_id_3109_u8_rtparam1_usize_ret_enum_yo_id_3135_u8(bytes, ((byte_index) + (1ULL)));
          __yo_t20 second_opt = _file____User_temp_1764;
          __yo_t27 _file____User_temp_1777;
          switch ((second_opt).tag) {
          case __YO_T20_SOME: {
            uint8_t second = second_opt.data.Some.value;
            uint32_t _file____User_temp_1773 = ((((((((uint32_t)(first_byte))) & (31U))) << (6U))) | (((((uint32_t)(second))) & (63U))));
            uint32_t codepoint = _file____User_temp_1773;
            __yo_t27 _file____User_temp_1774 = yo_id_2991(codepoint);
            _file____User_temp_1777 = _file____User_temp_1774;
            break;
          }
          case __YO_T20_NONE: {
            _file____User_temp_1777 = (__yo_t27){ .tag = __YO_T27_NONE };
            break;
          }
          }
          _file____User_temp_1907 = _file____User_temp_1777;
        }
        else {
          bool __yo_sc_yo_id_12240 = false;
          if (((first_byte) >= (224))) {
            __yo_sc_yo_id_12240 = ((first_byte) < (240));
          }
          if (__yo_sc_yo_id_12240) {
            __yo_t20 _file____User_temp_1780 = yo_id_3138_rtparam0_R_gs_yo_id_3109_u8_rtparam1_usize_ret_enum_yo_id_3135_u8(bytes, ((byte_index) + (1ULL)));
            __yo_t20 second_opt = _file____User_temp_1780;
            __yo_t20 _file____User_temp_1782 = yo_id_3138_rtparam0_R_gs_yo_id_3109_u8_rtparam1_usize_ret_enum_yo_id_3135_u8(bytes, ((byte_index) + (2ULL)));
            __yo_t20 third_opt = _file____User_temp_1782;
            __yo_t27 _file____User_temp_1818;
            switch ((second_opt).tag) {
            case __YO_T20_SOME: {
              uint8_t second = second_opt.data.Some.value;
              __yo_t27 _file____User_temp_1816;
              switch ((third_opt).tag) {
              case __YO_T20_SOME: {
                uint8_t third = third_opt.data.Some.value;
                uint32_t _file____User_temp_1811 = ((((((((((uint32_t)(first_byte))) & (15U))) << (12U))) | (((((((uint32_t)(second))) & (63U))) << (6U))))) | (((((uint32_t)(third))) & (63U))));
                uint32_t codepoint = _file____User_temp_1811;
                __yo_t27 _file____User_temp_1812 = yo_id_2991(codepoint);
                _file____User_temp_1816 = _file____User_temp_1812;
                break;
              }
              case __YO_T20_NONE: {
                _file____User_temp_1816 = (__yo_t27){ .tag = __YO_T27_NONE };
                break;
              }
              }
              _file____User_temp_1818 = _file____User_temp_1816;
              break;
            }
            case __YO_T20_NONE: {
              _file____User_temp_1818 = (__yo_t27){ .tag = __YO_T27_NONE };
              break;
            }
            }
            _file____User_temp_1907 = _file____User_temp_1818;
          }
          else {
            bool __yo_sc_yo_id_12241 = false;
            if (((first_byte) >= (240))) {
              __yo_sc_yo_id_12241 = ((first_byte) < (248));
            }
            if (__yo_sc_yo_id_12241) {
              __yo_t20 _file____User_temp_1821 = yo_id_3138_rtparam0_R_gs_yo_id_3109_u8_rtparam1_usize_ret_enum_yo_id_3135_u8(bytes, ((byte_index) + (1ULL)));
              __yo_t20 second_opt = _file____User_temp_1821;
              __yo_t20 _file____User_temp_1823 = yo_id_3138_rtparam0_R_gs_yo_id_3109_u8_rtparam1_usize_ret_enum_yo_id_3135_u8(bytes, ((byte_index) + (2ULL)));
              __yo_t20 third_opt = _file____User_temp_1823;
              __yo_t20 _file____User_temp_1825 = yo_id_3138_rtparam0_R_gs_yo_id_3109_u8_rtparam1_usize_ret_enum_yo_id_3135_u8(bytes, ((byte_index) + (3ULL)));
              __yo_t20 fourth_opt = _file____User_temp_1825;
              __yo_t27 _file____User_temp_1904;
              switch ((second_opt).tag) {
              case __YO_T20_SOME: {
                uint8_t second = second_opt.data.Some.value;
                __yo_t27 _file____User_temp_1902;
                switch ((third_opt).tag) {
                case __YO_T20_SOME: {
                  uint8_t third = third_opt.data.Some.value;
                  __yo_t27 _file____User_temp_1899;
                  switch ((fourth_opt).tag) {
                  case __YO_T20_SOME: {
                    uint8_t fourth = fourth_opt.data.Some.value;
                    uint32_t _file____User_temp_1894 = ((((((((((((uint32_t)(first_byte))) & (7U))) << (18U))) | (((((((uint32_t)(second))) & (63U))) << (12U))))) | (((((((uint32_t)(third))) & (63U))) << (6U))))) | (((((uint32_t)(fourth))) & (63U))));
                    uint32_t codepoint = _file____User_temp_1894;
                    __yo_t27 _file____User_temp_1895 = yo_id_2991(codepoint);
                    _file____User_temp_1899 = _file____User_temp_1895;
                    break;
                  }
                  case __YO_T20_NONE: {
                    _file____User_temp_1899 = (__yo_t27){ .tag = __YO_T27_NONE };
                    break;
                  }
                  }
                  _file____User_temp_1902 = _file____User_temp_1899;
                  break;
                }
                case __YO_T20_NONE: {
                  _file____User_temp_1902 = (__yo_t27){ .tag = __YO_T27_NONE };
                  break;
                }
                }
                _file____User_temp_1904 = _file____User_temp_1902;
                break;
              }
              case __YO_T20_NONE: {
                _file____User_temp_1904 = (__yo_t27){ .tag = __YO_T27_NONE };
                break;
              }
              }
              _file____User_temp_1907 = _file____User_temp_1904;
            }
            else {
              _file____User_temp_1907 = (__yo_t27){ .tag = __YO_T27_NONE };
            }
          }
        }
      }
      __yo_t27 res = _file____User_temp_1907;
      // Drop local variables before early return
switch ((al).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((al).data.Some.value));
    break;
  }
  default: break;
}
      return res;
      break;
    }
    case __YO_T20_NONE: {
      _file____User_temp_1910 = (__yo_t27){ .tag = __YO_T27_NONE };
      break;
    }
    }
    _file____User_temp_1912 = _file____User_temp_1910;
    break;
  }
  }
  __yo_t27 __yo_scope_ret = _file____User_temp_1912;
switch ((al).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((al).data.Some.value));
    break;
  }
  default: break;
}
  return __yo_scope_ret;
}
static inline __yo_t16* yo_id_4285_String_id_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam0_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam1_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_ret_R_gs_yo_id_3109_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8(__yo_t10 self, __yo_t10 separator) {
  __yo_t16* _file____User_temp_4729 = yo_id_4232(separator, self);
  return _file____User_temp_4729;
}
static inline uint8_t* yo_id_3122_rtparam0_R_gs_yo_id_3109_u8_ret_enum_yo_id_3118___u8_(__yo_t0* self) {
  return self->_ptr;
}
static inline size_t yo_id_3669(__yo_t10 self) {
  size_t _file____User_temp_2090;
  __yo_t11 _file____User_temp_2086 = self;
__yo_t11 temp_dup_enum_yo_id_12242 = _file____User_temp_2086;
switch ((temp_dup_enum_yo_id_12242).tag) {
  case __YO_T11_SOME: {
    (temp_dup_enum_yo_id_12242).data.Some.value = ((__yo_t0*)__yo_incr_rc((void*)((temp_dup_enum_yo_id_12242).data.Some.value)));
    break;
  }
  default: break;
}
  temp_dup_enum_yo_id_12242;
  switch ((_file____User_temp_2086).tag) {
  case __YO_T11_SOME: {
    __yo_t0* b = _file____User_temp_2086.data.Some.value;
    size_t _file____User_temp_2088 = yo_id_3119_rtparam0_R_gs_yo_id_3109_u8_ret_usize(b);
    _file____User_temp_2090 = _file____User_temp_2088;
    break;
  }
  case __YO_T11_NONE: {
    _file____User_temp_2090 = 0ULL;
    break;
  }
  }
  return _file____User_temp_2090;
}
static inline __yo_t23 yo_id_4228(__yo_t10 self, __yo_t10 haystack, size_t from_index) {
  __yo_t23 _file____User_temp_3417 = yo_id_3814(haystack, self, from_index);
  return _file____User_temp_3417;
}
static inline __yo_t6 yo_id_3133_rtparam0_R_gs_yo_id_3109_usize_rtparam1_usize_ret_enum_yo_id_3132_unit_enum_yo_id_3108_enum_yo_id_3055_usize_usize(__yo_t24* self, size_t value) {
  __yo_t6 _file____User_temp_2565;
  if (((self->_length) >= (self->_capacity))) {
    size_t _file____User_temp_2517;
    if (((self->_capacity) == (0ULL))) {
      _file____User_temp_2517 = 4ULL;
    }
    else {
      _file____User_temp_2517 = ((self->_capacity) * (2ULL));
    }
    size_t new_capacity = _file____User_temp_2517;
    void* _file____User_temp_2525;
    size_t* _file____User_temp_2519 = self->_ptr;
    if (_file____User_temp_2519 != NULL) {
      size_t* old_ptr = _file____User_temp_2519;
      void* _file____User_temp_2522 = ((void*)(old_ptr));
      __yo_borrow_assert_unborrowed((void*)self);
      _file____User_temp_2525 = __yo_realloc(_file____User_temp_2522, ((8ULL) * (new_capacity)));
    } else {
      _file____User_temp_2525 = __yo_malloc(((8ULL) * (new_capacity)));
    }
    void* new_some_ptr = _file____User_temp_2525;
    __yo_t6 _file____User_temp_2546;
    if (new_some_ptr != NULL) {
      void* new_ptr = new_some_ptr;
      size_t* typed_ptr = ((size_t*)(new_ptr));
      size_t* _file____User_temp_2528 = self->_ptr; // Save old value for later use
      size_t* _file____User_temp_2527 = typed_ptr;
      self->_ptr = _file____User_temp_2527;
      _file____User_temp_2528;
      size_t _file____User_temp_2530 = self->_capacity; // Save old value for later use
      self->_capacity = new_capacity;
      _file____User_temp_2530;
      size_t* _file____User_temp_2533 = (typed_ptr + self->_length);
      size_t* target_ptr = _file____User_temp_2533;
      size_t _file____User_temp_2535 = (*target_ptr); // Save old value for later use
      (*target_ptr) = value;
      _file____User_temp_2535;
      size_t _file____User_temp_2540 = self->_length; // Save old value for later use
      self->_length = ((self->_length) + (1ULL));
      _file____User_temp_2540;
      __yo_t6 _file____User_temp_2541 = (__yo_t6){ .tag = __YO_T6_OK };
      _file____User_temp_2546 = _file____User_temp_2541;
    } else {
      _file____User_temp_2546 = (__yo_t6){ .tag = __YO_T6_ERR, .data = { .Err = { .error = (__yo_t7){ .tag = __YO_T7_ALLOCERROR, .data = { .AllocError = { .error = __YO_T8_OUTOFMEMORY } } } } } };
    }
    _file____User_temp_2565 = _file____User_temp_2546;
  }
  else {
    __yo_t6 _file____User_temp_2563;
    size_t* _file____User_temp_2549 = self->_ptr;
    if (_file____User_temp_2549 != NULL) {
      size_t* _ptr = _file____User_temp_2549;
      size_t* _file____User_temp_2551 = (_ptr + self->_length);
      size_t* target_ptr = _file____User_temp_2551;
      size_t _file____User_temp_2553 = (*target_ptr); // Save old value for later use
      (*target_ptr) = value;
      _file____User_temp_2553;
      size_t _file____User_temp_2558 = self->_length; // Save old value for later use
      self->_length = ((self->_length) + (1ULL));
      _file____User_temp_2558;
      __yo_t6 _file____User_temp_2559 = (__yo_t6){ .tag = __YO_T6_OK };
      _file____User_temp_2563 = _file____User_temp_2559;
    } else {
      fprintf(stderr, "%s\n", "\"ArrayList has capacity but no ptr\"");
      abort();
      _file____User_temp_2563 = (*((__yo_t6*)NULL));
    }
    _file____User_temp_2565 = _file____User_temp_2563;
  }
  return _file____User_temp_2565;
}
static inline size_t yo_id_3119_rtparam0_R_gs_yo_id_3109_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_ret_usize(__yo_t16* self) {
  size_t _file____User_temp_4731 = self->_length;
  return _file____User_temp_4731;
}
static inline bool yo_id_4436(uint8_t byte) {
  bool __yo_sc_yo_id_12243 = false;
  if (((byte) >= (48))) {
    __yo_sc_yo_id_12243 = ((byte) <= (57));
  }
  return __yo_sc_yo_id_12243;
}
static inline __yo_t10 yo_id_10071(__yo_t16* dep_names) {
  size_t _file____User_temp_12143 = yo_id_3119_rtparam0_R_gs_yo_id_3109_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_ret_usize(dep_names);
  size_t n = _file____User_temp_12143;
  __yo_t10 _file____User_temp_12215;
  if (((n) == (0ULL))) {
    __yo_t10 _file____User_temp_12148 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"imports :: ComptimeList(build.ImportEntry)();\nexport(imports);\n", .len = 63 });
    _file____User_temp_12215 = _file____User_temp_12148;
  }
  else {
    __yo_t10 _file____User_temp_12149 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"imports :: ComptimeList(build.ImportEntry)(\n", .len = 44 });
    __yo_t10 block = _file____User_temp_12149;
    size_t i = 0ULL;
    while (true) {
      if (!(((i) < (n)))) {
        break;
      }
      { // begin block (loop body)
      __yo_t9 _file____User_temp_12153 = yo_id_3138_rtparam0_R_gs_yo_id_3109_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam1_usize_ret_enum_yo_id_3135_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8(dep_names, i);
      switch ((_file____User_temp_12153).tag) {
      case __YO_T9_NONE: {
        break;
      }
      case __YO_T9_SOME: {
        __yo_t10 dep_name = _file____User_temp_12153.data.Some.value;
        __yo_t10 _file____User_temp_12184 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"  { name: \"", .len = 11 });
        __yo_t10 _file____User_temp_12185 = yo_id_3607(_file____User_temp_12184, dep_name);
        __yo_t10 _file____User_temp_12186 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"\", module: ", .len = 11 });
        __yo_t10 _file____User_temp_12187 = yo_id_3607(_file____User_temp_12185, _file____User_temp_12186);
        __yo_t10 _file____User_temp_12188 = yo_id_3607(_file____User_temp_12187, dep_name);
        __yo_t10 _file____User_temp_12189 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)".module() }", .len = 11 });
        __yo_t10 _file____User_temp_12190 = yo_id_3607(_file____User_temp_12188, _file____User_temp_12189);
        __yo_t10 entry = _file____User_temp_12190;
        __yo_t10 _file____User_temp_12192 = block; // Save old value for later use
        __yo_t10 _file____User_temp_12191 = yo_id_3607(block, entry);
        block = _file____User_temp_12191;
        _file____User_temp_12192;
        if (((((i) + (1ULL))) < (n))) {
          __yo_t10 _file____User_temp_12200 = block; // Save old value for later use
          __yo_t10 _file____User_temp_12198 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)",\n", .len = 2 });
          __yo_t10 _file____User_temp_12199 = yo_id_3607(block, _file____User_temp_12198);
          block = _file____User_temp_12199;
switch ((_file____User_temp_12198).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_12198).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_12200).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_12200).data.Some.value));
    break;
  }
  default: break;
}
        }
        else {
          __yo_t10 _file____User_temp_12204 = block; // Save old value for later use
          __yo_t10 _file____User_temp_12202 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"\n", .len = 1 });
          __yo_t10 _file____User_temp_12203 = yo_id_3607(block, _file____User_temp_12202);
          block = _file____User_temp_12203;
switch ((_file____User_temp_12202).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_12202).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_12204).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_12204).data.Some.value));
    break;
  }
  default: break;
}
        }
switch ((_file____User_temp_12184).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_12184).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_12185).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_12185).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_12186).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_12186).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_12187).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_12187).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_12188).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_12188).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_12189).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_12189).data.Some.value));
    break;
  }
  default: break;
}
switch ((entry).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((entry).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_12192).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_12192).data.Some.value));
    break;
  }
  default: break;
}
        break;
      }
      }
      size_t _file____User_temp_12210 = i; // Save old value for later use
      i = ((i) + (1ULL));
      _file____User_temp_12210;
switch ((_file____User_temp_12153).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_12153).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_12153).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
      } // end begin block (loop body)
    }
    loop_yo_id_12244:;
    __yo_t10 _file____User_temp_12212 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)");\nexport(imports);\n", .len = 20 });
    __yo_t10 _file____User_temp_12213 = yo_id_3607(block, _file____User_temp_12212);
    _file____User_temp_12215 = _file____User_temp_12213;
switch ((block).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((block).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_12212).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_12212).data.Some.value));
    break;
  }
  default: break;
}
  }
  return _file____User_temp_12215;
}
static inline uint8_t** yo_id_5910() {
  return __yo_argv;
}
static inline bool yo_id_4277_String_id_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam0_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam1_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam2_usize_ret_bool(__yo_t10 self, __yo_t10 prefix, size_t position) {
  bool _file____User_temp_11498 = yo_id_4214(prefix, self, position);
  return _file____User_temp_11498;
}
static inline void yo_id_12_u8_id_u8_rtparam0_struct_yo_id_10___u8__rtparam1___u8__ret_unit(__yo_t46 self, uint8_t* slot) {
  ((void)0);
}
static inline __yo_t10 yo_id_4105(__yo_t10 self, __yo_t10 other) {
  __yo_t10 _file____User_temp_3250 = yo_id_3607(self, other);
  return _file____User_temp_3250;
}
static inline bool fn_yo_id_3049(__yo_t26 a, __yo_t26 b) {
  return ((a) > (b));
}
static inline void yo_id_4582(bool flag, __yo_t10 msg) {
  if (flag) {
  }
  else {
    __yo_effect_escaped = 0;
    yo_id_4578((__yo_t10)(msg));
    if (__yo_effect_escaped) {
      return;
    }
  }
}
static inline __yo_t15 yo_id_5905() {
  __yo_t15 _file____User_temp_6225 = (__yo_t15){ .ptr = __yo_argv, .len = ((size_t)(__yo_argc)) };
  return _file____User_temp_6225;
}
static inline void yo_id_12140(__yo_t28* self) {
  __yo_t10 __yo_disp_f0 = self->tag; // Destructuring tag
switch ((__yo_disp_f0).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((__yo_disp_f0).data.Some.value));
    break;
  }
  default: break;
}
}
static inline __yo_t28** yo_id_2456_rtparam0_enum_yo_id_9855___R_struct_yo_id_9715_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_i32_i32_i32__ret___R_struct_yo_id_9715_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_i32_i32_i32_(__yo_t28** self) {
  __yo_t28** _file____User_temp_14278;
  if (self != NULL) {
    __yo_t28** value = self;
    _file____User_temp_14278 = value;
  } else {
    fprintf(stderr, "%s\n", "\"Called unwrap on a None value\"");
    abort();
    _file____User_temp_14278 = (*((__yo_t28***)NULL));
  }
  return _file____User_temp_14278;
}
static inline __yo_t29 yo_id_3138_rtparam0_R_gs_yo_id_3109_R_struct_yo_id_9715_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_i32_i32_i32_rtparam1_usize_ret_enum_yo_id_3135_R_struct_yo_id_9715_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_i32_i32_i32(__yo_t31* self, size_t index) {
  __yo_t29 _file____User_temp_11889;
  if (((index) >= (self->_length))) {
    _file____User_temp_11889 = (__yo_t29){ .tag = __YO_T29_NONE };
  }
  else {
    __yo_t29 _file____User_temp_11887;
    __yo_t28** _file____User_temp_11880 = self->_ptr;
    if (_file____User_temp_11880 != NULL) {
      __yo_t28** _ptr = _file____User_temp_11880;
__yo_t28* _file____User_temp_11883 = (*(_ptr + index));
      ((__yo_t28*)__yo_incr_rc((void*)(_file____User_temp_11883)));
      __yo_t29 _file____User_temp_11885 = (__yo_t29){ .tag = __YO_T29_SOME, .data = { .Some = { .value = _file____User_temp_11883 } } };
      _file____User_temp_11887 = _file____User_temp_11885;
    } else {
      _file____User_temp_11887 = (__yo_t29){ .tag = __YO_T29_NONE };
    }
    _file____User_temp_11889 = _file____User_temp_11887;
  }
  return _file____User_temp_11889;
}
static inline void yo_id_3141_rtparam0_R_gs_yo_id_3109_u8_ret_unit(__yo_t0* self) {
}
static inline void yo_id_5001_str_id_str_rtparam0_str_ret_unit(__yo_str msg) {
  __yo_t10 _file____User_temp_13439 = yo_id_4873((&(msg)));
  uint8_t* _file____User_temp_13440 = yo_id_3444(_file____User_temp_13439);
  fprintf(stderr, "%s\n", (const char*)_file____User_temp_13440);
  abort();
  (*((void*)NULL));
switch ((_file____User_temp_13439).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13439).data.Some.value));
    break;
  }
  default: break;
}
}
static inline bool yo_id_9717(__yo_t10 spec) {
  __yo_effect_escaped = 0;
  bool _file____User_temp_11494 = yo_id_4133((__yo_t10)(spec), (__yo_str)((__yo_str){ .ptr = (const uint8_t*)".", .len = 1 }));
  if (__yo_effect_escaped) {
    return (bool){0};
  }
  __yo_effect_escaped = 0;
  bool _file____User_temp_11495 = yo_id_4133((__yo_t10)(spec), (__yo_str)((__yo_str){ .ptr = (const uint8_t*)"..", .len = 2 }));
  if (__yo_effect_escaped) {
    return (bool){0};
  }
  __yo_t10 _file____User_temp_11496 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"./", .len = 2 });
  bool _file____User_temp_11499 = yo_id_4277_String_id_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam0_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam1_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam2_usize_ret_bool(spec, _file____User_temp_11496, 0ULL);
  bool __yo_sc_yo_id_12245 = true;
  __yo_t10 _file____User_temp_11500 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"../", .len = 3 });
  bool _file____User_temp_11501 = yo_id_4277_String_id_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam0_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam1_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam2_usize_ret_bool(spec, _file____User_temp_11500, 0ULL);
  if (!(_file____User_temp_11501)) {
    __yo_t10 _file____User_temp_11502 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"/", .len = 1 });
    bool _file____User_temp_11503 = yo_id_4277_String_id_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam0_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam1_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam2_usize_ret_bool(spec, _file____User_temp_11502, 0ULL);
    __yo_sc_yo_id_12245 = _file____User_temp_11503;
  }
  return (_file____User_temp_11494 || (_file____User_temp_11495 || (_file____User_temp_11499 || __yo_sc_yo_id_12245)));
}
static inline __yo_t30 yo_id_4441(__yo_t10 self) {
  __yo_t30 _file____User_temp_3812;
  __yo_t11 _file____User_temp_3744 = self;
__yo_t11 temp_dup_enum_yo_id_12246 = _file____User_temp_3744;
switch ((temp_dup_enum_yo_id_12246).tag) {
  case __YO_T11_SOME: {
    (temp_dup_enum_yo_id_12246).data.Some.value = ((__yo_t0*)__yo_incr_rc((void*)((temp_dup_enum_yo_id_12246).data.Some.value)));
    break;
  }
  default: break;
}
  temp_dup_enum_yo_id_12246;
  switch ((_file____User_temp_3744).tag) {
  case __YO_T11_NONE: {
    _file____User_temp_3812 = (__yo_t30){ .tag = __YO_T30_NONE };
    break;
  }
  case __YO_T11_SOME: {
    __yo_t0* al = _file____User_temp_3744.data.Some.value;
    size_t _file____User_temp_3746 = yo_id_3119_rtparam0_R_gs_yo_id_3109_u8_ret_usize(al);
    size_t total_bytes = _file____User_temp_3746;
    __yo_t30 _file____User_temp_3810;
    if (((total_bytes) == (0ULL))) {
      _file____User_temp_3810 = (__yo_t30){ .tag = __YO_T30_NONE };
    }
    else {
      size_t idx = 0ULL;
      bool is_negative = false;
      __yo_t20 _file____User_temp_3750 = yo_id_3138_rtparam0_R_gs_yo_id_3109_u8_rtparam1_usize_ret_enum_yo_id_3135_u8(al, 0ULL);
      __yo_t20 first_byte_opt = _file____User_temp_3750;
      switch ((first_byte_opt).tag) {
      case __YO_T20_SOME: {
        uint8_t first_byte = first_byte_opt.data.Some.value;
        if (((first_byte) == (45))) {
          bool _file____User_temp_3755 = is_negative; // Save old value for later use
          is_negative = true;
          size_t _file____User_temp_3756 = idx; // Save old value for later use
          idx = 1ULL;
        }
        else {
          if (((first_byte) == (43))) {
            size_t _file____User_temp_3758 = idx; // Save old value for later use
            idx = 1ULL;
          }
          else {
          }
        }
        break;
      }
      case __YO_T20_NONE: {
        __yo_t30 _file____User_temp_3763 = (__yo_t30){ .tag = __YO_T30_NONE };
        return _file____User_temp_3763;
        break;
      }
      }
      __yo_t30 _file____User_temp_3808;
      if (((idx) >= (total_bytes))) {
        _file____User_temp_3808 = (__yo_t30){ .tag = __YO_T30_NONE };
      }
      else {
        int64_t result = 0LL;
        bool has_digit = false;
        while (true) {
          if (!(((idx) < (total_bytes)))) {
            break;
          }
          { // begin block (loop body)
          __yo_t20 _file____User_temp_3771 = yo_id_3138_rtparam0_R_gs_yo_id_3109_u8_rtparam1_usize_ret_enum_yo_id_3135_u8(al, idx);
          __yo_t20 byte_opt = _file____User_temp_3771;
          switch ((byte_opt).tag) {
          case __YO_T20_SOME: {
            uint8_t byte = byte_opt.data.Some.value;
            bool _file____User_temp_3773 = yo_id_4436(byte);
            if (_file____User_temp_3773) {
              int64_t digit = ((int64_t)(((byte) - (48))));
              int64_t _file____User_temp_3778 = result; // Save old value for later use
              result = ((((result) * (10LL))) + (digit));
              bool _file____User_temp_3779 = has_digit; // Save old value for later use
              has_digit = true;
            }
            else {
              __yo_t30 _file____User_temp_3781 = (__yo_t30){ .tag = __YO_T30_NONE };
              return _file____User_temp_3781;
            }
            break;
          }
          case __YO_T20_NONE: {
            __yo_t30 _file____User_temp_3785 = (__yo_t30){ .tag = __YO_T30_NONE };
            return _file____User_temp_3785;
            break;
          }
          }
          } // end begin block (loop body)
        continue_yo_id_12248:;
          idx = ((idx) + (1ULL));
        }
        loop_yo_id_12247:;
        __yo_t30 _file____User_temp_3806;
        __yo_effect_escaped = 0;
        bool _file____User_temp_3792 = yo_id_122_bool_id_bool_rtparam0_bool_ret_bool((bool)(has_digit));
        if (__yo_effect_escaped) {
          return (__yo_t30){0};
        }
        if (_file____User_temp_3792) {
          _file____User_temp_3806 = (__yo_t30){ .tag = __YO_T30_NONE };
        }
        else {
          int64_t _file____User_temp_3797;
          if (is_negative) {
            _file____User_temp_3797 = ((0LL) - (result));
          }
          else {
            _file____User_temp_3797 = result;
          }
          int64_t final_val = _file____User_temp_3797;
          __yo_t30 _file____User_temp_3804;
          bool __yo_sc_yo_id_12249 = true;
          if (!(((final_val) < (-2147483648LL)))) {
            __yo_sc_yo_id_12249 = ((final_val) > (2147483647LL));
          }
          if (__yo_sc_yo_id_12249) {
            _file____User_temp_3804 = (__yo_t30){ .tag = __YO_T30_NONE };
          }
          else {
            __yo_t30 _file____User_temp_3803 = (__yo_t30){ .tag = __YO_T30_SOME, .data = { .Some = { .value = ((int32_t)(final_val)) } } };
            _file____User_temp_3804 = _file____User_temp_3803;
          }
          _file____User_temp_3806 = _file____User_temp_3804;
        }
        _file____User_temp_3808 = _file____User_temp_3806;
      }
      _file____User_temp_3810 = _file____User_temp_3808;
    }
    _file____User_temp_3812 = _file____User_temp_3810;
    break;
  }
  }
  return _file____User_temp_3812;
}
static inline __yo_t16* yo_id_3747(__yo_t10 self, __yo_t10 separator) {
  __yo_t16* _file____User_temp_2301 = yo_id_3124__ret_R_gs_yo_id_3109_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8();
  __yo_t16* result = _file____User_temp_2301;
  bool _file____User_temp_2305 = yo_id_3427(separator);
  if (_file____User_temp_2305) {
    size_t _file____User_temp_2308 = yo_id_3414(self);
    size_t char_count = _file____User_temp_2308;
    size_t i = 0ULL;
    while (true) {
      if (!(((i) < (char_count)))) {
        break;
      }
      { // begin block (loop body)
      __yo_t10 _file____User_temp_2312 = yo_id_3684(self, i, ((i) + (1ULL)));
      __yo_t10 char_str = _file____User_temp_2312;
      __yo_t6 _file____User_temp_2377 = yo_id_3133_rtparam0_R_gs_yo_id_3109_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam1_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_ret_enum_yo_id_3132_unit_enum_yo_id_3108_enum_yo_id_3055_usize_usize(result, char_str);
      _file____User_temp_2377;
switch ((char_str).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((char_str).data.Some.value));
    break;
  }
  default: break;
}
      } // end begin block (loop body)
    continue_yo_id_12251:;
      i = ((i) + (1ULL));
    }
    loop_yo_id_12250:;
    ((__yo_t16*)__yo_incr_rc((void*)(result)));
    // Drop local variables before early return
    __yo_decr_rc((void*)(result));
    return result;
  }
  else {
    bool _file____User_temp_2307 = yo_id_3427(self);
    if (_file____User_temp_2307) {
      __yo_effect_escaped = 0;
      __yo_t10 _file____User_temp_2382 = yo_id_3337();
      if (__yo_effect_escaped) {
        // Drop local variables before early return
switch ((_file____User_temp_2382).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_2382).data.Some.value));
    break;
  }
  default: break;
}
        __yo_decr_rc((void*)(result));
        return (__yo_t16*){0};
      }
      __yo_t6 _file____User_temp_2383 = yo_id_3133_rtparam0_R_gs_yo_id_3109_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam1_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_ret_enum_yo_id_3132_unit_enum_yo_id_3108_enum_yo_id_3055_usize_usize(result, _file____User_temp_2382);
      ((__yo_t16*)__yo_incr_rc((void*)(result)));
      // Drop local variables before early return
switch ((_file____User_temp_2382).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_2382).data.Some.value));
    break;
  }
  default: break;
}
      __yo_decr_rc((void*)(result));
      return result;
switch ((_file____User_temp_2382).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_2382).data.Some.value));
    break;
  }
  default: break;
}
    }
    else {
      __yo_t16* _file____User_temp_2472;
      __yo_t11 _file____User_temp_2386 = self;
__yo_t11 temp_dup_enum_yo_id_12252 = _file____User_temp_2386;
switch ((temp_dup_enum_yo_id_12252).tag) {
  case __YO_T11_SOME: {
    (temp_dup_enum_yo_id_12252).data.Some.value = ((__yo_t0*)__yo_incr_rc((void*)((temp_dup_enum_yo_id_12252).data.Some.value)));
    break;
  }
  default: break;
}
      temp_dup_enum_yo_id_12252;
      switch ((_file____User_temp_2386).tag) {
      case __YO_T11_NONE: {
        __yo_effect_escaped = 0;
        __yo_t10 _file____User_temp_2387 = yo_id_3337();
        if (__yo_effect_escaped) {
          // Drop local variables before early return
switch ((_file____User_temp_2387).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_2387).data.Some.value));
    break;
  }
  default: break;
}
          __yo_decr_rc((void*)(result));
          return (__yo_t16*){0};
        }
        __yo_t6 _file____User_temp_2388 = yo_id_3133_rtparam0_R_gs_yo_id_3109_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam1_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_ret_enum_yo_id_3132_unit_enum_yo_id_3108_enum_yo_id_3055_usize_usize(result, _file____User_temp_2387);
        _file____User_temp_2388;
        ((__yo_t16*)__yo_incr_rc((void*)(result)));
        // Drop local variables before early return
switch ((_file____User_temp_2387).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_2387).data.Some.value));
    break;
  }
  default: break;
}
        __yo_decr_rc((void*)(result));
        return result;
switch ((_file____User_temp_2387).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_2387).data.Some.value));
    break;
  }
  default: break;
}
        break;
      }
      case __YO_T11_SOME: {
        __yo_t0* self_al = _file____User_temp_2386.data.Some.value;
        __yo_t16* _file____User_temp_2471;
        __yo_t11 _file____User_temp_2391 = separator;
__yo_t11 temp_dup_enum_yo_id_12253 = _file____User_temp_2391;
switch ((temp_dup_enum_yo_id_12253).tag) {
  case __YO_T11_SOME: {
    (temp_dup_enum_yo_id_12253).data.Some.value = ((__yo_t0*)__yo_incr_rc((void*)((temp_dup_enum_yo_id_12253).data.Some.value)));
    break;
  }
  default: break;
}
        temp_dup_enum_yo_id_12253;
        switch ((_file____User_temp_2391).tag) {
        case __YO_T11_NONE: {
          __yo_t6 _file____User_temp_2392 = yo_id_3133_rtparam0_R_gs_yo_id_3109_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam1_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_ret_enum_yo_id_3132_unit_enum_yo_id_3108_enum_yo_id_3055_usize_usize(result, self);
          _file____User_temp_2392;
          ((__yo_t16*)__yo_incr_rc((void*)(result)));
          // Drop local variables before early return
          __yo_decr_rc((void*)(result));
          return result;
          break;
        }
        case __YO_T11_SOME: {
          __yo_t0* sep_al = _file____User_temp_2391.data.Some.value;
          size_t _file____User_temp_2394 = yo_id_3119_rtparam0_R_gs_yo_id_3109_u8_ret_usize(self_al);
          size_t self_bytes = _file____User_temp_2394;
          size_t _file____User_temp_2395 = yo_id_3119_rtparam0_R_gs_yo_id_3109_u8_ret_usize(sep_al);
          size_t sep_bytes = _file____User_temp_2395;
          __yo_t0* _file____User_temp_2396 = yo_id_3124__ret_R_gs_yo_id_3109_u8();
          __yo_t0* current_bytes = _file____User_temp_2396;
          size_t byte_index = 0ULL;
          while (true) {
            if (!(((byte_index) < (self_bytes)))) {
              break;
            }
            { // begin block (loop body)
            bool matches = true;
            if (((((byte_index) + (sep_bytes))) <= (self_bytes))) {
              size_t j = 0ULL;
              while (true) {
                if (!(((j) < (sep_bytes)))) {
                  break;
                }
                { // begin block (loop body)
                __yo_t20 _file____User_temp_2406 = yo_id_3138_rtparam0_R_gs_yo_id_3109_u8_rtparam1_usize_ret_enum_yo_id_3135_u8(self_al, ((byte_index) + (j)));
                __yo_t20 self_byte_opt = _file____User_temp_2406;
                __yo_t20 _file____User_temp_2407 = yo_id_3138_rtparam0_R_gs_yo_id_3109_u8_rtparam1_usize_ret_enum_yo_id_3135_u8(sep_al, j);
                __yo_t20 sep_byte_opt = _file____User_temp_2407;
                switch ((self_byte_opt).tag) {
                case __YO_T20_SOME: {
                  uint8_t self_byte = self_byte_opt.data.Some.value;
                  switch ((sep_byte_opt).tag) {
                  case __YO_T20_SOME: {
                    uint8_t sep_byte = sep_byte_opt.data.Some.value;
                    if (((self_byte) != (sep_byte))) {
                      bool _file____User_temp_2410 = matches; // Save old value for later use
                      matches = false;
                      goto loop_yo_id_12256;
                    }
                    else {
                    }
                    break;
                  }
                  case __YO_T20_NONE: {
                    bool _file____User_temp_2415 = matches; // Save old value for later use
                    matches = false;
                    _file____User_temp_2415;
                    goto loop_yo_id_12256;
                    break;
                  }
                  }
                  break;
                }
                case __YO_T20_NONE: {
                  bool _file____User_temp_2419 = matches; // Save old value for later use
                  matches = false;
                  _file____User_temp_2419;
                  goto loop_yo_id_12256;
                  break;
                }
                }
                } // end begin block (loop body)
              continue_yo_id_12257:;
                j = ((j) + (1ULL));
              }
              loop_yo_id_12256:;
            }
            else {
              bool _file____User_temp_2426 = matches; // Save old value for later use
              matches = false;
            }
            if (matches) {
              __yo_t6 _file____User_temp_2440;
              size_t _file____User_temp_2430 = yo_id_3119_rtparam0_R_gs_yo_id_3109_u8_ret_usize(current_bytes);
              if (((_file____User_temp_2430) == (0ULL))) {
                __yo_t10 _file____User_temp_2433 = ((__yo_t10)((__yo_t11){ .tag = __YO_T11_NONE }));
                __yo_t6 _file____User_temp_2435 = yo_id_3133_rtparam0_R_gs_yo_id_3109_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam1_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_ret_enum_yo_id_3132_unit_enum_yo_id_3108_enum_yo_id_3055_usize_usize(result, _file____User_temp_2433);
switch ((_file____User_temp_2433).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_2433).data.Some.value));
    break;
  }
  default: break;
}
                _file____User_temp_2440 = _file____User_temp_2435;
              }
              else {
                ((__yo_t0*)__yo_incr_rc((void*)(current_bytes)));
                __yo_t11 _file____User_temp_2436 = (__yo_t11){ .tag = __YO_T11_SOME, .data = { .Some = { .value = current_bytes } } };
                __yo_t10 _file____User_temp_2437 = ((__yo_t10)(_file____User_temp_2436));
                __yo_t6 _file____User_temp_2439 = yo_id_3133_rtparam0_R_gs_yo_id_3109_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam1_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_ret_enum_yo_id_3132_unit_enum_yo_id_3108_enum_yo_id_3055_usize_usize(result, _file____User_temp_2437);
switch ((_file____User_temp_2437).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_2437).data.Some.value));
    break;
  }
  default: break;
}
                _file____User_temp_2440 = _file____User_temp_2439;
              }
              __yo_t0* _file____User_temp_2442 = current_bytes; // Save old value for later use
              __yo_t0* _file____User_temp_2441 = yo_id_3124__ret_R_gs_yo_id_3109_u8();
              current_bytes = _file____User_temp_2441;
              size_t _file____User_temp_2446 = byte_index; // Save old value for later use
              byte_index = ((((byte_index) + (sep_bytes))) - (1ULL));
              __yo_decr_rc((void*)(_file____User_temp_2442));
            }
            else {
              __yo_t20 _file____User_temp_2448 = yo_id_3138_rtparam0_R_gs_yo_id_3109_u8_rtparam1_usize_ret_enum_yo_id_3135_u8(self_al, byte_index);
              __yo_t20 byte_opt = _file____User_temp_2448;
              switch ((byte_opt).tag) {
              case __YO_T20_SOME: {
                uint8_t byte = byte_opt.data.Some.value;
                __yo_t6 _file____User_temp_2449 = yo_id_3133_rtparam0_R_gs_yo_id_3109_u8_rtparam1_u8_ret_enum_yo_id_3132_unit_enum_yo_id_3108_enum_yo_id_3055_usize_usize(current_bytes, byte);
                _file____User_temp_2449;
                break;
              }
              case __YO_T20_NONE: {
                break;
              }
              }
            }
            } // end begin block (loop body)
          continue_yo_id_12255:;
            byte_index = ((byte_index) + (1ULL));
          }
          loop_yo_id_12254:;
          __yo_t6 _file____User_temp_2469;
          size_t _file____User_temp_2459 = yo_id_3119_rtparam0_R_gs_yo_id_3109_u8_ret_usize(current_bytes);
          if (((_file____User_temp_2459) == (0ULL))) {
            __yo_t10 _file____User_temp_2462 = ((__yo_t10)((__yo_t11){ .tag = __YO_T11_NONE }));
            __yo_t6 _file____User_temp_2464 = yo_id_3133_rtparam0_R_gs_yo_id_3109_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam1_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_ret_enum_yo_id_3132_unit_enum_yo_id_3108_enum_yo_id_3055_usize_usize(result, _file____User_temp_2462);
switch ((_file____User_temp_2462).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_2462).data.Some.value));
    break;
  }
  default: break;
}
            _file____User_temp_2469 = _file____User_temp_2464;
          }
          else {
            ((__yo_t0*)__yo_incr_rc((void*)(current_bytes)));
            __yo_t11 _file____User_temp_2465 = (__yo_t11){ .tag = __YO_T11_SOME, .data = { .Some = { .value = current_bytes } } };
            __yo_t10 _file____User_temp_2466 = ((__yo_t10)(_file____User_temp_2465));
            __yo_t6 _file____User_temp_2468 = yo_id_3133_rtparam0_R_gs_yo_id_3109_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam1_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_ret_enum_yo_id_3132_unit_enum_yo_id_3108_enum_yo_id_3055_usize_usize(result, _file____User_temp_2466);
switch ((_file____User_temp_2466).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_2466).data.Some.value));
    break;
  }
  default: break;
}
            _file____User_temp_2469 = _file____User_temp_2468;
          }
          _file____User_temp_2469;
          ((__yo_t16*)__yo_incr_rc((void*)(result)));
          // Drop local variables before early return
          __yo_decr_rc((void*)(current_bytes));
          __yo_decr_rc((void*)(result));
          return result;
          __yo_decr_rc((void*)(current_bytes));
          break;
        }
        }
switch ((_file____User_temp_2391).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_2391).data.Some.value));
    break;
  }
  default: break;
}
        _file____User_temp_2472 = _file____User_temp_2471;
        break;
      }
      }
switch ((_file____User_temp_2386).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_2386).data.Some.value));
    break;
  }
  default: break;
}
    }
  }
  __yo_decr_rc((void*)(result));
}
static inline __yo_t16* yo_id_3130_rtparam0_usize_ret_R_gs_yo_id_3109_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8(size_t cap) {
  __yo_t16* _file____User_temp_6245;
  if (((cap) == (0ULL))) {
    __yo_t16* _file____User_temp_6236 = yo_id_3124__ret_R_gs_yo_id_3109_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8();
    _file____User_temp_6245 = _file____User_temp_6236;
  }
  else {
    void* ptr_result = __yo_malloc(((16ULL) * (cap)));
    __yo_t16* _file____User_temp_6242;
    if (ptr_result != NULL) {
      void* _ptr = ptr_result;
      __yo_t10* _file____User_temp_6238 = ((__yo_t10*)(_ptr));
      __yo_t16* _file____User_temp_6240 = __yo_new___yo_t16(_file____User_temp_6238, 0ULL, cap);
      _file____User_temp_6242 = _file____User_temp_6240;
    } else {
      fprintf(stderr, "%s\n", "\"malloc returned None\"");
      abort();
      _file____User_temp_6242 = (*((__yo_t16**)NULL));
    }
    _file____User_temp_6245 = _file____User_temp_6242;
  }
  return _file____User_temp_6245;
}
static inline void yo_id_5002_str_id_str_rtparam0_bool_rtparam1_comptime_str_ret_unit(bool flag, __yo_str msg) {
  if (flag) {
  }
  else {
    __yo_effect_escaped = 0;
    yo_id_5001_str_id_str_rtparam0_str_ret_unit((__yo_str)(msg));
    if (__yo_effect_escaped) {
      return;
    }
  }
}
static inline __yo_t10 yo_id_3963(__yo_t10 self, __yo_t10 search_value, __yo_t10 new_value) {
  __yo_t10 _file____User_temp_3036;
  bool _file____User_temp_2951 = yo_id_3427(search_value);
  if (_file____User_temp_2951) {
    __yo_t10 _file____User_temp_2952 = self;
__yo_t11 temp_dup_enum_yo_id_12258 = _file____User_temp_2952;
switch ((temp_dup_enum_yo_id_12258).tag) {
  case __YO_T11_SOME: {
    (temp_dup_enum_yo_id_12258).data.Some.value = ((__yo_t0*)__yo_incr_rc((void*)((temp_dup_enum_yo_id_12258).data.Some.value)));
    break;
  }
  default: break;
}
    temp_dup_enum_yo_id_12258;
    _file____User_temp_3036 = _file____User_temp_2952;
  }
  else {
    __yo_t10 _file____User_temp_3035;
    __yo_t11 _file____User_temp_2954 = self;
__yo_t11 temp_dup_enum_yo_id_12259 = _file____User_temp_2954;
switch ((temp_dup_enum_yo_id_12259).tag) {
  case __YO_T11_SOME: {
    (temp_dup_enum_yo_id_12259).data.Some.value = ((__yo_t0*)__yo_incr_rc((void*)((temp_dup_enum_yo_id_12259).data.Some.value)));
    break;
  }
  default: break;
}
    temp_dup_enum_yo_id_12259;
    switch ((_file____User_temp_2954).tag) {
    case __YO_T11_NONE: {
      __yo_t10 _file____User_temp_2955 = self;
__yo_t11 temp_dup_enum_yo_id_12260 = _file____User_temp_2955;
switch ((temp_dup_enum_yo_id_12260).tag) {
  case __YO_T11_SOME: {
    (temp_dup_enum_yo_id_12260).data.Some.value = ((__yo_t0*)__yo_incr_rc((void*)((temp_dup_enum_yo_id_12260).data.Some.value)));
    break;
  }
  default: break;
}
      temp_dup_enum_yo_id_12260;
      _file____User_temp_3035 = _file____User_temp_2955;
      break;
    }
    case __YO_T11_SOME: {
      __yo_t0* self_al = _file____User_temp_2954.data.Some.value;
      __yo_t10 _file____User_temp_3033;
      __yo_t11 _file____User_temp_2957 = search_value;
__yo_t11 temp_dup_enum_yo_id_12261 = _file____User_temp_2957;
switch ((temp_dup_enum_yo_id_12261).tag) {
  case __YO_T11_SOME: {
    (temp_dup_enum_yo_id_12261).data.Some.value = ((__yo_t0*)__yo_incr_rc((void*)((temp_dup_enum_yo_id_12261).data.Some.value)));
    break;
  }
  default: break;
}
      temp_dup_enum_yo_id_12261;
      switch ((_file____User_temp_2957).tag) {
      case __YO_T11_NONE: {
        __yo_t10 _file____User_temp_2958 = self;
__yo_t11 temp_dup_enum_yo_id_12262 = _file____User_temp_2958;
switch ((temp_dup_enum_yo_id_12262).tag) {
  case __YO_T11_SOME: {
    (temp_dup_enum_yo_id_12262).data.Some.value = ((__yo_t0*)__yo_incr_rc((void*)((temp_dup_enum_yo_id_12262).data.Some.value)));
    break;
  }
  default: break;
}
        temp_dup_enum_yo_id_12262;
        _file____User_temp_3033 = _file____User_temp_2958;
        break;
      }
      case __YO_T11_SOME: {
        __yo_t0* search_al = _file____User_temp_2957.data.Some.value;
        size_t _file____User_temp_2959 = yo_id_3119_rtparam0_R_gs_yo_id_3109_u8_ret_usize(self_al);
        size_t self_bytes = _file____User_temp_2959;
        size_t _file____User_temp_2960 = yo_id_3119_rtparam0_R_gs_yo_id_3109_u8_ret_usize(search_al);
        size_t search_bytes = _file____User_temp_2960;
        __yo_t0* _file____User_temp_2961 = yo_id_3124__ret_R_gs_yo_id_3109_u8();
        __yo_t0* new_bytes = _file____User_temp_2961;
        size_t byte_index = 0ULL;
        while (true) {
          if (!(((byte_index) < (self_bytes)))) {
            break;
          }
          { // begin block (loop body)
          bool matches = true;
          if (((((byte_index) + (search_bytes))) <= (self_bytes))) {
            size_t j = 0ULL;
            while (true) {
              if (!(((j) < (search_bytes)))) {
                break;
              }
              { // begin block (loop body)
              __yo_t20 _file____User_temp_2971 = yo_id_3138_rtparam0_R_gs_yo_id_3109_u8_rtparam1_usize_ret_enum_yo_id_3135_u8(self_al, ((byte_index) + (j)));
              __yo_t20 self_byte_opt = _file____User_temp_2971;
              __yo_t20 _file____User_temp_2972 = yo_id_3138_rtparam0_R_gs_yo_id_3109_u8_rtparam1_usize_ret_enum_yo_id_3135_u8(search_al, j);
              __yo_t20 search_byte_opt = _file____User_temp_2972;
              switch ((self_byte_opt).tag) {
              case __YO_T20_SOME: {
                uint8_t self_byte = self_byte_opt.data.Some.value;
                switch ((search_byte_opt).tag) {
                case __YO_T20_SOME: {
                  uint8_t search_byte = search_byte_opt.data.Some.value;
                  if (((self_byte) != (search_byte))) {
                    bool _file____User_temp_2975 = matches; // Save old value for later use
                    matches = false;
                    goto loop_yo_id_12265;
                  }
                  else {
                  }
                  break;
                }
                case __YO_T20_NONE: {
                  bool _file____User_temp_2980 = matches; // Save old value for later use
                  matches = false;
                  _file____User_temp_2980;
                  goto loop_yo_id_12265;
                  break;
                }
                }
                break;
              }
              case __YO_T20_NONE: {
                bool _file____User_temp_2984 = matches; // Save old value for later use
                matches = false;
                _file____User_temp_2984;
                goto loop_yo_id_12265;
                break;
              }
              }
              } // end begin block (loop body)
            continue_yo_id_12266:;
              j = ((j) + (1ULL));
            }
            loop_yo_id_12265:;
          }
          else {
            bool _file____User_temp_2991 = matches; // Save old value for later use
            matches = false;
          }
          if (matches) {
            __yo_t11 _file____User_temp_2995 = new_value;
__yo_t11 temp_dup_enum_yo_id_12267 = _file____User_temp_2995;
switch ((temp_dup_enum_yo_id_12267).tag) {
  case __YO_T11_SOME: {
    (temp_dup_enum_yo_id_12267).data.Some.value = ((__yo_t0*)__yo_incr_rc((void*)((temp_dup_enum_yo_id_12267).data.Some.value)));
    break;
  }
  default: break;
}
            temp_dup_enum_yo_id_12267;
            switch ((_file____User_temp_2995).tag) {
            case __YO_T11_SOME: {
              __yo_t0* nv_al = _file____User_temp_2995.data.Some.value;
              uint8_t* _file____User_temp_2997 = yo_id_3122_rtparam0_R_gs_yo_id_3109_u8_ret_enum_yo_id_3118___u8_(nv_al);
              if (_file____User_temp_2997 != NULL) {
                uint8_t* p = _file____User_temp_2997;
                size_t _file____User_temp_2998 = yo_id_3119_rtparam0_R_gs_yo_id_3109_u8_ret_usize(nv_al);
                yo_id_3149_rtparam0_R_gs_yo_id_3109_u8_rtparam1___u8__rtparam2_usize_ret_unit(new_bytes, p, _file____User_temp_2998);
              } else {
              }
              break;
            }
            case __YO_T11_NONE: {
              break;
            }
            }
            size_t _file____User_temp_3009 = byte_index; // Save old value for later use
            byte_index = ((((byte_index) + (search_bytes))) - (1ULL));
switch ((_file____User_temp_2995).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_2995).data.Some.value));
    break;
  }
  default: break;
}
          }
          else {
            __yo_t20 _file____User_temp_3011 = yo_id_3138_rtparam0_R_gs_yo_id_3109_u8_rtparam1_usize_ret_enum_yo_id_3135_u8(self_al, byte_index);
            __yo_t20 byte_opt = _file____User_temp_3011;
            switch ((byte_opt).tag) {
            case __YO_T20_SOME: {
              uint8_t byte = byte_opt.data.Some.value;
              __yo_t6 _file____User_temp_3012 = yo_id_3133_rtparam0_R_gs_yo_id_3109_u8_rtparam1_u8_ret_enum_yo_id_3132_unit_enum_yo_id_3108_enum_yo_id_3055_usize_usize(new_bytes, byte);
              _file____User_temp_3012;
              break;
            }
            case __YO_T20_NONE: {
              break;
            }
            }
          }
          } // end begin block (loop body)
        continue_yo_id_12264:;
          byte_index = ((byte_index) + (1ULL));
        }
        loop_yo_id_12263:;
        __yo_t10 _file____User_temp_3030;
        size_t _file____User_temp_3022 = yo_id_3119_rtparam0_R_gs_yo_id_3109_u8_ret_usize(new_bytes);
        if (((_file____User_temp_3022) == (0ULL))) {
          _file____User_temp_3030 = ((__yo_t10)((__yo_t11){ .tag = __YO_T11_NONE }));
        }
        else {
          ((__yo_t0*)__yo_incr_rc((void*)(new_bytes)));
          __yo_t11 _file____User_temp_3027 = (__yo_t11){ .tag = __YO_T11_SOME, .data = { .Some = { .value = new_bytes } } };
          __yo_t10 _file____User_temp_3029 = ((__yo_t10)(_file____User_temp_3027));
          _file____User_temp_3030 = _file____User_temp_3029;
        }
        __yo_decr_rc((void*)(new_bytes));
        _file____User_temp_3033 = _file____User_temp_3030;
        break;
      }
      }
switch ((_file____User_temp_2957).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_2957).data.Some.value));
    break;
  }
  default: break;
}
      _file____User_temp_3035 = _file____User_temp_3033;
      break;
    }
    }
switch ((_file____User_temp_2954).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_2954).data.Some.value));
    break;
  }
  default: break;
}
    _file____User_temp_3036 = _file____User_temp_3035;
  }
  return _file____User_temp_3036;
}
static inline __yo_t20 yo_id_3138_rtparam0_R_gs_yo_id_3109_u8_rtparam1_usize_ret_enum_yo_id_3135_u8(__yo_t0* self, size_t index) {
  __yo_t20 _file____User_temp_1678;
  if (((index) >= (self->_length))) {
    _file____User_temp_1678 = (__yo_t20){ .tag = __YO_T20_NONE };
  }
  else {
    __yo_t20 _file____User_temp_1676;
    uint8_t* _file____User_temp_1669 = self->_ptr;
    if (_file____User_temp_1669 != NULL) {
      uint8_t* _ptr = _file____User_temp_1669;
      __yo_t20 _file____User_temp_1674 = (__yo_t20){ .tag = __YO_T20_SOME, .data = { .Some = { .value = (*(_ptr + index)) } } };
      _file____User_temp_1676 = _file____User_temp_1674;
    } else {
      _file____User_temp_1676 = (__yo_t20){ .tag = __YO_T20_NONE };
    }
    _file____User_temp_1678 = _file____User_temp_1676;
  }
  return _file____User_temp_1678;
}
static inline void yo_id_3148_rtparam0_R_gs_yo_id_3109_u8_rtparam1_usize_ret_unit(__yo_t0* self, size_t min_cap) {
  if (((min_cap) <= (self->_capacity))) {
  }
  else {
    size_t _file____User_temp_1514;
    if (((self->_capacity) == (0ULL))) {
      _file____User_temp_1514 = min_cap;
    }
    else {
      size_t _file____User_temp_1507 = self->_capacity;
      size_t cap = _file____User_temp_1507;
      while (true) {
        if (!(((cap) < (min_cap)))) {
          break;
        }
        { // begin block (loop body)
        size_t _file____User_temp_1511 = cap; // Save old value for later use
        cap = ((cap) * (2ULL));
        _file____User_temp_1511;
        } // end begin block (loop body)
      }
      loop_yo_id_12268:;
      _file____User_temp_1514 = cap;
    }
    size_t new_capacity = _file____User_temp_1514;
    void* _file____User_temp_1522;
    uint8_t* _file____User_temp_1516 = self->_ptr;
    if (_file____User_temp_1516 != NULL) {
      uint8_t* old_ptr = _file____User_temp_1516;
      void* _file____User_temp_1519 = ((void*)(old_ptr));
      __yo_borrow_assert_unborrowed((void*)self);
      _file____User_temp_1522 = __yo_realloc(_file____User_temp_1519, ((1ULL) * (new_capacity)));
    } else {
      _file____User_temp_1522 = __yo_malloc(((1ULL) * (new_capacity)));
    }
    void* new_some_ptr = _file____User_temp_1522;
    if (new_some_ptr != NULL) {
      void* new_ptr = new_some_ptr;
      uint8_t* _file____User_temp_1525 = self->_ptr; // Save old value for later use
      uint8_t* _file____User_temp_1524 = ((uint8_t*)(new_ptr));
      self->_ptr = _file____User_temp_1524;
      _file____User_temp_1525;
      size_t _file____User_temp_1527 = self->_capacity; // Save old value for later use
      self->_capacity = new_capacity;
      _file____User_temp_1527;
    } else {
      fprintf(stderr, "%s\n", "\"ArrayList.ensure_total_capacity: allocation failed\"");
      abort();
      (*((void*)NULL));
    }
  }
}
static inline __yo_t23 yo_id_4281_String_id_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam0_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam1_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam2_usize_ret_enum_yo_id_3135_usize(__yo_t10 self, __yo_t10 substr, size_t from_index) {
  __yo_t23 _file____User_temp_12053 = yo_id_4224(substr, self, from_index);
  return _file____User_temp_12053;
}
static inline __yo_t0* yo_id_3130_rtparam0_usize_ret_R_gs_yo_id_3109_u8(size_t cap) {
  __yo_t0* _file____User_temp_1464;
  if (((cap) == (0ULL))) {
    __yo_t0* _file____User_temp_1455 = yo_id_3124__ret_R_gs_yo_id_3109_u8();
    _file____User_temp_1464 = _file____User_temp_1455;
  }
  else {
    void* ptr_result = __yo_malloc(((1ULL) * (cap)));
    __yo_t0* _file____User_temp_1461;
    if (ptr_result != NULL) {
      void* _ptr = ptr_result;
      uint8_t* _file____User_temp_1457 = ((uint8_t*)(_ptr));
      __yo_t0* _file____User_temp_1459 = __yo_new___yo_t0(_file____User_temp_1457, 0ULL, cap);
      _file____User_temp_1461 = _file____User_temp_1459;
    } else {
      fprintf(stderr, "%s\n", "\"malloc returned None\"");
      abort();
      _file____User_temp_1461 = (*((__yo_t0**)NULL));
    }
    _file____User_temp_1464 = _file____User_temp_1461;
  }
  return _file____User_temp_1464;
}
static inline bool yo_id_3427(__yo_t10 self) {
  bool _file____User_temp_1703;
  __yo_t11 _file____User_temp_1697 = self;
__yo_t11 temp_dup_enum_yo_id_12269 = _file____User_temp_1697;
switch ((temp_dup_enum_yo_id_12269).tag) {
  case __YO_T11_SOME: {
    (temp_dup_enum_yo_id_12269).data.Some.value = ((__yo_t0*)__yo_incr_rc((void*)((temp_dup_enum_yo_id_12269).data.Some.value)));
    break;
  }
  default: break;
}
  temp_dup_enum_yo_id_12269;
  switch ((_file____User_temp_1697).tag) {
  case __YO_T11_NONE: {
    _file____User_temp_1703 = true;
    break;
  }
  case __YO_T11_SOME: {
    __yo_t0* al = _file____User_temp_1697.data.Some.value;
    size_t _file____User_temp_1700 = yo_id_3119_rtparam0_R_gs_yo_id_3109_u8_ret_usize(al);
    _file____User_temp_1703 = ((_file____User_temp_1700) == (0ULL));
    break;
  }
  }
  return _file____User_temp_1703;
}
static inline size_t yo_id_3119_rtparam0_R_gs_yo_id_3109_R_struct_yo_id_9715_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_i32_i32_i32_ret_usize(__yo_t31* self) {
  size_t _file____User_temp_11864 = self->_length;
  return _file____User_temp_11864;
}
static inline void yo_id_3141_rtparam0_R_gs_yo_id_3109_usize_ret_unit(__yo_t24* self) {
}
static inline __yo_t10 yo_id_3684(__yo_t10 self, size_t start, size_t end) {
  __yo_t10 _file____User_temp_2200;
  __yo_t11 _file____User_temp_2110 = self;
__yo_t11 temp_dup_enum_yo_id_12270 = _file____User_temp_2110;
switch ((temp_dup_enum_yo_id_12270).tag) {
  case __YO_T11_SOME: {
    (temp_dup_enum_yo_id_12270).data.Some.value = ((__yo_t0*)__yo_incr_rc((void*)((temp_dup_enum_yo_id_12270).data.Some.value)));
    break;
  }
  default: break;
}
  temp_dup_enum_yo_id_12270;
  switch ((_file____User_temp_2110).tag) {
  case __YO_T11_NONE: {
    __yo_t10 _file____User_temp_2111 = ((__yo_t10)((__yo_t11){ .tag = __YO_T11_NONE }));
    return _file____User_temp_2111;
    break;
  }
  case __YO_T11_SOME: {
    __yo_t0* al = _file____User_temp_2110.data.Some.value;
    size_t _file____User_temp_2113 = yo_id_3119_rtparam0_R_gs_yo_id_3109_u8_ret_usize(al);
    size_t total_bytes = _file____User_temp_2113;
    if (((start) >= (end))) {
      __yo_t10 _file____User_temp_2117 = ((__yo_t10)((__yo_t11){ .tag = __YO_T11_NONE }));
      return _file____User_temp_2117;
    }
    else {
    }
    size_t char_index = 0ULL;
    size_t byte_index = 0ULL;
    size_t start_byte = total_bytes;
    size_t end_byte = total_bytes;
    while (true) {
      if (!(((byte_index) < (total_bytes)))) {
        break;
      }
      { // begin block (loop body)
      if (((char_index) == (start))) {
        size_t _file____User_temp_2126 = start_byte; // Save old value for later use
        start_byte = byte_index;
      }
      else {
      }
      if (((char_index) == (end))) {
        size_t _file____User_temp_2133 = end_byte; // Save old value for later use
        end_byte = byte_index;
        goto loop_yo_id_12271;
      }
      else {
      }
      uint8_t b = (*yo_id_3158_rtparam0_R_gs_yo_id_3109_u8_rtparam1_usize_ret___u8_(&al, byte_index));
      size_t _file____User_temp_2162;
      if (((b) < (128))) {
        _file____User_temp_2162 = 1ULL;
      }
      else {
        if (((b) < (224))) {
          _file____User_temp_2162 = 2ULL;
        }
        else {
          if (((b) < (240))) {
            _file____User_temp_2162 = 3ULL;
          }
          else {
            _file____User_temp_2162 = 4ULL;
          }
        }
      }
      size_t byte_len = _file____User_temp_2162;
      size_t _file____User_temp_2164 = byte_index; // Save old value for later use
      byte_index = ((byte_index) + (byte_len));
      _file____User_temp_2164;
      size_t _file____User_temp_2166 = char_index; // Save old value for later use
      char_index = ((char_index) + (1ULL));
      _file____User_temp_2166;
      } // end begin block (loop body)
    }
    loop_yo_id_12271:;
    if (((char_index) == (start))) {
      size_t _file____User_temp_2170 = start_byte; // Save old value for later use
      start_byte = byte_index;
    }
    else {
    }
    if (((char_index) == (end))) {
      size_t _file____User_temp_2177 = end_byte; // Save old value for later use
      end_byte = byte_index;
    }
    else {
    }
    if (((start_byte) >= (end_byte))) {
      __yo_t10 _file____User_temp_2184 = ((__yo_t10)((__yo_t11){ .tag = __YO_T11_NONE }));
      return _file____User_temp_2184;
    }
    else {
    }
    size_t count = ((end_byte) - (start_byte));
    __yo_t0* _file____User_temp_2189 = yo_id_3130_rtparam0_usize_ret_R_gs_yo_id_3109_u8((size_t)(count));
    __yo_t0* new_bytes = _file____User_temp_2189;
    uint8_t* _file____User_temp_2191 = yo_id_3122_rtparam0_R_gs_yo_id_3109_u8_ret_enum_yo_id_3118___u8_(al);
    if (_file____User_temp_2191 != NULL) {
      uint8_t* src_p = _file____User_temp_2191;
      yo_id_3149_rtparam0_R_gs_yo_id_3109_u8_rtparam1___u8__rtparam2_usize_ret_unit(new_bytes, (src_p + start_byte), count);
    } else {
    }
    ((__yo_t0*)__yo_incr_rc((void*)(new_bytes)));
    __yo_t11 _file____User_temp_2197 = (__yo_t11){ .tag = __YO_T11_SOME, .data = { .Some = { .value = new_bytes } } };
    __yo_t10 _file____User_temp_2198 = ((__yo_t10)(_file____User_temp_2197));
    __yo_decr_rc((void*)(new_bytes));
    _file____User_temp_2200 = _file____User_temp_2198;
    break;
  }
  }
  return _file____User_temp_2200;
}
static inline uint8_t* yo_id_3444(__yo_t10 self) {
  __yo_t22 _file____User_temp_1724 = yo_id_3439(self);
  __yo_t22 raw = _file____User_temp_1724;
  size_t _file____User_temp_1727 = ((raw.len) + (1ULL));
  size_t sz = _file____User_temp_1727;
  void* ptr_opt = __yo_malloc(sz);
  uint8_t* _file____User_temp_1730;
  if (ptr_opt != NULL) {
    void* p = ptr_opt;
    _file____User_temp_1730 = ((uint8_t*)(p));
  } else {
    fprintf(stderr, "%s\n", "\"to_c_str: allocation failed\"");
    abort();
    _file____User_temp_1730 = (*((uint8_t**)NULL));
  }
  uint8_t* ptr = _file____User_temp_1730;
  if (((raw.len) > (0ULL))) {
    size_t _file____User_temp_1737 = raw.len;
    memcpy(((void*)(ptr)), ((void*)(raw.ptr)), _file____User_temp_1737);
  }
  else {
  }
  uint8_t* null_byte = (ptr + raw.len);
  uint8_t _file____User_temp_1744 = (*null_byte); // Save old value for later use
  (*null_byte) = 0;
  return ptr;
}
void __yo_user_main() {
  __yo_str __yo_ref_spill_2 = (__yo_str){ .ptr = (const uint8_t*)"YO_TEST_INDEX", .len = 13 };
  __yo_t10 _file____User_temp_13258 = yo_id_4873((&(__yo_ref_spill_2)));
  __yo_t9 _file____User_temp_13260 = yo_id_5948((__yo_t10)(_file____User_temp_13258));
switch ((_file____User_temp_13258).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13258).data.Some.value));
    break;
  }
  default: break;
}
  switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
    __yo_t10 __yo_test_idx = _file____User_temp_13260.data.Some.value;
    __yo_str __yo_ref_spill_3 = (__yo_str){ .ptr = (const uint8_t*)"0", .len = 1 };
    __yo_t10 _file____User_temp_13262 = yo_id_4873((&(__yo_ref_spill_3)));
    __yo_effect_escaped = 0;
    bool _file____User_temp_13264 = yo_id_4111((__yo_t10)(__yo_test_idx), (__yo_t10)(_file____User_temp_13262));
switch ((_file____User_temp_13262).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13262).data.Some.value));
    break;
  }
  default: break;
}
    if (__yo_effect_escaped) {
      // Drop local variables before early return
switch ((_file____User_temp_13262).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13262).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
      return;
    }
    if (_file____User_temp_13264) {
      { // begin block
        __yo_t10 _file____User_temp_13433 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)".", .len = 1 });
        __yo_effect_escaped = 0;
        bool _file____User_temp_13434 = yo_id_9717((__yo_t10)(_file____User_temp_13433));
        if (__yo_effect_escaped) {
          // Drop local variables before early return
switch ((_file____User_temp_13433).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13433).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
          return;
        }
        __yo_effect_escaped = 0;
        yo_id_5002_str_id_str_rtparam0_bool_rtparam1_comptime_str_ret_unit((bool)(_file____User_temp_13434), (__yo_str)((__yo_str){ .ptr = (const uint8_t*)"dot is local", .len = 12 }));
        if (__yo_effect_escaped) {
          // Drop local variables before early return
switch ((_file____User_temp_13433).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13433).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
          return;
        }
switch ((_file____User_temp_13433).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13433).data.Some.value));
    break;
  }
  default: break;
}
      } // end begin block
    }
    else {
      __yo_str __yo_ref_spill_4 = (__yo_str){ .ptr = (const uint8_t*)"1", .len = 1 };
      __yo_t10 _file____User_temp_13266 = yo_id_4873((&(__yo_ref_spill_4)));
      __yo_effect_escaped = 0;
      bool _file____User_temp_13268 = yo_id_4111((__yo_t10)(__yo_test_idx), (__yo_t10)(_file____User_temp_13266));
switch ((_file____User_temp_13266).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13266).data.Some.value));
    break;
  }
  default: break;
}
      if (__yo_effect_escaped) {
        // Drop local variables before early return
switch ((_file____User_temp_13266).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13266).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
        return;
      }
      if (_file____User_temp_13268) {
        { // begin block
          __yo_t10 _file____User_temp_13447 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"..", .len = 2 });
          __yo_effect_escaped = 0;
          bool _file____User_temp_13448 = yo_id_9717((__yo_t10)(_file____User_temp_13447));
          if (__yo_effect_escaped) {
            // Drop local variables before early return
switch ((_file____User_temp_13447).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13447).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
            return;
          }
          __yo_effect_escaped = 0;
          yo_id_5002_str_id_str_rtparam0_bool_rtparam1_comptime_str_ret_unit((bool)(_file____User_temp_13448), (__yo_str)((__yo_str){ .ptr = (const uint8_t*)"dotdot is local", .len = 15 }));
          if (__yo_effect_escaped) {
            // Drop local variables before early return
switch ((_file____User_temp_13447).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13447).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
            return;
          }
switch ((_file____User_temp_13447).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13447).data.Some.value));
    break;
  }
  default: break;
}
        } // end begin block
      }
      else {
        __yo_str __yo_ref_spill_5 = (__yo_str){ .ptr = (const uint8_t*)"2", .len = 1 };
        __yo_t10 _file____User_temp_13270 = yo_id_4873((&(__yo_ref_spill_5)));
        __yo_effect_escaped = 0;
        bool _file____User_temp_13272 = yo_id_4111((__yo_t10)(__yo_test_idx), (__yo_t10)(_file____User_temp_13270));
switch ((_file____User_temp_13270).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13270).data.Some.value));
    break;
  }
  default: break;
}
        if (__yo_effect_escaped) {
          // Drop local variables before early return
switch ((_file____User_temp_13270).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13270).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
          return;
        }
        if (_file____User_temp_13272) {
          { // begin block
            __yo_t10 _file____User_temp_13452 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"./foo", .len = 5 });
            __yo_effect_escaped = 0;
            bool _file____User_temp_13453 = yo_id_9717((__yo_t10)(_file____User_temp_13452));
            if (__yo_effect_escaped) {
              // Drop local variables before early return
switch ((_file____User_temp_13452).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13452).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
              return;
            }
            __yo_effect_escaped = 0;
            yo_id_5002_str_id_str_rtparam0_bool_rtparam1_comptime_str_ret_unit((bool)(_file____User_temp_13453), (__yo_str)((__yo_str){ .ptr = (const uint8_t*)"./foo is local", .len = 14 }));
            if (__yo_effect_escaped) {
              // Drop local variables before early return
switch ((_file____User_temp_13452).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13452).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
              return;
            }
switch ((_file____User_temp_13452).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13452).data.Some.value));
    break;
  }
  default: break;
}
          } // end begin block
        }
        else {
          __yo_str __yo_ref_spill_6 = (__yo_str){ .ptr = (const uint8_t*)"3", .len = 1 };
          __yo_t10 _file____User_temp_13274 = yo_id_4873((&(__yo_ref_spill_6)));
          __yo_effect_escaped = 0;
          bool _file____User_temp_13276 = yo_id_4111((__yo_t10)(__yo_test_idx), (__yo_t10)(_file____User_temp_13274));
switch ((_file____User_temp_13274).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13274).data.Some.value));
    break;
  }
  default: break;
}
          if (__yo_effect_escaped) {
            // Drop local variables before early return
switch ((_file____User_temp_13274).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13274).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
            return;
          }
          if (_file____User_temp_13276) {
            { // begin block
              __yo_t10 _file____User_temp_13457 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"../bar", .len = 6 });
              __yo_effect_escaped = 0;
              bool _file____User_temp_13458 = yo_id_9717((__yo_t10)(_file____User_temp_13457));
              if (__yo_effect_escaped) {
                // Drop local variables before early return
switch ((_file____User_temp_13457).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13457).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                return;
              }
              __yo_effect_escaped = 0;
              yo_id_5002_str_id_str_rtparam0_bool_rtparam1_comptime_str_ret_unit((bool)(_file____User_temp_13458), (__yo_str)((__yo_str){ .ptr = (const uint8_t*)"../bar is local", .len = 15 }));
              if (__yo_effect_escaped) {
                // Drop local variables before early return
switch ((_file____User_temp_13457).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13457).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                return;
              }
switch ((_file____User_temp_13457).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13457).data.Some.value));
    break;
  }
  default: break;
}
            } // end begin block
          }
          else {
            __yo_str __yo_ref_spill_7 = (__yo_str){ .ptr = (const uint8_t*)"4", .len = 1 };
            __yo_t10 _file____User_temp_13278 = yo_id_4873((&(__yo_ref_spill_7)));
            __yo_effect_escaped = 0;
            bool _file____User_temp_13280 = yo_id_4111((__yo_t10)(__yo_test_idx), (__yo_t10)(_file____User_temp_13278));
switch ((_file____User_temp_13278).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13278).data.Some.value));
    break;
  }
  default: break;
}
            if (__yo_effect_escaped) {
              // Drop local variables before early return
switch ((_file____User_temp_13278).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13278).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
              return;
            }
            if (_file____User_temp_13280) {
              { // begin block
                __yo_t10 _file____User_temp_13462 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"/abs/path", .len = 9 });
                __yo_effect_escaped = 0;
                bool _file____User_temp_13463 = yo_id_9717((__yo_t10)(_file____User_temp_13462));
                if (__yo_effect_escaped) {
                  // Drop local variables before early return
switch ((_file____User_temp_13462).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13462).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                  return;
                }
                __yo_effect_escaped = 0;
                yo_id_5002_str_id_str_rtparam0_bool_rtparam1_comptime_str_ret_unit((bool)(_file____User_temp_13463), (__yo_str)((__yo_str){ .ptr = (const uint8_t*)"/abs is local", .len = 13 }));
                if (__yo_effect_escaped) {
                  // Drop local variables before early return
switch ((_file____User_temp_13462).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13462).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                  return;
                }
switch ((_file____User_temp_13462).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13462).data.Some.value));
    break;
  }
  default: break;
}
              } // end begin block
            }
            else {
              __yo_str __yo_ref_spill_8 = (__yo_str){ .ptr = (const uint8_t*)"5", .len = 1 };
              __yo_t10 _file____User_temp_13282 = yo_id_4873((&(__yo_ref_spill_8)));
              __yo_effect_escaped = 0;
              bool _file____User_temp_13284 = yo_id_4111((__yo_t10)(__yo_test_idx), (__yo_t10)(_file____User_temp_13282));
switch ((_file____User_temp_13282).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13282).data.Some.value));
    break;
  }
  default: break;
}
              if (__yo_effect_escaped) {
                // Drop local variables before early return
switch ((_file____User_temp_13282).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13282).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                return;
              }
              if (_file____User_temp_13284) {
                { // begin block
                  __yo_t10 _file____User_temp_13471 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"user/repo", .len = 9 });
                  __yo_effect_escaped = 0;
                  bool _file____User_temp_13472 = yo_id_9717((__yo_t10)(_file____User_temp_13471));
                  if (__yo_effect_escaped) {
                    // Drop local variables before early return
switch ((_file____User_temp_13471).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13471).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                    return;
                  }
                  __yo_effect_escaped = 0;
                  bool _file____User_temp_13473 = yo_id_122_bool_id_bool_rtparam0_bool_ret_bool((bool)(_file____User_temp_13472));
                  if (__yo_effect_escaped) {
                    // Drop local variables before early return
switch ((_file____User_temp_13471).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13471).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                    return;
                  }
                  __yo_effect_escaped = 0;
                  yo_id_5002_str_id_str_rtparam0_bool_rtparam1_comptime_str_ret_unit((bool)(_file____User_temp_13473), (__yo_str)((__yo_str){ .ptr = (const uint8_t*)"user/repo is not local", .len = 22 }));
                  if (__yo_effect_escaped) {
                    // Drop local variables before early return
switch ((_file____User_temp_13471).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13471).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                    return;
                  }
switch ((_file____User_temp_13471).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13471).data.Some.value));
    break;
  }
  default: break;
}
                } // end begin block
              }
              else {
                __yo_str __yo_ref_spill_9 = (__yo_str){ .ptr = (const uint8_t*)"6", .len = 1 };
                __yo_t10 _file____User_temp_13286 = yo_id_4873((&(__yo_ref_spill_9)));
                __yo_effect_escaped = 0;
                bool _file____User_temp_13288 = yo_id_4111((__yo_t10)(__yo_test_idx), (__yo_t10)(_file____User_temp_13286));
switch ((_file____User_temp_13286).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13286).data.Some.value));
    break;
  }
  default: break;
}
                if (__yo_effect_escaped) {
                  // Drop local variables before early return
switch ((_file____User_temp_13286).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13286).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                  return;
                }
                if (_file____User_temp_13288) {
                  { // begin block
                    __yo_t10 _file____User_temp_13483 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"https://github.com/user/repo", .len = 28 });
                    __yo_effect_escaped = 0;
                    bool _file____User_temp_13484 = yo_id_9717((__yo_t10)(_file____User_temp_13483));
                    if (__yo_effect_escaped) {
                      // Drop local variables before early return
switch ((_file____User_temp_13483).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13483).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                      return;
                    }
                    __yo_effect_escaped = 0;
                    bool _file____User_temp_13485 = yo_id_122_bool_id_bool_rtparam0_bool_ret_bool((bool)(_file____User_temp_13484));
                    if (__yo_effect_escaped) {
                      // Drop local variables before early return
switch ((_file____User_temp_13483).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13483).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                      return;
                    }
                    __yo_effect_escaped = 0;
                    yo_id_5002_str_id_str_rtparam0_bool_rtparam1_comptime_str_ret_unit((bool)(_file____User_temp_13485), (__yo_str)((__yo_str){ .ptr = (const uint8_t*)"https url not local", .len = 19 }));
                    if (__yo_effect_escaped) {
                      // Drop local variables before early return
switch ((_file____User_temp_13483).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13483).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                      return;
                    }
switch ((_file____User_temp_13483).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13483).data.Some.value));
    break;
  }
  default: break;
}
                  } // end begin block
                }
                else {
                  __yo_str __yo_ref_spill_10 = (__yo_str){ .ptr = (const uint8_t*)"7", .len = 1 };
                  __yo_t10 _file____User_temp_13290 = yo_id_4873((&(__yo_ref_spill_10)));
                  __yo_effect_escaped = 0;
                  bool _file____User_temp_13292 = yo_id_4111((__yo_t10)(__yo_test_idx), (__yo_t10)(_file____User_temp_13290));
switch ((_file____User_temp_13290).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13290).data.Some.value));
    break;
  }
  default: break;
}
                  if (__yo_effect_escaped) {
                    // Drop local variables before early return
switch ((_file____User_temp_13290).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13290).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                    return;
                  }
                  if (_file____User_temp_13292) {
                    { // begin block
                      __yo_t10 _file____User_temp_13489 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"https://github.com/user/myrepo.git", .len = 34 });
                      __yo_effect_escaped = 0;
                      __yo_t10 _file____User_temp_13490 = yo_id_9731((__yo_t10)(_file____User_temp_13489));
                      if (__yo_effect_escaped) {
                        // Drop local variables before early return
switch ((_file____User_temp_13489).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13489).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                        return;
                      }
                      __yo_t10 result = _file____User_temp_13490;
                      __yo_t10 _file____User_temp_13492 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"myrepo", .len = 6 });
                      __yo_effect_escaped = 0;
                      bool _file____User_temp_13493 = yo_id_4111((__yo_t10)(result), (__yo_t10)(_file____User_temp_13492));
                      if (__yo_effect_escaped) {
                        // Drop local variables before early return
switch ((_file____User_temp_13489).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13489).data.Some.value));
    break;
  }
  default: break;
}
switch ((result).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((result).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13492).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13492).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                        return;
                      }
                      __yo_effect_escaped = 0;
                      yo_id_5002_str_id_str_rtparam0_bool_rtparam1_comptime_str_ret_unit((bool)(_file____User_temp_13493), (__yo_str)((__yo_str){ .ptr = (const uint8_t*)"stripped .git and got last segment", .len = 34 }));
                      if (__yo_effect_escaped) {
                        // Drop local variables before early return
switch ((_file____User_temp_13489).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13489).data.Some.value));
    break;
  }
  default: break;
}
switch ((result).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((result).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13492).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13492).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                        return;
                      }
switch ((_file____User_temp_13489).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13489).data.Some.value));
    break;
  }
  default: break;
}
switch ((result).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((result).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13492).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13492).data.Some.value));
    break;
  }
  default: break;
}
                    } // end begin block
                  }
                  else {
                    __yo_str __yo_ref_spill_11 = (__yo_str){ .ptr = (const uint8_t*)"8", .len = 1 };
                    __yo_t10 _file____User_temp_13294 = yo_id_4873((&(__yo_ref_spill_11)));
                    __yo_effect_escaped = 0;
                    bool _file____User_temp_13296 = yo_id_4111((__yo_t10)(__yo_test_idx), (__yo_t10)(_file____User_temp_13294));
switch ((_file____User_temp_13294).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13294).data.Some.value));
    break;
  }
  default: break;
}
                    if (__yo_effect_escaped) {
                      // Drop local variables before early return
switch ((_file____User_temp_13294).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13294).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                      return;
                    }
                    if (_file____User_temp_13296) {
                      { // begin block
                        __yo_t10 _file____User_temp_13497 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"https://github.com/user/mylib", .len = 29 });
                        __yo_effect_escaped = 0;
                        __yo_t10 _file____User_temp_13498 = yo_id_9731((__yo_t10)(_file____User_temp_13497));
                        if (__yo_effect_escaped) {
                          // Drop local variables before early return
switch ((_file____User_temp_13497).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13497).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                          return;
                        }
                        __yo_t10 result = _file____User_temp_13498;
                        __yo_t10 _file____User_temp_13500 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"mylib", .len = 5 });
                        __yo_effect_escaped = 0;
                        bool _file____User_temp_13501 = yo_id_4111((__yo_t10)(result), (__yo_t10)(_file____User_temp_13500));
                        if (__yo_effect_escaped) {
                          // Drop local variables before early return
switch ((_file____User_temp_13497).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13497).data.Some.value));
    break;
  }
  default: break;
}
switch ((result).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((result).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13500).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13500).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                          return;
                        }
                        __yo_effect_escaped = 0;
                        yo_id_5002_str_id_str_rtparam0_bool_rtparam1_comptime_str_ret_unit((bool)(_file____User_temp_13501), (__yo_str)((__yo_str){ .ptr = (const uint8_t*)"last segment without .git", .len = 25 }));
                        if (__yo_effect_escaped) {
                          // Drop local variables before early return
switch ((_file____User_temp_13497).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13497).data.Some.value));
    break;
  }
  default: break;
}
switch ((result).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((result).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13500).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13500).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                          return;
                        }
switch ((_file____User_temp_13497).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13497).data.Some.value));
    break;
  }
  default: break;
}
switch ((result).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((result).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13500).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13500).data.Some.value));
    break;
  }
  default: break;
}
                      } // end begin block
                    }
                    else {
                      __yo_str __yo_ref_spill_12 = (__yo_str){ .ptr = (const uint8_t*)"9", .len = 1 };
                      __yo_t10 _file____User_temp_13298 = yo_id_4873((&(__yo_ref_spill_12)));
                      __yo_effect_escaped = 0;
                      bool _file____User_temp_13300 = yo_id_4111((__yo_t10)(__yo_test_idx), (__yo_t10)(_file____User_temp_13298));
switch ((_file____User_temp_13298).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13298).data.Some.value));
    break;
  }
  default: break;
}
                      if (__yo_effect_escaped) {
                        // Drop local variables before early return
switch ((_file____User_temp_13298).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13298).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                        return;
                      }
                      if (_file____User_temp_13300) {
                        { // begin block
                          __yo_t10 _file____User_temp_13505 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"myrepo.git", .len = 10 });
                          __yo_effect_escaped = 0;
                          __yo_t10 _file____User_temp_13506 = yo_id_9731((__yo_t10)(_file____User_temp_13505));
                          if (__yo_effect_escaped) {
                            // Drop local variables before early return
switch ((_file____User_temp_13505).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13505).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                            return;
                          }
                          __yo_t10 result = _file____User_temp_13506;
                          __yo_t10 _file____User_temp_13508 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"myrepo", .len = 6 });
                          __yo_effect_escaped = 0;
                          bool _file____User_temp_13509 = yo_id_4111((__yo_t10)(result), (__yo_t10)(_file____User_temp_13508));
                          if (__yo_effect_escaped) {
                            // Drop local variables before early return
switch ((_file____User_temp_13505).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13505).data.Some.value));
    break;
  }
  default: break;
}
switch ((result).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((result).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13508).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13508).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                            return;
                          }
                          __yo_effect_escaped = 0;
                          yo_id_5002_str_id_str_rtparam0_bool_rtparam1_comptime_str_ret_unit((bool)(_file____User_temp_13509), (__yo_str)((__yo_str){ .ptr = (const uint8_t*)"no slash, stripped .git", .len = 23 }));
                          if (__yo_effect_escaped) {
                            // Drop local variables before early return
switch ((_file____User_temp_13505).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13505).data.Some.value));
    break;
  }
  default: break;
}
switch ((result).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((result).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13508).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13508).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                            return;
                          }
switch ((_file____User_temp_13505).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13505).data.Some.value));
    break;
  }
  default: break;
}
switch ((result).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((result).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13508).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13508).data.Some.value));
    break;
  }
  default: break;
}
                        } // end begin block
                      }
                      else {
                        __yo_str __yo_ref_spill_13 = (__yo_str){ .ptr = (const uint8_t*)"10", .len = 2 };
                        __yo_t10 _file____User_temp_13302 = yo_id_4873((&(__yo_ref_spill_13)));
                        __yo_effect_escaped = 0;
                        bool _file____User_temp_13304 = yo_id_4111((__yo_t10)(__yo_test_idx), (__yo_t10)(_file____User_temp_13302));
switch ((_file____User_temp_13302).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13302).data.Some.value));
    break;
  }
  default: break;
}
                        if (__yo_effect_escaped) {
                          // Drop local variables before early return
switch ((_file____User_temp_13302).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13302).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                          return;
                        }
                        if (_file____User_temp_13304) {
                          { // begin block
                            __yo_t10 _file____User_temp_13513 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"myrepo", .len = 6 });
                            __yo_effect_escaped = 0;
                            __yo_t10 _file____User_temp_13514 = yo_id_9731((__yo_t10)(_file____User_temp_13513));
                            if (__yo_effect_escaped) {
                              // Drop local variables before early return
switch ((_file____User_temp_13513).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13513).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                              return;
                            }
                            __yo_t10 result = _file____User_temp_13514;
                            __yo_t10 _file____User_temp_13516 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"myrepo", .len = 6 });
                            __yo_effect_escaped = 0;
                            bool _file____User_temp_13517 = yo_id_4111((__yo_t10)(result), (__yo_t10)(_file____User_temp_13516));
                            if (__yo_effect_escaped) {
                              // Drop local variables before early return
switch ((_file____User_temp_13513).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13513).data.Some.value));
    break;
  }
  default: break;
}
switch ((result).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((result).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13516).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13516).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                              return;
                            }
                            __yo_effect_escaped = 0;
                            yo_id_5002_str_id_str_rtparam0_bool_rtparam1_comptime_str_ret_unit((bool)(_file____User_temp_13517), (__yo_str)((__yo_str){ .ptr = (const uint8_t*)"plain name unchanged", .len = 20 }));
                            if (__yo_effect_escaped) {
                              // Drop local variables before early return
switch ((_file____User_temp_13513).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13513).data.Some.value));
    break;
  }
  default: break;
}
switch ((result).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((result).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13516).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13516).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                              return;
                            }
switch ((_file____User_temp_13513).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13513).data.Some.value));
    break;
  }
  default: break;
}
switch ((result).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((result).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13516).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13516).data.Some.value));
    break;
  }
  default: break;
}
                          } // end begin block
                        }
                        else {
                          __yo_str __yo_ref_spill_14 = (__yo_str){ .ptr = (const uint8_t*)"11", .len = 2 };
                          __yo_t10 _file____User_temp_13306 = yo_id_4873((&(__yo_ref_spill_14)));
                          __yo_effect_escaped = 0;
                          bool _file____User_temp_13308 = yo_id_4111((__yo_t10)(__yo_test_idx), (__yo_t10)(_file____User_temp_13306));
switch ((_file____User_temp_13306).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13306).data.Some.value));
    break;
  }
  default: break;
}
                          if (__yo_effect_escaped) {
                            // Drop local variables before early return
switch ((_file____User_temp_13306).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13306).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                            return;
                          }
                          if (_file____User_temp_13308) {
                            { // begin block
                              __yo_t10 _file____User_temp_13521 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"123", .len = 3 });
                              __yo_effect_escaped = 0;
                              bool _file____User_temp_13522 = yo_id_9750((__yo_t10)(_file____User_temp_13521));
                              if (__yo_effect_escaped) {
                                // Drop local variables before early return
switch ((_file____User_temp_13521).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13521).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                return;
                              }
                              __yo_effect_escaped = 0;
                              yo_id_5002_str_id_str_rtparam0_bool_rtparam1_comptime_str_ret_unit((bool)(_file____User_temp_13522), (__yo_str)((__yo_str){ .ptr = (const uint8_t*)"123 all digits", .len = 14 }));
                              if (__yo_effect_escaped) {
                                // Drop local variables before early return
switch ((_file____User_temp_13521).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13521).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                return;
                              }
switch ((_file____User_temp_13521).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13521).data.Some.value));
    break;
  }
  default: break;
}
                            } // end begin block
                          }
                          else {
                            __yo_str __yo_ref_spill_15 = (__yo_str){ .ptr = (const uint8_t*)"12", .len = 2 };
                            __yo_t10 _file____User_temp_13310 = yo_id_4873((&(__yo_ref_spill_15)));
                            __yo_effect_escaped = 0;
                            bool _file____User_temp_13312 = yo_id_4111((__yo_t10)(__yo_test_idx), (__yo_t10)(_file____User_temp_13310));
switch ((_file____User_temp_13310).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13310).data.Some.value));
    break;
  }
  default: break;
}
                            if (__yo_effect_escaped) {
                              // Drop local variables before early return
switch ((_file____User_temp_13310).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13310).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                              return;
                            }
                            if (_file____User_temp_13312) {
                              { // begin block
                                __yo_t10 _file____User_temp_13530 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"", .len = 0 });
                                __yo_effect_escaped = 0;
                                bool _file____User_temp_13531 = yo_id_9750((__yo_t10)(_file____User_temp_13530));
                                if (__yo_effect_escaped) {
                                  // Drop local variables before early return
switch ((_file____User_temp_13530).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13530).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                  return;
                                }
                                __yo_effect_escaped = 0;
                                bool _file____User_temp_13532 = yo_id_122_bool_id_bool_rtparam0_bool_ret_bool((bool)(_file____User_temp_13531));
                                if (__yo_effect_escaped) {
                                  // Drop local variables before early return
switch ((_file____User_temp_13530).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13530).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                  return;
                                }
                                __yo_effect_escaped = 0;
                                yo_id_5002_str_id_str_rtparam0_bool_rtparam1_comptime_str_ret_unit((bool)(_file____User_temp_13532), (__yo_str)((__yo_str){ .ptr = (const uint8_t*)"empty is false", .len = 14 }));
                                if (__yo_effect_escaped) {
                                  // Drop local variables before early return
switch ((_file____User_temp_13530).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13530).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                  return;
                                }
switch ((_file____User_temp_13530).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13530).data.Some.value));
    break;
  }
  default: break;
}
                              } // end begin block
                            }
                            else {
                              __yo_str __yo_ref_spill_16 = (__yo_str){ .ptr = (const uint8_t*)"13", .len = 2 };
                              __yo_t10 _file____User_temp_13314 = yo_id_4873((&(__yo_ref_spill_16)));
                              __yo_effect_escaped = 0;
                              bool _file____User_temp_13316 = yo_id_4111((__yo_t10)(__yo_test_idx), (__yo_t10)(_file____User_temp_13314));
switch ((_file____User_temp_13314).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13314).data.Some.value));
    break;
  }
  default: break;
}
                              if (__yo_effect_escaped) {
                                // Drop local variables before early return
switch ((_file____User_temp_13314).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13314).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                return;
                              }
                              if (_file____User_temp_13316) {
                                { // begin block
                                  __yo_t10 _file____User_temp_13540 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"12a3", .len = 4 });
                                  __yo_effect_escaped = 0;
                                  bool _file____User_temp_13541 = yo_id_9750((__yo_t10)(_file____User_temp_13540));
                                  if (__yo_effect_escaped) {
                                    // Drop local variables before early return
switch ((_file____User_temp_13540).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13540).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                    return;
                                  }
                                  __yo_effect_escaped = 0;
                                  bool _file____User_temp_13542 = yo_id_122_bool_id_bool_rtparam0_bool_ret_bool((bool)(_file____User_temp_13541));
                                  if (__yo_effect_escaped) {
                                    // Drop local variables before early return
switch ((_file____User_temp_13540).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13540).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                    return;
                                  }
                                  __yo_effect_escaped = 0;
                                  yo_id_5002_str_id_str_rtparam0_bool_rtparam1_comptime_str_ret_unit((bool)(_file____User_temp_13542), (__yo_str)((__yo_str){ .ptr = (const uint8_t*)"letter makes it false", .len = 21 }));
                                  if (__yo_effect_escaped) {
                                    // Drop local variables before early return
switch ((_file____User_temp_13540).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13540).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                    return;
                                  }
switch ((_file____User_temp_13540).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13540).data.Some.value));
    break;
  }
  default: break;
}
                                } // end begin block
                              }
                              else {
                                __yo_str __yo_ref_spill_17 = (__yo_str){ .ptr = (const uint8_t*)"14", .len = 2 };
                                __yo_t10 _file____User_temp_13318 = yo_id_4873((&(__yo_ref_spill_17)));
                                __yo_effect_escaped = 0;
                                bool _file____User_temp_13320 = yo_id_4111((__yo_t10)(__yo_test_idx), (__yo_t10)(_file____User_temp_13318));
switch ((_file____User_temp_13318).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13318).data.Some.value));
    break;
  }
  default: break;
}
                                if (__yo_effect_escaped) {
                                  // Drop local variables before early return
switch ((_file____User_temp_13318).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13318).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                  return;
                                }
                                if (_file____User_temp_13320) {
                                  { // begin block
                                    __yo_t10 _file____User_temp_13546 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"0", .len = 1 });
                                    __yo_effect_escaped = 0;
                                    bool _file____User_temp_13547 = yo_id_9750((__yo_t10)(_file____User_temp_13546));
                                    if (__yo_effect_escaped) {
                                      // Drop local variables before early return
switch ((_file____User_temp_13546).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13546).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                      return;
                                    }
                                    __yo_effect_escaped = 0;
                                    yo_id_5002_str_id_str_rtparam0_bool_rtparam1_comptime_str_ret_unit((bool)(_file____User_temp_13547), (__yo_str)((__yo_str){ .ptr = (const uint8_t*)"single 0 is digits", .len = 18 }));
                                    if (__yo_effect_escaped) {
                                      // Drop local variables before early return
switch ((_file____User_temp_13546).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13546).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                      return;
                                    }
switch ((_file____User_temp_13546).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13546).data.Some.value));
    break;
  }
  default: break;
}
                                  } // end begin block
                                }
                                else {
                                  __yo_str __yo_ref_spill_18 = (__yo_str){ .ptr = (const uint8_t*)"15", .len = 2 };
                                  __yo_t10 _file____User_temp_13322 = yo_id_4873((&(__yo_ref_spill_18)));
                                  __yo_effect_escaped = 0;
                                  bool _file____User_temp_13324 = yo_id_4111((__yo_t10)(__yo_test_idx), (__yo_t10)(_file____User_temp_13322));
switch ((_file____User_temp_13322).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13322).data.Some.value));
    break;
  }
  default: break;
}
                                  if (__yo_effect_escaped) {
                                    // Drop local variables before early return
switch ((_file____User_temp_13322).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13322).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                    return;
                                  }
                                  if (_file____User_temp_13324) {
                                    { // begin block
                                      __yo_t10 _file____User_temp_13551 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"v1.2.3", .len = 6 });
                                      __yo_effect_escaped = 0;
                                      __yo_t29 _file____User_temp_13552 = yo_id_9763((__yo_t10)(_file____User_temp_13551));
                                      if (__yo_effect_escaped) {
                                        // Drop local variables before early return
switch ((_file____User_temp_13551).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13551).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                        return;
                                      }
                                      __yo_t29 result = _file____User_temp_13552;
                                      switch ((result).tag) {
                                      case __YO_T29_NONE: {
                                        __yo_effect_escaped = 0;
                                        yo_id_5002_str_id_str_rtparam0_bool_rtparam1_comptime_str_ret_unit((bool)(false), (__yo_str)((__yo_str){ .ptr = (const uint8_t*)"expected Some", .len = 13 }));
                                        if (__yo_effect_escaped) {
                                          // Drop local variables before early return
switch ((_file____User_temp_13551).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13551).data.Some.value));
    break;
  }
  default: break;
}
switch ((result).tag) {
  case __YO_T29_SOME: {
    __yo_decr_rc((void*)((result).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                          return;
                                        }
                                        break;
                                      }
                                      case __YO_T29_SOME: {
                                        __yo_t28* sv = result.data.Some.value;
                                        __yo_effect_escaped = 0;
                                        yo_id_5002_str_id_str_rtparam0_bool_rtparam1_comptime_str_ret_unit((bool)(((sv->major) == (1))), (__yo_str)((__yo_str){ .ptr = (const uint8_t*)"major is 1", .len = 10 }));
                                        if (__yo_effect_escaped) {
                                          // Drop local variables before early return
switch ((_file____User_temp_13551).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13551).data.Some.value));
    break;
  }
  default: break;
}
switch ((result).tag) {
  case __YO_T29_SOME: {
    __yo_decr_rc((void*)((result).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                          return;
                                        }
                                        __yo_effect_escaped = 0;
                                        yo_id_5002_str_id_str_rtparam0_bool_rtparam1_comptime_str_ret_unit((bool)(((sv->minor) == (2))), (__yo_str)((__yo_str){ .ptr = (const uint8_t*)"minor is 2", .len = 10 }));
                                        if (__yo_effect_escaped) {
                                          // Drop local variables before early return
switch ((_file____User_temp_13551).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13551).data.Some.value));
    break;
  }
  default: break;
}
switch ((result).tag) {
  case __YO_T29_SOME: {
    __yo_decr_rc((void*)((result).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                          return;
                                        }
                                        __yo_effect_escaped = 0;
                                        yo_id_5002_str_id_str_rtparam0_bool_rtparam1_comptime_str_ret_unit((bool)(((sv->patch) == (3))), (__yo_str)((__yo_str){ .ptr = (const uint8_t*)"patch is 3", .len = 10 }));
                                        if (__yo_effect_escaped) {
                                          // Drop local variables before early return
switch ((_file____User_temp_13551).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13551).data.Some.value));
    break;
  }
  default: break;
}
switch ((result).tag) {
  case __YO_T29_SOME: {
    __yo_decr_rc((void*)((result).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                          return;
                                        }
                                        break;
                                      }
                                      }
switch ((_file____User_temp_13551).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13551).data.Some.value));
    break;
  }
  default: break;
}
switch ((result).tag) {
  case __YO_T29_SOME: {
    __yo_decr_rc((void*)((result).data.Some.value));
    break;
  }
  default: break;
}
                                    } // end begin block
                                  }
                                  else {
                                    __yo_str __yo_ref_spill_19 = (__yo_str){ .ptr = (const uint8_t*)"16", .len = 2 };
                                    __yo_t10 _file____User_temp_13326 = yo_id_4873((&(__yo_ref_spill_19)));
                                    __yo_effect_escaped = 0;
                                    bool _file____User_temp_13328 = yo_id_4111((__yo_t10)(__yo_test_idx), (__yo_t10)(_file____User_temp_13326));
switch ((_file____User_temp_13326).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13326).data.Some.value));
    break;
  }
  default: break;
}
                                    if (__yo_effect_escaped) {
                                      // Drop local variables before early return
switch ((_file____User_temp_13326).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13326).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                      return;
                                    }
                                    if (_file____User_temp_13328) {
                                      { // begin block
                                        __yo_t10 _file____User_temp_13571 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"V2.0.0", .len = 6 });
                                        __yo_effect_escaped = 0;
                                        __yo_t29 _file____User_temp_13572 = yo_id_9763((__yo_t10)(_file____User_temp_13571));
                                        if (__yo_effect_escaped) {
                                          // Drop local variables before early return
switch ((_file____User_temp_13571).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13571).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                          return;
                                        }
                                        __yo_t29 result = _file____User_temp_13572;
                                        switch ((result).tag) {
                                        case __YO_T29_NONE: {
                                          __yo_effect_escaped = 0;
                                          yo_id_5002_str_id_str_rtparam0_bool_rtparam1_comptime_str_ret_unit((bool)(false), (__yo_str)((__yo_str){ .ptr = (const uint8_t*)"expected Some", .len = 13 }));
                                          if (__yo_effect_escaped) {
                                            // Drop local variables before early return
switch ((_file____User_temp_13571).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13571).data.Some.value));
    break;
  }
  default: break;
}
switch ((result).tag) {
  case __YO_T29_SOME: {
    __yo_decr_rc((void*)((result).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                            return;
                                          }
                                          break;
                                        }
                                        case __YO_T29_SOME: {
                                          __yo_t28* sv = result.data.Some.value;
                                          __yo_effect_escaped = 0;
                                          yo_id_5002_str_id_str_rtparam0_bool_rtparam1_comptime_str_ret_unit((bool)(((sv->major) == (2))), (__yo_str)((__yo_str){ .ptr = (const uint8_t*)"major is 2", .len = 10 }));
                                          if (__yo_effect_escaped) {
                                            // Drop local variables before early return
switch ((_file____User_temp_13571).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13571).data.Some.value));
    break;
  }
  default: break;
}
switch ((result).tag) {
  case __YO_T29_SOME: {
    __yo_decr_rc((void*)((result).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                            return;
                                          }
                                          __yo_effect_escaped = 0;
                                          yo_id_5002_str_id_str_rtparam0_bool_rtparam1_comptime_str_ret_unit((bool)(((sv->minor) == (0))), (__yo_str)((__yo_str){ .ptr = (const uint8_t*)"minor is 0", .len = 10 }));
                                          if (__yo_effect_escaped) {
                                            // Drop local variables before early return
switch ((_file____User_temp_13571).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13571).data.Some.value));
    break;
  }
  default: break;
}
switch ((result).tag) {
  case __YO_T29_SOME: {
    __yo_decr_rc((void*)((result).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                            return;
                                          }
                                          __yo_effect_escaped = 0;
                                          yo_id_5002_str_id_str_rtparam0_bool_rtparam1_comptime_str_ret_unit((bool)(((sv->patch) == (0))), (__yo_str)((__yo_str){ .ptr = (const uint8_t*)"patch is 0", .len = 10 }));
                                          if (__yo_effect_escaped) {
                                            // Drop local variables before early return
switch ((_file____User_temp_13571).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13571).data.Some.value));
    break;
  }
  default: break;
}
switch ((result).tag) {
  case __YO_T29_SOME: {
    __yo_decr_rc((void*)((result).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                            return;
                                          }
                                          break;
                                        }
                                        }
switch ((_file____User_temp_13571).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13571).data.Some.value));
    break;
  }
  default: break;
}
switch ((result).tag) {
  case __YO_T29_SOME: {
    __yo_decr_rc((void*)((result).data.Some.value));
    break;
  }
  default: break;
}
                                      } // end begin block
                                    }
                                    else {
                                      __yo_str __yo_ref_spill_20 = (__yo_str){ .ptr = (const uint8_t*)"17", .len = 2 };
                                      __yo_t10 _file____User_temp_13330 = yo_id_4873((&(__yo_ref_spill_20)));
                                      __yo_effect_escaped = 0;
                                      bool _file____User_temp_13332 = yo_id_4111((__yo_t10)(__yo_test_idx), (__yo_t10)(_file____User_temp_13330));
switch ((_file____User_temp_13330).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13330).data.Some.value));
    break;
  }
  default: break;
}
                                      if (__yo_effect_escaped) {
                                        // Drop local variables before early return
switch ((_file____User_temp_13330).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13330).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                        return;
                                      }
                                      if (_file____User_temp_13332) {
                                        { // begin block
                                          __yo_t10 _file____User_temp_13591 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"3.4.5", .len = 5 });
                                          __yo_effect_escaped = 0;
                                          __yo_t29 _file____User_temp_13592 = yo_id_9763((__yo_t10)(_file____User_temp_13591));
                                          if (__yo_effect_escaped) {
                                            // Drop local variables before early return
switch ((_file____User_temp_13591).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13591).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                            return;
                                          }
                                          __yo_t29 result = _file____User_temp_13592;
                                          switch ((result).tag) {
                                          case __YO_T29_NONE: {
                                            __yo_effect_escaped = 0;
                                            yo_id_5002_str_id_str_rtparam0_bool_rtparam1_comptime_str_ret_unit((bool)(false), (__yo_str)((__yo_str){ .ptr = (const uint8_t*)"expected Some", .len = 13 }));
                                            if (__yo_effect_escaped) {
                                              // Drop local variables before early return
switch ((_file____User_temp_13591).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13591).data.Some.value));
    break;
  }
  default: break;
}
switch ((result).tag) {
  case __YO_T29_SOME: {
    __yo_decr_rc((void*)((result).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                              return;
                                            }
                                            break;
                                          }
                                          case __YO_T29_SOME: {
                                            __yo_t28* sv = result.data.Some.value;
                                            __yo_effect_escaped = 0;
                                            yo_id_5002_str_id_str_rtparam0_bool_rtparam1_comptime_str_ret_unit((bool)(((sv->major) == (3))), (__yo_str)((__yo_str){ .ptr = (const uint8_t*)"major is 3", .len = 10 }));
                                            if (__yo_effect_escaped) {
                                              // Drop local variables before early return
switch ((_file____User_temp_13591).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13591).data.Some.value));
    break;
  }
  default: break;
}
switch ((result).tag) {
  case __YO_T29_SOME: {
    __yo_decr_rc((void*)((result).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                              return;
                                            }
                                            __yo_effect_escaped = 0;
                                            yo_id_5002_str_id_str_rtparam0_bool_rtparam1_comptime_str_ret_unit((bool)(((sv->minor) == (4))), (__yo_str)((__yo_str){ .ptr = (const uint8_t*)"minor is 4", .len = 10 }));
                                            if (__yo_effect_escaped) {
                                              // Drop local variables before early return
switch ((_file____User_temp_13591).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13591).data.Some.value));
    break;
  }
  default: break;
}
switch ((result).tag) {
  case __YO_T29_SOME: {
    __yo_decr_rc((void*)((result).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                              return;
                                            }
                                            __yo_effect_escaped = 0;
                                            yo_id_5002_str_id_str_rtparam0_bool_rtparam1_comptime_str_ret_unit((bool)(((sv->patch) == (5))), (__yo_str)((__yo_str){ .ptr = (const uint8_t*)"patch is 5", .len = 10 }));
                                            if (__yo_effect_escaped) {
                                              // Drop local variables before early return
switch ((_file____User_temp_13591).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13591).data.Some.value));
    break;
  }
  default: break;
}
switch ((result).tag) {
  case __YO_T29_SOME: {
    __yo_decr_rc((void*)((result).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                              return;
                                            }
                                            break;
                                          }
                                          }
switch ((_file____User_temp_13591).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13591).data.Some.value));
    break;
  }
  default: break;
}
switch ((result).tag) {
  case __YO_T29_SOME: {
    __yo_decr_rc((void*)((result).data.Some.value));
    break;
  }
  default: break;
}
                                        } // end begin block
                                      }
                                      else {
                                        __yo_str __yo_ref_spill_21 = (__yo_str){ .ptr = (const uint8_t*)"18", .len = 2 };
                                        __yo_t10 _file____User_temp_13334 = yo_id_4873((&(__yo_ref_spill_21)));
                                        __yo_effect_escaped = 0;
                                        bool _file____User_temp_13336 = yo_id_4111((__yo_t10)(__yo_test_idx), (__yo_t10)(_file____User_temp_13334));
switch ((_file____User_temp_13334).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13334).data.Some.value));
    break;
  }
  default: break;
}
                                        if (__yo_effect_escaped) {
                                          // Drop local variables before early return
switch ((_file____User_temp_13334).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13334).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                          return;
                                        }
                                        if (_file____User_temp_13336) {
                                          { // begin block
                                            __yo_t10 _file____User_temp_13611 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"", .len = 0 });
                                            __yo_effect_escaped = 0;
                                            __yo_t29 _file____User_temp_13612 = yo_id_9763((__yo_t10)(_file____User_temp_13611));
                                            if (__yo_effect_escaped) {
                                              // Drop local variables before early return
switch ((_file____User_temp_13611).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13611).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                              return;
                                            }
                                            __yo_t29 result = _file____User_temp_13612;
                                            switch ((result).tag) {
                                            case __YO_T29_NONE: {
                                              __yo_effect_escaped = 0;
                                              yo_id_5002_str_id_str_rtparam0_bool_rtparam1_comptime_str_ret_unit((bool)(true), (__yo_str)((__yo_str){ .ptr = (const uint8_t*)"None as expected", .len = 16 }));
                                              if (__yo_effect_escaped) {
                                                // Drop local variables before early return
switch ((_file____User_temp_13611).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13611).data.Some.value));
    break;
  }
  default: break;
}
switch ((result).tag) {
  case __YO_T29_SOME: {
    __yo_decr_rc((void*)((result).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                return;
                                              }
                                              break;
                                            }
                                            case __YO_T29_SOME: {
                                              __yo_effect_escaped = 0;
                                              yo_id_5002_str_id_str_rtparam0_bool_rtparam1_comptime_str_ret_unit((bool)(false), (__yo_str)((__yo_str){ .ptr = (const uint8_t*)"expected None for empty", .len = 23 }));
                                              if (__yo_effect_escaped) {
                                                // Drop local variables before early return
switch ((_file____User_temp_13611).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13611).data.Some.value));
    break;
  }
  default: break;
}
switch ((result).tag) {
  case __YO_T29_SOME: {
    __yo_decr_rc((void*)((result).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                return;
                                              }
                                              break;
                                            }
                                            }
switch ((_file____User_temp_13611).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13611).data.Some.value));
    break;
  }
  default: break;
}
switch ((result).tag) {
  case __YO_T29_SOME: {
    __yo_decr_rc((void*)((result).data.Some.value));
    break;
  }
  default: break;
}
                                          } // end begin block
                                        }
                                        else {
                                          __yo_str __yo_ref_spill_22 = (__yo_str){ .ptr = (const uint8_t*)"19", .len = 2 };
                                          __yo_t10 _file____User_temp_13338 = yo_id_4873((&(__yo_ref_spill_22)));
                                          __yo_effect_escaped = 0;
                                          bool _file____User_temp_13340 = yo_id_4111((__yo_t10)(__yo_test_idx), (__yo_t10)(_file____User_temp_13338));
switch ((_file____User_temp_13338).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13338).data.Some.value));
    break;
  }
  default: break;
}
                                          if (__yo_effect_escaped) {
                                            // Drop local variables before early return
switch ((_file____User_temp_13338).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13338).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                            return;
                                          }
                                          if (_file____User_temp_13340) {
                                            { // begin block
                                              __yo_t10 _file____User_temp_13620 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"v1.2", .len = 4 });
                                              __yo_effect_escaped = 0;
                                              __yo_t29 _file____User_temp_13621 = yo_id_9763((__yo_t10)(_file____User_temp_13620));
                                              if (__yo_effect_escaped) {
                                                // Drop local variables before early return
switch ((_file____User_temp_13620).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13620).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                return;
                                              }
                                              __yo_t29 result = _file____User_temp_13621;
                                              switch ((result).tag) {
                                              case __YO_T29_NONE: {
                                                __yo_effect_escaped = 0;
                                                yo_id_5002_str_id_str_rtparam0_bool_rtparam1_comptime_str_ret_unit((bool)(true), (__yo_str)((__yo_str){ .ptr = (const uint8_t*)"None as expected", .len = 16 }));
                                                if (__yo_effect_escaped) {
                                                  // Drop local variables before early return
switch ((_file____User_temp_13620).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13620).data.Some.value));
    break;
  }
  default: break;
}
switch ((result).tag) {
  case __YO_T29_SOME: {
    __yo_decr_rc((void*)((result).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                  return;
                                                }
                                                break;
                                              }
                                              case __YO_T29_SOME: {
                                                __yo_effect_escaped = 0;
                                                yo_id_5002_str_id_str_rtparam0_bool_rtparam1_comptime_str_ret_unit((bool)(false), (__yo_str)((__yo_str){ .ptr = (const uint8_t*)"expected None for v1.2", .len = 22 }));
                                                if (__yo_effect_escaped) {
                                                  // Drop local variables before early return
switch ((_file____User_temp_13620).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13620).data.Some.value));
    break;
  }
  default: break;
}
switch ((result).tag) {
  case __YO_T29_SOME: {
    __yo_decr_rc((void*)((result).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                  return;
                                                }
                                                break;
                                              }
                                              }
switch ((_file____User_temp_13620).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13620).data.Some.value));
    break;
  }
  default: break;
}
switch ((result).tag) {
  case __YO_T29_SOME: {
    __yo_decr_rc((void*)((result).data.Some.value));
    break;
  }
  default: break;
}
                                            } // end begin block
                                          }
                                          else {
                                            __yo_str __yo_ref_spill_23 = (__yo_str){ .ptr = (const uint8_t*)"20", .len = 2 };
                                            __yo_t10 _file____User_temp_13342 = yo_id_4873((&(__yo_ref_spill_23)));
                                            __yo_effect_escaped = 0;
                                            bool _file____User_temp_13344 = yo_id_4111((__yo_t10)(__yo_test_idx), (__yo_t10)(_file____User_temp_13342));
switch ((_file____User_temp_13342).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13342).data.Some.value));
    break;
  }
  default: break;
}
                                            if (__yo_effect_escaped) {
                                              // Drop local variables before early return
switch ((_file____User_temp_13342).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13342).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                              return;
                                            }
                                            if (_file____User_temp_13344) {
                                              { // begin block
                                                __yo_t10 _file____User_temp_13629 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"v1.beta.3", .len = 9 });
                                                __yo_effect_escaped = 0;
                                                __yo_t29 _file____User_temp_13630 = yo_id_9763((__yo_t10)(_file____User_temp_13629));
                                                if (__yo_effect_escaped) {
                                                  // Drop local variables before early return
switch ((_file____User_temp_13629).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13629).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                  return;
                                                }
                                                __yo_t29 result = _file____User_temp_13630;
                                                switch ((result).tag) {
                                                case __YO_T29_NONE: {
                                                  __yo_effect_escaped = 0;
                                                  yo_id_5002_str_id_str_rtparam0_bool_rtparam1_comptime_str_ret_unit((bool)(true), (__yo_str)((__yo_str){ .ptr = (const uint8_t*)"None as expected", .len = 16 }));
                                                  if (__yo_effect_escaped) {
                                                    // Drop local variables before early return
switch ((_file____User_temp_13629).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13629).data.Some.value));
    break;
  }
  default: break;
}
switch ((result).tag) {
  case __YO_T29_SOME: {
    __yo_decr_rc((void*)((result).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                    return;
                                                  }
                                                  break;
                                                }
                                                case __YO_T29_SOME: {
                                                  __yo_effect_escaped = 0;
                                                  yo_id_5002_str_id_str_rtparam0_bool_rtparam1_comptime_str_ret_unit((bool)(false), (__yo_str)((__yo_str){ .ptr = (const uint8_t*)"expected None for v1.beta.3", .len = 27 }));
                                                  if (__yo_effect_escaped) {
                                                    // Drop local variables before early return
switch ((_file____User_temp_13629).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13629).data.Some.value));
    break;
  }
  default: break;
}
switch ((result).tag) {
  case __YO_T29_SOME: {
    __yo_decr_rc((void*)((result).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                    return;
                                                  }
                                                  break;
                                                }
                                                }
switch ((_file____User_temp_13629).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13629).data.Some.value));
    break;
  }
  default: break;
}
switch ((result).tag) {
  case __YO_T29_SOME: {
    __yo_decr_rc((void*)((result).data.Some.value));
    break;
  }
  default: break;
}
                                              } // end begin block
                                            }
                                            else {
                                              __yo_str __yo_ref_spill_24 = (__yo_str){ .ptr = (const uint8_t*)"21", .len = 2 };
                                              __yo_t10 _file____User_temp_13346 = yo_id_4873((&(__yo_ref_spill_24)));
                                              __yo_effect_escaped = 0;
                                              bool _file____User_temp_13348 = yo_id_4111((__yo_t10)(__yo_test_idx), (__yo_t10)(_file____User_temp_13346));
switch ((_file____User_temp_13346).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13346).data.Some.value));
    break;
  }
  default: break;
}
                                              if (__yo_effect_escaped) {
                                                // Drop local variables before early return
switch ((_file____User_temp_13346).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13346).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                return;
                                              }
                                              if (_file____User_temp_13348) {
                                                { // begin block
                                                  __yo_t10 _file____User_temp_13638 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"v1.0.0", .len = 6 });
                                                  __yo_t28* _file____User_temp_13639 = __yo_new___yo_t28(_file____User_temp_13638, 1, 0, 0);
                                                  __yo_t28* a = _file____User_temp_13639;
                                                  __yo_t10 _file____User_temp_13640 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"v1.0.0", .len = 6 });
                                                  __yo_t28* _file____User_temp_13641 = __yo_new___yo_t28(_file____User_temp_13640, 1, 0, 0);
                                                  __yo_t28* b = _file____User_temp_13641;
                                                  __yo_effect_escaped = 0;
                                                  int32_t _file____User_temp_13643 = yo_id_9831((__yo_t28*)(a), (__yo_t28*)(b));
                                                  if (__yo_effect_escaped) {
                                                    // Drop local variables before early return
                                                    __yo_decr_rc((void*)(a));
                                                    __yo_decr_rc((void*)(b));
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                    return;
                                                  }
                                                  __yo_effect_escaped = 0;
                                                  yo_id_5002_str_id_str_rtparam0_bool_rtparam1_comptime_str_ret_unit((bool)(((_file____User_temp_13643) == (0))), (__yo_str)((__yo_str){ .ptr = (const uint8_t*)"equal versions give 0", .len = 21 }));
                                                  if (__yo_effect_escaped) {
                                                    // Drop local variables before early return
                                                    __yo_decr_rc((void*)(a));
                                                    __yo_decr_rc((void*)(b));
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                    return;
                                                  }
                                                  __yo_decr_rc((void*)(a));
                                                  __yo_decr_rc((void*)(b));
                                                } // end begin block
                                              }
                                              else {
                                                __yo_str __yo_ref_spill_25 = (__yo_str){ .ptr = (const uint8_t*)"22", .len = 2 };
                                                __yo_t10 _file____User_temp_13350 = yo_id_4873((&(__yo_ref_spill_25)));
                                                __yo_effect_escaped = 0;
                                                bool _file____User_temp_13352 = yo_id_4111((__yo_t10)(__yo_test_idx), (__yo_t10)(_file____User_temp_13350));
switch ((_file____User_temp_13350).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13350).data.Some.value));
    break;
  }
  default: break;
}
                                                if (__yo_effect_escaped) {
                                                  // Drop local variables before early return
switch ((_file____User_temp_13350).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13350).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                  return;
                                                }
                                                if (_file____User_temp_13352) {
                                                  { // begin block
                                                    __yo_t10 _file____User_temp_13648 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"v2.0.0", .len = 6 });
                                                    __yo_t28* _file____User_temp_13649 = __yo_new___yo_t28(_file____User_temp_13648, 2, 0, 0);
                                                    __yo_t28* a = _file____User_temp_13649;
                                                    __yo_t10 _file____User_temp_13650 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"v1.9.9", .len = 6 });
                                                    __yo_t28* _file____User_temp_13651 = __yo_new___yo_t28(_file____User_temp_13650, 1, 9, 9);
                                                    __yo_t28* b = _file____User_temp_13651;
                                                    __yo_effect_escaped = 0;
                                                    int32_t _file____User_temp_13653 = yo_id_9831((__yo_t28*)(a), (__yo_t28*)(b));
                                                    if (__yo_effect_escaped) {
                                                      // Drop local variables before early return
                                                      __yo_decr_rc((void*)(a));
                                                      __yo_decr_rc((void*)(b));
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                      return;
                                                    }
                                                    __yo_effect_escaped = 0;
                                                    yo_id_5002_str_id_str_rtparam0_bool_rtparam1_comptime_str_ret_unit((bool)(((_file____User_temp_13653) > (0))), (__yo_str)((__yo_str){ .ptr = (const uint8_t*)"a > b by major", .len = 14 }));
                                                    if (__yo_effect_escaped) {
                                                      // Drop local variables before early return
                                                      __yo_decr_rc((void*)(a));
                                                      __yo_decr_rc((void*)(b));
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                      return;
                                                    }
                                                    __yo_decr_rc((void*)(a));
                                                    __yo_decr_rc((void*)(b));
                                                  } // end begin block
                                                }
                                                else {
                                                  __yo_str __yo_ref_spill_26 = (__yo_str){ .ptr = (const uint8_t*)"23", .len = 2 };
                                                  __yo_t10 _file____User_temp_13354 = yo_id_4873((&(__yo_ref_spill_26)));
                                                  __yo_effect_escaped = 0;
                                                  bool _file____User_temp_13356 = yo_id_4111((__yo_t10)(__yo_test_idx), (__yo_t10)(_file____User_temp_13354));
switch ((_file____User_temp_13354).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13354).data.Some.value));
    break;
  }
  default: break;
}
                                                  if (__yo_effect_escaped) {
                                                    // Drop local variables before early return
switch ((_file____User_temp_13354).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13354).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                    return;
                                                  }
                                                  if (_file____User_temp_13356) {
                                                    { // begin block
                                                      __yo_t10 _file____User_temp_13658 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"v1.3.0", .len = 6 });
                                                      __yo_t28* _file____User_temp_13659 = __yo_new___yo_t28(_file____User_temp_13658, 1, 3, 0);
                                                      __yo_t28* a = _file____User_temp_13659;
                                                      __yo_t10 _file____User_temp_13660 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"v1.2.9", .len = 6 });
                                                      __yo_t28* _file____User_temp_13661 = __yo_new___yo_t28(_file____User_temp_13660, 1, 2, 9);
                                                      __yo_t28* b = _file____User_temp_13661;
                                                      __yo_effect_escaped = 0;
                                                      int32_t _file____User_temp_13663 = yo_id_9831((__yo_t28*)(a), (__yo_t28*)(b));
                                                      if (__yo_effect_escaped) {
                                                        // Drop local variables before early return
                                                        __yo_decr_rc((void*)(a));
                                                        __yo_decr_rc((void*)(b));
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                        return;
                                                      }
                                                      __yo_effect_escaped = 0;
                                                      yo_id_5002_str_id_str_rtparam0_bool_rtparam1_comptime_str_ret_unit((bool)(((_file____User_temp_13663) > (0))), (__yo_str)((__yo_str){ .ptr = (const uint8_t*)"a > b by minor", .len = 14 }));
                                                      if (__yo_effect_escaped) {
                                                        // Drop local variables before early return
                                                        __yo_decr_rc((void*)(a));
                                                        __yo_decr_rc((void*)(b));
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                        return;
                                                      }
                                                      __yo_decr_rc((void*)(a));
                                                      __yo_decr_rc((void*)(b));
                                                    } // end begin block
                                                  }
                                                  else {
                                                    __yo_str __yo_ref_spill_27 = (__yo_str){ .ptr = (const uint8_t*)"24", .len = 2 };
                                                    __yo_t10 _file____User_temp_13358 = yo_id_4873((&(__yo_ref_spill_27)));
                                                    __yo_effect_escaped = 0;
                                                    bool _file____User_temp_13360 = yo_id_4111((__yo_t10)(__yo_test_idx), (__yo_t10)(_file____User_temp_13358));
switch ((_file____User_temp_13358).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13358).data.Some.value));
    break;
  }
  default: break;
}
                                                    if (__yo_effect_escaped) {
                                                      // Drop local variables before early return
switch ((_file____User_temp_13358).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13358).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                      return;
                                                    }
                                                    if (_file____User_temp_13360) {
                                                      { // begin block
                                                        __yo_t10 _file____User_temp_13668 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"v1.2.3", .len = 6 });
                                                        __yo_t28* _file____User_temp_13669 = __yo_new___yo_t28(_file____User_temp_13668, 1, 2, 3);
                                                        __yo_t28* a = _file____User_temp_13669;
                                                        __yo_t10 _file____User_temp_13670 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"v1.2.2", .len = 6 });
                                                        __yo_t28* _file____User_temp_13671 = __yo_new___yo_t28(_file____User_temp_13670, 1, 2, 2);
                                                        __yo_t28* b = _file____User_temp_13671;
                                                        __yo_effect_escaped = 0;
                                                        int32_t _file____User_temp_13673 = yo_id_9831((__yo_t28*)(a), (__yo_t28*)(b));
                                                        if (__yo_effect_escaped) {
                                                          // Drop local variables before early return
                                                          __yo_decr_rc((void*)(a));
                                                          __yo_decr_rc((void*)(b));
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                          return;
                                                        }
                                                        __yo_effect_escaped = 0;
                                                        yo_id_5002_str_id_str_rtparam0_bool_rtparam1_comptime_str_ret_unit((bool)(((_file____User_temp_13673) > (0))), (__yo_str)((__yo_str){ .ptr = (const uint8_t*)"a > b by patch", .len = 14 }));
                                                        if (__yo_effect_escaped) {
                                                          // Drop local variables before early return
                                                          __yo_decr_rc((void*)(a));
                                                          __yo_decr_rc((void*)(b));
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                          return;
                                                        }
                                                        __yo_decr_rc((void*)(a));
                                                        __yo_decr_rc((void*)(b));
                                                      } // end begin block
                                                    }
                                                    else {
                                                      __yo_str __yo_ref_spill_28 = (__yo_str){ .ptr = (const uint8_t*)"25", .len = 2 };
                                                      __yo_t10 _file____User_temp_13362 = yo_id_4873((&(__yo_ref_spill_28)));
                                                      __yo_effect_escaped = 0;
                                                      bool _file____User_temp_13364 = yo_id_4111((__yo_t10)(__yo_test_idx), (__yo_t10)(_file____User_temp_13362));
switch ((_file____User_temp_13362).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13362).data.Some.value));
    break;
  }
  default: break;
}
                                                      if (__yo_effect_escaped) {
                                                        // Drop local variables before early return
switch ((_file____User_temp_13362).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13362).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                        return;
                                                      }
                                                      if (_file____User_temp_13364) {
                                                        { // begin block
                                                          __yo_t10 _file____User_temp_13678 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"", .len = 0 });
                                                          __yo_effect_escaped = 0;
                                                          __yo_t9 _file____User_temp_13679 = yo_id_9846((__yo_t10)(_file____User_temp_13678));
                                                          if (__yo_effect_escaped) {
                                                            // Drop local variables before early return
switch ((_file____User_temp_13678).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13678).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                            return;
                                                          }
                                                          __yo_t9 result = _file____User_temp_13679;
                                                          switch ((result).tag) {
                                                          case __YO_T9_NONE: {
                                                            __yo_effect_escaped = 0;
                                                            yo_id_5002_str_id_str_rtparam0_bool_rtparam1_comptime_str_ret_unit((bool)(true), (__yo_str)((__yo_str){ .ptr = (const uint8_t*)"None for empty", .len = 14 }));
                                                            if (__yo_effect_escaped) {
                                                              // Drop local variables before early return
switch ((_file____User_temp_13678).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13678).data.Some.value));
    break;
  }
  default: break;
}
switch ((result).tag) {
  case __YO_T9_SOME: {
switch (((result).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((result).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                              return;
                                                            }
                                                            break;
                                                          }
                                                          case __YO_T9_SOME: {
                                                            __yo_effect_escaped = 0;
                                                            yo_id_5002_str_id_str_rtparam0_bool_rtparam1_comptime_str_ret_unit((bool)(false), (__yo_str)((__yo_str){ .ptr = (const uint8_t*)"expected None for empty input", .len = 29 }));
                                                            if (__yo_effect_escaped) {
                                                              // Drop local variables before early return
switch ((_file____User_temp_13678).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13678).data.Some.value));
    break;
  }
  default: break;
}
switch ((result).tag) {
  case __YO_T9_SOME: {
switch (((result).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((result).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                              return;
                                                            }
                                                            break;
                                                          }
                                                          }
switch ((_file____User_temp_13678).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13678).data.Some.value));
    break;
  }
  default: break;
}
switch ((result).tag) {
  case __YO_T9_SOME: {
switch (((result).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((result).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                        } // end begin block
                                                      }
                                                      else {
                                                        __yo_str __yo_ref_spill_29 = (__yo_str){ .ptr = (const uint8_t*)"26", .len = 2 };
                                                        __yo_t10 _file____User_temp_13366 = yo_id_4873((&(__yo_ref_spill_29)));
                                                        __yo_effect_escaped = 0;
                                                        bool _file____User_temp_13368 = yo_id_4111((__yo_t10)(__yo_test_idx), (__yo_t10)(_file____User_temp_13366));
switch ((_file____User_temp_13366).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13366).data.Some.value));
    break;
  }
  default: break;
}
                                                        if (__yo_effect_escaped) {
                                                          // Drop local variables before early return
switch ((_file____User_temp_13366).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13366).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                          return;
                                                        }
                                                        if (_file____User_temp_13368) {
                                                          { // begin block
                                                            __yo_t10 _file____User_temp_13692 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"abc123\trefs/tags/v1.0.0\n", .len = 24 });
                                                            __yo_t10 _file____User_temp_13693 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"def456\trefs/tags/v2.1.0\n", .len = 24 });
                                                            __yo_t10 _file____User_temp_13694 = yo_id_3607(_file____User_temp_13692, _file____User_temp_13693);
                                                            __yo_t10 _file____User_temp_13695 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"ghi789\trefs/tags/v1.5.3\n", .len = 24 });
                                                            __yo_t10 _file____User_temp_13696 = yo_id_3607(_file____User_temp_13694, _file____User_temp_13695);
                                                            __yo_t10 raw = _file____User_temp_13696;
                                                            __yo_effect_escaped = 0;
                                                            __yo_t9 _file____User_temp_13697 = yo_id_9846((__yo_t10)(raw));
                                                            if (__yo_effect_escaped) {
                                                              // Drop local variables before early return
switch ((_file____User_temp_13692).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13692).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13693).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13693).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13694).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13694).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13695).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13695).data.Some.value));
    break;
  }
  default: break;
}
switch ((raw).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((raw).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                              return;
                                                            }
                                                            __yo_t9 result = _file____User_temp_13697;
                                                            switch ((result).tag) {
                                                            case __YO_T9_NONE: {
                                                              __yo_effect_escaped = 0;
                                                              yo_id_5002_str_id_str_rtparam0_bool_rtparam1_comptime_str_ret_unit((bool)(false), (__yo_str)((__yo_str){ .ptr = (const uint8_t*)"expected Some", .len = 13 }));
                                                              if (__yo_effect_escaped) {
                                                                // Drop local variables before early return
switch ((_file____User_temp_13692).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13692).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13693).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13693).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13694).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13694).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13695).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13695).data.Some.value));
    break;
  }
  default: break;
}
switch ((raw).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((raw).data.Some.value));
    break;
  }
  default: break;
}
switch ((result).tag) {
  case __YO_T9_SOME: {
switch (((result).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((result).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                                return;
                                                              }
                                                              break;
                                                            }
                                                            case __YO_T9_SOME: {
                                                              __yo_t10 tag = result.data.Some.value;
                                                              __yo_t10 _file____User_temp_13701 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"v2.1.0", .len = 6 });
                                                              __yo_effect_escaped = 0;
                                                              bool _file____User_temp_13702 = yo_id_4111((__yo_t10)(tag), (__yo_t10)(_file____User_temp_13701));
                                                              if (__yo_effect_escaped) {
                                                                // Drop local variables before early return
switch ((_file____User_temp_13692).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13692).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13693).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13693).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13694).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13694).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13695).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13695).data.Some.value));
    break;
  }
  default: break;
}
switch ((raw).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((raw).data.Some.value));
    break;
  }
  default: break;
}
switch ((result).tag) {
  case __YO_T9_SOME: {
switch (((result).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((result).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                                return;
                                                              }
                                                              __yo_effect_escaped = 0;
                                                              yo_id_5002_str_id_str_rtparam0_bool_rtparam1_comptime_str_ret_unit((bool)(_file____User_temp_13702), (__yo_str)((__yo_str){ .ptr = (const uint8_t*)"highest tag is v2.1.0", .len = 21 }));
switch ((_file____User_temp_13701).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13701).data.Some.value));
    break;
  }
  default: break;
}
                                                              if (__yo_effect_escaped) {
                                                                // Drop local variables before early return
switch ((_file____User_temp_13692).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13692).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13693).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13693).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13694).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13694).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13695).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13695).data.Some.value));
    break;
  }
  default: break;
}
switch ((raw).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((raw).data.Some.value));
    break;
  }
  default: break;
}
switch ((result).tag) {
  case __YO_T9_SOME: {
switch (((result).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((result).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                                return;
                                                              }
                                                              break;
                                                            }
                                                            }
switch ((_file____User_temp_13692).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13692).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13693).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13693).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13694).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13694).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13695).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13695).data.Some.value));
    break;
  }
  default: break;
}
switch ((raw).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((raw).data.Some.value));
    break;
  }
  default: break;
}
switch ((result).tag) {
  case __YO_T9_SOME: {
switch (((result).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((result).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                          } // end begin block
                                                        }
                                                        else {
                                                          __yo_str __yo_ref_spill_30 = (__yo_str){ .ptr = (const uint8_t*)"27", .len = 2 };
                                                          __yo_t10 _file____User_temp_13370 = yo_id_4873((&(__yo_ref_spill_30)));
                                                          __yo_effect_escaped = 0;
                                                          bool _file____User_temp_13372 = yo_id_4111((__yo_t10)(__yo_test_idx), (__yo_t10)(_file____User_temp_13370));
switch ((_file____User_temp_13370).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13370).data.Some.value));
    break;
  }
  default: break;
}
                                                          if (__yo_effect_escaped) {
                                                            // Drop local variables before early return
switch ((_file____User_temp_13370).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13370).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                            return;
                                                          }
                                                          if (_file____User_temp_13372) {
                                                            { // begin block
                                                              __yo_t10 _file____User_temp_13709 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"abc123\trefs/heads/main\n", .len = 23 });
                                                              __yo_t10 _file____User_temp_13710 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"def456\trefs/tags/v0.3.1\n", .len = 24 });
                                                              __yo_t10 _file____User_temp_13711 = yo_id_3607(_file____User_temp_13709, _file____User_temp_13710);
                                                              __yo_t10 raw = _file____User_temp_13711;
                                                              __yo_effect_escaped = 0;
                                                              __yo_t9 _file____User_temp_13712 = yo_id_9846((__yo_t10)(raw));
                                                              if (__yo_effect_escaped) {
                                                                // Drop local variables before early return
switch ((_file____User_temp_13709).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13709).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13710).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13710).data.Some.value));
    break;
  }
  default: break;
}
switch ((raw).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((raw).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                                return;
                                                              }
                                                              __yo_t9 result = _file____User_temp_13712;
                                                              switch ((result).tag) {
                                                              case __YO_T9_NONE: {
                                                                __yo_effect_escaped = 0;
                                                                yo_id_5002_str_id_str_rtparam0_bool_rtparam1_comptime_str_ret_unit((bool)(false), (__yo_str)((__yo_str){ .ptr = (const uint8_t*)"expected Some", .len = 13 }));
                                                                if (__yo_effect_escaped) {
                                                                  // Drop local variables before early return
switch ((_file____User_temp_13709).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13709).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13710).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13710).data.Some.value));
    break;
  }
  default: break;
}
switch ((raw).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((raw).data.Some.value));
    break;
  }
  default: break;
}
switch ((result).tag) {
  case __YO_T9_SOME: {
switch (((result).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((result).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                                  return;
                                                                }
                                                                break;
                                                              }
                                                              case __YO_T9_SOME: {
                                                                __yo_t10 tag = result.data.Some.value;
                                                                __yo_t10 _file____User_temp_13716 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"v0.3.1", .len = 6 });
                                                                __yo_effect_escaped = 0;
                                                                bool _file____User_temp_13717 = yo_id_4111((__yo_t10)(tag), (__yo_t10)(_file____User_temp_13716));
                                                                if (__yo_effect_escaped) {
                                                                  // Drop local variables before early return
switch ((_file____User_temp_13709).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13709).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13710).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13710).data.Some.value));
    break;
  }
  default: break;
}
switch ((raw).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((raw).data.Some.value));
    break;
  }
  default: break;
}
switch ((result).tag) {
  case __YO_T9_SOME: {
switch (((result).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((result).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                                  return;
                                                                }
                                                                __yo_effect_escaped = 0;
                                                                yo_id_5002_str_id_str_rtparam0_bool_rtparam1_comptime_str_ret_unit((bool)(_file____User_temp_13717), (__yo_str)((__yo_str){ .ptr = (const uint8_t*)"picks the tag", .len = 13 }));
switch ((_file____User_temp_13716).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13716).data.Some.value));
    break;
  }
  default: break;
}
                                                                if (__yo_effect_escaped) {
                                                                  // Drop local variables before early return
switch ((_file____User_temp_13709).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13709).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13710).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13710).data.Some.value));
    break;
  }
  default: break;
}
switch ((raw).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((raw).data.Some.value));
    break;
  }
  default: break;
}
switch ((result).tag) {
  case __YO_T9_SOME: {
switch (((result).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((result).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                                  return;
                                                                }
                                                                break;
                                                              }
                                                              }
switch ((_file____User_temp_13709).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13709).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13710).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13710).data.Some.value));
    break;
  }
  default: break;
}
switch ((raw).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((raw).data.Some.value));
    break;
  }
  default: break;
}
switch ((result).tag) {
  case __YO_T9_SOME: {
switch (((result).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((result).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                            } // end begin block
                                                          }
                                                          else {
                                                            __yo_str __yo_ref_spill_31 = (__yo_str){ .ptr = (const uint8_t*)"28", .len = 2 };
                                                            __yo_t10 _file____User_temp_13374 = yo_id_4873((&(__yo_ref_spill_31)));
                                                            __yo_effect_escaped = 0;
                                                            bool _file____User_temp_13376 = yo_id_4111((__yo_t10)(__yo_test_idx), (__yo_t10)(_file____User_temp_13374));
switch ((_file____User_temp_13374).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13374).data.Some.value));
    break;
  }
  default: break;
}
                                                            if (__yo_effect_escaped) {
                                                              // Drop local variables before early return
switch ((_file____User_temp_13374).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13374).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                              return;
                                                            }
                                                            if (_file____User_temp_13376) {
                                                              { // begin block
                                                                __yo_t10 _file____User_temp_13723 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"user/myrepo", .len = 11 });
                                                                __yo_effect_escaped = 0;
                                                                __yo_t35 _file____User_temp_13724 = yo_id_9927((__yo_t10)(_file____User_temp_13723));
                                                                if (__yo_effect_escaped) {
                                                                  // Drop local variables before early return
switch ((_file____User_temp_13723).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13723).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                                  return;
                                                                }
                                                                __yo_t35 result = _file____User_temp_13724;
                                                                switch ((result).tag) {
                                                                case __YO_T35_ERR: {
                                                                  __yo_t10 msg = result.data.Err.error;
                                                                  __yo_effect_escaped = 0;
                                                                  yo_id_4582((bool)(false), (__yo_t10)(msg));
                                                                  if (__yo_effect_escaped) {
                                                                    // Drop local variables before early return
switch ((_file____User_temp_13723).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13723).data.Some.value));
    break;
  }
  default: break;
}
switch ((result).tag) {
  case __YO_T35_OK: {
switch (((result).data.Ok.value).tag) {
  case __YO_T34_GIT: {
switch ((((result).data.Ok.value).data.Git.name).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Git.name).data.Some.value));
    break;
  }
  default: break;
}
switch ((((result).data.Ok.value).data.Git.url).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Git.url).data.Some.value));
    break;
  }
  default: break;
}
switch ((((result).data.Ok.value).data.Git.pinned_ref).tag) {
  case __YO_T9_SOME: {
switch (((((result).data.Ok.value).data.Git.pinned_ref).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((((result).data.Ok.value).data.Git.pinned_ref).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
    break;
  }
  case __YO_T34_PATH: {
switch ((((result).data.Ok.value).data.Path.name).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Path.name).data.Some.value));
    break;
  }
  default: break;
}
switch ((((result).data.Ok.value).data.Path.rel_path).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Path.rel_path).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
    break;
  }
  case __YO_T35_ERR: {
switch (((result).data.Err.error).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((result).data.Err.error).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                                    return;
                                                                  }
                                                                  break;
                                                                }
                                                                case __YO_T35_OK: {
                                                                  __yo_t34 pkg = result.data.Ok.value;
                                                                  switch ((pkg).tag) {
                                                                  case __YO_T34_PATH: {
                                                                    __yo_effect_escaped = 0;
                                                                    yo_id_5002_str_id_str_rtparam0_bool_rtparam1_comptime_str_ret_unit((bool)(false), (__yo_str)((__yo_str){ .ptr = (const uint8_t*)"expected Git", .len = 12 }));
                                                                    if (__yo_effect_escaped) {
                                                                      // Drop local variables before early return
switch ((_file____User_temp_13723).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13723).data.Some.value));
    break;
  }
  default: break;
}
switch ((result).tag) {
  case __YO_T35_OK: {
switch (((result).data.Ok.value).tag) {
  case __YO_T34_GIT: {
switch ((((result).data.Ok.value).data.Git.name).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Git.name).data.Some.value));
    break;
  }
  default: break;
}
switch ((((result).data.Ok.value).data.Git.url).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Git.url).data.Some.value));
    break;
  }
  default: break;
}
switch ((((result).data.Ok.value).data.Git.pinned_ref).tag) {
  case __YO_T9_SOME: {
switch (((((result).data.Ok.value).data.Git.pinned_ref).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((((result).data.Ok.value).data.Git.pinned_ref).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
    break;
  }
  case __YO_T34_PATH: {
switch ((((result).data.Ok.value).data.Path.name).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Path.name).data.Some.value));
    break;
  }
  default: break;
}
switch ((((result).data.Ok.value).data.Path.rel_path).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Path.rel_path).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
    break;
  }
  case __YO_T35_ERR: {
switch (((result).data.Err.error).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((result).data.Err.error).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                                      return;
                                                                    }
                                                                    break;
                                                                  }
                                                                  case __YO_T34_GIT: {
                                                                    __yo_t10 name = pkg.data.Git.name;
                                                                    __yo_t10 url = pkg.data.Git.url;
                                                                    __yo_t9 pinned_ref = pkg.data.Git.pinned_ref;
                                                                    __yo_t10 _file____User_temp_13730 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"myrepo", .len = 6 });
                                                                    __yo_effect_escaped = 0;
                                                                    bool _file____User_temp_13731 = yo_id_4111((__yo_t10)(name), (__yo_t10)(_file____User_temp_13730));
                                                                    if (__yo_effect_escaped) {
                                                                      // Drop local variables before early return
switch ((_file____User_temp_13730).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13730).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13723).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13723).data.Some.value));
    break;
  }
  default: break;
}
switch ((result).tag) {
  case __YO_T35_OK: {
switch (((result).data.Ok.value).tag) {
  case __YO_T34_GIT: {
switch ((((result).data.Ok.value).data.Git.name).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Git.name).data.Some.value));
    break;
  }
  default: break;
}
switch ((((result).data.Ok.value).data.Git.url).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Git.url).data.Some.value));
    break;
  }
  default: break;
}
switch ((((result).data.Ok.value).data.Git.pinned_ref).tag) {
  case __YO_T9_SOME: {
switch (((((result).data.Ok.value).data.Git.pinned_ref).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((((result).data.Ok.value).data.Git.pinned_ref).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
    break;
  }
  case __YO_T34_PATH: {
switch ((((result).data.Ok.value).data.Path.name).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Path.name).data.Some.value));
    break;
  }
  default: break;
}
switch ((((result).data.Ok.value).data.Path.rel_path).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Path.rel_path).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
    break;
  }
  case __YO_T35_ERR: {
switch (((result).data.Err.error).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((result).data.Err.error).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                                      return;
                                                                    }
                                                                    __yo_effect_escaped = 0;
                                                                    yo_id_5002_str_id_str_rtparam0_bool_rtparam1_comptime_str_ret_unit((bool)(_file____User_temp_13731), (__yo_str)((__yo_str){ .ptr = (const uint8_t*)"name is myrepo", .len = 14 }));
                                                                    if (__yo_effect_escaped) {
                                                                      // Drop local variables before early return
switch ((_file____User_temp_13730).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13730).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13723).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13723).data.Some.value));
    break;
  }
  default: break;
}
switch ((result).tag) {
  case __YO_T35_OK: {
switch (((result).data.Ok.value).tag) {
  case __YO_T34_GIT: {
switch ((((result).data.Ok.value).data.Git.name).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Git.name).data.Some.value));
    break;
  }
  default: break;
}
switch ((((result).data.Ok.value).data.Git.url).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Git.url).data.Some.value));
    break;
  }
  default: break;
}
switch ((((result).data.Ok.value).data.Git.pinned_ref).tag) {
  case __YO_T9_SOME: {
switch (((((result).data.Ok.value).data.Git.pinned_ref).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((((result).data.Ok.value).data.Git.pinned_ref).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
    break;
  }
  case __YO_T34_PATH: {
switch ((((result).data.Ok.value).data.Path.name).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Path.name).data.Some.value));
    break;
  }
  default: break;
}
switch ((((result).data.Ok.value).data.Path.rel_path).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Path.rel_path).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
    break;
  }
  case __YO_T35_ERR: {
switch (((result).data.Err.error).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((result).data.Err.error).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                                      return;
                                                                    }
                                                                    __yo_t10 _file____User_temp_13734 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"https://github.com/user/myrepo.git", .len = 34 });
                                                                    __yo_effect_escaped = 0;
                                                                    bool _file____User_temp_13735 = yo_id_4111((__yo_t10)(url), (__yo_t10)(_file____User_temp_13734));
                                                                    if (__yo_effect_escaped) {
                                                                      // Drop local variables before early return
switch ((_file____User_temp_13730).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13730).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13734).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13734).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13723).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13723).data.Some.value));
    break;
  }
  default: break;
}
switch ((result).tag) {
  case __YO_T35_OK: {
switch (((result).data.Ok.value).tag) {
  case __YO_T34_GIT: {
switch ((((result).data.Ok.value).data.Git.name).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Git.name).data.Some.value));
    break;
  }
  default: break;
}
switch ((((result).data.Ok.value).data.Git.url).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Git.url).data.Some.value));
    break;
  }
  default: break;
}
switch ((((result).data.Ok.value).data.Git.pinned_ref).tag) {
  case __YO_T9_SOME: {
switch (((((result).data.Ok.value).data.Git.pinned_ref).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((((result).data.Ok.value).data.Git.pinned_ref).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
    break;
  }
  case __YO_T34_PATH: {
switch ((((result).data.Ok.value).data.Path.name).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Path.name).data.Some.value));
    break;
  }
  default: break;
}
switch ((((result).data.Ok.value).data.Path.rel_path).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Path.rel_path).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
    break;
  }
  case __YO_T35_ERR: {
switch (((result).data.Err.error).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((result).data.Err.error).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                                      return;
                                                                    }
                                                                    __yo_effect_escaped = 0;
                                                                    yo_id_5002_str_id_str_rtparam0_bool_rtparam1_comptime_str_ret_unit((bool)(_file____User_temp_13735), (__yo_str)((__yo_str){ .ptr = (const uint8_t*)"url is github https", .len = 19 }));
                                                                    if (__yo_effect_escaped) {
                                                                      // Drop local variables before early return
switch ((_file____User_temp_13730).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13730).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13734).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13734).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13723).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13723).data.Some.value));
    break;
  }
  default: break;
}
switch ((result).tag) {
  case __YO_T35_OK: {
switch (((result).data.Ok.value).tag) {
  case __YO_T34_GIT: {
switch ((((result).data.Ok.value).data.Git.name).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Git.name).data.Some.value));
    break;
  }
  default: break;
}
switch ((((result).data.Ok.value).data.Git.url).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Git.url).data.Some.value));
    break;
  }
  default: break;
}
switch ((((result).data.Ok.value).data.Git.pinned_ref).tag) {
  case __YO_T9_SOME: {
switch (((((result).data.Ok.value).data.Git.pinned_ref).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((((result).data.Ok.value).data.Git.pinned_ref).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
    break;
  }
  case __YO_T34_PATH: {
switch ((((result).data.Ok.value).data.Path.name).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Path.name).data.Some.value));
    break;
  }
  default: break;
}
switch ((((result).data.Ok.value).data.Path.rel_path).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Path.rel_path).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
    break;
  }
  case __YO_T35_ERR: {
switch (((result).data.Err.error).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((result).data.Err.error).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                                      return;
                                                                    }
                                                                    switch ((pinned_ref).tag) {
                                                                    case __YO_T9_NONE: {
                                                                      __yo_effect_escaped = 0;
                                                                      yo_id_5002_str_id_str_rtparam0_bool_rtparam1_comptime_str_ret_unit((bool)(true), (__yo_str)((__yo_str){ .ptr = (const uint8_t*)"no pinned ref", .len = 13 }));
                                                                      if (__yo_effect_escaped) {
                                                                        // Drop local variables before early return
switch ((_file____User_temp_13730).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13730).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13734).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13734).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13723).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13723).data.Some.value));
    break;
  }
  default: break;
}
switch ((result).tag) {
  case __YO_T35_OK: {
switch (((result).data.Ok.value).tag) {
  case __YO_T34_GIT: {
switch ((((result).data.Ok.value).data.Git.name).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Git.name).data.Some.value));
    break;
  }
  default: break;
}
switch ((((result).data.Ok.value).data.Git.url).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Git.url).data.Some.value));
    break;
  }
  default: break;
}
switch ((((result).data.Ok.value).data.Git.pinned_ref).tag) {
  case __YO_T9_SOME: {
switch (((((result).data.Ok.value).data.Git.pinned_ref).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((((result).data.Ok.value).data.Git.pinned_ref).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
    break;
  }
  case __YO_T34_PATH: {
switch ((((result).data.Ok.value).data.Path.name).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Path.name).data.Some.value));
    break;
  }
  default: break;
}
switch ((((result).data.Ok.value).data.Path.rel_path).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Path.rel_path).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
    break;
  }
  case __YO_T35_ERR: {
switch (((result).data.Err.error).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((result).data.Err.error).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                                        return;
                                                                      }
                                                                      break;
                                                                    }
                                                                    case __YO_T9_SOME: {
                                                                      __yo_effect_escaped = 0;
                                                                      yo_id_5002_str_id_str_rtparam0_bool_rtparam1_comptime_str_ret_unit((bool)(false), (__yo_str)((__yo_str){ .ptr = (const uint8_t*)"no ref expected", .len = 15 }));
                                                                      if (__yo_effect_escaped) {
                                                                        // Drop local variables before early return
switch ((_file____User_temp_13730).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13730).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13734).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13734).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13723).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13723).data.Some.value));
    break;
  }
  default: break;
}
switch ((result).tag) {
  case __YO_T35_OK: {
switch (((result).data.Ok.value).tag) {
  case __YO_T34_GIT: {
switch ((((result).data.Ok.value).data.Git.name).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Git.name).data.Some.value));
    break;
  }
  default: break;
}
switch ((((result).data.Ok.value).data.Git.url).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Git.url).data.Some.value));
    break;
  }
  default: break;
}
switch ((((result).data.Ok.value).data.Git.pinned_ref).tag) {
  case __YO_T9_SOME: {
switch (((((result).data.Ok.value).data.Git.pinned_ref).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((((result).data.Ok.value).data.Git.pinned_ref).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
    break;
  }
  case __YO_T34_PATH: {
switch ((((result).data.Ok.value).data.Path.name).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Path.name).data.Some.value));
    break;
  }
  default: break;
}
switch ((((result).data.Ok.value).data.Path.rel_path).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Path.rel_path).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
    break;
  }
  case __YO_T35_ERR: {
switch (((result).data.Err.error).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((result).data.Err.error).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                                        return;
                                                                      }
                                                                      break;
                                                                    }
                                                                    }
switch ((_file____User_temp_13730).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13730).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13734).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13734).data.Some.value));
    break;
  }
  default: break;
}
                                                                    break;
                                                                  }
                                                                  }
                                                                  break;
                                                                }
                                                                }
switch ((_file____User_temp_13723).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13723).data.Some.value));
    break;
  }
  default: break;
}
switch ((result).tag) {
  case __YO_T35_OK: {
switch (((result).data.Ok.value).tag) {
  case __YO_T34_GIT: {
switch ((((result).data.Ok.value).data.Git.name).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Git.name).data.Some.value));
    break;
  }
  default: break;
}
switch ((((result).data.Ok.value).data.Git.url).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Git.url).data.Some.value));
    break;
  }
  default: break;
}
switch ((((result).data.Ok.value).data.Git.pinned_ref).tag) {
  case __YO_T9_SOME: {
switch (((((result).data.Ok.value).data.Git.pinned_ref).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((((result).data.Ok.value).data.Git.pinned_ref).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
    break;
  }
  case __YO_T34_PATH: {
switch ((((result).data.Ok.value).data.Path.name).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Path.name).data.Some.value));
    break;
  }
  default: break;
}
switch ((((result).data.Ok.value).data.Path.rel_path).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Path.rel_path).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
    break;
  }
  case __YO_T35_ERR: {
switch (((result).data.Err.error).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((result).data.Err.error).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                              } // end begin block
                                                            }
                                                            else {
                                                              __yo_str __yo_ref_spill_32 = (__yo_str){ .ptr = (const uint8_t*)"29", .len = 2 };
                                                              __yo_t10 _file____User_temp_13378 = yo_id_4873((&(__yo_ref_spill_32)));
                                                              __yo_effect_escaped = 0;
                                                              bool _file____User_temp_13380 = yo_id_4111((__yo_t10)(__yo_test_idx), (__yo_t10)(_file____User_temp_13378));
switch ((_file____User_temp_13378).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13378).data.Some.value));
    break;
  }
  default: break;
}
                                                              if (__yo_effect_escaped) {
                                                                // Drop local variables before early return
switch ((_file____User_temp_13378).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13378).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                                return;
                                                              }
                                                              if (_file____User_temp_13380) {
                                                                { // begin block
                                                                  __yo_t10 _file____User_temp_13748 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"user/myrepo@v1.2.3", .len = 18 });
                                                                  __yo_effect_escaped = 0;
                                                                  __yo_t35 _file____User_temp_13749 = yo_id_9927((__yo_t10)(_file____User_temp_13748));
                                                                  if (__yo_effect_escaped) {
                                                                    // Drop local variables before early return
switch ((_file____User_temp_13748).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13748).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                                    return;
                                                                  }
                                                                  __yo_t35 result = _file____User_temp_13749;
                                                                  switch ((result).tag) {
                                                                  case __YO_T35_ERR: {
                                                                    __yo_t10 msg = result.data.Err.error;
                                                                    __yo_effect_escaped = 0;
                                                                    yo_id_4582((bool)(false), (__yo_t10)(msg));
                                                                    if (__yo_effect_escaped) {
                                                                      // Drop local variables before early return
switch ((_file____User_temp_13748).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13748).data.Some.value));
    break;
  }
  default: break;
}
switch ((result).tag) {
  case __YO_T35_OK: {
switch (((result).data.Ok.value).tag) {
  case __YO_T34_GIT: {
switch ((((result).data.Ok.value).data.Git.name).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Git.name).data.Some.value));
    break;
  }
  default: break;
}
switch ((((result).data.Ok.value).data.Git.url).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Git.url).data.Some.value));
    break;
  }
  default: break;
}
switch ((((result).data.Ok.value).data.Git.pinned_ref).tag) {
  case __YO_T9_SOME: {
switch (((((result).data.Ok.value).data.Git.pinned_ref).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((((result).data.Ok.value).data.Git.pinned_ref).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
    break;
  }
  case __YO_T34_PATH: {
switch ((((result).data.Ok.value).data.Path.name).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Path.name).data.Some.value));
    break;
  }
  default: break;
}
switch ((((result).data.Ok.value).data.Path.rel_path).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Path.rel_path).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
    break;
  }
  case __YO_T35_ERR: {
switch (((result).data.Err.error).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((result).data.Err.error).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                                      return;
                                                                    }
                                                                    break;
                                                                  }
                                                                  case __YO_T35_OK: {
                                                                    __yo_t34 pkg = result.data.Ok.value;
                                                                    switch ((pkg).tag) {
                                                                    case __YO_T34_PATH: {
                                                                      __yo_effect_escaped = 0;
                                                                      yo_id_5002_str_id_str_rtparam0_bool_rtparam1_comptime_str_ret_unit((bool)(false), (__yo_str)((__yo_str){ .ptr = (const uint8_t*)"expected Git", .len = 12 }));
                                                                      if (__yo_effect_escaped) {
                                                                        // Drop local variables before early return
switch ((_file____User_temp_13748).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13748).data.Some.value));
    break;
  }
  default: break;
}
switch ((result).tag) {
  case __YO_T35_OK: {
switch (((result).data.Ok.value).tag) {
  case __YO_T34_GIT: {
switch ((((result).data.Ok.value).data.Git.name).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Git.name).data.Some.value));
    break;
  }
  default: break;
}
switch ((((result).data.Ok.value).data.Git.url).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Git.url).data.Some.value));
    break;
  }
  default: break;
}
switch ((((result).data.Ok.value).data.Git.pinned_ref).tag) {
  case __YO_T9_SOME: {
switch (((((result).data.Ok.value).data.Git.pinned_ref).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((((result).data.Ok.value).data.Git.pinned_ref).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
    break;
  }
  case __YO_T34_PATH: {
switch ((((result).data.Ok.value).data.Path.name).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Path.name).data.Some.value));
    break;
  }
  default: break;
}
switch ((((result).data.Ok.value).data.Path.rel_path).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Path.rel_path).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
    break;
  }
  case __YO_T35_ERR: {
switch (((result).data.Err.error).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((result).data.Err.error).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                                        return;
                                                                      }
                                                                      break;
                                                                    }
                                                                    case __YO_T34_GIT: {
                                                                      __yo_t10 name = pkg.data.Git.name;
                                                                      __yo_t10 url = pkg.data.Git.url;
                                                                      __yo_t9 pinned_ref = pkg.data.Git.pinned_ref;
                                                                      __yo_t10 _file____User_temp_13755 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"myrepo", .len = 6 });
                                                                      __yo_effect_escaped = 0;
                                                                      bool _file____User_temp_13756 = yo_id_4111((__yo_t10)(name), (__yo_t10)(_file____User_temp_13755));
                                                                      if (__yo_effect_escaped) {
                                                                        // Drop local variables before early return
switch ((_file____User_temp_13755).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13755).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13748).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13748).data.Some.value));
    break;
  }
  default: break;
}
switch ((result).tag) {
  case __YO_T35_OK: {
switch (((result).data.Ok.value).tag) {
  case __YO_T34_GIT: {
switch ((((result).data.Ok.value).data.Git.name).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Git.name).data.Some.value));
    break;
  }
  default: break;
}
switch ((((result).data.Ok.value).data.Git.url).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Git.url).data.Some.value));
    break;
  }
  default: break;
}
switch ((((result).data.Ok.value).data.Git.pinned_ref).tag) {
  case __YO_T9_SOME: {
switch (((((result).data.Ok.value).data.Git.pinned_ref).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((((result).data.Ok.value).data.Git.pinned_ref).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
    break;
  }
  case __YO_T34_PATH: {
switch ((((result).data.Ok.value).data.Path.name).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Path.name).data.Some.value));
    break;
  }
  default: break;
}
switch ((((result).data.Ok.value).data.Path.rel_path).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Path.rel_path).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
    break;
  }
  case __YO_T35_ERR: {
switch (((result).data.Err.error).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((result).data.Err.error).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                                        return;
                                                                      }
                                                                      __yo_effect_escaped = 0;
                                                                      yo_id_5002_str_id_str_rtparam0_bool_rtparam1_comptime_str_ret_unit((bool)(_file____User_temp_13756), (__yo_str)((__yo_str){ .ptr = (const uint8_t*)"name is myrepo", .len = 14 }));
                                                                      if (__yo_effect_escaped) {
                                                                        // Drop local variables before early return
switch ((_file____User_temp_13755).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13755).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13748).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13748).data.Some.value));
    break;
  }
  default: break;
}
switch ((result).tag) {
  case __YO_T35_OK: {
switch (((result).data.Ok.value).tag) {
  case __YO_T34_GIT: {
switch ((((result).data.Ok.value).data.Git.name).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Git.name).data.Some.value));
    break;
  }
  default: break;
}
switch ((((result).data.Ok.value).data.Git.url).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Git.url).data.Some.value));
    break;
  }
  default: break;
}
switch ((((result).data.Ok.value).data.Git.pinned_ref).tag) {
  case __YO_T9_SOME: {
switch (((((result).data.Ok.value).data.Git.pinned_ref).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((((result).data.Ok.value).data.Git.pinned_ref).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
    break;
  }
  case __YO_T34_PATH: {
switch ((((result).data.Ok.value).data.Path.name).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Path.name).data.Some.value));
    break;
  }
  default: break;
}
switch ((((result).data.Ok.value).data.Path.rel_path).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Path.rel_path).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
    break;
  }
  case __YO_T35_ERR: {
switch (((result).data.Err.error).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((result).data.Err.error).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                                        return;
                                                                      }
                                                                      switch ((pinned_ref).tag) {
                                                                      case __YO_T9_NONE: {
                                                                        __yo_effect_escaped = 0;
                                                                        yo_id_5002_str_id_str_rtparam0_bool_rtparam1_comptime_str_ret_unit((bool)(false), (__yo_str)((__yo_str){ .ptr = (const uint8_t*)"expected pinned ref", .len = 19 }));
                                                                        if (__yo_effect_escaped) {
                                                                          // Drop local variables before early return
switch ((_file____User_temp_13755).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13755).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13748).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13748).data.Some.value));
    break;
  }
  default: break;
}
switch ((result).tag) {
  case __YO_T35_OK: {
switch (((result).data.Ok.value).tag) {
  case __YO_T34_GIT: {
switch ((((result).data.Ok.value).data.Git.name).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Git.name).data.Some.value));
    break;
  }
  default: break;
}
switch ((((result).data.Ok.value).data.Git.url).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Git.url).data.Some.value));
    break;
  }
  default: break;
}
switch ((((result).data.Ok.value).data.Git.pinned_ref).tag) {
  case __YO_T9_SOME: {
switch (((((result).data.Ok.value).data.Git.pinned_ref).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((((result).data.Ok.value).data.Git.pinned_ref).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
    break;
  }
  case __YO_T34_PATH: {
switch ((((result).data.Ok.value).data.Path.name).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Path.name).data.Some.value));
    break;
  }
  default: break;
}
switch ((((result).data.Ok.value).data.Path.rel_path).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Path.rel_path).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
    break;
  }
  case __YO_T35_ERR: {
switch (((result).data.Err.error).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((result).data.Err.error).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                                          return;
                                                                        }
                                                                        break;
                                                                      }
                                                                      case __YO_T9_SOME: {
                                                                        __yo_t10 ref = pinned_ref.data.Some.value;
                                                                        __yo_t10 _file____User_temp_13761 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"v1.2.3", .len = 6 });
                                                                        __yo_effect_escaped = 0;
                                                                        bool _file____User_temp_13762 = yo_id_4111((__yo_t10)(ref), (__yo_t10)(_file____User_temp_13761));
                                                                        if (__yo_effect_escaped) {
                                                                          // Drop local variables before early return
switch ((_file____User_temp_13755).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13755).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13748).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13748).data.Some.value));
    break;
  }
  default: break;
}
switch ((result).tag) {
  case __YO_T35_OK: {
switch (((result).data.Ok.value).tag) {
  case __YO_T34_GIT: {
switch ((((result).data.Ok.value).data.Git.name).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Git.name).data.Some.value));
    break;
  }
  default: break;
}
switch ((((result).data.Ok.value).data.Git.url).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Git.url).data.Some.value));
    break;
  }
  default: break;
}
switch ((((result).data.Ok.value).data.Git.pinned_ref).tag) {
  case __YO_T9_SOME: {
switch (((((result).data.Ok.value).data.Git.pinned_ref).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((((result).data.Ok.value).data.Git.pinned_ref).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
    break;
  }
  case __YO_T34_PATH: {
switch ((((result).data.Ok.value).data.Path.name).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Path.name).data.Some.value));
    break;
  }
  default: break;
}
switch ((((result).data.Ok.value).data.Path.rel_path).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Path.rel_path).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
    break;
  }
  case __YO_T35_ERR: {
switch (((result).data.Err.error).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((result).data.Err.error).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                                          return;
                                                                        }
                                                                        __yo_effect_escaped = 0;
                                                                        yo_id_5002_str_id_str_rtparam0_bool_rtparam1_comptime_str_ret_unit((bool)(_file____User_temp_13762), (__yo_str)((__yo_str){ .ptr = (const uint8_t*)"pinned ref is v1.2.3", .len = 20 }));
switch ((_file____User_temp_13761).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13761).data.Some.value));
    break;
  }
  default: break;
}
                                                                        if (__yo_effect_escaped) {
                                                                          // Drop local variables before early return
switch ((_file____User_temp_13755).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13755).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13748).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13748).data.Some.value));
    break;
  }
  default: break;
}
switch ((result).tag) {
  case __YO_T35_OK: {
switch (((result).data.Ok.value).tag) {
  case __YO_T34_GIT: {
switch ((((result).data.Ok.value).data.Git.name).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Git.name).data.Some.value));
    break;
  }
  default: break;
}
switch ((((result).data.Ok.value).data.Git.url).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Git.url).data.Some.value));
    break;
  }
  default: break;
}
switch ((((result).data.Ok.value).data.Git.pinned_ref).tag) {
  case __YO_T9_SOME: {
switch (((((result).data.Ok.value).data.Git.pinned_ref).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((((result).data.Ok.value).data.Git.pinned_ref).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
    break;
  }
  case __YO_T34_PATH: {
switch ((((result).data.Ok.value).data.Path.name).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Path.name).data.Some.value));
    break;
  }
  default: break;
}
switch ((((result).data.Ok.value).data.Path.rel_path).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Path.rel_path).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
    break;
  }
  case __YO_T35_ERR: {
switch (((result).data.Err.error).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((result).data.Err.error).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                                          return;
                                                                        }
                                                                        break;
                                                                      }
                                                                      }
switch ((_file____User_temp_13755).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13755).data.Some.value));
    break;
  }
  default: break;
}
                                                                      break;
                                                                    }
                                                                    }
                                                                    break;
                                                                  }
                                                                  }
switch ((_file____User_temp_13748).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13748).data.Some.value));
    break;
  }
  default: break;
}
switch ((result).tag) {
  case __YO_T35_OK: {
switch (((result).data.Ok.value).tag) {
  case __YO_T34_GIT: {
switch ((((result).data.Ok.value).data.Git.name).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Git.name).data.Some.value));
    break;
  }
  default: break;
}
switch ((((result).data.Ok.value).data.Git.url).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Git.url).data.Some.value));
    break;
  }
  default: break;
}
switch ((((result).data.Ok.value).data.Git.pinned_ref).tag) {
  case __YO_T9_SOME: {
switch (((((result).data.Ok.value).data.Git.pinned_ref).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((((result).data.Ok.value).data.Git.pinned_ref).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
    break;
  }
  case __YO_T34_PATH: {
switch ((((result).data.Ok.value).data.Path.name).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Path.name).data.Some.value));
    break;
  }
  default: break;
}
switch ((((result).data.Ok.value).data.Path.rel_path).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Path.rel_path).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
    break;
  }
  case __YO_T35_ERR: {
switch (((result).data.Err.error).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((result).data.Err.error).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                                } // end begin block
                                                              }
                                                              else {
                                                                __yo_str __yo_ref_spill_33 = (__yo_str){ .ptr = (const uint8_t*)"30", .len = 2 };
                                                                __yo_t10 _file____User_temp_13382 = yo_id_4873((&(__yo_ref_spill_33)));
                                                                __yo_effect_escaped = 0;
                                                                bool _file____User_temp_13384 = yo_id_4111((__yo_t10)(__yo_test_idx), (__yo_t10)(_file____User_temp_13382));
switch ((_file____User_temp_13382).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13382).data.Some.value));
    break;
  }
  default: break;
}
                                                                if (__yo_effect_escaped) {
                                                                  // Drop local variables before early return
switch ((_file____User_temp_13382).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13382).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                                  return;
                                                                }
                                                                if (_file____User_temp_13384) {
                                                                  { // begin block
                                                                    __yo_t10 _file____User_temp_13772 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"https://github.com/user/repo.git", .len = 32 });
                                                                    __yo_effect_escaped = 0;
                                                                    __yo_t35 _file____User_temp_13773 = yo_id_9927((__yo_t10)(_file____User_temp_13772));
                                                                    if (__yo_effect_escaped) {
                                                                      // Drop local variables before early return
switch ((_file____User_temp_13772).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13772).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                                      return;
                                                                    }
                                                                    __yo_t35 result = _file____User_temp_13773;
                                                                    switch ((result).tag) {
                                                                    case __YO_T35_ERR: {
                                                                      __yo_t10 msg = result.data.Err.error;
                                                                      __yo_effect_escaped = 0;
                                                                      yo_id_4582((bool)(false), (__yo_t10)(msg));
                                                                      if (__yo_effect_escaped) {
                                                                        // Drop local variables before early return
switch ((_file____User_temp_13772).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13772).data.Some.value));
    break;
  }
  default: break;
}
switch ((result).tag) {
  case __YO_T35_OK: {
switch (((result).data.Ok.value).tag) {
  case __YO_T34_GIT: {
switch ((((result).data.Ok.value).data.Git.name).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Git.name).data.Some.value));
    break;
  }
  default: break;
}
switch ((((result).data.Ok.value).data.Git.url).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Git.url).data.Some.value));
    break;
  }
  default: break;
}
switch ((((result).data.Ok.value).data.Git.pinned_ref).tag) {
  case __YO_T9_SOME: {
switch (((((result).data.Ok.value).data.Git.pinned_ref).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((((result).data.Ok.value).data.Git.pinned_ref).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
    break;
  }
  case __YO_T34_PATH: {
switch ((((result).data.Ok.value).data.Path.name).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Path.name).data.Some.value));
    break;
  }
  default: break;
}
switch ((((result).data.Ok.value).data.Path.rel_path).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Path.rel_path).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
    break;
  }
  case __YO_T35_ERR: {
switch (((result).data.Err.error).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((result).data.Err.error).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                                        return;
                                                                      }
                                                                      break;
                                                                    }
                                                                    case __YO_T35_OK: {
                                                                      __yo_t34 pkg = result.data.Ok.value;
                                                                      switch ((pkg).tag) {
                                                                      case __YO_T34_PATH: {
                                                                        __yo_effect_escaped = 0;
                                                                        yo_id_5002_str_id_str_rtparam0_bool_rtparam1_comptime_str_ret_unit((bool)(false), (__yo_str)((__yo_str){ .ptr = (const uint8_t*)"expected Git", .len = 12 }));
                                                                        if (__yo_effect_escaped) {
                                                                          // Drop local variables before early return
switch ((_file____User_temp_13772).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13772).data.Some.value));
    break;
  }
  default: break;
}
switch ((result).tag) {
  case __YO_T35_OK: {
switch (((result).data.Ok.value).tag) {
  case __YO_T34_GIT: {
switch ((((result).data.Ok.value).data.Git.name).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Git.name).data.Some.value));
    break;
  }
  default: break;
}
switch ((((result).data.Ok.value).data.Git.url).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Git.url).data.Some.value));
    break;
  }
  default: break;
}
switch ((((result).data.Ok.value).data.Git.pinned_ref).tag) {
  case __YO_T9_SOME: {
switch (((((result).data.Ok.value).data.Git.pinned_ref).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((((result).data.Ok.value).data.Git.pinned_ref).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
    break;
  }
  case __YO_T34_PATH: {
switch ((((result).data.Ok.value).data.Path.name).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Path.name).data.Some.value));
    break;
  }
  default: break;
}
switch ((((result).data.Ok.value).data.Path.rel_path).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Path.rel_path).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
    break;
  }
  case __YO_T35_ERR: {
switch (((result).data.Err.error).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((result).data.Err.error).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                                          return;
                                                                        }
                                                                        break;
                                                                      }
                                                                      case __YO_T34_GIT: {
                                                                        __yo_t10 name = pkg.data.Git.name;
                                                                        __yo_t10 url = pkg.data.Git.url;
                                                                        __yo_t10 _file____User_temp_13779 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"repo", .len = 4 });
                                                                        __yo_effect_escaped = 0;
                                                                        bool _file____User_temp_13780 = yo_id_4111((__yo_t10)(name), (__yo_t10)(_file____User_temp_13779));
                                                                        if (__yo_effect_escaped) {
                                                                          // Drop local variables before early return
switch ((_file____User_temp_13779).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13779).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13772).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13772).data.Some.value));
    break;
  }
  default: break;
}
switch ((result).tag) {
  case __YO_T35_OK: {
switch (((result).data.Ok.value).tag) {
  case __YO_T34_GIT: {
switch ((((result).data.Ok.value).data.Git.name).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Git.name).data.Some.value));
    break;
  }
  default: break;
}
switch ((((result).data.Ok.value).data.Git.url).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Git.url).data.Some.value));
    break;
  }
  default: break;
}
switch ((((result).data.Ok.value).data.Git.pinned_ref).tag) {
  case __YO_T9_SOME: {
switch (((((result).data.Ok.value).data.Git.pinned_ref).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((((result).data.Ok.value).data.Git.pinned_ref).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
    break;
  }
  case __YO_T34_PATH: {
switch ((((result).data.Ok.value).data.Path.name).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Path.name).data.Some.value));
    break;
  }
  default: break;
}
switch ((((result).data.Ok.value).data.Path.rel_path).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Path.rel_path).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
    break;
  }
  case __YO_T35_ERR: {
switch (((result).data.Err.error).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((result).data.Err.error).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                                          return;
                                                                        }
                                                                        __yo_effect_escaped = 0;
                                                                        yo_id_5002_str_id_str_rtparam0_bool_rtparam1_comptime_str_ret_unit((bool)(_file____User_temp_13780), (__yo_str)((__yo_str){ .ptr = (const uint8_t*)"name from url", .len = 13 }));
                                                                        if (__yo_effect_escaped) {
                                                                          // Drop local variables before early return
switch ((_file____User_temp_13779).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13779).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13772).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13772).data.Some.value));
    break;
  }
  default: break;
}
switch ((result).tag) {
  case __YO_T35_OK: {
switch (((result).data.Ok.value).tag) {
  case __YO_T34_GIT: {
switch ((((result).data.Ok.value).data.Git.name).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Git.name).data.Some.value));
    break;
  }
  default: break;
}
switch ((((result).data.Ok.value).data.Git.url).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Git.url).data.Some.value));
    break;
  }
  default: break;
}
switch ((((result).data.Ok.value).data.Git.pinned_ref).tag) {
  case __YO_T9_SOME: {
switch (((((result).data.Ok.value).data.Git.pinned_ref).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((((result).data.Ok.value).data.Git.pinned_ref).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
    break;
  }
  case __YO_T34_PATH: {
switch ((((result).data.Ok.value).data.Path.name).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Path.name).data.Some.value));
    break;
  }
  default: break;
}
switch ((((result).data.Ok.value).data.Path.rel_path).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Path.rel_path).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
    break;
  }
  case __YO_T35_ERR: {
switch (((result).data.Err.error).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((result).data.Err.error).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                                          return;
                                                                        }
                                                                        __yo_t10 _file____User_temp_13783 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"https://github.com/user/repo.git", .len = 32 });
                                                                        __yo_effect_escaped = 0;
                                                                        bool _file____User_temp_13784 = yo_id_4111((__yo_t10)(url), (__yo_t10)(_file____User_temp_13783));
                                                                        if (__yo_effect_escaped) {
                                                                          // Drop local variables before early return
switch ((_file____User_temp_13779).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13779).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13783).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13783).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13772).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13772).data.Some.value));
    break;
  }
  default: break;
}
switch ((result).tag) {
  case __YO_T35_OK: {
switch (((result).data.Ok.value).tag) {
  case __YO_T34_GIT: {
switch ((((result).data.Ok.value).data.Git.name).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Git.name).data.Some.value));
    break;
  }
  default: break;
}
switch ((((result).data.Ok.value).data.Git.url).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Git.url).data.Some.value));
    break;
  }
  default: break;
}
switch ((((result).data.Ok.value).data.Git.pinned_ref).tag) {
  case __YO_T9_SOME: {
switch (((((result).data.Ok.value).data.Git.pinned_ref).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((((result).data.Ok.value).data.Git.pinned_ref).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
    break;
  }
  case __YO_T34_PATH: {
switch ((((result).data.Ok.value).data.Path.name).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Path.name).data.Some.value));
    break;
  }
  default: break;
}
switch ((((result).data.Ok.value).data.Path.rel_path).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Path.rel_path).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
    break;
  }
  case __YO_T35_ERR: {
switch (((result).data.Err.error).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((result).data.Err.error).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                                          return;
                                                                        }
                                                                        __yo_effect_escaped = 0;
                                                                        yo_id_5002_str_id_str_rtparam0_bool_rtparam1_comptime_str_ret_unit((bool)(_file____User_temp_13784), (__yo_str)((__yo_str){ .ptr = (const uint8_t*)"url preserved", .len = 13 }));
                                                                        if (__yo_effect_escaped) {
                                                                          // Drop local variables before early return
switch ((_file____User_temp_13779).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13779).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13783).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13783).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13772).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13772).data.Some.value));
    break;
  }
  default: break;
}
switch ((result).tag) {
  case __YO_T35_OK: {
switch (((result).data.Ok.value).tag) {
  case __YO_T34_GIT: {
switch ((((result).data.Ok.value).data.Git.name).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Git.name).data.Some.value));
    break;
  }
  default: break;
}
switch ((((result).data.Ok.value).data.Git.url).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Git.url).data.Some.value));
    break;
  }
  default: break;
}
switch ((((result).data.Ok.value).data.Git.pinned_ref).tag) {
  case __YO_T9_SOME: {
switch (((((result).data.Ok.value).data.Git.pinned_ref).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((((result).data.Ok.value).data.Git.pinned_ref).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
    break;
  }
  case __YO_T34_PATH: {
switch ((((result).data.Ok.value).data.Path.name).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Path.name).data.Some.value));
    break;
  }
  default: break;
}
switch ((((result).data.Ok.value).data.Path.rel_path).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Path.rel_path).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
    break;
  }
  case __YO_T35_ERR: {
switch (((result).data.Err.error).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((result).data.Err.error).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                                          return;
                                                                        }
switch ((_file____User_temp_13779).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13779).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13783).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13783).data.Some.value));
    break;
  }
  default: break;
}
                                                                        break;
                                                                      }
                                                                      }
                                                                      break;
                                                                    }
                                                                    }
switch ((_file____User_temp_13772).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13772).data.Some.value));
    break;
  }
  default: break;
}
switch ((result).tag) {
  case __YO_T35_OK: {
switch (((result).data.Ok.value).tag) {
  case __YO_T34_GIT: {
switch ((((result).data.Ok.value).data.Git.name).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Git.name).data.Some.value));
    break;
  }
  default: break;
}
switch ((((result).data.Ok.value).data.Git.url).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Git.url).data.Some.value));
    break;
  }
  default: break;
}
switch ((((result).data.Ok.value).data.Git.pinned_ref).tag) {
  case __YO_T9_SOME: {
switch (((((result).data.Ok.value).data.Git.pinned_ref).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((((result).data.Ok.value).data.Git.pinned_ref).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
    break;
  }
  case __YO_T34_PATH: {
switch ((((result).data.Ok.value).data.Path.name).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Path.name).data.Some.value));
    break;
  }
  default: break;
}
switch ((((result).data.Ok.value).data.Path.rel_path).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Path.rel_path).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
    break;
  }
  case __YO_T35_ERR: {
switch (((result).data.Err.error).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((result).data.Err.error).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                                  } // end begin block
                                                                }
                                                                else {
                                                                  __yo_str __yo_ref_spill_34 = (__yo_str){ .ptr = (const uint8_t*)"31", .len = 2 };
                                                                  __yo_t10 _file____User_temp_13386 = yo_id_4873((&(__yo_ref_spill_34)));
                                                                  __yo_effect_escaped = 0;
                                                                  bool _file____User_temp_13388 = yo_id_4111((__yo_t10)(__yo_test_idx), (__yo_t10)(_file____User_temp_13386));
switch ((_file____User_temp_13386).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13386).data.Some.value));
    break;
  }
  default: break;
}
                                                                  if (__yo_effect_escaped) {
                                                                    // Drop local variables before early return
switch ((_file____User_temp_13386).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13386).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                                    return;
                                                                  }
                                                                  if (_file____User_temp_13388) {
                                                                    { // begin block
                                                                      __yo_t10 _file____User_temp_13792 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"./my-lib", .len = 8 });
                                                                      __yo_effect_escaped = 0;
                                                                      __yo_t35 _file____User_temp_13793 = yo_id_9927((__yo_t10)(_file____User_temp_13792));
                                                                      if (__yo_effect_escaped) {
                                                                        // Drop local variables before early return
switch ((_file____User_temp_13792).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13792).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                                        return;
                                                                      }
                                                                      __yo_t35 result = _file____User_temp_13793;
                                                                      switch ((result).tag) {
                                                                      case __YO_T35_ERR: {
                                                                        __yo_t10 msg = result.data.Err.error;
                                                                        __yo_effect_escaped = 0;
                                                                        yo_id_4582((bool)(false), (__yo_t10)(msg));
                                                                        if (__yo_effect_escaped) {
                                                                          // Drop local variables before early return
switch ((_file____User_temp_13792).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13792).data.Some.value));
    break;
  }
  default: break;
}
switch ((result).tag) {
  case __YO_T35_OK: {
switch (((result).data.Ok.value).tag) {
  case __YO_T34_GIT: {
switch ((((result).data.Ok.value).data.Git.name).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Git.name).data.Some.value));
    break;
  }
  default: break;
}
switch ((((result).data.Ok.value).data.Git.url).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Git.url).data.Some.value));
    break;
  }
  default: break;
}
switch ((((result).data.Ok.value).data.Git.pinned_ref).tag) {
  case __YO_T9_SOME: {
switch (((((result).data.Ok.value).data.Git.pinned_ref).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((((result).data.Ok.value).data.Git.pinned_ref).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
    break;
  }
  case __YO_T34_PATH: {
switch ((((result).data.Ok.value).data.Path.name).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Path.name).data.Some.value));
    break;
  }
  default: break;
}
switch ((((result).data.Ok.value).data.Path.rel_path).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Path.rel_path).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
    break;
  }
  case __YO_T35_ERR: {
switch (((result).data.Err.error).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((result).data.Err.error).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                                          return;
                                                                        }
                                                                        break;
                                                                      }
                                                                      case __YO_T35_OK: {
                                                                        __yo_t34 pkg = result.data.Ok.value;
                                                                        switch ((pkg).tag) {
                                                                        case __YO_T34_GIT: {
                                                                          __yo_effect_escaped = 0;
                                                                          yo_id_5002_str_id_str_rtparam0_bool_rtparam1_comptime_str_ret_unit((bool)(false), (__yo_str)((__yo_str){ .ptr = (const uint8_t*)"expected Path", .len = 13 }));
                                                                          if (__yo_effect_escaped) {
                                                                            // Drop local variables before early return
switch ((_file____User_temp_13792).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13792).data.Some.value));
    break;
  }
  default: break;
}
switch ((result).tag) {
  case __YO_T35_OK: {
switch (((result).data.Ok.value).tag) {
  case __YO_T34_GIT: {
switch ((((result).data.Ok.value).data.Git.name).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Git.name).data.Some.value));
    break;
  }
  default: break;
}
switch ((((result).data.Ok.value).data.Git.url).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Git.url).data.Some.value));
    break;
  }
  default: break;
}
switch ((((result).data.Ok.value).data.Git.pinned_ref).tag) {
  case __YO_T9_SOME: {
switch (((((result).data.Ok.value).data.Git.pinned_ref).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((((result).data.Ok.value).data.Git.pinned_ref).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
    break;
  }
  case __YO_T34_PATH: {
switch ((((result).data.Ok.value).data.Path.name).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Path.name).data.Some.value));
    break;
  }
  default: break;
}
switch ((((result).data.Ok.value).data.Path.rel_path).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Path.rel_path).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
    break;
  }
  case __YO_T35_ERR: {
switch (((result).data.Err.error).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((result).data.Err.error).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                                            return;
                                                                          }
                                                                          break;
                                                                        }
                                                                        case __YO_T34_PATH: {
                                                                          __yo_t10 name = pkg.data.Path.name;
                                                                          __yo_t10 rel_path = pkg.data.Path.rel_path;
                                                                          __yo_t10 _file____User_temp_13799 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"my-lib", .len = 6 });
                                                                          __yo_effect_escaped = 0;
                                                                          bool _file____User_temp_13800 = yo_id_4111((__yo_t10)(name), (__yo_t10)(_file____User_temp_13799));
                                                                          if (__yo_effect_escaped) {
                                                                            // Drop local variables before early return
switch ((_file____User_temp_13799).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13799).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13792).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13792).data.Some.value));
    break;
  }
  default: break;
}
switch ((result).tag) {
  case __YO_T35_OK: {
switch (((result).data.Ok.value).tag) {
  case __YO_T34_GIT: {
switch ((((result).data.Ok.value).data.Git.name).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Git.name).data.Some.value));
    break;
  }
  default: break;
}
switch ((((result).data.Ok.value).data.Git.url).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Git.url).data.Some.value));
    break;
  }
  default: break;
}
switch ((((result).data.Ok.value).data.Git.pinned_ref).tag) {
  case __YO_T9_SOME: {
switch (((((result).data.Ok.value).data.Git.pinned_ref).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((((result).data.Ok.value).data.Git.pinned_ref).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
    break;
  }
  case __YO_T34_PATH: {
switch ((((result).data.Ok.value).data.Path.name).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Path.name).data.Some.value));
    break;
  }
  default: break;
}
switch ((((result).data.Ok.value).data.Path.rel_path).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Path.rel_path).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
    break;
  }
  case __YO_T35_ERR: {
switch (((result).data.Err.error).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((result).data.Err.error).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                                            return;
                                                                          }
                                                                          __yo_effect_escaped = 0;
                                                                          yo_id_5002_str_id_str_rtparam0_bool_rtparam1_comptime_str_ret_unit((bool)(_file____User_temp_13800), (__yo_str)((__yo_str){ .ptr = (const uint8_t*)"name is my-lib", .len = 14 }));
                                                                          if (__yo_effect_escaped) {
                                                                            // Drop local variables before early return
switch ((_file____User_temp_13799).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13799).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13792).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13792).data.Some.value));
    break;
  }
  default: break;
}
switch ((result).tag) {
  case __YO_T35_OK: {
switch (((result).data.Ok.value).tag) {
  case __YO_T34_GIT: {
switch ((((result).data.Ok.value).data.Git.name).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Git.name).data.Some.value));
    break;
  }
  default: break;
}
switch ((((result).data.Ok.value).data.Git.url).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Git.url).data.Some.value));
    break;
  }
  default: break;
}
switch ((((result).data.Ok.value).data.Git.pinned_ref).tag) {
  case __YO_T9_SOME: {
switch (((((result).data.Ok.value).data.Git.pinned_ref).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((((result).data.Ok.value).data.Git.pinned_ref).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
    break;
  }
  case __YO_T34_PATH: {
switch ((((result).data.Ok.value).data.Path.name).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Path.name).data.Some.value));
    break;
  }
  default: break;
}
switch ((((result).data.Ok.value).data.Path.rel_path).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Path.rel_path).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
    break;
  }
  case __YO_T35_ERR: {
switch (((result).data.Err.error).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((result).data.Err.error).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                                            return;
                                                                          }
                                                                          __yo_t10 _file____User_temp_13803 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"./my-lib", .len = 8 });
                                                                          __yo_effect_escaped = 0;
                                                                          bool _file____User_temp_13804 = yo_id_4111((__yo_t10)(rel_path), (__yo_t10)(_file____User_temp_13803));
                                                                          if (__yo_effect_escaped) {
                                                                            // Drop local variables before early return
switch ((_file____User_temp_13799).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13799).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13803).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13803).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13792).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13792).data.Some.value));
    break;
  }
  default: break;
}
switch ((result).tag) {
  case __YO_T35_OK: {
switch (((result).data.Ok.value).tag) {
  case __YO_T34_GIT: {
switch ((((result).data.Ok.value).data.Git.name).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Git.name).data.Some.value));
    break;
  }
  default: break;
}
switch ((((result).data.Ok.value).data.Git.url).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Git.url).data.Some.value));
    break;
  }
  default: break;
}
switch ((((result).data.Ok.value).data.Git.pinned_ref).tag) {
  case __YO_T9_SOME: {
switch (((((result).data.Ok.value).data.Git.pinned_ref).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((((result).data.Ok.value).data.Git.pinned_ref).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
    break;
  }
  case __YO_T34_PATH: {
switch ((((result).data.Ok.value).data.Path.name).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Path.name).data.Some.value));
    break;
  }
  default: break;
}
switch ((((result).data.Ok.value).data.Path.rel_path).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Path.rel_path).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
    break;
  }
  case __YO_T35_ERR: {
switch (((result).data.Err.error).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((result).data.Err.error).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                                            return;
                                                                          }
                                                                          __yo_effect_escaped = 0;
                                                                          yo_id_5002_str_id_str_rtparam0_bool_rtparam1_comptime_str_ret_unit((bool)(_file____User_temp_13804), (__yo_str)((__yo_str){ .ptr = (const uint8_t*)"rel_path preserved", .len = 18 }));
                                                                          if (__yo_effect_escaped) {
                                                                            // Drop local variables before early return
switch ((_file____User_temp_13799).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13799).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13803).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13803).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13792).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13792).data.Some.value));
    break;
  }
  default: break;
}
switch ((result).tag) {
  case __YO_T35_OK: {
switch (((result).data.Ok.value).tag) {
  case __YO_T34_GIT: {
switch ((((result).data.Ok.value).data.Git.name).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Git.name).data.Some.value));
    break;
  }
  default: break;
}
switch ((((result).data.Ok.value).data.Git.url).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Git.url).data.Some.value));
    break;
  }
  default: break;
}
switch ((((result).data.Ok.value).data.Git.pinned_ref).tag) {
  case __YO_T9_SOME: {
switch (((((result).data.Ok.value).data.Git.pinned_ref).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((((result).data.Ok.value).data.Git.pinned_ref).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
    break;
  }
  case __YO_T34_PATH: {
switch ((((result).data.Ok.value).data.Path.name).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Path.name).data.Some.value));
    break;
  }
  default: break;
}
switch ((((result).data.Ok.value).data.Path.rel_path).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Path.rel_path).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
    break;
  }
  case __YO_T35_ERR: {
switch (((result).data.Err.error).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((result).data.Err.error).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                                            return;
                                                                          }
switch ((_file____User_temp_13799).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13799).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13803).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13803).data.Some.value));
    break;
  }
  default: break;
}
                                                                          break;
                                                                        }
                                                                        }
                                                                        break;
                                                                      }
                                                                      }
switch ((_file____User_temp_13792).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13792).data.Some.value));
    break;
  }
  default: break;
}
switch ((result).tag) {
  case __YO_T35_OK: {
switch (((result).data.Ok.value).tag) {
  case __YO_T34_GIT: {
switch ((((result).data.Ok.value).data.Git.name).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Git.name).data.Some.value));
    break;
  }
  default: break;
}
switch ((((result).data.Ok.value).data.Git.url).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Git.url).data.Some.value));
    break;
  }
  default: break;
}
switch ((((result).data.Ok.value).data.Git.pinned_ref).tag) {
  case __YO_T9_SOME: {
switch (((((result).data.Ok.value).data.Git.pinned_ref).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((((result).data.Ok.value).data.Git.pinned_ref).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
    break;
  }
  case __YO_T34_PATH: {
switch ((((result).data.Ok.value).data.Path.name).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Path.name).data.Some.value));
    break;
  }
  default: break;
}
switch ((((result).data.Ok.value).data.Path.rel_path).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Path.rel_path).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
    break;
  }
  case __YO_T35_ERR: {
switch (((result).data.Err.error).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((result).data.Err.error).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                                    } // end begin block
                                                                  }
                                                                  else {
                                                                    __yo_str __yo_ref_spill_35 = (__yo_str){ .ptr = (const uint8_t*)"32", .len = 2 };
                                                                    __yo_t10 _file____User_temp_13390 = yo_id_4873((&(__yo_ref_spill_35)));
                                                                    __yo_effect_escaped = 0;
                                                                    bool _file____User_temp_13392 = yo_id_4111((__yo_t10)(__yo_test_idx), (__yo_t10)(_file____User_temp_13390));
switch ((_file____User_temp_13390).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13390).data.Some.value));
    break;
  }
  default: break;
}
                                                                    if (__yo_effect_escaped) {
                                                                      // Drop local variables before early return
switch ((_file____User_temp_13390).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13390).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                                      return;
                                                                    }
                                                                    if (_file____User_temp_13392) {
                                                                      { // begin block
                                                                        __yo_t10 _file____User_temp_13812 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"notvalid", .len = 8 });
                                                                        __yo_effect_escaped = 0;
                                                                        __yo_t35 _file____User_temp_13813 = yo_id_9927((__yo_t10)(_file____User_temp_13812));
                                                                        if (__yo_effect_escaped) {
                                                                          // Drop local variables before early return
switch ((_file____User_temp_13812).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13812).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                                          return;
                                                                        }
                                                                        __yo_t35 result = _file____User_temp_13813;
                                                                        switch ((result).tag) {
                                                                        case __YO_T35_OK: {
                                                                          __yo_effect_escaped = 0;
                                                                          yo_id_5002_str_id_str_rtparam0_bool_rtparam1_comptime_str_ret_unit((bool)(false), (__yo_str)((__yo_str){ .ptr = (const uint8_t*)"expected Err for invalid spec", .len = 29 }));
                                                                          if (__yo_effect_escaped) {
                                                                            // Drop local variables before early return
switch ((_file____User_temp_13812).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13812).data.Some.value));
    break;
  }
  default: break;
}
switch ((result).tag) {
  case __YO_T35_OK: {
switch (((result).data.Ok.value).tag) {
  case __YO_T34_GIT: {
switch ((((result).data.Ok.value).data.Git.name).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Git.name).data.Some.value));
    break;
  }
  default: break;
}
switch ((((result).data.Ok.value).data.Git.url).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Git.url).data.Some.value));
    break;
  }
  default: break;
}
switch ((((result).data.Ok.value).data.Git.pinned_ref).tag) {
  case __YO_T9_SOME: {
switch (((((result).data.Ok.value).data.Git.pinned_ref).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((((result).data.Ok.value).data.Git.pinned_ref).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
    break;
  }
  case __YO_T34_PATH: {
switch ((((result).data.Ok.value).data.Path.name).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Path.name).data.Some.value));
    break;
  }
  default: break;
}
switch ((((result).data.Ok.value).data.Path.rel_path).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Path.rel_path).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
    break;
  }
  case __YO_T35_ERR: {
switch (((result).data.Err.error).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((result).data.Err.error).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                                            return;
                                                                          }
                                                                          break;
                                                                        }
                                                                        case __YO_T35_ERR: {
                                                                          __yo_effect_escaped = 0;
                                                                          yo_id_5002_str_id_str_rtparam0_bool_rtparam1_comptime_str_ret_unit((bool)(true), (__yo_str)((__yo_str){ .ptr = (const uint8_t*)"got Err as expected", .len = 19 }));
                                                                          if (__yo_effect_escaped) {
                                                                            // Drop local variables before early return
switch ((_file____User_temp_13812).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13812).data.Some.value));
    break;
  }
  default: break;
}
switch ((result).tag) {
  case __YO_T35_OK: {
switch (((result).data.Ok.value).tag) {
  case __YO_T34_GIT: {
switch ((((result).data.Ok.value).data.Git.name).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Git.name).data.Some.value));
    break;
  }
  default: break;
}
switch ((((result).data.Ok.value).data.Git.url).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Git.url).data.Some.value));
    break;
  }
  default: break;
}
switch ((((result).data.Ok.value).data.Git.pinned_ref).tag) {
  case __YO_T9_SOME: {
switch (((((result).data.Ok.value).data.Git.pinned_ref).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((((result).data.Ok.value).data.Git.pinned_ref).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
    break;
  }
  case __YO_T34_PATH: {
switch ((((result).data.Ok.value).data.Path.name).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Path.name).data.Some.value));
    break;
  }
  default: break;
}
switch ((((result).data.Ok.value).data.Path.rel_path).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Path.rel_path).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
    break;
  }
  case __YO_T35_ERR: {
switch (((result).data.Err.error).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((result).data.Err.error).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                                            return;
                                                                          }
                                                                          break;
                                                                        }
                                                                        }
switch ((_file____User_temp_13812).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13812).data.Some.value));
    break;
  }
  default: break;
}
switch ((result).tag) {
  case __YO_T35_OK: {
switch (((result).data.Ok.value).tag) {
  case __YO_T34_GIT: {
switch ((((result).data.Ok.value).data.Git.name).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Git.name).data.Some.value));
    break;
  }
  default: break;
}
switch ((((result).data.Ok.value).data.Git.url).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Git.url).data.Some.value));
    break;
  }
  default: break;
}
switch ((((result).data.Ok.value).data.Git.pinned_ref).tag) {
  case __YO_T9_SOME: {
switch (((((result).data.Ok.value).data.Git.pinned_ref).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((((result).data.Ok.value).data.Git.pinned_ref).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
    break;
  }
  case __YO_T34_PATH: {
switch ((((result).data.Ok.value).data.Path.name).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Path.name).data.Some.value));
    break;
  }
  default: break;
}
switch ((((result).data.Ok.value).data.Path.rel_path).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((((result).data.Ok.value).data.Path.rel_path).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
    break;
  }
  case __YO_T35_ERR: {
switch (((result).data.Err.error).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((result).data.Err.error).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                                      } // end begin block
                                                                    }
                                                                    else {
                                                                      __yo_str __yo_ref_spill_36 = (__yo_str){ .ptr = (const uint8_t*)"33", .len = 2 };
                                                                      __yo_t10 _file____User_temp_13394 = yo_id_4873((&(__yo_ref_spill_36)));
                                                                      __yo_effect_escaped = 0;
                                                                      bool _file____User_temp_13396 = yo_id_4111((__yo_t10)(__yo_test_idx), (__yo_t10)(_file____User_temp_13394));
switch ((_file____User_temp_13394).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13394).data.Some.value));
    break;
  }
  default: break;
}
                                                                      if (__yo_effect_escaped) {
                                                                        // Drop local variables before early return
switch ((_file____User_temp_13394).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13394).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                                        return;
                                                                      }
                                                                      if (_file____User_temp_13396) {
                                                                        { // begin block
                                                                          __yo_t10 _file____User_temp_13821 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"mylib :: build.dependency(url: \"https://github.com/u/mylib.git\", ref: \"v1.0.0\");\n", .len = 81 });
                                                                          __yo_t10 content = _file____User_temp_13821;
                                                                          __yo_t10 _file____User_temp_13822 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"mylib", .len = 5 });
                                                                          __yo_effect_escaped = 0;
                                                                          bool _file____User_temp_13823 = yo_id_10015((__yo_t10)(content), (__yo_t10)(_file____User_temp_13822));
                                                                          if (__yo_effect_escaped) {
                                                                            // Drop local variables before early return
switch ((content).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((content).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13822).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13822).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                                            return;
                                                                          }
                                                                          __yo_effect_escaped = 0;
                                                                          yo_id_5002_str_id_str_rtparam0_bool_rtparam1_comptime_str_ret_unit((bool)(_file____User_temp_13823), (__yo_str)((__yo_str){ .ptr = (const uint8_t*)"git dep found", .len = 13 }));
                                                                          if (__yo_effect_escaped) {
                                                                            // Drop local variables before early return
switch ((content).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((content).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13822).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13822).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                                            return;
                                                                          }
switch ((content).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((content).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13822).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13822).data.Some.value));
    break;
  }
  default: break;
}
                                                                        } // end begin block
                                                                      }
                                                                      else {
                                                                        __yo_str __yo_ref_spill_37 = (__yo_str){ .ptr = (const uint8_t*)"34", .len = 2 };
                                                                        __yo_t10 _file____User_temp_13398 = yo_id_4873((&(__yo_ref_spill_37)));
                                                                        __yo_effect_escaped = 0;
                                                                        bool _file____User_temp_13400 = yo_id_4111((__yo_t10)(__yo_test_idx), (__yo_t10)(_file____User_temp_13398));
switch ((_file____User_temp_13398).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13398).data.Some.value));
    break;
  }
  default: break;
}
                                                                        if (__yo_effect_escaped) {
                                                                          // Drop local variables before early return
switch ((_file____User_temp_13398).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13398).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                                          return;
                                                                        }
                                                                        if (_file____User_temp_13400) {
                                                                          { // begin block
                                                                            __yo_t10 _file____User_temp_13827 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"locallib :: build.path_dependency(path: \"./local\");\n", .len = 52 });
                                                                            __yo_t10 content = _file____User_temp_13827;
                                                                            __yo_t10 _file____User_temp_13828 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"locallib", .len = 8 });
                                                                            __yo_effect_escaped = 0;
                                                                            bool _file____User_temp_13829 = yo_id_10015((__yo_t10)(content), (__yo_t10)(_file____User_temp_13828));
                                                                            if (__yo_effect_escaped) {
                                                                              // Drop local variables before early return
switch ((content).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((content).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13828).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13828).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                                              return;
                                                                            }
                                                                            __yo_effect_escaped = 0;
                                                                            yo_id_5002_str_id_str_rtparam0_bool_rtparam1_comptime_str_ret_unit((bool)(_file____User_temp_13829), (__yo_str)((__yo_str){ .ptr = (const uint8_t*)"path dep found", .len = 14 }));
                                                                            if (__yo_effect_escaped) {
                                                                              // Drop local variables before early return
switch ((content).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((content).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13828).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13828).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                                              return;
                                                                            }
switch ((content).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((content).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13828).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13828).data.Some.value));
    break;
  }
  default: break;
}
                                                                          } // end begin block
                                                                        }
                                                                        else {
                                                                          __yo_str __yo_ref_spill_38 = (__yo_str){ .ptr = (const uint8_t*)"35", .len = 2 };
                                                                          __yo_t10 _file____User_temp_13402 = yo_id_4873((&(__yo_ref_spill_38)));
                                                                          __yo_effect_escaped = 0;
                                                                          bool _file____User_temp_13404 = yo_id_4111((__yo_t10)(__yo_test_idx), (__yo_t10)(_file____User_temp_13402));
switch ((_file____User_temp_13402).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13402).data.Some.value));
    break;
  }
  default: break;
}
                                                                          if (__yo_effect_escaped) {
                                                                            // Drop local variables before early return
switch ((_file____User_temp_13402).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13402).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                                            return;
                                                                          }
                                                                          if (_file____User_temp_13404) {
                                                                            { // begin block
                                                                              __yo_t10 _file____User_temp_13833 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"other :: build.dependency(url: \"https://github.com/u/other.git\", ref: \"v1.0.0\");\n", .len = 81 });
                                                                              __yo_t10 content = _file____User_temp_13833;
                                                                              __yo_t10 _file____User_temp_13838 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"mylib", .len = 5 });
                                                                              __yo_effect_escaped = 0;
                                                                              bool _file____User_temp_13839 = yo_id_10015((__yo_t10)(content), (__yo_t10)(_file____User_temp_13838));
                                                                              if (__yo_effect_escaped) {
                                                                                // Drop local variables before early return
switch ((content).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((content).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13838).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13838).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                                                return;
                                                                              }
                                                                              __yo_effect_escaped = 0;
                                                                              bool _file____User_temp_13840 = yo_id_122_bool_id_bool_rtparam0_bool_ret_bool((bool)(_file____User_temp_13839));
                                                                              if (__yo_effect_escaped) {
                                                                                // Drop local variables before early return
switch ((content).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((content).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13838).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13838).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                                                return;
                                                                              }
                                                                              __yo_effect_escaped = 0;
                                                                              yo_id_5002_str_id_str_rtparam0_bool_rtparam1_comptime_str_ret_unit((bool)(_file____User_temp_13840), (__yo_str)((__yo_str){ .ptr = (const uint8_t*)"mylib not found", .len = 15 }));
                                                                              if (__yo_effect_escaped) {
                                                                                // Drop local variables before early return
switch ((content).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((content).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13838).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13838).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                                                return;
                                                                              }
switch ((content).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((content).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13838).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13838).data.Some.value));
    break;
  }
  default: break;
}
                                                                            } // end begin block
                                                                          }
                                                                          else {
                                                                            __yo_str __yo_ref_spill_39 = (__yo_str){ .ptr = (const uint8_t*)"36", .len = 2 };
                                                                            __yo_t10 _file____User_temp_13406 = yo_id_4873((&(__yo_ref_spill_39)));
                                                                            __yo_effect_escaped = 0;
                                                                            bool _file____User_temp_13408 = yo_id_4111((__yo_t10)(__yo_test_idx), (__yo_t10)(_file____User_temp_13406));
switch ((_file____User_temp_13406).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13406).data.Some.value));
    break;
  }
  default: break;
}
                                                                            if (__yo_effect_escaped) {
                                                                              // Drop local variables before early return
switch ((_file____User_temp_13406).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13406).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                                              return;
                                                                            }
                                                                            if (_file____User_temp_13408) {
                                                                              { // begin block
                                                                                __yo_t10 _file____User_temp_13845 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"mylib :: build.dependency(url: \"https://github.com/u/mylib.git\", ref: \"v1.0.0\");\n", .len = 81 });
                                                                                __yo_t10 _file____User_temp_13846 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"other :: build.dependency(url: \"https://github.com/u/other.git\", ref: \"main\");\n", .len = 79 });
                                                                                __yo_t10 _file____User_temp_13847 = yo_id_3607(_file____User_temp_13845, _file____User_temp_13846);
                                                                                __yo_t10 content = _file____User_temp_13847;
                                                                                __yo_effect_escaped = 0;
                                                                                __yo_t16* _file____User_temp_13848 = yo_id_10027((__yo_t10)(content));
                                                                                if (__yo_effect_escaped) {
                                                                                  // Drop local variables before early return
switch ((_file____User_temp_13845).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13845).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13846).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13846).data.Some.value));
    break;
  }
  default: break;
}
switch ((content).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((content).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                                                  return;
                                                                                }
                                                                                __yo_t16* names = _file____User_temp_13848;
                                                                                size_t _file____User_temp_13852 = yo_id_3119_rtparam0_R_gs_yo_id_3109_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_ret_usize(names);
                                                                                __yo_effect_escaped = 0;
                                                                                yo_id_5002_str_id_str_rtparam0_bool_rtparam1_comptime_str_ret_unit((bool)(((_file____User_temp_13852) == (2ULL))), (__yo_str)((__yo_str){ .ptr = (const uint8_t*)"two deps found", .len = 14 }));
                                                                                if (__yo_effect_escaped) {
                                                                                  // Drop local variables before early return
switch ((_file____User_temp_13845).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13845).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13846).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13846).data.Some.value));
    break;
  }
  default: break;
}
switch ((content).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((content).data.Some.value));
    break;
  }
  default: break;
}
                                                                                  __yo_decr_rc((void*)(names));
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                                                  return;
                                                                                }
                                                                                __yo_t9 _file____User_temp_13873 = yo_id_3138_rtparam0_R_gs_yo_id_3109_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam1_usize_ret_enum_yo_id_3135_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8(names, 0ULL);
                                                                                switch ((_file____User_temp_13873).tag) {
                                                                                case __YO_T9_NONE: {
                                                                                  __yo_effect_escaped = 0;
                                                                                  yo_id_5002_str_id_str_rtparam0_bool_rtparam1_comptime_str_ret_unit((bool)(false), (__yo_str)((__yo_str){ .ptr = (const uint8_t*)"first dep", .len = 9 }));
                                                                                  if (__yo_effect_escaped) {
                                                                                    // Drop local variables before early return
switch ((_file____User_temp_13845).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13845).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13846).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13846).data.Some.value));
    break;
  }
  default: break;
}
switch ((content).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((content).data.Some.value));
    break;
  }
  default: break;
}
                                                                                    __yo_decr_rc((void*)(names));
switch ((_file____User_temp_13873).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13873).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13873).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                                                    return;
                                                                                  }
                                                                                  break;
                                                                                }
                                                                                case __YO_T9_SOME: {
                                                                                  __yo_t10 n = _file____User_temp_13873.data.Some.value;
                                                                                  __yo_t10 _file____User_temp_13877 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"mylib", .len = 5 });
                                                                                  __yo_effect_escaped = 0;
                                                                                  bool _file____User_temp_13878 = yo_id_4111((__yo_t10)(n), (__yo_t10)(_file____User_temp_13877));
                                                                                  if (__yo_effect_escaped) {
                                                                                    // Drop local variables before early return
switch ((_file____User_temp_13845).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13845).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13846).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13846).data.Some.value));
    break;
  }
  default: break;
}
switch ((content).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((content).data.Some.value));
    break;
  }
  default: break;
}
                                                                                    __yo_decr_rc((void*)(names));
switch ((_file____User_temp_13873).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13873).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13873).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                                                    return;
                                                                                  }
                                                                                  __yo_effect_escaped = 0;
                                                                                  yo_id_5002_str_id_str_rtparam0_bool_rtparam1_comptime_str_ret_unit((bool)(_file____User_temp_13878), (__yo_str)((__yo_str){ .ptr = (const uint8_t*)"first dep is mylib", .len = 18 }));
switch ((_file____User_temp_13877).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13877).data.Some.value));
    break;
  }
  default: break;
}
                                                                                  if (__yo_effect_escaped) {
                                                                                    // Drop local variables before early return
switch ((_file____User_temp_13845).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13845).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13846).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13846).data.Some.value));
    break;
  }
  default: break;
}
switch ((content).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((content).data.Some.value));
    break;
  }
  default: break;
}
                                                                                    __yo_decr_rc((void*)(names));
switch ((_file____User_temp_13873).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13873).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13873).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                                                    return;
                                                                                  }
                                                                                  break;
                                                                                }
                                                                                }
                                                                                __yo_t9 _file____User_temp_13883 = yo_id_3138_rtparam0_R_gs_yo_id_3109_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam1_usize_ret_enum_yo_id_3135_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8(names, 1ULL);
                                                                                switch ((_file____User_temp_13883).tag) {
                                                                                case __YO_T9_NONE: {
                                                                                  __yo_effect_escaped = 0;
                                                                                  yo_id_5002_str_id_str_rtparam0_bool_rtparam1_comptime_str_ret_unit((bool)(false), (__yo_str)((__yo_str){ .ptr = (const uint8_t*)"second dep", .len = 10 }));
                                                                                  if (__yo_effect_escaped) {
                                                                                    // Drop local variables before early return
switch ((_file____User_temp_13845).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13845).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13846).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13846).data.Some.value));
    break;
  }
  default: break;
}
switch ((content).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((content).data.Some.value));
    break;
  }
  default: break;
}
                                                                                    __yo_decr_rc((void*)(names));
switch ((_file____User_temp_13873).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13873).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13873).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
switch ((_file____User_temp_13883).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13883).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13883).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                                                    return;
                                                                                  }
                                                                                  break;
                                                                                }
                                                                                case __YO_T9_SOME: {
                                                                                  __yo_t10 n = _file____User_temp_13883.data.Some.value;
                                                                                  __yo_t10 _file____User_temp_13887 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"other", .len = 5 });
                                                                                  __yo_effect_escaped = 0;
                                                                                  bool _file____User_temp_13888 = yo_id_4111((__yo_t10)(n), (__yo_t10)(_file____User_temp_13887));
                                                                                  if (__yo_effect_escaped) {
                                                                                    // Drop local variables before early return
switch ((_file____User_temp_13845).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13845).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13846).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13846).data.Some.value));
    break;
  }
  default: break;
}
switch ((content).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((content).data.Some.value));
    break;
  }
  default: break;
}
                                                                                    __yo_decr_rc((void*)(names));
switch ((_file____User_temp_13873).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13873).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13873).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
switch ((_file____User_temp_13883).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13883).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13883).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                                                    return;
                                                                                  }
                                                                                  __yo_effect_escaped = 0;
                                                                                  yo_id_5002_str_id_str_rtparam0_bool_rtparam1_comptime_str_ret_unit((bool)(_file____User_temp_13888), (__yo_str)((__yo_str){ .ptr = (const uint8_t*)"second dep is other", .len = 19 }));
switch ((_file____User_temp_13887).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13887).data.Some.value));
    break;
  }
  default: break;
}
                                                                                  if (__yo_effect_escaped) {
                                                                                    // Drop local variables before early return
switch ((_file____User_temp_13845).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13845).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13846).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13846).data.Some.value));
    break;
  }
  default: break;
}
switch ((content).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((content).data.Some.value));
    break;
  }
  default: break;
}
                                                                                    __yo_decr_rc((void*)(names));
switch ((_file____User_temp_13873).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13873).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13873).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
switch ((_file____User_temp_13883).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13883).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13883).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                                                    return;
                                                                                  }
                                                                                  break;
                                                                                }
                                                                                }
switch ((_file____User_temp_13845).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13845).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13846).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13846).data.Some.value));
    break;
  }
  default: break;
}
switch ((content).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((content).data.Some.value));
    break;
  }
  default: break;
}
                                                                                __yo_decr_rc((void*)(names));
switch ((_file____User_temp_13873).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13873).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13873).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
switch ((_file____User_temp_13883).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13883).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13883).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                                              } // end begin block
                                                                            }
                                                                            else {
                                                                              __yo_str __yo_ref_spill_40 = (__yo_str){ .ptr = (const uint8_t*)"37", .len = 2 };
                                                                              __yo_t10 _file____User_temp_13410 = yo_id_4873((&(__yo_ref_spill_40)));
                                                                              __yo_effect_escaped = 0;
                                                                              bool _file____User_temp_13412 = yo_id_4111((__yo_t10)(__yo_test_idx), (__yo_t10)(_file____User_temp_13410));
switch ((_file____User_temp_13410).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13410).data.Some.value));
    break;
  }
  default: break;
}
                                                                              if (__yo_effect_escaped) {
                                                                                // Drop local variables before early return
switch ((_file____User_temp_13410).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13410).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                                                return;
                                                                              }
                                                                              if (_file____User_temp_13412) {
                                                                                { // begin block
                                                                                  __yo_t10 _file____User_temp_13894 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"locallib :: build.path_dependency(path: \"./local\");\n", .len = 52 });
                                                                                  __yo_t10 content = _file____User_temp_13894;
                                                                                  __yo_effect_escaped = 0;
                                                                                  __yo_t16* _file____User_temp_13895 = yo_id_10027((__yo_t10)(content));
                                                                                  if (__yo_effect_escaped) {
                                                                                    // Drop local variables before early return
switch ((content).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((content).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                                                    return;
                                                                                  }
                                                                                  __yo_t16* names = _file____User_temp_13895;
                                                                                  size_t _file____User_temp_13897 = yo_id_3119_rtparam0_R_gs_yo_id_3109_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_ret_usize(names);
                                                                                  __yo_effect_escaped = 0;
                                                                                  yo_id_5002_str_id_str_rtparam0_bool_rtparam1_comptime_str_ret_unit((bool)(((_file____User_temp_13897) == (1ULL))), (__yo_str)((__yo_str){ .ptr = (const uint8_t*)"one dep found", .len = 13 }));
                                                                                  if (__yo_effect_escaped) {
                                                                                    // Drop local variables before early return
switch ((content).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((content).data.Some.value));
    break;
  }
  default: break;
}
                                                                                    __yo_decr_rc((void*)(names));
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                                                    return;
                                                                                  }
                                                                                  __yo_t9 _file____User_temp_13901 = yo_id_3138_rtparam0_R_gs_yo_id_3109_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam1_usize_ret_enum_yo_id_3135_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8(names, 0ULL);
                                                                                  switch ((_file____User_temp_13901).tag) {
                                                                                  case __YO_T9_NONE: {
                                                                                    __yo_effect_escaped = 0;
                                                                                    yo_id_5002_str_id_str_rtparam0_bool_rtparam1_comptime_str_ret_unit((bool)(false), (__yo_str)((__yo_str){ .ptr = (const uint8_t*)"first dep", .len = 9 }));
                                                                                    if (__yo_effect_escaped) {
                                                                                      // Drop local variables before early return
switch ((content).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((content).data.Some.value));
    break;
  }
  default: break;
}
                                                                                      __yo_decr_rc((void*)(names));
switch ((_file____User_temp_13901).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13901).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13901).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                                                      return;
                                                                                    }
                                                                                    break;
                                                                                  }
                                                                                  case __YO_T9_SOME: {
                                                                                    __yo_t10 n = _file____User_temp_13901.data.Some.value;
                                                                                    __yo_t10 _file____User_temp_13905 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"locallib", .len = 8 });
                                                                                    __yo_effect_escaped = 0;
                                                                                    bool _file____User_temp_13906 = yo_id_4111((__yo_t10)(n), (__yo_t10)(_file____User_temp_13905));
                                                                                    if (__yo_effect_escaped) {
                                                                                      // Drop local variables before early return
switch ((content).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((content).data.Some.value));
    break;
  }
  default: break;
}
                                                                                      __yo_decr_rc((void*)(names));
switch ((_file____User_temp_13901).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13901).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13901).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                                                      return;
                                                                                    }
                                                                                    __yo_effect_escaped = 0;
                                                                                    yo_id_5002_str_id_str_rtparam0_bool_rtparam1_comptime_str_ret_unit((bool)(_file____User_temp_13906), (__yo_str)((__yo_str){ .ptr = (const uint8_t*)"dep is locallib", .len = 15 }));
switch ((_file____User_temp_13905).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13905).data.Some.value));
    break;
  }
  default: break;
}
                                                                                    if (__yo_effect_escaped) {
                                                                                      // Drop local variables before early return
switch ((content).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((content).data.Some.value));
    break;
  }
  default: break;
}
                                                                                      __yo_decr_rc((void*)(names));
switch ((_file____User_temp_13901).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13901).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13901).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                                                      return;
                                                                                    }
                                                                                    break;
                                                                                  }
                                                                                  }
switch ((content).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((content).data.Some.value));
    break;
  }
  default: break;
}
                                                                                  __yo_decr_rc((void*)(names));
switch ((_file____User_temp_13901).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13901).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13901).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                                                } // end begin block
                                                                              }
                                                                              else {
                                                                                __yo_str __yo_ref_spill_41 = (__yo_str){ .ptr = (const uint8_t*)"38", .len = 2 };
                                                                                __yo_t10 _file____User_temp_13414 = yo_id_4873((&(__yo_ref_spill_41)));
                                                                                __yo_effect_escaped = 0;
                                                                                bool _file____User_temp_13416 = yo_id_4111((__yo_t10)(__yo_test_idx), (__yo_t10)(_file____User_temp_13414));
switch ((_file____User_temp_13414).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13414).data.Some.value));
    break;
  }
  default: break;
}
                                                                                if (__yo_effect_escaped) {
                                                                                  // Drop local variables before early return
switch ((_file____User_temp_13414).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13414).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                                                  return;
                                                                                }
                                                                                if (_file____User_temp_13416) {
                                                                                  { // begin block
                                                                                    __yo_t10 _file____User_temp_13912 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"", .len = 0 });
                                                                                    __yo_effect_escaped = 0;
                                                                                    __yo_t16* _file____User_temp_13913 = yo_id_10027((__yo_t10)(_file____User_temp_13912));
                                                                                    if (__yo_effect_escaped) {
                                                                                      // Drop local variables before early return
switch ((_file____User_temp_13912).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13912).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                                                      return;
                                                                                    }
                                                                                    __yo_t16* names = _file____User_temp_13913;
                                                                                    size_t _file____User_temp_13915 = yo_id_3119_rtparam0_R_gs_yo_id_3109_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_ret_usize(names);
                                                                                    __yo_effect_escaped = 0;
                                                                                    yo_id_5002_str_id_str_rtparam0_bool_rtparam1_comptime_str_ret_unit((bool)(((_file____User_temp_13915) == (0ULL))), (__yo_str)((__yo_str){ .ptr = (const uint8_t*)"no deps in empty content", .len = 24 }));
                                                                                    if (__yo_effect_escaped) {
                                                                                      // Drop local variables before early return
switch ((_file____User_temp_13912).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13912).data.Some.value));
    break;
  }
  default: break;
}
                                                                                      __yo_decr_rc((void*)(names));
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                                                      return;
                                                                                    }
switch ((_file____User_temp_13912).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13912).data.Some.value));
    break;
  }
  default: break;
}
                                                                                    __yo_decr_rc((void*)(names));
                                                                                  } // end begin block
                                                                                }
                                                                                else {
                                                                                  __yo_str __yo_ref_spill_42 = (__yo_str){ .ptr = (const uint8_t*)"39", .len = 2 };
                                                                                  __yo_t10 _file____User_temp_13418 = yo_id_4873((&(__yo_ref_spill_42)));
                                                                                  __yo_effect_escaped = 0;
                                                                                  bool _file____User_temp_13420 = yo_id_4111((__yo_t10)(__yo_test_idx), (__yo_t10)(_file____User_temp_13418));
switch ((_file____User_temp_13418).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13418).data.Some.value));
    break;
  }
  default: break;
}
                                                                                  if (__yo_effect_escaped) {
                                                                                    // Drop local variables before early return
switch ((_file____User_temp_13418).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13418).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                                                    return;
                                                                                  }
                                                                                  if (_file____User_temp_13420) {
                                                                                    { // begin block
                                                                                      __yo_t16* _file____User_temp_13920 = yo_id_3124__ret_R_gs_yo_id_3109_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8();
                                                                                      __yo_effect_escaped = 0;
                                                                                      __yo_t10 _file____User_temp_13923 = yo_id_10071((__yo_t16*)(_file____User_temp_13920));
                                                                                      if (__yo_effect_escaped) {
                                                                                        // Drop local variables before early return
                                                                                        __yo_decr_rc((void*)(_file____User_temp_13920));
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                                                        return;
                                                                                      }
                                                                                      __yo_t10 result = _file____User_temp_13923;
                                                                                      __yo_t10 _file____User_temp_13924 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"ComptimeList(build.ImportEntry)()", .len = 33 });
                                                                                      bool _file____User_temp_13927 = yo_id_4279_String_id_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam0_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam1_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam2_usize_ret_bool(result, _file____User_temp_13924, 0ULL);
                                                                                      __yo_effect_escaped = 0;
                                                                                      yo_id_5002_str_id_str_rtparam0_bool_rtparam1_comptime_str_ret_unit((bool)(_file____User_temp_13927), (__yo_str)((__yo_str){ .ptr = (const uint8_t*)"empty list form", .len = 15 }));
                                                                                      if (__yo_effect_escaped) {
                                                                                        // Drop local variables before early return
                                                                                        __yo_decr_rc((void*)(_file____User_temp_13920));
switch ((result).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((result).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13924).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13924).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                                                        return;
                                                                                      }
                                                                                      __yo_t10 _file____User_temp_13929 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"export(imports);", .len = 16 });
                                                                                      bool _file____User_temp_13930 = yo_id_4279_String_id_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam0_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam1_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam2_usize_ret_bool(result, _file____User_temp_13929, 0ULL);
                                                                                      __yo_effect_escaped = 0;
                                                                                      yo_id_5002_str_id_str_rtparam0_bool_rtparam1_comptime_str_ret_unit((bool)(_file____User_temp_13930), (__yo_str)((__yo_str){ .ptr = (const uint8_t*)"export(line present)", .len = 20 }));
                                                                                      if (__yo_effect_escaped) {
                                                                                        // Drop local variables before early return
                                                                                        __yo_decr_rc((void*)(_file____User_temp_13920));
switch ((result).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((result).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13924).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13924).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13929).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13929).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                                                        return;
                                                                                      }
                                                                                      __yo_decr_rc((void*)(_file____User_temp_13920));
switch ((result).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((result).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13924).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13924).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13929).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13929).data.Some.value));
    break;
  }
  default: break;
}
                                                                                    } // end begin block
                                                                                  }
                                                                                  else {
                                                                                    __yo_str __yo_ref_spill_43 = (__yo_str){ .ptr = (const uint8_t*)"40", .len = 2 };
                                                                                    __yo_t10 _file____User_temp_13422 = yo_id_4873((&(__yo_ref_spill_43)));
                                                                                    __yo_effect_escaped = 0;
                                                                                    bool _file____User_temp_13424 = yo_id_4111((__yo_t10)(__yo_test_idx), (__yo_t10)(_file____User_temp_13422));
switch ((_file____User_temp_13422).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13422).data.Some.value));
    break;
  }
  default: break;
}
                                                                                    if (__yo_effect_escaped) {
                                                                                      // Drop local variables before early return
switch ((_file____User_temp_13422).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13422).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                                                      return;
                                                                                    }
                                                                                    if (_file____User_temp_13424) {
                                                                                      { // begin block
                                                                                        __yo_t16* _file____User_temp_13934 = yo_id_3124__ret_R_gs_yo_id_3109_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8();
                                                                                        __yo_t16* deps = _file____User_temp_13934;
                                                                                        __yo_t10 _file____User_temp_13935 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"mylib", .len = 5 });
                                                                                        __yo_t6 _file____User_temp_13999 = yo_id_3133_rtparam0_R_gs_yo_id_3109_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam1_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_ret_enum_yo_id_3132_unit_enum_yo_id_3108_enum_yo_id_3055_usize_usize(deps, _file____User_temp_13935);
                                                                                        __yo_effect_escaped = 0;
                                                                                        __yo_t10 _file____User_temp_14000 = yo_id_10071((__yo_t16*)(deps));
                                                                                        if (__yo_effect_escaped) {
                                                                                          // Drop local variables before early return
                                                                                          __yo_decr_rc((void*)(deps));
switch ((_file____User_temp_13935).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13935).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                                                          return;
                                                                                        }
                                                                                        __yo_t10 result = _file____User_temp_14000;
                                                                                        __yo_t10 _file____User_temp_14001 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"mylib.module()", .len = 14 });
                                                                                        bool _file____User_temp_14002 = yo_id_4279_String_id_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam0_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam1_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam2_usize_ret_bool(result, _file____User_temp_14001, 0ULL);
                                                                                        __yo_effect_escaped = 0;
                                                                                        yo_id_5002_str_id_str_rtparam0_bool_rtparam1_comptime_str_ret_unit((bool)(_file____User_temp_14002), (__yo_str)((__yo_str){ .ptr = (const uint8_t*)"module() call present", .len = 21 }));
                                                                                        if (__yo_effect_escaped) {
                                                                                          // Drop local variables before early return
                                                                                          __yo_decr_rc((void*)(deps));
switch ((_file____User_temp_13935).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13935).data.Some.value));
    break;
  }
  default: break;
}
switch ((result).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((result).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_14001).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_14001).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                                                          return;
                                                                                        }
                                                                                        __yo_t10 _file____User_temp_14004 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"export(imports);", .len = 16 });
                                                                                        bool _file____User_temp_14005 = yo_id_4279_String_id_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam0_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam1_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam2_usize_ret_bool(result, _file____User_temp_14004, 0ULL);
                                                                                        __yo_effect_escaped = 0;
                                                                                        yo_id_5002_str_id_str_rtparam0_bool_rtparam1_comptime_str_ret_unit((bool)(_file____User_temp_14005), (__yo_str)((__yo_str){ .ptr = (const uint8_t*)"export(line present)", .len = 20 }));
                                                                                        if (__yo_effect_escaped) {
                                                                                          // Drop local variables before early return
                                                                                          __yo_decr_rc((void*)(deps));
switch ((_file____User_temp_13935).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13935).data.Some.value));
    break;
  }
  default: break;
}
switch ((result).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((result).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_14001).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_14001).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_14004).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_14004).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                                                          return;
                                                                                        }
                                                                                        __yo_decr_rc((void*)(deps));
switch ((_file____User_temp_13935).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13935).data.Some.value));
    break;
  }
  default: break;
}
switch ((result).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((result).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_14001).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_14001).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_14004).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_14004).data.Some.value));
    break;
  }
  default: break;
}
                                                                                      } // end begin block
                                                                                    }
                                                                                    else {
                                                                                      __yo_str __yo_ref_spill_44 = (__yo_str){ .ptr = (const uint8_t*)"41", .len = 2 };
                                                                                      __yo_t10 _file____User_temp_13426 = yo_id_4873((&(__yo_ref_spill_44)));
                                                                                      __yo_effect_escaped = 0;
                                                                                      bool _file____User_temp_13428 = yo_id_4111((__yo_t10)(__yo_test_idx), (__yo_t10)(_file____User_temp_13426));
switch ((_file____User_temp_13426).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13426).data.Some.value));
    break;
  }
  default: break;
}
                                                                                      if (__yo_effect_escaped) {
                                                                                        // Drop local variables before early return
switch ((_file____User_temp_13426).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13426).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                                                        return;
                                                                                      }
                                                                                      if (_file____User_temp_13428) {
                                                                                        { // begin block
                                                                                          __yo_t10 _file____User_temp_14009 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"mylib :: build.dependency(url: \"https://github.com/u/mylib.git\", ref: \"v1.0.0\");", .len = 80 });
                                                                                          __yo_t10 dep_line = _file____User_temp_14009;
                                                                                          __yo_t10 _file____User_temp_14010 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"", .len = 0 });
                                                                                          __yo_effect_escaped = 0;
                                                                                          __yo_t10 _file____User_temp_14011 = yo_id_10277((__yo_t10)(_file____User_temp_14010), (__yo_t10)(dep_line));
                                                                                          if (__yo_effect_escaped) {
                                                                                            // Drop local variables before early return
switch ((dep_line).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((dep_line).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_14010).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_14010).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                                                            return;
                                                                                          }
                                                                                          __yo_t10 result = _file____User_temp_14011;
                                                                                          bool _file____User_temp_14012 = yo_id_4279_String_id_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam0_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam1_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam2_usize_ret_bool(result, dep_line, 0ULL);
                                                                                          __yo_effect_escaped = 0;
                                                                                          yo_id_5002_str_id_str_rtparam0_bool_rtparam1_comptime_str_ret_unit((bool)(_file____User_temp_14012), (__yo_str)((__yo_str){ .ptr = (const uint8_t*)"dep line in result", .len = 18 }));
                                                                                          if (__yo_effect_escaped) {
                                                                                            // Drop local variables before early return
switch ((dep_line).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((dep_line).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_14010).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_14010).data.Some.value));
    break;
  }
  default: break;
}
switch ((result).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((result).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                                                            return;
                                                                                          }
                                                                                          __yo_t10 _file____User_temp_14014 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"export(imports);", .len = 16 });
                                                                                          bool _file____User_temp_14015 = yo_id_4279_String_id_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam0_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam1_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam2_usize_ret_bool(result, _file____User_temp_14014, 0ULL);
                                                                                          __yo_effect_escaped = 0;
                                                                                          yo_id_5002_str_id_str_rtparam0_bool_rtparam1_comptime_str_ret_unit((bool)(_file____User_temp_14015), (__yo_str)((__yo_str){ .ptr = (const uint8_t*)"imports regenerated", .len = 19 }));
                                                                                          if (__yo_effect_escaped) {
                                                                                            // Drop local variables before early return
switch ((dep_line).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((dep_line).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_14010).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_14010).data.Some.value));
    break;
  }
  default: break;
}
switch ((result).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((result).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_14014).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_14014).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                                                            return;
                                                                                          }
switch ((dep_line).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((dep_line).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_14010).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_14010).data.Some.value));
    break;
  }
  default: break;
}
switch ((result).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((result).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_14014).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_14014).data.Some.value));
    break;
  }
  default: break;
}
                                                                                        } // end begin block
                                                                                      }
                                                                                      else {
                                                                                        __yo_str __yo_ref_spill_45 = (__yo_str){ .ptr = (const uint8_t*)"42", .len = 2 };
                                                                                        __yo_t10 _file____User_temp_13430 = yo_id_4873((&(__yo_ref_spill_45)));
                                                                                        __yo_effect_escaped = 0;
                                                                                        bool _file____User_temp_13432 = yo_id_4111((__yo_t10)(__yo_test_idx), (__yo_t10)(_file____User_temp_13430));
switch ((_file____User_temp_13430).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13430).data.Some.value));
    break;
  }
  default: break;
}
                                                                                        if (__yo_effect_escaped) {
                                                                                          // Drop local variables before early return
switch ((_file____User_temp_13430).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_13430).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                                                          return;
                                                                                        }
                                                                                        if (_file____User_temp_13432) {
                                                                                          { // begin block
                                                                                            __yo_t10 _file____User_temp_14102 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"// --- Dependencies ---\n", .len = 24 });
                                                                                            __yo_t10 _file____User_temp_14103 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"other :: build.dependency(url: \"https://github.com/u/other.git\", ref: \"main\");\n", .len = 79 });
                                                                                            __yo_t10 _file____User_temp_14104 = yo_id_3607(_file____User_temp_14102, _file____User_temp_14103);
                                                                                            __yo_t10 _file____User_temp_14105 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"\n// --- Import list ---\n", .len = 24 });
                                                                                            __yo_t10 _file____User_temp_14106 = yo_id_3607(_file____User_temp_14104, _file____User_temp_14105);
                                                                                            __yo_t10 _file____User_temp_14107 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"imports :: ComptimeList(build.ImportEntry)(\n", .len = 44 });
                                                                                            __yo_t10 _file____User_temp_14108 = yo_id_3607(_file____User_temp_14106, _file____User_temp_14107);
                                                                                            __yo_t10 _file____User_temp_14109 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"  { name: \"other\", module: other.module() }\n", .len = 44 });
                                                                                            __yo_t10 _file____User_temp_14110 = yo_id_3607(_file____User_temp_14108, _file____User_temp_14109);
                                                                                            __yo_t10 _file____User_temp_14111 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)");\nexport(imports);\n", .len = 20 });
                                                                                            __yo_t10 _file____User_temp_14112 = yo_id_3607(_file____User_temp_14110, _file____User_temp_14111);
                                                                                            __yo_t10 content = _file____User_temp_14112;
                                                                                            __yo_t10 _file____User_temp_14113 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"mylib :: build.dependency(url: \"https://github.com/u/mylib.git\", ref: \"v1.0.0\");", .len = 80 });
                                                                                            __yo_t10 dep_line = _file____User_temp_14113;
                                                                                            __yo_effect_escaped = 0;
                                                                                            __yo_t10 _file____User_temp_14114 = yo_id_10277((__yo_t10)(content), (__yo_t10)(dep_line));
                                                                                            if (__yo_effect_escaped) {
                                                                                              // Drop local variables before early return
switch ((_file____User_temp_14102).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_14102).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_14103).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_14103).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_14104).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_14104).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_14105).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_14105).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_14106).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_14106).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_14107).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_14107).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_14108).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_14108).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_14109).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_14109).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_14110).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_14110).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_14111).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_14111).data.Some.value));
    break;
  }
  default: break;
}
switch ((content).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((content).data.Some.value));
    break;
  }
  default: break;
}
switch ((dep_line).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((dep_line).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                                                              return;
                                                                                            }
                                                                                            __yo_t10 result = _file____User_temp_14114;
                                                                                            bool _file____User_temp_14115 = yo_id_4279_String_id_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam0_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam1_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam2_usize_ret_bool(result, dep_line, 0ULL);
                                                                                            __yo_effect_escaped = 0;
                                                                                            yo_id_5002_str_id_str_rtparam0_bool_rtparam1_comptime_str_ret_unit((bool)(_file____User_temp_14115), (__yo_str)((__yo_str){ .ptr = (const uint8_t*)"new dep line present", .len = 20 }));
                                                                                            if (__yo_effect_escaped) {
                                                                                              // Drop local variables before early return
switch ((_file____User_temp_14102).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_14102).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_14103).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_14103).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_14104).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_14104).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_14105).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_14105).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_14106).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_14106).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_14107).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_14107).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_14108).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_14108).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_14109).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_14109).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_14110).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_14110).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_14111).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_14111).data.Some.value));
    break;
  }
  default: break;
}
switch ((content).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((content).data.Some.value));
    break;
  }
  default: break;
}
switch ((dep_line).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((dep_line).data.Some.value));
    break;
  }
  default: break;
}
switch ((result).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((result).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                                                              return;
                                                                                            }
                                                                                            __yo_t10 _file____User_temp_14117 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"other", .len = 5 });
                                                                                            bool _file____User_temp_14118 = yo_id_4279_String_id_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam0_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam1_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam2_usize_ret_bool(result, _file____User_temp_14117, 0ULL);
                                                                                            __yo_effect_escaped = 0;
                                                                                            yo_id_5002_str_id_str_rtparam0_bool_rtparam1_comptime_str_ret_unit((bool)(_file____User_temp_14118), (__yo_str)((__yo_str){ .ptr = (const uint8_t*)"existing dep preserved", .len = 22 }));
                                                                                            if (__yo_effect_escaped) {
                                                                                              // Drop local variables before early return
switch ((_file____User_temp_14102).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_14102).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_14103).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_14103).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_14104).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_14104).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_14105).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_14105).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_14106).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_14106).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_14107).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_14107).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_14108).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_14108).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_14109).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_14109).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_14110).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_14110).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_14111).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_14111).data.Some.value));
    break;
  }
  default: break;
}
switch ((content).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((content).data.Some.value));
    break;
  }
  default: break;
}
switch ((dep_line).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((dep_line).data.Some.value));
    break;
  }
  default: break;
}
switch ((result).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((result).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_14117).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_14117).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                                                              return;
                                                                                            }
                                                                                            __yo_t10 _file____User_temp_14120 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"mylib.module()", .len = 14 });
                                                                                            bool _file____User_temp_14121 = yo_id_4279_String_id_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam0_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam1_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam2_usize_ret_bool(result, _file____User_temp_14120, 0ULL);
                                                                                            __yo_effect_escaped = 0;
                                                                                            yo_id_5002_str_id_str_rtparam0_bool_rtparam1_comptime_str_ret_unit((bool)(_file____User_temp_14121), (__yo_str)((__yo_str){ .ptr = (const uint8_t*)"mylib in imports block", .len = 22 }));
                                                                                            if (__yo_effect_escaped) {
                                                                                              // Drop local variables before early return
switch ((_file____User_temp_14102).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_14102).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_14103).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_14103).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_14104).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_14104).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_14105).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_14105).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_14106).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_14106).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_14107).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_14107).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_14108).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_14108).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_14109).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_14109).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_14110).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_14110).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_14111).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_14111).data.Some.value));
    break;
  }
  default: break;
}
switch ((content).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((content).data.Some.value));
    break;
  }
  default: break;
}
switch ((dep_line).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((dep_line).data.Some.value));
    break;
  }
  default: break;
}
switch ((result).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((result).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_14117).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_14117).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_14120).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_14120).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
                                                                                              return;
                                                                                            }
switch ((_file____User_temp_14102).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_14102).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_14103).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_14103).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_14104).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_14104).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_14105).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_14105).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_14106).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_14106).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_14107).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_14107).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_14108).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_14108).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_14109).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_14109).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_14110).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_14110).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_14111).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_14111).data.Some.value));
    break;
  }
  default: break;
}
switch ((content).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((content).data.Some.value));
    break;
  }
  default: break;
}
switch ((dep_line).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((dep_line).data.Some.value));
    break;
  }
  default: break;
}
switch ((result).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((result).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_14117).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_14117).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_14120).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_14120).data.Some.value));
    break;
  }
  default: break;
}
                                                                                          } // end begin block
                                                                                        }
                                                                                        else {
                                                                                        }
                                                                                      }
                                                                                    }
                                                                                  }
                                                                                }
                                                                              }
                                                                            }
                                                                          }
                                                                        }
                                                                      }
                                                                    }
                                                                  }
                                                                }
                                                              }
                                                            }
                                                          }
                                                        }
                                                      }
                                                    }
                                                  }
                                                }
                                              }
                                            }
                                          }
                                        }
                                      }
                                    }
                                  }
                                }
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
    break;
  }
  case __YO_T9_NONE: {
    break;
  }
  }
switch ((_file____User_temp_13260).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_13260).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_13260).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
}
static inline bool yo_id_4111(__yo_t10 self, __yo_t10 other) {
  size_t _file____User_temp_3258;
  __yo_t11 _file____User_temp_3254 = self;
__yo_t11 temp_dup_enum_yo_id_12272 = _file____User_temp_3254;
switch ((temp_dup_enum_yo_id_12272).tag) {
  case __YO_T11_SOME: {
    (temp_dup_enum_yo_id_12272).data.Some.value = ((__yo_t0*)__yo_incr_rc((void*)((temp_dup_enum_yo_id_12272).data.Some.value)));
    break;
  }
  default: break;
}
  temp_dup_enum_yo_id_12272;
  switch ((_file____User_temp_3254).tag) {
  case __YO_T11_SOME: {
    __yo_t0* b = _file____User_temp_3254.data.Some.value;
    size_t _file____User_temp_3256 = yo_id_3119_rtparam0_R_gs_yo_id_3109_u8_ret_usize(b);
    _file____User_temp_3258 = _file____User_temp_3256;
    break;
  }
  case __YO_T11_NONE: {
    _file____User_temp_3258 = 0ULL;
    break;
  }
  }
  size_t self_len = _file____User_temp_3258;
  size_t _file____User_temp_3264;
  __yo_t11 _file____User_temp_3260 = other;
__yo_t11 temp_dup_enum_yo_id_12273 = _file____User_temp_3260;
switch ((temp_dup_enum_yo_id_12273).tag) {
  case __YO_T11_SOME: {
    (temp_dup_enum_yo_id_12273).data.Some.value = ((__yo_t0*)__yo_incr_rc((void*)((temp_dup_enum_yo_id_12273).data.Some.value)));
    break;
  }
  default: break;
}
  temp_dup_enum_yo_id_12273;
  switch ((_file____User_temp_3260).tag) {
  case __YO_T11_SOME: {
    __yo_t0* b = _file____User_temp_3260.data.Some.value;
    size_t _file____User_temp_3262 = yo_id_3119_rtparam0_R_gs_yo_id_3109_u8_ret_usize(b);
    _file____User_temp_3264 = _file____User_temp_3262;
    break;
  }
  case __YO_T11_NONE: {
    _file____User_temp_3264 = 0ULL;
    break;
  }
  }
  size_t other_len = _file____User_temp_3264;
  bool _file____User_temp_3293;
  if (((self_len) != (other_len))) {
    _file____User_temp_3293 = false;
  }
  else {
    if (((self_len) == (0ULL))) {
      _file____User_temp_3293 = true;
    }
    else {
      bool _file____User_temp_3292;
      __yo_t11 _file____User_temp_3272 = self;
__yo_t11 temp_dup_enum_yo_id_12274 = _file____User_temp_3272;
switch ((temp_dup_enum_yo_id_12274).tag) {
  case __YO_T11_SOME: {
    (temp_dup_enum_yo_id_12274).data.Some.value = ((__yo_t0*)__yo_incr_rc((void*)((temp_dup_enum_yo_id_12274).data.Some.value)));
    break;
  }
  default: break;
}
      temp_dup_enum_yo_id_12274;
      switch ((_file____User_temp_3272).tag) {
      case __YO_T11_SOME: {
        __yo_t0* self_al = _file____User_temp_3272.data.Some.value;
        bool _file____User_temp_3289;
        __yo_t11 _file____User_temp_3274 = other;
__yo_t11 temp_dup_enum_yo_id_12275 = _file____User_temp_3274;
switch ((temp_dup_enum_yo_id_12275).tag) {
  case __YO_T11_SOME: {
    (temp_dup_enum_yo_id_12275).data.Some.value = ((__yo_t0*)__yo_incr_rc((void*)((temp_dup_enum_yo_id_12275).data.Some.value)));
    break;
  }
  default: break;
}
        temp_dup_enum_yo_id_12275;
        switch ((_file____User_temp_3274).tag) {
        case __YO_T11_SOME: {
          __yo_t0* other_al = _file____User_temp_3274.data.Some.value;
          bool _file____User_temp_3286;
          uint8_t* _file____User_temp_3276 = yo_id_3122_rtparam0_R_gs_yo_id_3109_u8_ret_enum_yo_id_3118___u8_(self_al);
          if (_file____User_temp_3276 != NULL) {
            uint8_t* self_ptr = _file____User_temp_3276;
            bool _file____User_temp_3283;
            uint8_t* _file____User_temp_3278 = yo_id_3122_rtparam0_R_gs_yo_id_3109_u8_ret_enum_yo_id_3118___u8_(other_al);
            if (_file____User_temp_3278 != NULL) {
              uint8_t* other_ptr = _file____User_temp_3278;
              _file____User_temp_3283 = ((memcmp(((void*)(self_ptr)), ((void*)(other_ptr)), self_len)) == (((int)(0))));
            } else {
              _file____User_temp_3283 = false;
            }
            _file____User_temp_3286 = _file____User_temp_3283;
          } else {
            _file____User_temp_3286 = false;
          }
          _file____User_temp_3289 = _file____User_temp_3286;
          break;
        }
        case __YO_T11_NONE: {
          _file____User_temp_3289 = false;
          break;
        }
        }
switch ((_file____User_temp_3274).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_3274).data.Some.value));
    break;
  }
  default: break;
}
        _file____User_temp_3292 = _file____User_temp_3289;
        break;
      }
      case __YO_T11_NONE: {
        _file____User_temp_3292 = false;
        break;
      }
      }
switch ((_file____User_temp_3272).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_3272).data.Some.value));
    break;
  }
  default: break;
}
      _file____User_temp_3293 = _file____User_temp_3292;
    }
  }
  bool __yo_scope_ret = _file____User_temp_3293;
switch ((_file____User_temp_3254).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_3254).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_3260).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_3260).data.Some.value));
    break;
  }
  default: break;
}
  return __yo_scope_ret;
}
static inline void yo_id_3168_rtparam0_R_gs_yo_id_3109_u8_rtparam1_struct_yo_id_10___u8__ret_unit(__yo_t0* self, __yo_t46 tracer) {
  uint8_t* _file____User_temp_14182 = self->_ptr;
  if (_file____User_temp_14182 != NULL) {
    uint8_t* base = _file____User_temp_14182;
    size_t i = 0ULL;
    while (true) {
      if (!(((i) < (self->_length)))) {
        break;
      }
      { // begin block (loop body)
      yo_id_12_u8_id_u8_rtparam0_struct_yo_id_10___u8__rtparam1___u8__ret_unit(tracer, (base + i));
      size_t _file____User_temp_14192 = i; // Save old value for later use
      i = ((i) + (1ULL));
      _file____User_temp_14192;
      } // end begin block (loop body)
    }
    loop_yo_id_12276:;
  } else {
  }
}
static inline bool yo_id_4133(__yo_t10 self, __yo_str other) {
  size_t _file____User_temp_3305;
  __yo_t11 _file____User_temp_3301 = self;
__yo_t11 temp_dup_enum_yo_id_12277 = _file____User_temp_3301;
switch ((temp_dup_enum_yo_id_12277).tag) {
  case __YO_T11_SOME: {
    (temp_dup_enum_yo_id_12277).data.Some.value = ((__yo_t0*)__yo_incr_rc((void*)((temp_dup_enum_yo_id_12277).data.Some.value)));
    break;
  }
  default: break;
}
  temp_dup_enum_yo_id_12277;
  switch ((_file____User_temp_3301).tag) {
  case __YO_T11_SOME: {
    __yo_t0* b = _file____User_temp_3301.data.Some.value;
    size_t _file____User_temp_3303 = yo_id_3119_rtparam0_R_gs_yo_id_3109_u8_ret_usize(b);
    _file____User_temp_3305 = _file____User_temp_3303;
    break;
  }
  case __YO_T11_NONE: {
    _file____User_temp_3305 = 0ULL;
    break;
  }
  }
  size_t self_len = _file____User_temp_3305;
  size_t _file____User_temp_3306 = (other.len);
  size_t other_len = _file____User_temp_3306;
  bool _file____User_temp_3327;
  if (((self_len) != (other_len))) {
    _file____User_temp_3327 = false;
  }
  else {
    if (((self_len) == (0ULL))) {
      _file____User_temp_3327 = true;
    }
    else {
      bool _file____User_temp_3326;
      __yo_t11 _file____User_temp_3314 = self;
__yo_t11 temp_dup_enum_yo_id_12278 = _file____User_temp_3314;
switch ((temp_dup_enum_yo_id_12278).tag) {
  case __YO_T11_SOME: {
    (temp_dup_enum_yo_id_12278).data.Some.value = ((__yo_t0*)__yo_incr_rc((void*)((temp_dup_enum_yo_id_12278).data.Some.value)));
    break;
  }
  default: break;
}
      temp_dup_enum_yo_id_12278;
      switch ((_file____User_temp_3314).tag) {
      case __YO_T11_SOME: {
        __yo_t0* self_al = _file____User_temp_3314.data.Some.value;
        bool _file____User_temp_3323;
        uint8_t* _file____User_temp_3316 = yo_id_3122_rtparam0_R_gs_yo_id_3109_u8_ret_enum_yo_id_3118___u8_(self_al);
        if (_file____User_temp_3316 != NULL) {
          uint8_t* self_ptr = _file____User_temp_3316;
          _file____User_temp_3323 = ((memcmp(((void*)(self_ptr)), ((void*)(((uint8_t*)other.ptr))), self_len)) == (((int)(0))));
        } else {
          _file____User_temp_3323 = false;
        }
        _file____User_temp_3326 = _file____User_temp_3323;
        break;
      }
      case __YO_T11_NONE: {
        _file____User_temp_3326 = false;
        break;
      }
      }
switch ((_file____User_temp_3314).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_3314).data.Some.value));
    break;
  }
  default: break;
}
      _file____User_temp_3327 = _file____User_temp_3326;
    }
  }
  bool __yo_scope_ret = _file____User_temp_3327;
switch ((_file____User_temp_3301).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_3301).data.Some.value));
    break;
  }
  default: break;
}
  return __yo_scope_ret;
}
static inline __yo_t10 yo_id_4871(__yo_t10* self) {
__yo_t11 temp_dup_enum_yo_id_12279 = (*self);
switch ((temp_dup_enum_yo_id_12279).tag) {
  case __YO_T11_SOME: {
    (temp_dup_enum_yo_id_12279).data.Some.value = ((__yo_t0*)__yo_incr_rc((void*)((temp_dup_enum_yo_id_12279).data.Some.value)));
    break;
  }
  default: break;
}
  temp_dup_enum_yo_id_12279;
  return (*self);
}
static inline __yo_t10 yo_id_2712_rtparam0_enum_yo_id_3287_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_enum_yo_id_3272_usize_usize_ret_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8(__yo_t12 self) {
  __yo_t10 _file____User_temp_6256;
  switch ((self).tag) {
  case __YO_T12_OK: {
    __yo_t10 value = self.data.Ok.value;
    __yo_t10 _file____User_temp_6253 = value;
__yo_t11 temp_dup_enum_yo_id_12280 = _file____User_temp_6253;
switch ((temp_dup_enum_yo_id_12280).tag) {
  case __YO_T11_SOME: {
    (temp_dup_enum_yo_id_12280).data.Some.value = ((__yo_t0*)__yo_incr_rc((void*)((temp_dup_enum_yo_id_12280).data.Some.value)));
    break;
  }
  default: break;
}
    temp_dup_enum_yo_id_12280;
    _file____User_temp_6256 = _file____User_temp_6253;
    break;
  }
  case __YO_T12_ERR: {
    fprintf(stderr, "%s\n", "\"Called unwrap on an Error value\"");
    abort();
    _file____User_temp_6256 = (*((__yo_t10*)NULL));
    break;
  }
  }
  return _file____User_temp_6256;
}
static inline uint8_t* yo_id_2456_rtparam0_enum_yo_id_3118___u8__ret___u8_(uint8_t* self) {
  uint8_t* _file____User_temp_6338;
  if (self != NULL) {
    uint8_t* value = self;
    _file____User_temp_6338 = value;
  } else {
    fprintf(stderr, "%s\n", "\"Called unwrap on a None value\"");
    abort();
    _file____User_temp_6338 = (*((uint8_t**)NULL));
  }
  return _file____User_temp_6338;
}
static inline __yo_t23 yo_id_4224(__yo_t10 self, __yo_t10 haystack, size_t from_index) {
  __yo_t23 _file____User_temp_3416 = yo_id_3716(haystack, self, from_index);
  return _file____User_temp_3416;
}
static inline __yo_t10 yo_id_10277(__yo_t10 content, __yo_t10 dep_line) {
  __yo_t10 _file____User_temp_12326 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"// --- Dependencies ---", .len = 23 });
  __yo_t10 dep_marker = _file____User_temp_12326;
  __yo_t10 _file____User_temp_12327 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"// --- Import list ---", .len = 22 });
  __yo_t10 import_marker = _file____User_temp_12327;
  __yo_t23 _file____User_temp_12328 = yo_id_4281_String_id_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam0_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam1_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam2_usize_ret_enum_yo_id_3135_usize(content, dep_marker, 0ULL);
  __yo_t23 dep_marker_idx = _file____User_temp_12328;
  __yo_t10 _file____User_temp_12388;
  switch ((dep_marker_idx).tag) {
  case __YO_T23_SOME: {
    size_t d_idx = dep_marker_idx.data.Some.value;
    size_t _file____User_temp_12333 = yo_id_3414(dep_marker);
    size_t _file____User_temp_12335 = ((((d_idx) + (_file____User_temp_12333))) + (1ULL));
    size_t insert_pos = _file____User_temp_12335;
    __yo_t10 _file____User_temp_12340 = yo_id_3684(content, 0ULL, insert_pos);
    __yo_t10 _file____User_temp_12341 = yo_id_3607(_file____User_temp_12340, dep_line);
    size_t _file____User_temp_12342 = yo_id_3414(content);
    __yo_t10 _file____User_temp_12343 = yo_id_3684(content, insert_pos, _file____User_temp_12342);
    __yo_t10 _file____User_temp_12344 = yo_id_3607(_file____User_temp_12341, _file____User_temp_12343);
switch ((_file____User_temp_12340).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_12340).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_12341).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_12341).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_12343).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_12343).data.Some.value));
    break;
  }
  default: break;
}
    _file____User_temp_12388 = _file____User_temp_12344;
    break;
  }
  case __YO_T23_NONE: {
    __yo_t10 _file____User_temp_12387;
    __yo_t23 _file____User_temp_12347 = yo_id_4281_String_id_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam0_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam1_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam2_usize_ret_enum_yo_id_3135_usize(content, import_marker, 0ULL);
    switch ((_file____User_temp_12347).tag) {
    case __YO_T23_SOME: {
      size_t i_idx = _file____User_temp_12347.data.Some.value;
      __yo_t10 _file____User_temp_12360 = yo_id_3684(content, 0ULL, i_idx);
      __yo_t10 _file____User_temp_12361 = yo_id_3607(_file____User_temp_12360, dep_line);
      __yo_t10 _file____User_temp_12362 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"\n", .len = 1 });
      __yo_t10 _file____User_temp_12363 = yo_id_3607(_file____User_temp_12361, _file____User_temp_12362);
      size_t _file____User_temp_12364 = yo_id_3414(content);
      __yo_t10 _file____User_temp_12365 = yo_id_3684(content, i_idx, _file____User_temp_12364);
      __yo_t10 _file____User_temp_12367 = yo_id_3607(_file____User_temp_12363, _file____User_temp_12365);
switch ((_file____User_temp_12360).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_12360).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_12361).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_12361).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_12362).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_12362).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_12363).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_12363).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_12365).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_12365).data.Some.value));
    break;
  }
  default: break;
}
      _file____User_temp_12387 = _file____User_temp_12367;
      break;
    }
    case __YO_T23_NONE: {
      __yo_t10 _file____User_temp_12375;
      __yo_t10 _file____User_temp_12368 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"\n", .len = 1 });
      bool _file____User_temp_12370 = yo_id_4278_String_id_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam0_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam1_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam2_usize_ret_bool(content, _file____User_temp_12368, -1ULL);
switch ((_file____User_temp_12368).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_12368).data.Some.value));
    break;
  }
  default: break;
}
      if (_file____User_temp_12370) {
        __yo_t10 _file____User_temp_12372 = yo_id_3337();
        _file____User_temp_12375 = _file____User_temp_12372;
      }
      else {
        __yo_t10 _file____User_temp_12374 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"\n", .len = 1 });
        _file____User_temp_12375 = _file____User_temp_12374;
      }
      __yo_t10 suffix = _file____User_temp_12375;
      __yo_t10 _file____User_temp_12381 = yo_id_3607(content, suffix);
      __yo_t10 _file____User_temp_12382 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"\n", .len = 1 });
      __yo_t10 _file____User_temp_12383 = yo_id_3607(_file____User_temp_12381, _file____User_temp_12382);
      __yo_t10 _file____User_temp_12384 = yo_id_3607(_file____User_temp_12383, dep_line);
switch ((suffix).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((suffix).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_12381).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_12381).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_12382).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_12382).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_12383).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_12383).data.Some.value));
    break;
  }
  default: break;
}
      _file____User_temp_12387 = _file____User_temp_12384;
      break;
    }
    }
    _file____User_temp_12388 = _file____User_temp_12387;
    break;
  }
  }
  __yo_t10 content2 = _file____User_temp_12388;
  __yo_effect_escaped = 0;
  __yo_t10 _file____User_temp_12389 = yo_id_10154((__yo_t10)(content2));
  if (__yo_effect_escaped) {
    // Drop local variables before early return
switch ((dep_marker).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((dep_marker).data.Some.value));
    break;
  }
  default: break;
}
switch ((import_marker).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((import_marker).data.Some.value));
    break;
  }
  default: break;
}
switch ((content2).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((content2).data.Some.value));
    break;
  }
  default: break;
}
    return (__yo_t10){0};
  }
  __yo_t10 __yo_scope_ret = _file____User_temp_12389;
switch ((dep_marker).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((dep_marker).data.Some.value));
    break;
  }
  default: break;
}
switch ((import_marker).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((import_marker).data.Some.value));
    break;
  }
  default: break;
}
switch ((content2).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((content2).data.Some.value));
    break;
  }
  default: break;
}
  return __yo_scope_ret;
}
static inline __yo_t6 yo_id_3133_rtparam0_R_gs_yo_id_3109_R_struct_yo_id_9715_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_i32_i32_i32_rtparam1_R_struct_yo_id_9715_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_i32_i32_i32_ret_enum_yo_id_3132_unit_enum_yo_id_3108_enum_yo_id_3055_usize_usize(__yo_t31* self, __yo_t28* value) {
  __yo_t6 _file____User_temp_11846;
  if (((self->_length) >= (self->_capacity))) {
    size_t _file____User_temp_11798;
    if (((self->_capacity) == (0ULL))) {
      _file____User_temp_11798 = 4ULL;
    }
    else {
      _file____User_temp_11798 = ((self->_capacity) * (2ULL));
    }
    size_t new_capacity = _file____User_temp_11798;
    void* _file____User_temp_11806;
    __yo_t28** _file____User_temp_11800 = self->_ptr;
    if (_file____User_temp_11800 != NULL) {
      __yo_t28** old_ptr = _file____User_temp_11800;
      void* _file____User_temp_11803 = ((void*)(old_ptr));
      __yo_borrow_assert_unborrowed((void*)self);
      _file____User_temp_11806 = __yo_realloc(_file____User_temp_11803, ((8ULL) * (new_capacity)));
    } else {
      _file____User_temp_11806 = __yo_malloc(((8ULL) * (new_capacity)));
    }
    void* new_some_ptr = _file____User_temp_11806;
    __yo_t6 _file____User_temp_11827;
    if (new_some_ptr != NULL) {
      void* new_ptr = new_some_ptr;
      __yo_t28** typed_ptr = ((__yo_t28**)(new_ptr));
      __yo_t28** _file____User_temp_11809 = self->_ptr; // Save old value for later use
      __yo_t28** _file____User_temp_11808 = typed_ptr;
      self->_ptr = _file____User_temp_11808;
      _file____User_temp_11809;
      size_t _file____User_temp_11811 = self->_capacity; // Save old value for later use
      self->_capacity = new_capacity;
      _file____User_temp_11811;
      __yo_t28** _file____User_temp_11814 = (typed_ptr + self->_length);
      __yo_t28** target_ptr = _file____User_temp_11814;
      __yo_t28* _file____User_temp_11816 = (*target_ptr); // Save old value for later use
      ((__yo_t28*)__yo_incr_rc((void*)(value)));
      (*target_ptr) = value;
      _file____User_temp_11816;
      size_t _file____User_temp_11821 = self->_length; // Save old value for later use
      self->_length = ((self->_length) + (1ULL));
      _file____User_temp_11821;
      __yo_t6 _file____User_temp_11822 = (__yo_t6){ .tag = __YO_T6_OK };
      _file____User_temp_11827 = _file____User_temp_11822;
    } else {
      _file____User_temp_11827 = (__yo_t6){ .tag = __YO_T6_ERR, .data = { .Err = { .error = (__yo_t7){ .tag = __YO_T7_ALLOCERROR, .data = { .AllocError = { .error = __YO_T8_OUTOFMEMORY } } } } } };
    }
    _file____User_temp_11846 = _file____User_temp_11827;
  }
  else {
    __yo_t6 _file____User_temp_11844;
    __yo_t28** _file____User_temp_11830 = self->_ptr;
    if (_file____User_temp_11830 != NULL) {
      __yo_t28** _ptr = _file____User_temp_11830;
      __yo_t28** _file____User_temp_11832 = (_ptr + self->_length);
      __yo_t28** target_ptr = _file____User_temp_11832;
      __yo_t28* _file____User_temp_11834 = (*target_ptr); // Save old value for later use
      ((__yo_t28*)__yo_incr_rc((void*)(value)));
      (*target_ptr) = value;
      _file____User_temp_11834;
      size_t _file____User_temp_11839 = self->_length; // Save old value for later use
      self->_length = ((self->_length) + (1ULL));
      _file____User_temp_11839;
      __yo_t6 _file____User_temp_11840 = (__yo_t6){ .tag = __YO_T6_OK };
      _file____User_temp_11844 = _file____User_temp_11840;
    } else {
      fprintf(stderr, "%s\n", "\"ArrayList has capacity but no ptr\"");
      abort();
      _file____User_temp_11844 = (*((__yo_t6*)NULL));
    }
    _file____User_temp_11846 = _file____User_temp_11844;
  }
  return _file____User_temp_11846;
}
static inline bool yo_id_4214(__yo_t10 self, __yo_t10 haystack, size_t position) {
  bool _file____User_temp_3413 = yo_id_3872(haystack, self, position);
  return _file____User_temp_3413;
}
static inline void yo_id_12172(__yo_t0* self) {
  yo_id_3163_rtparam0_R_gs_yo_id_3109_u8_ret_unit(self);
}
static inline void yo_id_12_SemVer_id_R_struct_yo_id_9715_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_i32_i32_i32_rtparam0_struct_yo_id_10___u8__rtparam1___R_struct_yo_id_9715_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_i32_i32_i32__ret_unit(__yo_t46 self, __yo_t28** slot) {
  if ((*(slot))) { ((void(*)(void*))self)((*(slot))); }
  ((void)0);
}
static inline __yo_t0* yo_id_3393(__yo_t10 self) {
  size_t _file____User_temp_1576;
  __yo_t11 _file____User_temp_1572 = self;
__yo_t11 temp_dup_enum_yo_id_12281 = _file____User_temp_1572;
switch ((temp_dup_enum_yo_id_12281).tag) {
  case __YO_T11_SOME: {
    (temp_dup_enum_yo_id_12281).data.Some.value = ((__yo_t0*)__yo_incr_rc((void*)((temp_dup_enum_yo_id_12281).data.Some.value)));
    break;
  }
  default: break;
}
  temp_dup_enum_yo_id_12281;
  switch ((_file____User_temp_1572).tag) {
  case __YO_T11_SOME: {
    __yo_t0* b = _file____User_temp_1572.data.Some.value;
    size_t _file____User_temp_1574 = yo_id_3119_rtparam0_R_gs_yo_id_3109_u8_ret_usize(b);
    _file____User_temp_1576 = _file____User_temp_1574;
    break;
  }
  case __YO_T11_NONE: {
    _file____User_temp_1576 = 0ULL;
    break;
  }
  }
  size_t bytes_len = _file____User_temp_1576;
  __yo_t0* _file____User_temp_1578 = yo_id_3130_rtparam0_usize_ret_R_gs_yo_id_3109_u8((size_t)(((bytes_len) + (1ULL))));
  __yo_t0* bytes_with_null = _file____User_temp_1578;
  __yo_t11 _file____User_temp_1580 = self;
__yo_t11 temp_dup_enum_yo_id_12282 = _file____User_temp_1580;
switch ((temp_dup_enum_yo_id_12282).tag) {
  case __YO_T11_SOME: {
    (temp_dup_enum_yo_id_12282).data.Some.value = ((__yo_t0*)__yo_incr_rc((void*)((temp_dup_enum_yo_id_12282).data.Some.value)));
    break;
  }
  default: break;
}
  temp_dup_enum_yo_id_12282;
  switch ((_file____User_temp_1580).tag) {
  case __YO_T11_SOME: {
    __yo_t0* b = _file____User_temp_1580.data.Some.value;
    uint8_t* _file____User_temp_1584 = yo_id_3122_rtparam0_R_gs_yo_id_3109_u8_ret_enum_yo_id_3118___u8_(b);
    if (_file____User_temp_1584 != NULL) {
      uint8_t* src = _file____User_temp_1584;
      yo_id_3149_rtparam0_R_gs_yo_id_3109_u8_rtparam1___u8__rtparam2_usize_ret_unit(bytes_with_null, src, bytes_len);
    } else {
    }
    break;
  }
  case __YO_T11_NONE: {
    break;
  }
  }
  __yo_t6 _file____User_temp_1655 = yo_id_3133_rtparam0_R_gs_yo_id_3109_u8_rtparam1_u8_ret_enum_yo_id_3132_unit_enum_yo_id_3108_enum_yo_id_3055_usize_usize(bytes_with_null, 0);
  // Drop local variables before early return
switch ((_file____User_temp_1572).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_1572).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_1580).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_1580).data.Some.value));
    break;
  }
  default: break;
}
  return bytes_with_null;
}
static inline __yo_t10 yo_id_4873(__yo_str* self) {
  __yo_t10 _file____User_temp_4504 = yo_id_3356((*self));
  return _file____User_temp_4504;
}
static inline uint8_t* yo_id_3158_rtparam0_R_gs_yo_id_3109_u8_rtparam1_usize_ret___u8_(__yo_t0** self, size_t idx) {
  if (((idx) >= ((*self)->_length))) {
    fprintf(stderr, "%s\n", "\"ArrayList: index out of bounds\"");
    abort();
    (*((uint8_t**)NULL));
  }
  else {
  }
  uint8_t* _file____User_temp_2150;
  uint8_t* _file____User_temp_2146 = (*self)->_ptr;
  if (_file____User_temp_2146 != NULL) {
    uint8_t* _ptr = _file____User_temp_2146;
    _file____User_temp_2150 = (_ptr + idx);
  } else {
    fprintf(stderr, "%s\n", "\"ArrayList: index on empty list\"");
    abort();
    _file____User_temp_2150 = (*((uint8_t**)NULL));
  }
  return _file____User_temp_2150;
}
static inline __yo_t6 yo_id_3133_rtparam0_R_gs_yo_id_3109_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam1_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_ret_enum_yo_id_3132_unit_enum_yo_id_3108_enum_yo_id_3055_usize_usize(__yo_t16* self, __yo_t10 value) {
  __yo_t6 _file____User_temp_6321;
  if (((self->_length) >= (self->_capacity))) {
    size_t _file____User_temp_6273;
    if (((self->_capacity) == (0ULL))) {
      _file____User_temp_6273 = 4ULL;
    }
    else {
      _file____User_temp_6273 = ((self->_capacity) * (2ULL));
    }
    size_t new_capacity = _file____User_temp_6273;
    void* _file____User_temp_6281;
    __yo_t10* _file____User_temp_6275 = self->_ptr;
    if (_file____User_temp_6275 != NULL) {
      __yo_t10* old_ptr = _file____User_temp_6275;
      void* _file____User_temp_6278 = ((void*)(old_ptr));
      __yo_borrow_assert_unborrowed((void*)self);
      _file____User_temp_6281 = __yo_realloc(_file____User_temp_6278, ((16ULL) * (new_capacity)));
    } else {
      _file____User_temp_6281 = __yo_malloc(((16ULL) * (new_capacity)));
    }
    void* new_some_ptr = _file____User_temp_6281;
    __yo_t6 _file____User_temp_6302;
    if (new_some_ptr != NULL) {
      void* new_ptr = new_some_ptr;
      __yo_t10* typed_ptr = ((__yo_t10*)(new_ptr));
      __yo_t10* _file____User_temp_6284 = self->_ptr; // Save old value for later use
      __yo_t10* _file____User_temp_6283 = typed_ptr;
      self->_ptr = _file____User_temp_6283;
      _file____User_temp_6284;
      size_t _file____User_temp_6286 = self->_capacity; // Save old value for later use
      self->_capacity = new_capacity;
      _file____User_temp_6286;
      __yo_t10* _file____User_temp_6289 = (typed_ptr + self->_length);
      __yo_t10* target_ptr = _file____User_temp_6289;
      __yo_t10 _file____User_temp_6291 = (*target_ptr); // Save old value for later use
__yo_t11 temp_dup_enum_yo_id_12283 = value;
switch ((temp_dup_enum_yo_id_12283).tag) {
  case __YO_T11_SOME: {
    (temp_dup_enum_yo_id_12283).data.Some.value = ((__yo_t0*)__yo_incr_rc((void*)((temp_dup_enum_yo_id_12283).data.Some.value)));
    break;
  }
  default: break;
}
      temp_dup_enum_yo_id_12283;
      (*target_ptr) = value;
      _file____User_temp_6291;
      size_t _file____User_temp_6296 = self->_length; // Save old value for later use
      self->_length = ((self->_length) + (1ULL));
      _file____User_temp_6296;
      __yo_t6 _file____User_temp_6297 = (__yo_t6){ .tag = __YO_T6_OK };
      _file____User_temp_6302 = _file____User_temp_6297;
    } else {
      _file____User_temp_6302 = (__yo_t6){ .tag = __YO_T6_ERR, .data = { .Err = { .error = (__yo_t7){ .tag = __YO_T7_ALLOCERROR, .data = { .AllocError = { .error = __YO_T8_OUTOFMEMORY } } } } } };
    }
    _file____User_temp_6321 = _file____User_temp_6302;
  }
  else {
    __yo_t6 _file____User_temp_6319;
    __yo_t10* _file____User_temp_6305 = self->_ptr;
    if (_file____User_temp_6305 != NULL) {
      __yo_t10* _ptr = _file____User_temp_6305;
      __yo_t10* _file____User_temp_6307 = (_ptr + self->_length);
      __yo_t10* target_ptr = _file____User_temp_6307;
      __yo_t10 _file____User_temp_6309 = (*target_ptr); // Save old value for later use
__yo_t11 temp_dup_enum_yo_id_12284 = value;
switch ((temp_dup_enum_yo_id_12284).tag) {
  case __YO_T11_SOME: {
    (temp_dup_enum_yo_id_12284).data.Some.value = ((__yo_t0*)__yo_incr_rc((void*)((temp_dup_enum_yo_id_12284).data.Some.value)));
    break;
  }
  default: break;
}
      temp_dup_enum_yo_id_12284;
      (*target_ptr) = value;
      _file____User_temp_6309;
      size_t _file____User_temp_6314 = self->_length; // Save old value for later use
      self->_length = ((self->_length) + (1ULL));
      _file____User_temp_6314;
      __yo_t6 _file____User_temp_6315 = (__yo_t6){ .tag = __YO_T6_OK };
      _file____User_temp_6319 = _file____User_temp_6315;
    } else {
      fprintf(stderr, "%s\n", "\"ArrayList has capacity but no ptr\"");
      abort();
      _file____User_temp_6319 = (*((__yo_t6*)NULL));
    }
    _file____User_temp_6321 = _file____User_temp_6319;
  }
  return _file____User_temp_6321;
}
static inline __yo_t10 yo_id_9731(__yo_t10 url) {
  __yo_t10 _file____User_temp_11504 = yo_id_4570((&(url)));
  __yo_t10 s = _file____User_temp_11504;
  __yo_t10 _file____User_temp_11517;
  __yo_t10 _file____User_temp_11506 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)".git", .len = 4 });
  bool _file____User_temp_11510 = yo_id_4278_String_id_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam0_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam1_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam2_usize_ret_bool(s, _file____User_temp_11506, -1ULL);
switch ((_file____User_temp_11506).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_11506).data.Some.value));
    break;
  }
  default: break;
}
  if (_file____User_temp_11510) {
    size_t _file____User_temp_11512 = yo_id_3669(s);
    __yo_t10 _file____User_temp_11515 = yo_id_3684(s, 0ULL, ((_file____User_temp_11512) - (4ULL)));
    _file____User_temp_11517 = _file____User_temp_11515;
  }
  else {
    __yo_t10 _file____User_temp_11516 = s;
__yo_t11 temp_dup_enum_yo_id_12285 = _file____User_temp_11516;
switch ((temp_dup_enum_yo_id_12285).tag) {
  case __YO_T11_SOME: {
    (temp_dup_enum_yo_id_12285).data.Some.value = ((__yo_t0*)__yo_incr_rc((void*)((temp_dup_enum_yo_id_12285).data.Some.value)));
    break;
  }
  default: break;
}
    temp_dup_enum_yo_id_12285;
    _file____User_temp_11517 = _file____User_temp_11516;
  }
  __yo_t10 s2 = _file____User_temp_11517;
  __yo_t10 _file____User_temp_11528;
  __yo_t10 _file____User_temp_11518 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"/", .len = 1 });
  __yo_t23 _file____User_temp_11522 = yo_id_4283_String_id_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam0_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam1_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam2_usize_ret_enum_yo_id_3135_usize(s2, _file____User_temp_11518, -1ULL);
switch ((_file____User_temp_11518).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_11518).data.Some.value));
    break;
  }
  default: break;
}
  switch ((_file____User_temp_11522).tag) {
  case __YO_T23_NONE: {
    __yo_t10 _file____User_temp_11523 = s2;
__yo_t11 temp_dup_enum_yo_id_12286 = _file____User_temp_11523;
switch ((temp_dup_enum_yo_id_12286).tag) {
  case __YO_T11_SOME: {
    (temp_dup_enum_yo_id_12286).data.Some.value = ((__yo_t0*)__yo_incr_rc((void*)((temp_dup_enum_yo_id_12286).data.Some.value)));
    break;
  }
  default: break;
}
    temp_dup_enum_yo_id_12286;
    _file____User_temp_11528 = _file____User_temp_11523;
    break;
  }
  case __YO_T23_SOME: {
    size_t idx = _file____User_temp_11522.data.Some.value;
    size_t _file____User_temp_11525 = yo_id_3669(s2);
    __yo_t10 _file____User_temp_11527 = yo_id_3684(s2, ((idx) + (1ULL)), _file____User_temp_11525);
    _file____User_temp_11528 = _file____User_temp_11527;
    break;
  }
  }
  __yo_t10 __yo_scope_ret = _file____User_temp_11528;
switch ((s).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((s).data.Some.value));
    break;
  }
  default: break;
}
switch ((s2).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((s2).data.Some.value));
    break;
  }
  default: break;
}
  return __yo_scope_ret;
}
static inline bool yo_id_4279_String_id_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam0_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam1_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam2_usize_ret_bool(__yo_t10 self, __yo_t10 substr, size_t from_index) {
  bool _file____User_temp_12029 = yo_id_4220(substr, self, from_index);
  return _file____User_temp_12029;
}
static inline __yo_t23 yo_id_4283_String_id_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam0_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam1_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam2_usize_ret_enum_yo_id_3135_usize(__yo_t10 self, __yo_t10 substr, size_t from_index) {
  __yo_t23 _file____User_temp_11520 = yo_id_4228(substr, self, from_index);
  return _file____User_temp_11520;
}
static inline __yo_t23 yo_id_3716(__yo_t10 self, __yo_t10 substr, size_t from_index) {
  __yo_t23 _file____User_temp_2295;
  bool _file____User_temp_2202 = yo_id_3427(substr);
  if (_file____User_temp_2202) {
    __yo_t23 _file____User_temp_2204 = (__yo_t23){ .tag = __YO_T23_SOME, .data = { .Some = { .value = from_index } } };
    _file____User_temp_2295 = _file____User_temp_2204;
  }
  else {
    size_t _file____User_temp_2210;
    __yo_t11 _file____User_temp_2206 = self;
__yo_t11 temp_dup_enum_yo_id_12287 = _file____User_temp_2206;
switch ((temp_dup_enum_yo_id_12287).tag) {
  case __YO_T11_SOME: {
    (temp_dup_enum_yo_id_12287).data.Some.value = ((__yo_t0*)__yo_incr_rc((void*)((temp_dup_enum_yo_id_12287).data.Some.value)));
    break;
  }
  default: break;
}
    temp_dup_enum_yo_id_12287;
    switch ((_file____User_temp_2206).tag) {
    case __YO_T11_SOME: {
      __yo_t0* b = _file____User_temp_2206.data.Some.value;
      size_t _file____User_temp_2208 = yo_id_3119_rtparam0_R_gs_yo_id_3109_u8_ret_usize(b);
      _file____User_temp_2210 = _file____User_temp_2208;
      break;
    }
    case __YO_T11_NONE: {
      _file____User_temp_2210 = 0ULL;
      break;
    }
    }
    size_t self_bytes = _file____User_temp_2210;
    size_t _file____User_temp_2216;
    __yo_t11 _file____User_temp_2212 = substr;
__yo_t11 temp_dup_enum_yo_id_12288 = _file____User_temp_2212;
switch ((temp_dup_enum_yo_id_12288).tag) {
  case __YO_T11_SOME: {
    (temp_dup_enum_yo_id_12288).data.Some.value = ((__yo_t0*)__yo_incr_rc((void*)((temp_dup_enum_yo_id_12288).data.Some.value)));
    break;
  }
  default: break;
}
    temp_dup_enum_yo_id_12288;
    switch ((_file____User_temp_2212).tag) {
    case __YO_T11_SOME: {
      __yo_t0* b = _file____User_temp_2212.data.Some.value;
      size_t _file____User_temp_2214 = yo_id_3119_rtparam0_R_gs_yo_id_3109_u8_ret_usize(b);
      _file____User_temp_2216 = _file____User_temp_2214;
      break;
    }
    case __YO_T11_NONE: {
      _file____User_temp_2216 = 0ULL;
      break;
    }
    }
    size_t sub_bytes = _file____User_temp_2216;
    __yo_t23 _file____User_temp_2293;
    if (((sub_bytes) > (self_bytes))) {
      _file____User_temp_2293 = (__yo_t23){ .tag = __YO_T23_NONE };
    }
    else {
      __yo_t23 _file____User_temp_2292;
      __yo_t11 _file____User_temp_2221 = self;
__yo_t11 temp_dup_enum_yo_id_12289 = _file____User_temp_2221;
switch ((temp_dup_enum_yo_id_12289).tag) {
  case __YO_T11_SOME: {
    (temp_dup_enum_yo_id_12289).data.Some.value = ((__yo_t0*)__yo_incr_rc((void*)((temp_dup_enum_yo_id_12289).data.Some.value)));
    break;
  }
  default: break;
}
      temp_dup_enum_yo_id_12289;
      switch ((_file____User_temp_2221).tag) {
      case __YO_T11_NONE: {
        _file____User_temp_2292 = (__yo_t23){ .tag = __YO_T23_NONE };
        break;
      }
      case __YO_T11_SOME: {
        __yo_t0* self_al = _file____User_temp_2221.data.Some.value;
        __yo_t23 _file____User_temp_2290;
        __yo_t11 _file____User_temp_2224 = substr;
__yo_t11 temp_dup_enum_yo_id_12290 = _file____User_temp_2224;
switch ((temp_dup_enum_yo_id_12290).tag) {
  case __YO_T11_SOME: {
    (temp_dup_enum_yo_id_12290).data.Some.value = ((__yo_t0*)__yo_incr_rc((void*)((temp_dup_enum_yo_id_12290).data.Some.value)));
    break;
  }
  default: break;
}
        temp_dup_enum_yo_id_12290;
        switch ((_file____User_temp_2224).tag) {
        case __YO_T11_NONE: {
          _file____User_temp_2290 = (__yo_t23){ .tag = __YO_T23_NONE };
          break;
        }
        case __YO_T11_SOME: {
          __yo_t0* sub_al = _file____User_temp_2224.data.Some.value;
          size_t char_index = 0ULL;
          size_t byte_index = 0ULL;
          while (true) {
            bool __yo_sc_yo_id_12293 = false;
            if (((byte_index) < (self_bytes))) {
              __yo_sc_yo_id_12293 = ((char_index) < (from_index));
            }
            if (!(__yo_sc_yo_id_12293)) {
              break;
            }
            { // begin block (loop body)
            __yo_t20 _file____User_temp_2229 = yo_id_3138_rtparam0_R_gs_yo_id_3109_u8_rtparam1_usize_ret_enum_yo_id_3135_u8(self_al, byte_index);
            __yo_t20 first_byte_opt = _file____User_temp_2229;
            switch ((first_byte_opt).tag) {
            case __YO_T20_SOME: {
              uint8_t first_byte = first_byte_opt.data.Some.value;
              bool __yo_sc_yo_id_12294 = true;
              if (!(((first_byte) < (128)))) {
                __yo_sc_yo_id_12294 = ((first_byte) >= (192));
              }
              bool is_start = __yo_sc_yo_id_12294;
              if (is_start) {
                size_t _file____User_temp_2233 = char_index; // Save old value for later use
                char_index = ((char_index) + (1ULL));
              }
              else {
              }
              break;
            }
            case __YO_T20_NONE: {
              break;
            }
            }
            } // end begin block (loop body)
          continue_yo_id_12292:;
            byte_index = ((byte_index) + (1ULL));
          }
          loop_yo_id_12291:;
          while (true) {
            if (!(((byte_index) <= (((self_bytes) - (sub_bytes)))))) {
              break;
            }
            { // begin block (loop body)
            bool matches = true;
            size_t j = 0ULL;
            while (true) {
              if (!(((j) < (sub_bytes)))) {
                break;
              }
              { // begin block (loop body)
              __yo_t20 _file____User_temp_2250 = yo_id_3138_rtparam0_R_gs_yo_id_3109_u8_rtparam1_usize_ret_enum_yo_id_3135_u8(self_al, ((byte_index) + (j)));
              __yo_t20 self_byte_opt = _file____User_temp_2250;
              __yo_t20 _file____User_temp_2251 = yo_id_3138_rtparam0_R_gs_yo_id_3109_u8_rtparam1_usize_ret_enum_yo_id_3135_u8(sub_al, j);
              __yo_t20 sub_byte_opt = _file____User_temp_2251;
              switch ((self_byte_opt).tag) {
              case __YO_T20_SOME: {
                uint8_t self_byte = self_byte_opt.data.Some.value;
                switch ((sub_byte_opt).tag) {
                case __YO_T20_SOME: {
                  uint8_t sub_byte = sub_byte_opt.data.Some.value;
                  if (((self_byte) != (sub_byte))) {
                    bool _file____User_temp_2254 = matches; // Save old value for later use
                    matches = false;
                    goto loop_yo_id_12297;
                  }
                  else {
                  }
                  break;
                }
                case __YO_T20_NONE: {
                  bool _file____User_temp_2259 = matches; // Save old value for later use
                  matches = false;
                  _file____User_temp_2259;
                  goto loop_yo_id_12297;
                  break;
                }
                }
                break;
              }
              case __YO_T20_NONE: {
                bool _file____User_temp_2263 = matches; // Save old value for later use
                matches = false;
                _file____User_temp_2263;
                goto loop_yo_id_12297;
                break;
              }
              }
              } // end begin block (loop body)
            continue_yo_id_12298:;
              j = ((j) + (1ULL));
            }
            loop_yo_id_12297:;
            if (matches) {
              __yo_t23 _file____User_temp_2269 = (__yo_t23){ .tag = __YO_T23_SOME, .data = { .Some = { .value = char_index } } };
              // Drop local variables before early return
switch ((_file____User_temp_2206).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_2206).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_2212).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_2212).data.Some.value));
    break;
  }
  default: break;
}
              return _file____User_temp_2269;
            }
            else {
            }
            __yo_t20 _file____User_temp_2273 = yo_id_3138_rtparam0_R_gs_yo_id_3109_u8_rtparam1_usize_ret_enum_yo_id_3135_u8(self_al, byte_index);
            __yo_t20 first_byte_opt = _file____User_temp_2273;
            switch ((first_byte_opt).tag) {
            case __YO_T20_SOME: {
              uint8_t first_byte = first_byte_opt.data.Some.value;
              bool __yo_sc_yo_id_12299 = true;
              if (!(((first_byte) < (128)))) {
                __yo_sc_yo_id_12299 = ((first_byte) >= (192));
              }
              bool is_start = __yo_sc_yo_id_12299;
              if (is_start) {
                size_t _file____User_temp_2277 = char_index; // Save old value for later use
                char_index = ((char_index) + (1ULL));
              }
              else {
              }
              break;
            }
            case __YO_T20_NONE: {
              break;
            }
            }
            } // end begin block (loop body)
          continue_yo_id_12296:;
            byte_index = ((byte_index) + (1ULL));
          }
          loop_yo_id_12295:;
          __yo_t23 _file____User_temp_2287 = (__yo_t23){ .tag = __YO_T23_NONE };
          // Drop local variables before early return
switch ((_file____User_temp_2206).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_2206).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_2212).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_2212).data.Some.value));
    break;
  }
  default: break;
}
          return _file____User_temp_2287;
          break;
        }
        }
switch ((_file____User_temp_2224).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_2224).data.Some.value));
    break;
  }
  default: break;
}
        _file____User_temp_2292 = _file____User_temp_2290;
        break;
      }
      }
switch ((_file____User_temp_2221).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_2221).data.Some.value));
    break;
  }
  default: break;
}
      _file____User_temp_2293 = _file____User_temp_2292;
    }
    _file____User_temp_2295 = _file____User_temp_2293;
switch ((_file____User_temp_2206).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_2206).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_2212).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_2212).data.Some.value));
    break;
  }
  default: break;
}
  }
  return _file____User_temp_2295;
}
static inline __yo_t16* yo_id_10027(__yo_t10 content) {
  __yo_t16* _file____User_temp_12033 = yo_id_3124__ret_R_gs_yo_id_3109_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8();
  __yo_t16* names = _file____User_temp_12033;
  __yo_t10 _file____User_temp_12036 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"\n", .len = 1 });
  __yo_t16* _file____User_temp_12037 = yo_id_4285_String_id_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam0_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam1_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_ret_R_gs_yo_id_3109_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8(content, _file____User_temp_12036);
  __yo_t16* all_lines = _file____User_temp_12037;
  size_t _file____User_temp_12038 = yo_id_3119_rtparam0_R_gs_yo_id_3109_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_ret_usize(all_lines);
  size_t n = _file____User_temp_12038;
  size_t i = 0ULL;
  while (true) {
    if (!(((i) < (n)))) {
      break;
    }
    { // begin block (loop body)
    __yo_t9 _file____User_temp_12042 = yo_id_3138_rtparam0_R_gs_yo_id_3109_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam1_usize_ret_enum_yo_id_3135_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8(all_lines, i);
    switch ((_file____User_temp_12042).tag) {
    case __YO_T9_NONE: {
      break;
    }
    case __YO_T9_SOME: {
      __yo_t10 line = _file____User_temp_12042.data.Some.value;
      __yo_t10 _file____User_temp_12044 = yo_id_4027(line);
      __yo_t10 trimmed = _file____User_temp_12044;
      __yo_t10 _file____User_temp_12045 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)":: build.dependency(", .len = 20 });
      bool _file____User_temp_12046 = yo_id_4279_String_id_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam0_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam1_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam2_usize_ret_bool(trimmed, _file____User_temp_12045, 0ULL);
      bool has_git = _file____User_temp_12046;
      __yo_t10 _file____User_temp_12047 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)":: build.path_dependency(", .len = 25 });
      bool _file____User_temp_12048 = yo_id_4279_String_id_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam0_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam1_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam2_usize_ret_bool(trimmed, _file____User_temp_12047, 0ULL);
      bool has_path = _file____User_temp_12048;
      bool __yo_sc_yo_id_12301 = true;
      if (!(has_git)) {
        __yo_sc_yo_id_12301 = has_path;
      }
      if (__yo_sc_yo_id_12301) {
        __yo_t10 _file____User_temp_12051 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)" ::", .len = 3 });
        __yo_t10 sep = _file____User_temp_12051;
        __yo_t23 _file____User_temp_12055 = yo_id_4281_String_id_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam0_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam1_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam2_usize_ret_enum_yo_id_3135_usize(trimmed, sep, 0ULL);
        switch ((_file____User_temp_12055).tag) {
        case __YO_T23_NONE: {
          break;
        }
        case __YO_T23_SOME: {
          size_t sep_idx = _file____User_temp_12055.data.Some.value;
          __yo_t10 _file____User_temp_12058 = yo_id_3684(trimmed, 0ULL, sep_idx);
          __yo_t10 _file____User_temp_12059 = yo_id_4027(_file____User_temp_12058);
          __yo_t10 name = _file____User_temp_12059;
          size_t _file____User_temp_12062 = yo_id_3414(name);
          if (((_file____User_temp_12062) > (0ULL))) {
            __yo_t6 _file____User_temp_12128 = yo_id_3133_rtparam0_R_gs_yo_id_3109_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam1_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_ret_enum_yo_id_3132_unit_enum_yo_id_3108_enum_yo_id_3055_usize_usize(names, name);
          }
          else {
          }
switch ((_file____User_temp_12058).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_12058).data.Some.value));
    break;
  }
  default: break;
}
switch ((name).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((name).data.Some.value));
    break;
  }
  default: break;
}
          break;
        }
        }
switch ((sep).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((sep).data.Some.value));
    break;
  }
  default: break;
}
      }
      else {
      }
switch ((trimmed).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((trimmed).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_12045).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_12045).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_12047).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_12047).data.Some.value));
    break;
  }
  default: break;
}
      break;
    }
    }
    size_t _file____User_temp_12140 = i; // Save old value for later use
    i = ((i) + (1ULL));
    _file____User_temp_12140;
switch ((_file____User_temp_12042).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_12042).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_12042).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
    } // end begin block (loop body)
  }
  loop_yo_id_12300:;
  __yo_t16* __yo_scope_ret = names;
switch ((_file____User_temp_12036).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_12036).data.Some.value));
    break;
  }
  default: break;
}
  __yo_decr_rc((void*)(all_lines));
  return __yo_scope_ret;
}
static inline bool yo_id_3872(__yo_t10 self, __yo_t10 prefix, size_t position) {
  size_t _file____User_temp_2668;
  __yo_t11 _file____User_temp_2664 = prefix;
__yo_t11 temp_dup_enum_yo_id_12302 = _file____User_temp_2664;
switch ((temp_dup_enum_yo_id_12302).tag) {
  case __YO_T11_SOME: {
    (temp_dup_enum_yo_id_12302).data.Some.value = ((__yo_t0*)__yo_incr_rc((void*)((temp_dup_enum_yo_id_12302).data.Some.value)));
    break;
  }
  default: break;
}
  temp_dup_enum_yo_id_12302;
  switch ((_file____User_temp_2664).tag) {
  case __YO_T11_SOME: {
    __yo_t0* b = _file____User_temp_2664.data.Some.value;
    size_t _file____User_temp_2666 = yo_id_3119_rtparam0_R_gs_yo_id_3109_u8_ret_usize(b);
    _file____User_temp_2668 = _file____User_temp_2666;
    break;
  }
  case __YO_T11_NONE: {
    _file____User_temp_2668 = 0ULL;
    break;
  }
  }
  size_t prefix_bytes = _file____User_temp_2668;
  size_t _file____User_temp_2674;
  __yo_t11 _file____User_temp_2670 = self;
__yo_t11 temp_dup_enum_yo_id_12303 = _file____User_temp_2670;
switch ((temp_dup_enum_yo_id_12303).tag) {
  case __YO_T11_SOME: {
    (temp_dup_enum_yo_id_12303).data.Some.value = ((__yo_t0*)__yo_incr_rc((void*)((temp_dup_enum_yo_id_12303).data.Some.value)));
    break;
  }
  default: break;
}
  temp_dup_enum_yo_id_12303;
  switch ((_file____User_temp_2670).tag) {
  case __YO_T11_SOME: {
    __yo_t0* b = _file____User_temp_2670.data.Some.value;
    size_t _file____User_temp_2672 = yo_id_3119_rtparam0_R_gs_yo_id_3109_u8_ret_usize(b);
    _file____User_temp_2674 = _file____User_temp_2672;
    break;
  }
  case __YO_T11_NONE: {
    _file____User_temp_2674 = 0ULL;
    break;
  }
  }
  size_t self_bytes = _file____User_temp_2674;
  bool _file____User_temp_2756;
  if (((prefix_bytes) == (0ULL))) {
    _file____User_temp_2756 = true;
  }
  else {
    bool _file____User_temp_2755;
    __yo_t11 _file____User_temp_2679 = self;
__yo_t11 temp_dup_enum_yo_id_12304 = _file____User_temp_2679;
switch ((temp_dup_enum_yo_id_12304).tag) {
  case __YO_T11_SOME: {
    (temp_dup_enum_yo_id_12304).data.Some.value = ((__yo_t0*)__yo_incr_rc((void*)((temp_dup_enum_yo_id_12304).data.Some.value)));
    break;
  }
  default: break;
}
    temp_dup_enum_yo_id_12304;
    switch ((_file____User_temp_2679).tag) {
    case __YO_T11_NONE: {
      _file____User_temp_2755 = false;
      break;
    }
    case __YO_T11_SOME: {
      __yo_t0* self_al = _file____User_temp_2679.data.Some.value;
      bool _file____User_temp_2753;
      __yo_t11 _file____User_temp_2682 = prefix;
__yo_t11 temp_dup_enum_yo_id_12305 = _file____User_temp_2682;
switch ((temp_dup_enum_yo_id_12305).tag) {
  case __YO_T11_SOME: {
    (temp_dup_enum_yo_id_12305).data.Some.value = ((__yo_t0*)__yo_incr_rc((void*)((temp_dup_enum_yo_id_12305).data.Some.value)));
    break;
  }
  default: break;
}
      temp_dup_enum_yo_id_12305;
      switch ((_file____User_temp_2682).tag) {
      case __YO_T11_NONE: {
        _file____User_temp_2753 = true;
        break;
      }
      case __YO_T11_SOME: {
        __yo_t0* prefix_al = _file____User_temp_2682.data.Some.value;
        size_t char_index = 0ULL;
        size_t byte_index = 0ULL;
        while (true) {
          bool __yo_sc_yo_id_12308 = false;
          if (((byte_index) < (self_bytes))) {
            __yo_sc_yo_id_12308 = ((char_index) < (position));
          }
          if (!(__yo_sc_yo_id_12308)) {
            break;
          }
          { // begin block (loop body)
          __yo_t20 _file____User_temp_2687 = yo_id_3138_rtparam0_R_gs_yo_id_3109_u8_rtparam1_usize_ret_enum_yo_id_3135_u8(self_al, byte_index);
          __yo_t20 byte_opt = _file____User_temp_2687;
          switch ((byte_opt).tag) {
          case __YO_T20_SOME: {
            uint8_t byte = byte_opt.data.Some.value;
            bool __yo_sc_yo_id_12309 = true;
            if (!(((byte) < (128)))) {
              __yo_sc_yo_id_12309 = ((byte) >= (192));
            }
            bool is_start = __yo_sc_yo_id_12309;
            if (is_start) {
              size_t _file____User_temp_2706;
              if (((byte) < (128))) {
                _file____User_temp_2706 = 1ULL;
              }
              else {
                bool __yo_sc_yo_id_12310 = false;
                if (((byte) >= (192))) {
                  __yo_sc_yo_id_12310 = ((byte) < (224));
                }
                if (__yo_sc_yo_id_12310) {
                  _file____User_temp_2706 = 2ULL;
                }
                else {
                  bool __yo_sc_yo_id_12311 = false;
                  if (((byte) >= (224))) {
                    __yo_sc_yo_id_12311 = ((byte) < (240));
                  }
                  if (__yo_sc_yo_id_12311) {
                    _file____User_temp_2706 = 3ULL;
                  }
                  else {
                    bool __yo_sc_yo_id_12312 = false;
                    if (((byte) >= (240))) {
                      __yo_sc_yo_id_12312 = ((byte) < (248));
                    }
                    if (__yo_sc_yo_id_12312) {
                      _file____User_temp_2706 = 4ULL;
                    }
                    else {
                      _file____User_temp_2706 = 1ULL;
                    }
                  }
                }
              }
              size_t byte_len = _file____User_temp_2706;
              size_t _file____User_temp_2710 = byte_index; // Save old value for later use
              byte_index = ((((byte_index) + (byte_len))) - (1ULL));
              size_t _file____User_temp_2712 = char_index; // Save old value for later use
              char_index = ((char_index) + (1ULL));
            }
            else {
            }
            break;
          }
          case __YO_T20_NONE: {
            break;
          }
          }
          } // end begin block (loop body)
        continue_yo_id_12307:;
          byte_index = ((byte_index) + (1ULL));
        }
        loop_yo_id_12306:;
        bool _file____User_temp_2750;
        if (((((byte_index) + (prefix_bytes))) > (self_bytes))) {
          _file____User_temp_2750 = false;
        }
        else {
          size_t i = 0ULL;
          bool matches = true;
          while (true) {
            if (!(((i) < (prefix_bytes)))) {
              break;
            }
            { // begin block (loop body)
            __yo_t20 _file____User_temp_2730 = yo_id_3138_rtparam0_R_gs_yo_id_3109_u8_rtparam1_usize_ret_enum_yo_id_3135_u8(self_al, ((byte_index) + (i)));
            __yo_t20 self_byte_opt = _file____User_temp_2730;
            __yo_t20 _file____User_temp_2731 = yo_id_3138_rtparam0_R_gs_yo_id_3109_u8_rtparam1_usize_ret_enum_yo_id_3135_u8(prefix_al, i);
            __yo_t20 prefix_byte_opt = _file____User_temp_2731;
            switch ((self_byte_opt).tag) {
            case __YO_T20_SOME: {
              uint8_t self_byte = self_byte_opt.data.Some.value;
              switch ((prefix_byte_opt).tag) {
              case __YO_T20_SOME: {
                uint8_t prefix_byte = prefix_byte_opt.data.Some.value;
                if (((self_byte) != (prefix_byte))) {
                  bool _file____User_temp_2734 = matches; // Save old value for later use
                  matches = false;
                  goto loop_yo_id_12313;
                }
                else {
                }
                break;
              }
              case __YO_T20_NONE: {
                bool _file____User_temp_2739 = matches; // Save old value for later use
                matches = false;
                _file____User_temp_2739;
                goto loop_yo_id_12313;
                break;
              }
              }
              break;
            }
            case __YO_T20_NONE: {
              bool _file____User_temp_2743 = matches; // Save old value for later use
              matches = false;
              _file____User_temp_2743;
              goto loop_yo_id_12313;
              break;
            }
            }
            } // end begin block (loop body)
          continue_yo_id_12314:;
            i = ((i) + (1ULL));
          }
          loop_yo_id_12313:;
          // Drop local variables before early return
switch ((_file____User_temp_2664).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_2664).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_2670).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_2670).data.Some.value));
    break;
  }
  default: break;
}
          return matches;
        }
        _file____User_temp_2753 = _file____User_temp_2750;
        break;
      }
      }
switch ((_file____User_temp_2682).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_2682).data.Some.value));
    break;
  }
  default: break;
}
      _file____User_temp_2755 = _file____User_temp_2753;
      break;
    }
    }
switch ((_file____User_temp_2679).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_2679).data.Some.value));
    break;
  }
  default: break;
}
    _file____User_temp_2756 = _file____User_temp_2755;
  }
  bool __yo_scope_ret = _file____User_temp_2756;
switch ((_file____User_temp_2664).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_2664).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_2670).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_2670).data.Some.value));
    break;
  }
  default: break;
}
  return __yo_scope_ret;
}
static inline __yo_t12 yo_id_3383(uint8_t* cstr) {
  size_t len = strlen(((char*)(cstr)));
  if (((len) == (0ULL))) {
    __yo_t10 _file____User_temp_1560 = ((__yo_t10)((__yo_t11){ .tag = __YO_T11_NONE }));
    __yo_t12 _file____User_temp_1561 = (__yo_t12){ .tag = __YO_T12_OK, .data = { .Ok = { .value = _file____User_temp_1560 } } };
    return _file____User_temp_1561;
  }
  else {
  }
  __yo_t0* _file____User_temp_1565 = yo_id_3130_rtparam0_usize_ret_R_gs_yo_id_3109_u8((size_t)(len));
  __yo_t0* bytes = _file____User_temp_1565;
  yo_id_3149_rtparam0_R_gs_yo_id_3109_u8_rtparam1___u8__rtparam2_usize_ret_unit(bytes, cstr, len);
  ((__yo_t0*)__yo_incr_rc((void*)(bytes)));
  __yo_t11 _file____User_temp_1567 = (__yo_t11){ .tag = __YO_T11_SOME, .data = { .Some = { .value = bytes } } };
  __yo_t10 _file____User_temp_1568 = ((__yo_t10)(_file____User_temp_1567));
  __yo_t12 _file____User_temp_1569 = (__yo_t12){ .tag = __YO_T12_OK, .data = { .Ok = { .value = _file____User_temp_1568 } } };
  // Drop local variables before early return
  __yo_decr_rc((void*)(bytes));
  return _file____User_temp_1569;
}
static inline void yo_id_3149_rtparam0_R_gs_yo_id_3109_u8_rtparam1___u8__rtparam2_usize_ret_unit(__yo_t0* self, uint8_t* src, size_t count) {
  if (((count) == (0ULL))) {
  }
  else {
    yo_id_3148_rtparam0_R_gs_yo_id_3109_u8_rtparam1_usize_ret_unit(self, ((self->_length) + (count)));
    uint8_t* _file____User_temp_1536 = self->_ptr;
    if (_file____User_temp_1536 != NULL) {
      uint8_t* dst_base = _file____User_temp_1536;
      void* dst = ((void*)((dst_base + self->_length)));
      void* _file____User_temp_1541 = memcpy(dst, ((void*)(src)), ((count) * (1ULL)));
      size_t _file____User_temp_1546 = self->_length; // Save old value for later use
      self->_length = ((self->_length) + (count));
      _file____User_temp_1546;
    } else {
      fprintf(stderr, "%s\n", "\"ArrayList.extend_from_ptr: no ptr after ensure_total_capacity\"");
      abort();
      (*((void*)NULL));
    }
  }
}
static inline __yo_t10 fn_yo_id_5312(__yo_t19** self) {
  __yo_t16* _file____User_temp_5371 = (*self)->_segments;
  ((__yo_t16*)__yo_incr_rc((void*)(_file____User_temp_5371)));
  __yo_t16* segments = _file____User_temp_5371;
  __yo_t10 _file____User_temp_5372 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"/", .len = 1 });
  __yo_t10 sep = _file____User_temp_5372;
  __yo_t10 _file____User_temp_5373 = yo_id_3337();
  __yo_t10 result = _file____User_temp_5373;
  bool _file____User_temp_5408;
  size_t _file____User_temp_5375 = yo_id_3119_rtparam0_R_gs_yo_id_3109_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_ret_usize(segments);
  if (((_file____User_temp_5375) > (0ULL))) {
    __yo_t9 _file____User_temp_5378 = yo_id_3138_rtparam0_R_gs_yo_id_3109_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam1_usize_ret_enum_yo_id_3135_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8(segments, 0ULL);
    __yo_t9 first_seg_opt = _file____User_temp_5378;
    bool _file____User_temp_5405;
    switch ((first_seg_opt).tag) {
    case __YO_T9_SOME: {
      __yo_t10 first_seg = first_seg_opt.data.Some.value;
      bool _file____User_temp_5403;
      size_t _file____User_temp_5380 = yo_id_3414(first_seg);
      if (((_file____User_temp_5380) == (2ULL))) {
        __yo_t0* _file____User_temp_5384 = yo_id_3433(first_seg);
        __yo_t20 _file____User_temp_5385 = yo_id_3138_rtparam0_R_gs_yo_id_3109_u8_rtparam1_usize_ret_enum_yo_id_3135_u8(_file____User_temp_5384, 0ULL);
        __yo_t20 b0_opt = _file____User_temp_5385;
        __yo_t0* _file____User_temp_5387 = yo_id_3433(first_seg);
        __yo_t20 _file____User_temp_5388 = yo_id_3138_rtparam0_R_gs_yo_id_3109_u8_rtparam1_usize_ret_enum_yo_id_3135_u8(_file____User_temp_5387, 1ULL);
        __yo_t20 b1_opt = _file____User_temp_5388;
        bool _file____User_temp_5399;
        switch ((b0_opt).tag) {
        case __YO_T20_SOME: {
          uint8_t b0 = b0_opt.data.Some.value;
          bool _file____User_temp_5397;
          switch ((b1_opt).tag) {
          case __YO_T20_SOME: {
            uint8_t b1 = b1_opt.data.Some.value;
            bool __yo_sc_yo_id_12315 = false;
            if (((b0) >= (65))) {
              __yo_sc_yo_id_12315 = ((b0) <= (90));
            }
            bool __yo_sc_yo_id_12316 = false;
            if (((b0) >= (97))) {
              __yo_sc_yo_id_12316 = ((b0) <= (122));
            }
            bool is_letter = (__yo_sc_yo_id_12315 || __yo_sc_yo_id_12316);
            bool _file____User_temp_5393 = ((b1) == (58));
            bool is_colon = _file____User_temp_5393;
            bool __yo_sc_yo_id_12317 = false;
            if (is_letter) {
              __yo_sc_yo_id_12317 = is_colon;
            }
            _file____User_temp_5397 = __yo_sc_yo_id_12317;
            break;
          }
          case __YO_T20_NONE: {
            _file____User_temp_5397 = false;
            break;
          }
          }
          _file____User_temp_5399 = _file____User_temp_5397;
          break;
        }
        case __YO_T20_NONE: {
          _file____User_temp_5399 = false;
          break;
        }
        }
        _file____User_temp_5403 = _file____User_temp_5399;
        __yo_decr_rc((void*)(_file____User_temp_5384));
        __yo_decr_rc((void*)(_file____User_temp_5387));
      }
      else {
        _file____User_temp_5403 = false;
      }
      _file____User_temp_5405 = _file____User_temp_5403;
      break;
    }
    case __YO_T9_NONE: {
      _file____User_temp_5405 = false;
      break;
    }
    }
    _file____User_temp_5408 = _file____User_temp_5405;
switch ((first_seg_opt).tag) {
  case __YO_T9_SOME: {
switch (((first_seg_opt).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((first_seg_opt).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
  }
  else {
    _file____User_temp_5408 = false;
  }
  bool has_drive_letter = _file____User_temp_5408;
  bool __yo_sc_yo_id_12318 = false;
  if ((*self)->_is_absolute) {
    __yo_effect_escaped = 0;
    bool _file____User_temp_5410 = yo_id_122_bool_id_bool_rtparam0_bool_ret_bool((bool)(has_drive_letter));
    if (__yo_effect_escaped) {
      // Drop local variables before early return
      __yo_decr_rc((void*)(segments));
switch ((sep).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((sep).data.Some.value));
    break;
  }
  default: break;
}
      return (__yo_t10){0};
    }
    __yo_sc_yo_id_12318 = _file____User_temp_5410;
  }
  if (__yo_sc_yo_id_12318) {
    __yo_t10 _file____User_temp_5413 = result; // Save old value for later use
    __yo_t10 _file____User_temp_5412 = yo_id_3607(result, sep);
    result = _file____User_temp_5412;
switch ((_file____User_temp_5413).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_5413).data.Some.value));
    break;
  }
  default: break;
}
  }
  else {
  }
  size_t i = 0ULL;
  size_t _file____User_temp_5417 = yo_id_3119_rtparam0_R_gs_yo_id_3109_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_ret_usize(segments);
  size_t segments_len = _file____User_temp_5417;
  while (true) {
    if (!(((i) < (segments_len)))) {
      break;
    }
    { // begin block (loop body)
    __yo_t9 _file____User_temp_5420 = yo_id_3138_rtparam0_R_gs_yo_id_3109_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam1_usize_ret_enum_yo_id_3135_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8(segments, i);
    __yo_t9 seg = _file____User_temp_5420;
    switch ((seg).tag) {
    case __YO_T9_SOME: {
      __yo_t10 s = seg.data.Some.value;
      __yo_t10 _file____User_temp_5422 = result; // Save old value for later use
      __yo_t10 _file____User_temp_5421 = yo_id_3607(result, s);
      result = _file____User_temp_5421;
      _file____User_temp_5422;
      if (((i) < (((segments_len) - (1ULL))))) {
        __yo_t10 _file____User_temp_5428 = result; // Save old value for later use
        __yo_t10 _file____User_temp_5427 = yo_id_3607(result, sep);
        result = _file____User_temp_5427;
switch ((_file____User_temp_5428).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_5428).data.Some.value));
    break;
  }
  default: break;
}
      }
      else {
      }
switch ((_file____User_temp_5422).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_5422).data.Some.value));
    break;
  }
  default: break;
}
      break;
    }
    case __YO_T9_NONE: {
      break;
    }
    }
switch ((seg).tag) {
  case __YO_T9_SOME: {
switch (((seg).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((seg).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
    } // end begin block (loop body)
  continue_yo_id_12320:;
    i = ((i) + (1ULL));
  }
  loop_yo_id_12319:;
  // Drop local variables before early return
  __yo_decr_rc((void*)(segments));
switch ((sep).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((sep).data.Some.value));
    break;
  }
  default: break;
}
  return result;
}
static inline __yo_t24* yo_id_3124__ret_R_gs_yo_id_3109_usize() {
  __yo_t24* _file____User_temp_2495 = __yo_new___yo_t24(NULL, 0ULL, 0ULL);
  return _file____User_temp_2495;
}
static inline __yo_t16* yo_id_3124__ret_R_gs_yo_id_3109_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8() {
  __yo_t16* _file____User_temp_6235 = __yo_new___yo_t16(NULL, 0ULL, 0ULL);
  return _file____User_temp_6235;
}
static inline __yo_t29 yo_id_9763(__yo_t10 tag) {
  size_t _file____User_temp_11561 = yo_id_3414(tag);
  size_t n = _file____User_temp_11561;
  if (((n) == (0ULL))) {
    __yo_t29 _file____User_temp_11566 = (__yo_t29){ .tag = __YO_T29_NONE };
    return _file____User_temp_11566;
  }
  else {
  }
  __yo_t26 _file____User_temp_11574;
  __yo_t27 _file____User_temp_11570 = yo_id_3595(tag, 0ULL);
  switch ((_file____User_temp_11570).tag) {
  case __YO_T27_NONE: {
    __yo_t29 _file____User_temp_11571 = (__yo_t29){ .tag = __YO_T29_NONE };
    return _file____User_temp_11571;
    break;
  }
  case __YO_T27_SOME: {
    __yo_t26 c = _file____User_temp_11570.data.Some.value;
    _file____User_temp_11574 = c;
    break;
  }
  }
  __yo_t26 first_char = _file____User_temp_11574;
  __yo_t10 _file____User_temp_11584;
  bool __yo_sc_yo_id_12321 = true;
  __yo_t26 _file____User_temp_11576 = ((__yo_t26)(118U));
  __yo_effect_escaped = 0;
  bool _file____User_temp_11577 = fn_yo_id_3038((__yo_t26)(first_char), (__yo_t26)(_file____User_temp_11576));
  if (__yo_effect_escaped) {
    return (__yo_t29){0};
  }
  if (!(_file____User_temp_11577)) {
    __yo_t26 _file____User_temp_11578 = ((__yo_t26)(86U));
    __yo_effect_escaped = 0;
    bool _file____User_temp_11579 = fn_yo_id_3038((__yo_t26)(first_char), (__yo_t26)(_file____User_temp_11578));
    if (__yo_effect_escaped) {
      return (__yo_t29){0};
    }
    __yo_sc_yo_id_12321 = _file____User_temp_11579;
  }
  if (__yo_sc_yo_id_12321) {
    __yo_t10 _file____User_temp_11582 = yo_id_3684(tag, 1ULL, n);
    _file____User_temp_11584 = _file____User_temp_11582;
  }
  else {
    __yo_t10 _file____User_temp_11583 = tag;
__yo_t11 temp_dup_enum_yo_id_12322 = _file____User_temp_11583;
switch ((temp_dup_enum_yo_id_12322).tag) {
  case __YO_T11_SOME: {
    (temp_dup_enum_yo_id_12322).data.Some.value = ((__yo_t0*)__yo_incr_rc((void*)((temp_dup_enum_yo_id_12322).data.Some.value)));
    break;
  }
  default: break;
}
    temp_dup_enum_yo_id_12322;
    _file____User_temp_11584 = _file____User_temp_11583;
  }
  __yo_t10 stripped = _file____User_temp_11584;
  __yo_t10 _file____User_temp_11585 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)".", .len = 1 });
  __yo_t16* _file____User_temp_11588 = yo_id_4285_String_id_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam0_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam1_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_ret_R_gs_yo_id_3109_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8(stripped, _file____User_temp_11585);
  __yo_t16* parts = _file____User_temp_11588;
  size_t _file____User_temp_11599 = yo_id_3119_rtparam0_R_gs_yo_id_3109_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_ret_usize(parts);
  __yo_effect_escaped = 0;
  bool _file____User_temp_11604 = yo_id_122_bool_id_bool_rtparam0_bool_ret_bool((bool)(((_file____User_temp_11599) == (3ULL))));
  if (__yo_effect_escaped) {
    // Drop local variables before early return
switch ((stripped).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((stripped).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_11585).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_11585).data.Some.value));
    break;
  }
  default: break;
}
    __yo_decr_rc((void*)(parts));
    return (__yo_t29){0};
  }
  if (_file____User_temp_11604) {
    __yo_t29 _file____User_temp_11606 = (__yo_t29){ .tag = __YO_T29_NONE };
    // Drop local variables before early return
switch ((stripped).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((stripped).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_11585).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_11585).data.Some.value));
    break;
  }
  default: break;
}
    __yo_decr_rc((void*)(parts));
    return _file____User_temp_11606;
  }
  else {
  }
  __yo_t10 _file____User_temp_11631;
  __yo_t9 _file____User_temp_11627 = yo_id_3138_rtparam0_R_gs_yo_id_3109_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam1_usize_ret_enum_yo_id_3135_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8(parts, 0ULL);
  switch ((_file____User_temp_11627).tag) {
  case __YO_T9_NONE: {
    __yo_t29 _file____User_temp_11628 = (__yo_t29){ .tag = __YO_T29_NONE };
    // Drop local variables before early return
switch ((stripped).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((stripped).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_11585).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_11585).data.Some.value));
    break;
  }
  default: break;
}
    __yo_decr_rc((void*)(parts));
switch ((_file____User_temp_11627).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_11627).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_11627).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
    return _file____User_temp_11628;
    break;
  }
  case __YO_T9_SOME: {
    __yo_t10 s = _file____User_temp_11627.data.Some.value;
    __yo_t10 _file____User_temp_11630 = s;
__yo_t11 temp_dup_enum_yo_id_12323 = _file____User_temp_11630;
switch ((temp_dup_enum_yo_id_12323).tag) {
  case __YO_T11_SOME: {
    (temp_dup_enum_yo_id_12323).data.Some.value = ((__yo_t0*)__yo_incr_rc((void*)((temp_dup_enum_yo_id_12323).data.Some.value)));
    break;
  }
  default: break;
}
    temp_dup_enum_yo_id_12323;
    _file____User_temp_11631 = _file____User_temp_11630;
    break;
  }
  }
  __yo_t10 major_str = _file____User_temp_11631;
  __yo_t10 _file____User_temp_11637;
  __yo_t9 _file____User_temp_11633 = yo_id_3138_rtparam0_R_gs_yo_id_3109_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam1_usize_ret_enum_yo_id_3135_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8(parts, 1ULL);
  switch ((_file____User_temp_11633).tag) {
  case __YO_T9_NONE: {
    __yo_t29 _file____User_temp_11634 = (__yo_t29){ .tag = __YO_T29_NONE };
    // Drop local variables before early return
switch ((stripped).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((stripped).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_11585).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_11585).data.Some.value));
    break;
  }
  default: break;
}
    __yo_decr_rc((void*)(parts));
switch ((_file____User_temp_11627).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_11627).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_11627).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
switch ((major_str).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((major_str).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_11633).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_11633).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_11633).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
    return _file____User_temp_11634;
    break;
  }
  case __YO_T9_SOME: {
    __yo_t10 s = _file____User_temp_11633.data.Some.value;
    __yo_t10 _file____User_temp_11636 = s;
__yo_t11 temp_dup_enum_yo_id_12324 = _file____User_temp_11636;
switch ((temp_dup_enum_yo_id_12324).tag) {
  case __YO_T11_SOME: {
    (temp_dup_enum_yo_id_12324).data.Some.value = ((__yo_t0*)__yo_incr_rc((void*)((temp_dup_enum_yo_id_12324).data.Some.value)));
    break;
  }
  default: break;
}
    temp_dup_enum_yo_id_12324;
    _file____User_temp_11637 = _file____User_temp_11636;
    break;
  }
  }
  __yo_t10 minor_str = _file____User_temp_11637;
  __yo_t10 _file____User_temp_11643;
  __yo_t9 _file____User_temp_11639 = yo_id_3138_rtparam0_R_gs_yo_id_3109_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam1_usize_ret_enum_yo_id_3135_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8(parts, 2ULL);
  switch ((_file____User_temp_11639).tag) {
  case __YO_T9_NONE: {
    __yo_t29 _file____User_temp_11640 = (__yo_t29){ .tag = __YO_T29_NONE };
    // Drop local variables before early return
switch ((stripped).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((stripped).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_11585).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_11585).data.Some.value));
    break;
  }
  default: break;
}
    __yo_decr_rc((void*)(parts));
switch ((_file____User_temp_11627).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_11627).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_11627).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
switch ((major_str).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((major_str).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_11633).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_11633).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_11633).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
switch ((minor_str).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((minor_str).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_11639).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_11639).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_11639).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
    return _file____User_temp_11640;
    break;
  }
  case __YO_T9_SOME: {
    __yo_t10 s = _file____User_temp_11639.data.Some.value;
    __yo_t10 _file____User_temp_11642 = s;
__yo_t11 temp_dup_enum_yo_id_12325 = _file____User_temp_11642;
switch ((temp_dup_enum_yo_id_12325).tag) {
  case __YO_T11_SOME: {
    (temp_dup_enum_yo_id_12325).data.Some.value = ((__yo_t0*)__yo_incr_rc((void*)((temp_dup_enum_yo_id_12325).data.Some.value)));
    break;
  }
  default: break;
}
    temp_dup_enum_yo_id_12325;
    _file____User_temp_11643 = _file____User_temp_11642;
    break;
  }
  }
  __yo_t10 patch_str = _file____User_temp_11643;
  __yo_effect_escaped = 0;
  bool _file____User_temp_11651 = yo_id_9750((__yo_t10)(major_str));
  if (__yo_effect_escaped) {
    // Drop local variables before early return
switch ((stripped).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((stripped).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_11585).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_11585).data.Some.value));
    break;
  }
  default: break;
}
    __yo_decr_rc((void*)(parts));
switch ((_file____User_temp_11627).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_11627).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_11627).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
switch ((major_str).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((major_str).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_11633).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_11633).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_11633).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
switch ((minor_str).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((minor_str).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_11639).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_11639).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_11639).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
switch ((patch_str).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((patch_str).data.Some.value));
    break;
  }
  default: break;
}
    return (__yo_t29){0};
  }
  bool __yo_sc_yo_id_12326 = false;
  __yo_effect_escaped = 0;
  bool _file____User_temp_11652 = yo_id_9750((__yo_t10)(minor_str));
  if (__yo_effect_escaped) {
    // Drop local variables before early return
switch ((stripped).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((stripped).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_11585).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_11585).data.Some.value));
    break;
  }
  default: break;
}
    __yo_decr_rc((void*)(parts));
switch ((_file____User_temp_11627).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_11627).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_11627).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
switch ((major_str).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((major_str).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_11633).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_11633).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_11633).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
switch ((minor_str).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((minor_str).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_11639).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_11639).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_11639).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
switch ((patch_str).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((patch_str).data.Some.value));
    break;
  }
  default: break;
}
    return (__yo_t29){0};
  }
  if (_file____User_temp_11652) {
    __yo_effect_escaped = 0;
    bool _file____User_temp_11653 = yo_id_9750((__yo_t10)(patch_str));
    if (__yo_effect_escaped) {
      // Drop local variables before early return
switch ((stripped).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((stripped).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_11585).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_11585).data.Some.value));
    break;
  }
  default: break;
}
      __yo_decr_rc((void*)(parts));
switch ((_file____User_temp_11627).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_11627).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_11627).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
switch ((major_str).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((major_str).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_11633).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_11633).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_11633).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
switch ((minor_str).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((minor_str).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_11639).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_11639).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_11639).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
switch ((patch_str).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((patch_str).data.Some.value));
    break;
  }
  default: break;
}
      return (__yo_t29){0};
    }
    __yo_sc_yo_id_12326 = _file____User_temp_11653;
  }
  __yo_effect_escaped = 0;
  bool _file____User_temp_11655 = yo_id_122_bool_id_bool_rtparam0_bool_ret_bool((bool)((_file____User_temp_11651 && __yo_sc_yo_id_12326)));
  if (__yo_effect_escaped) {
    // Drop local variables before early return
switch ((stripped).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((stripped).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_11585).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_11585).data.Some.value));
    break;
  }
  default: break;
}
    __yo_decr_rc((void*)(parts));
switch ((_file____User_temp_11627).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_11627).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_11627).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
switch ((major_str).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((major_str).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_11633).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_11633).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_11633).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
switch ((minor_str).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((minor_str).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_11639).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_11639).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_11639).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
switch ((patch_str).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((patch_str).data.Some.value));
    break;
  }
  default: break;
}
    return (__yo_t29){0};
  }
  if (_file____User_temp_11655) {
    __yo_t29 _file____User_temp_11657 = (__yo_t29){ .tag = __YO_T29_NONE };
    // Drop local variables before early return
switch ((stripped).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((stripped).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_11585).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_11585).data.Some.value));
    break;
  }
  default: break;
}
    __yo_decr_rc((void*)(parts));
switch ((_file____User_temp_11627).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_11627).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_11627).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
switch ((major_str).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((major_str).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_11633).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_11633).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_11633).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
switch ((minor_str).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((minor_str).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_11639).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_11639).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_11639).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
switch ((patch_str).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((patch_str).data.Some.value));
    break;
  }
  default: break;
}
    return _file____User_temp_11657;
  }
  else {
  }
  int32_t _file____User_temp_11665;
  __yo_t30 _file____User_temp_11661 = yo_id_4441(major_str);
  switch ((_file____User_temp_11661).tag) {
  case __YO_T30_NONE: {
    __yo_t29 _file____User_temp_11662 = (__yo_t29){ .tag = __YO_T29_NONE };
    // Drop local variables before early return
switch ((stripped).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((stripped).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_11585).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_11585).data.Some.value));
    break;
  }
  default: break;
}
    __yo_decr_rc((void*)(parts));
switch ((_file____User_temp_11627).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_11627).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_11627).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
switch ((major_str).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((major_str).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_11633).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_11633).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_11633).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
switch ((minor_str).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((minor_str).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_11639).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_11639).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_11639).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
switch ((patch_str).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((patch_str).data.Some.value));
    break;
  }
  default: break;
}
    return _file____User_temp_11662;
    break;
  }
  case __YO_T30_SOME: {
    int32_t x = _file____User_temp_11661.data.Some.value;
    _file____User_temp_11665 = x;
    break;
  }
  }
  int32_t major = _file____User_temp_11665;
  int32_t _file____User_temp_11671;
  __yo_t30 _file____User_temp_11667 = yo_id_4441(minor_str);
  switch ((_file____User_temp_11667).tag) {
  case __YO_T30_NONE: {
    __yo_t29 _file____User_temp_11668 = (__yo_t29){ .tag = __YO_T29_NONE };
    // Drop local variables before early return
switch ((stripped).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((stripped).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_11585).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_11585).data.Some.value));
    break;
  }
  default: break;
}
    __yo_decr_rc((void*)(parts));
switch ((_file____User_temp_11627).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_11627).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_11627).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
switch ((major_str).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((major_str).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_11633).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_11633).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_11633).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
switch ((minor_str).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((minor_str).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_11639).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_11639).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_11639).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
switch ((patch_str).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((patch_str).data.Some.value));
    break;
  }
  default: break;
}
    return _file____User_temp_11668;
    break;
  }
  case __YO_T30_SOME: {
    int32_t x = _file____User_temp_11667.data.Some.value;
    _file____User_temp_11671 = x;
    break;
  }
  }
  int32_t minor = _file____User_temp_11671;
  int32_t _file____User_temp_11677;
  __yo_t30 _file____User_temp_11673 = yo_id_4441(patch_str);
  switch ((_file____User_temp_11673).tag) {
  case __YO_T30_NONE: {
    __yo_t29 _file____User_temp_11674 = (__yo_t29){ .tag = __YO_T29_NONE };
    // Drop local variables before early return
switch ((stripped).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((stripped).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_11585).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_11585).data.Some.value));
    break;
  }
  default: break;
}
    __yo_decr_rc((void*)(parts));
switch ((_file____User_temp_11627).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_11627).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_11627).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
switch ((major_str).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((major_str).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_11633).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_11633).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_11633).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
switch ((minor_str).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((minor_str).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_11639).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_11639).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_11639).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
switch ((patch_str).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((patch_str).data.Some.value));
    break;
  }
  default: break;
}
    return _file____User_temp_11674;
    break;
  }
  case __YO_T30_SOME: {
    int32_t x = _file____User_temp_11673.data.Some.value;
    _file____User_temp_11677 = x;
    break;
  }
  }
  int32_t patch = _file____User_temp_11677;
__yo_t11 temp_dup_enum_yo_id_12327 = tag;
switch ((temp_dup_enum_yo_id_12327).tag) {
  case __YO_T11_SOME: {
    (temp_dup_enum_yo_id_12327).data.Some.value = ((__yo_t0*)__yo_incr_rc((void*)((temp_dup_enum_yo_id_12327).data.Some.value)));
    break;
  }
  default: break;
}
  temp_dup_enum_yo_id_12327;
  __yo_t28* _file____User_temp_11678 = __yo_new___yo_t28(tag, major, minor, patch);
  __yo_t29 _file____User_temp_11679 = (__yo_t29){ .tag = __YO_T29_SOME, .data = { .Some = { .value = _file____User_temp_11678 } } };
  __yo_t29 __yo_scope_ret = _file____User_temp_11679;
switch ((stripped).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((stripped).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_11585).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_11585).data.Some.value));
    break;
  }
  default: break;
}
  __yo_decr_rc((void*)(parts));
switch ((_file____User_temp_11627).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_11627).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_11627).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
switch ((major_str).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((major_str).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_11633).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_11633).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_11633).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
switch ((minor_str).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((minor_str).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_11639).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_11639).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_11639).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
switch ((patch_str).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((patch_str).data.Some.value));
    break;
  }
  default: break;
}
  return __yo_scope_ret;
}
static inline __yo_t31* yo_id_3124__ret_R_gs_yo_id_3109_R_struct_yo_id_9715_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_i32_i32_i32() {
  __yo_t31* _file____User_temp_11748 = __yo_new___yo_t31(NULL, 0ULL, 0ULL);
  return _file____User_temp_11748;
}
static inline __yo_t10 yo_id_4570(__yo_t10* self) {
  __yo_t10 _file____User_temp_4091;
  __yo_t11 _file____User_temp_4071 = (*self);
__yo_t11 temp_dup_enum_yo_id_12328 = _file____User_temp_4071;
switch ((temp_dup_enum_yo_id_12328).tag) {
  case __YO_T11_SOME: {
    (temp_dup_enum_yo_id_12328).data.Some.value = ((__yo_t0*)__yo_incr_rc((void*)((temp_dup_enum_yo_id_12328).data.Some.value)));
    break;
  }
  default: break;
}
  temp_dup_enum_yo_id_12328;
  switch ((_file____User_temp_4071).tag) {
  case __YO_T11_NONE: {
    _file____User_temp_4091 = ((__yo_t10)((__yo_t11){ .tag = __YO_T11_NONE }));
    break;
  }
  case __YO_T11_SOME: {
    __yo_t0* al = _file____User_temp_4071.data.Some.value;
    size_t _file____User_temp_4074 = yo_id_3119_rtparam0_R_gs_yo_id_3109_u8_ret_usize(al);
    size_t n = _file____User_temp_4074;
    __yo_t10 _file____User_temp_4089;
    if (((n) == (0ULL))) {
      _file____User_temp_4089 = ((__yo_t10)((__yo_t11){ .tag = __YO_T11_NONE }));
    }
    else {
      __yo_t0* _file____User_temp_4079 = yo_id_3130_rtparam0_usize_ret_R_gs_yo_id_3109_u8((size_t)(n));
      __yo_t0* buf = _file____User_temp_4079;
      uint8_t* _file____User_temp_4081 = al->_ptr;
      if (_file____User_temp_4081 != NULL) {
        uint8_t* ptr = _file____User_temp_4081;
        yo_id_3149_rtparam0_R_gs_yo_id_3109_u8_rtparam1___u8__rtparam2_usize_ret_unit(buf, ptr, n);
      } else {
      }
      ((__yo_t0*)__yo_incr_rc((void*)(buf)));
      __yo_t11 _file____User_temp_4086 = (__yo_t11){ .tag = __YO_T11_SOME, .data = { .Some = { .value = buf } } };
      __yo_t10 _file____User_temp_4087 = ((__yo_t10)(_file____User_temp_4086));
      _file____User_temp_4089 = _file____User_temp_4087;
      __yo_decr_rc((void*)(buf));
    }
    _file____User_temp_4091 = _file____User_temp_4089;
    break;
  }
  }
  return _file____User_temp_4091;
}
static inline __yo_t10 yo_id_10154(__yo_t10 content) {
  __yo_effect_escaped = 0;
  __yo_t16* _file____User_temp_12217 = yo_id_10027((__yo_t10)(content));
  if (__yo_effect_escaped) {
    return (__yo_t10){0};
  }
  __yo_t16* dep_names = _file____User_temp_12217;
  __yo_t10 _file____User_temp_12218 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"// --- Import list ---", .len = 22 });
  __yo_t10 marker = _file____User_temp_12218;
  __yo_t10 _file____User_temp_12219 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"export(imports);", .len = 16 });
  __yo_t10 export_line = _file____User_temp_12219;
  __yo_effect_escaped = 0;
  __yo_t10 _file____User_temp_12220 = yo_id_10071((__yo_t16*)(dep_names));
  if (__yo_effect_escaped) {
    // Drop local variables before early return
    __yo_decr_rc((void*)(dep_names));
switch ((marker).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((marker).data.Some.value));
    break;
  }
  default: break;
}
switch ((export_line).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((export_line).data.Some.value));
    break;
  }
  default: break;
}
    return (__yo_t10){0};
  }
  __yo_t10 imports_blk = _file____User_temp_12220;
  __yo_t23 _file____User_temp_12221 = yo_id_4281_String_id_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam0_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam1_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam2_usize_ret_enum_yo_id_3135_usize(content, marker, 0ULL);
  __yo_t23 marker_idx = _file____User_temp_12221;
  __yo_t10 _file____User_temp_12324;
  switch ((marker_idx).tag) {
  case __YO_T23_NONE: {
    __yo_t10 _file____User_temp_12230;
    __yo_t10 _file____User_temp_12223 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"\n", .len = 1 });
    bool _file____User_temp_12225 = yo_id_4278_String_id_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam0_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam1_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam2_usize_ret_bool(content, _file____User_temp_12223, -1ULL);
switch ((_file____User_temp_12223).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_12223).data.Some.value));
    break;
  }
  default: break;
}
    if (_file____User_temp_12225) {
      __yo_t10 _file____User_temp_12227 = yo_id_3337();
      _file____User_temp_12230 = _file____User_temp_12227;
    }
    else {
      __yo_t10 _file____User_temp_12229 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"\n", .len = 1 });
      _file____User_temp_12230 = _file____User_temp_12229;
    }
    __yo_t10 suffix = _file____User_temp_12230;
    __yo_t10 _file____User_temp_12265 = yo_id_3607(content, suffix);
    __yo_t10 _file____User_temp_12266 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"\n", .len = 1 });
    __yo_t10 _file____User_temp_12267 = yo_id_3607(_file____User_temp_12265, _file____User_temp_12266);
    __yo_t10 _file____User_temp_12268 = yo_id_3607(_file____User_temp_12267, marker);
    __yo_t10 _file____User_temp_12269 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"\n", .len = 1 });
    __yo_t10 _file____User_temp_12270 = yo_id_3607(_file____User_temp_12268, _file____User_temp_12269);
    __yo_t10 _file____User_temp_12271 = yo_id_3607(_file____User_temp_12270, imports_blk);
switch ((suffix).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((suffix).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_12265).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_12265).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_12266).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_12266).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_12267).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_12267).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_12268).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_12268).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_12269).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_12269).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_12270).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_12270).data.Some.value));
    break;
  }
  default: break;
}
    _file____User_temp_12324 = _file____User_temp_12271;
    break;
  }
  case __YO_T23_SOME: {
    size_t m_idx = marker_idx.data.Some.value;
    __yo_t23 _file____User_temp_12273 = yo_id_4281_String_id_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam0_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam1_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam2_usize_ret_enum_yo_id_3135_usize(content, export_line, m_idx);
    __yo_t23 export_idx = _file____User_temp_12273;
    __yo_t10 _file____User_temp_12322;
    switch ((export_idx).tag) {
    case __YO_T23_NONE: {
      __yo_t10 _file____User_temp_12286 = yo_id_3684(content, 0ULL, m_idx);
      __yo_t10 _file____User_temp_12287 = yo_id_3607(_file____User_temp_12286, marker);
      __yo_t10 _file____User_temp_12288 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"\n", .len = 1 });
      __yo_t10 _file____User_temp_12289 = yo_id_3607(_file____User_temp_12287, _file____User_temp_12288);
      __yo_t10 _file____User_temp_12291 = yo_id_3607(_file____User_temp_12289, imports_blk);
switch ((_file____User_temp_12286).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_12286).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_12287).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_12287).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_12288).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_12288).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_12289).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_12289).data.Some.value));
    break;
  }
  default: break;
}
      _file____User_temp_12322 = _file____User_temp_12291;
      break;
    }
    case __YO_T23_SOME: {
      size_t e_idx = export_idx.data.Some.value;
      size_t _file____User_temp_12296 = yo_id_3414(export_line);
      size_t _file____User_temp_12298 = ((((e_idx) + (_file____User_temp_12296))) + (1ULL));
      size_t end_idx = _file____User_temp_12298;
      __yo_t10 _file____User_temp_12299 = yo_id_3684(content, 0ULL, m_idx);
      __yo_t10 prefix = _file____User_temp_12299;
      size_t _file____User_temp_12300 = yo_id_3414(content);
      __yo_t10 _file____User_temp_12301 = yo_id_3684(content, end_idx, _file____User_temp_12300);
      __yo_t10 tail = _file____User_temp_12301;
      __yo_t10 _file____User_temp_12316 = yo_id_3607(prefix, marker);
      __yo_t10 _file____User_temp_12317 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"\n", .len = 1 });
      __yo_t10 _file____User_temp_12318 = yo_id_3607(_file____User_temp_12316, _file____User_temp_12317);
      __yo_t10 _file____User_temp_12319 = yo_id_3607(_file____User_temp_12318, imports_blk);
      __yo_t10 _file____User_temp_12320 = yo_id_3607(_file____User_temp_12319, tail);
switch ((prefix).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((prefix).data.Some.value));
    break;
  }
  default: break;
}
switch ((tail).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((tail).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_12316).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_12316).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_12317).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_12317).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_12318).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_12318).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_12319).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_12319).data.Some.value));
    break;
  }
  default: break;
}
      _file____User_temp_12322 = _file____User_temp_12320;
      break;
    }
    }
    _file____User_temp_12324 = _file____User_temp_12322;
    break;
  }
  }
  __yo_t10 __yo_scope_ret = _file____User_temp_12324;
  __yo_decr_rc((void*)(dep_names));
switch ((marker).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((marker).data.Some.value));
    break;
  }
  default: break;
}
switch ((export_line).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((export_line).data.Some.value));
    break;
  }
  default: break;
}
switch ((imports_blk).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((imports_blk).data.Some.value));
    break;
  }
  default: break;
}
  return __yo_scope_ret;
}
static inline __yo_t9 yo_id_9846(__yo_t10 text) {
  __yo_t10 _file____User_temp_11741 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"\n", .len = 1 });
  __yo_t16* _file____User_temp_11742 = yo_id_4285_String_id_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam0_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam1_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_ret_R_gs_yo_id_3109_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8(text, _file____User_temp_11741);
  __yo_t16* lines = _file____User_temp_11742;
  __yo_t31* _file____User_temp_11746 = yo_id_3124__ret_R_gs_yo_id_3109_R_struct_yo_id_9715_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_i32_i32_i32();
  __yo_t31* tags = _file____User_temp_11746;
  size_t _file____User_temp_11749 = yo_id_3119_rtparam0_R_gs_yo_id_3109_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_ret_usize(lines);
  size_t n = _file____User_temp_11749;
  size_t i = 0ULL;
  while (true) {
    if (!(((i) < (n)))) {
      break;
    }
    { // begin block (loop body)
    __yo_t9 _file____User_temp_11753 = yo_id_3138_rtparam0_R_gs_yo_id_3109_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam1_usize_ret_enum_yo_id_3135_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8(lines, i);
    switch ((_file____User_temp_11753).tag) {
    case __YO_T9_NONE: {
      break;
    }
    case __YO_T9_SOME: {
      __yo_t10 line = _file____User_temp_11753.data.Some.value;
      __yo_t10 _file____User_temp_11755 = yo_id_4027(line);
      __yo_t10 trimmed = _file____User_temp_11755;
      bool __yo_sc_yo_id_12330 = false;
      size_t _file____User_temp_11758 = yo_id_3414(trimmed);
      if (((_file____User_temp_11758) > (0ULL))) {
        __yo_t10 _file____User_temp_11764 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"^{}", .len = 3 });
        bool _file____User_temp_11765 = yo_id_4278_String_id_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam0_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam1_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam2_usize_ret_bool(trimmed, _file____User_temp_11764, -1ULL);
        __yo_effect_escaped = 0;
        bool _file____User_temp_11766 = yo_id_122_bool_id_bool_rtparam0_bool_ret_bool((bool)(_file____User_temp_11765));
        if (__yo_effect_escaped) {
          // Drop local variables before early return
switch ((_file____User_temp_11764).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_11764).data.Some.value));
    break;
  }
  default: break;
}
switch ((trimmed).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((trimmed).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_11753).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_11753).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_11753).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
switch ((_file____User_temp_11741).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_11741).data.Some.value));
    break;
  }
  default: break;
}
          __yo_decr_rc((void*)(lines));
          __yo_decr_rc((void*)(tags));
          return (__yo_t9){0};
        }
        __yo_sc_yo_id_12330 = _file____User_temp_11766;
switch ((_file____User_temp_11764).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_11764).data.Some.value));
    break;
  }
  default: break;
}
      }
      if (__yo_sc_yo_id_12330) {
        __yo_t10 _file____User_temp_11768 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"\t", .len = 1 });
        __yo_t16* _file____User_temp_11769 = yo_id_4285_String_id_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam0_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam1_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_ret_R_gs_yo_id_3109_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8(trimmed, _file____User_temp_11768);
        __yo_t16* parts = _file____User_temp_11769;
        __yo_t9 _file____User_temp_11771 = yo_id_3138_rtparam0_R_gs_yo_id_3109_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam1_usize_ret_enum_yo_id_3135_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8(parts, 1ULL);
        switch ((_file____User_temp_11771).tag) {
        case __YO_T9_NONE: {
          break;
        }
        case __YO_T9_SOME: {
          __yo_t10 ref_path = _file____User_temp_11771.data.Some.value;
          __yo_t10 _file____User_temp_11773 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"refs/tags/", .len = 10 });
          __yo_t10 prefix = _file____User_temp_11773;
          bool _file____User_temp_11776 = yo_id_4277_String_id_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam0_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam1_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam2_usize_ret_bool(ref_path, prefix, 0ULL);
          if (_file____User_temp_11776) {
            size_t _file____User_temp_11777 = yo_id_3414(prefix);
            size_t _file____User_temp_11778 = yo_id_3414(ref_path);
            __yo_t10 _file____User_temp_11779 = yo_id_3684(ref_path, _file____User_temp_11777, _file____User_temp_11778);
            __yo_t10 tag_name = _file____User_temp_11779;
            __yo_effect_escaped = 0;
            __yo_t29 _file____User_temp_11781 = yo_id_9763((__yo_t10)(tag_name));
            if (__yo_effect_escaped) {
              // Drop local variables before early return
switch ((tag_name).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((tag_name).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_11781).tag) {
  case __YO_T29_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_11781).data.Some.value));
    break;
  }
  default: break;
}
switch ((prefix).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((prefix).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_11768).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_11768).data.Some.value));
    break;
  }
  default: break;
}
              __yo_decr_rc((void*)(parts));
switch ((_file____User_temp_11771).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_11771).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_11771).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
switch ((trimmed).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((trimmed).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_11753).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_11753).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_11753).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
switch ((_file____User_temp_11741).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_11741).data.Some.value));
    break;
  }
  default: break;
}
              __yo_decr_rc((void*)(lines));
              __yo_decr_rc((void*)(tags));
              return (__yo_t9){0};
            }
            switch ((_file____User_temp_11781).tag) {
            case __YO_T29_NONE: {
              break;
            }
            case __YO_T29_SOME: {
              __yo_t28* sv = _file____User_temp_11781.data.Some.value;
              __yo_t6 _file____User_temp_11847 = yo_id_3133_rtparam0_R_gs_yo_id_3109_R_struct_yo_id_9715_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_i32_i32_i32_rtparam1_R_struct_yo_id_9715_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_i32_i32_i32_ret_enum_yo_id_3132_unit_enum_yo_id_3108_enum_yo_id_3055_usize_usize(tags, sv);
              _file____User_temp_11847;
              break;
            }
            }
switch ((tag_name).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((tag_name).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_11781).tag) {
  case __YO_T29_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_11781).data.Some.value));
    break;
  }
  default: break;
}
          }
          else {
          }
switch ((prefix).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((prefix).data.Some.value));
    break;
  }
  default: break;
}
          break;
        }
        }
switch ((_file____User_temp_11768).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_11768).data.Some.value));
    break;
  }
  default: break;
}
        __yo_decr_rc((void*)(parts));
switch ((_file____User_temp_11771).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_11771).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_11771).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
      }
      else {
      }
switch ((trimmed).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((trimmed).data.Some.value));
    break;
  }
  default: break;
}
      break;
    }
    }
    size_t _file____User_temp_11861 = i; // Save old value for later use
    i = ((i) + (1ULL));
    _file____User_temp_11861;
switch ((_file____User_temp_11753).tag) {
  case __YO_T9_SOME: {
switch (((_file____User_temp_11753).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((_file____User_temp_11753).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
    } // end begin block (loop body)
  }
  loop_yo_id_12329:;
  size_t _file____User_temp_11867 = yo_id_3119_rtparam0_R_gs_yo_id_3109_R_struct_yo_id_9715_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_i32_i32_i32_ret_usize(tags);
  if (((_file____User_temp_11867) == (0ULL))) {
    __yo_t9 _file____User_temp_11871 = (__yo_t9){ .tag = __YO_T9_NONE };
    // Drop local variables before early return
switch ((_file____User_temp_11741).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_11741).data.Some.value));
    break;
  }
  default: break;
}
    __yo_decr_rc((void*)(lines));
    __yo_decr_rc((void*)(tags));
    return _file____User_temp_11871;
  }
  else {
  }
  __yo_t28* _file____User_temp_11895;
  __yo_t29 _file____User_temp_11891 = yo_id_3138_rtparam0_R_gs_yo_id_3109_R_struct_yo_id_9715_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_i32_i32_i32_rtparam1_usize_ret_enum_yo_id_3135_R_struct_yo_id_9715_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_i32_i32_i32(tags, 0ULL);
  switch ((_file____User_temp_11891).tag) {
  case __YO_T29_NONE: {
    __yo_t9 _file____User_temp_11892 = (__yo_t9){ .tag = __YO_T9_NONE };
    // Drop local variables before early return
switch ((_file____User_temp_11741).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_11741).data.Some.value));
    break;
  }
  default: break;
}
    __yo_decr_rc((void*)(lines));
    __yo_decr_rc((void*)(tags));
switch ((_file____User_temp_11891).tag) {
  case __YO_T29_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_11891).data.Some.value));
    break;
  }
  default: break;
}
    return _file____User_temp_11892;
    break;
  }
  case __YO_T29_SOME: {
    __yo_t28* t = _file____User_temp_11891.data.Some.value;
    __yo_t28* _file____User_temp_11894 = t;
    ((__yo_t28*)__yo_incr_rc((void*)(_file____User_temp_11894)));
    _file____User_temp_11895 = _file____User_temp_11894;
    break;
  }
  }
  __yo_t28* best = _file____User_temp_11895;
  size_t j = 1ULL;
  while (true) {
    size_t _file____User_temp_11897 = yo_id_3119_rtparam0_R_gs_yo_id_3109_R_struct_yo_id_9715_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_i32_i32_i32_ret_usize(tags);
    if (!(((j) < (_file____User_temp_11897)))) {
      break;
    }
    { // begin block (loop body)
    __yo_t29 _file____User_temp_11901 = yo_id_3138_rtparam0_R_gs_yo_id_3109_R_struct_yo_id_9715_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_i32_i32_i32_rtparam1_usize_ret_enum_yo_id_3135_R_struct_yo_id_9715_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_i32_i32_i32(tags, j);
    switch ((_file____User_temp_11901).tag) {
    case __YO_T29_NONE: {
      break;
    }
    case __YO_T29_SOME: {
      __yo_t28* t = _file____User_temp_11901.data.Some.value;
      __yo_effect_escaped = 0;
      int32_t _file____User_temp_11905 = yo_id_9831((__yo_t28*)(t), (__yo_t28*)(best));
      if (__yo_effect_escaped) {
        // Drop local variables before early return
switch ((_file____User_temp_11901).tag) {
  case __YO_T29_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_11901).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_11741).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_11741).data.Some.value));
    break;
  }
  default: break;
}
        __yo_decr_rc((void*)(lines));
        __yo_decr_rc((void*)(tags));
switch ((_file____User_temp_11891).tag) {
  case __YO_T29_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_11891).data.Some.value));
    break;
  }
  default: break;
}
        __yo_decr_rc((void*)(best));
        return (__yo_t9){0};
      }
      if (((_file____User_temp_11905) > (0))) {
        __yo_t28* _file____User_temp_11908 = best; // Save old value for later use
        ((__yo_t28*)__yo_incr_rc((void*)(t)));
        best = t;
        __yo_decr_rc((void*)(_file____User_temp_11908));
      }
      else {
      }
      break;
    }
    }
    size_t _file____User_temp_11915 = j; // Save old value for later use
    j = ((j) + (1ULL));
    _file____User_temp_11915;
switch ((_file____User_temp_11901).tag) {
  case __YO_T29_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_11901).data.Some.value));
    break;
  }
  default: break;
}
    } // end begin block (loop body)
  }
  loop_yo_id_12331:;
__yo_t10 _file____User_temp_11917 = best->tag;
__yo_t11 temp_dup_enum_yo_id_12332 = _file____User_temp_11917;
switch ((temp_dup_enum_yo_id_12332).tag) {
  case __YO_T11_SOME: {
    (temp_dup_enum_yo_id_12332).data.Some.value = ((__yo_t0*)__yo_incr_rc((void*)((temp_dup_enum_yo_id_12332).data.Some.value)));
    break;
  }
  default: break;
}
  temp_dup_enum_yo_id_12332;
  __yo_t9 _file____User_temp_11918 = (__yo_t9){ .tag = __YO_T9_SOME, .data = { .Some = { .value = _file____User_temp_11917 } } };
  __yo_t9 __yo_scope_ret = _file____User_temp_11918;
switch ((_file____User_temp_11741).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_11741).data.Some.value));
    break;
  }
  default: break;
}
  __yo_decr_rc((void*)(lines));
  __yo_decr_rc((void*)(tags));
switch ((_file____User_temp_11891).tag) {
  case __YO_T29_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_11891).data.Some.value));
    break;
  }
  default: break;
}
  __yo_decr_rc((void*)(best));
  return __yo_scope_ret;
}
static inline __yo_t22 yo_id_3439(__yo_t10 self) {
  __yo_t22 _file____User_temp_1723;
  __yo_t11 _file____User_temp_1711 = self;
__yo_t11 temp_dup_enum_yo_id_12333 = _file____User_temp_1711;
switch ((temp_dup_enum_yo_id_12333).tag) {
  case __YO_T11_SOME: {
    (temp_dup_enum_yo_id_12333).data.Some.value = ((__yo_t0*)__yo_incr_rc((void*)((temp_dup_enum_yo_id_12333).data.Some.value)));
    break;
  }
  default: break;
}
  temp_dup_enum_yo_id_12333;
  switch ((_file____User_temp_1711).tag) {
  case __YO_T11_NONE: {
    _file____User_temp_1723 = (__yo_t22){ .ptr = "", .len = 0ULL };
    break;
  }
  case __YO_T11_SOME: {
    __yo_t0* al = _file____User_temp_1711.data.Some.value;
    __yo_t22 _file____User_temp_1722;
    uint8_t* _file____User_temp_1715 = al->_ptr;
    if (_file____User_temp_1715 != NULL) {
      uint8_t* p = _file____User_temp_1715;
      __yo_t22 _file____User_temp_1718 = (__yo_t22){ .ptr = p, .len = al->_length };
      _file____User_temp_1722 = _file____User_temp_1718;
    } else {
      _file____User_temp_1722 = (__yo_t22){ .ptr = "", .len = 0ULL };
    }
    _file____User_temp_1723 = _file____User_temp_1722;
    break;
  }
  }
  return _file____User_temp_1723;
}
static inline __yo_t35 yo_id_9927(__yo_t10 spec) {
  __yo_t10 _file____User_temp_11921 = yo_id_4570((&(spec)));
  __yo_t10 spec_str = _file____User_temp_11921;
  __yo_effect_escaped = 0;
  bool _file____User_temp_11924 = yo_id_9717((__yo_t10)(spec_str));
  if (__yo_effect_escaped) {
    // Drop local variables before early return
switch ((spec_str).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((spec_str).data.Some.value));
    break;
  }
  default: break;
}
    return (__yo_t35){0};
  }
  if (_file____User_temp_11924) {
    __yo_effect_escaped = 0;
    __yo_t10 _file____User_temp_11925 = yo_id_9731((__yo_t10)(spec_str));
    if (__yo_effect_escaped) {
      // Drop local variables before early return
switch ((spec_str).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((spec_str).data.Some.value));
    break;
  }
  default: break;
}
      return (__yo_t35){0};
    }
    __yo_t10 name = _file____User_temp_11925;
__yo_t11 temp_dup_enum_yo_id_12334 = name;
switch ((temp_dup_enum_yo_id_12334).tag) {
  case __YO_T11_SOME: {
    (temp_dup_enum_yo_id_12334).data.Some.value = ((__yo_t0*)__yo_incr_rc((void*)((temp_dup_enum_yo_id_12334).data.Some.value)));
    break;
  }
  default: break;
}
    temp_dup_enum_yo_id_12334;
__yo_t11 temp_dup_enum_yo_id_12335 = spec;
switch ((temp_dup_enum_yo_id_12335).tag) {
  case __YO_T11_SOME: {
    (temp_dup_enum_yo_id_12335).data.Some.value = ((__yo_t0*)__yo_incr_rc((void*)((temp_dup_enum_yo_id_12335).data.Some.value)));
    break;
  }
  default: break;
}
    temp_dup_enum_yo_id_12335;
    __yo_t34 _file____User_temp_11926 = (__yo_t34){ .tag = __YO_T34_PATH, .data = { .Path = { .name = name, .rel_path = spec } } };
    __yo_t35 _file____User_temp_11927 = (__yo_t35){ .tag = __YO_T35_OK, .data = { .Ok = { .value = _file____User_temp_11926 } } };
    // Drop local variables before early return
switch ((name).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((name).data.Some.value));
    break;
  }
  default: break;
}
switch ((spec_str).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((spec_str).data.Some.value));
    break;
  }
  default: break;
}
    return _file____User_temp_11927;
switch ((name).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((name).data.Some.value));
    break;
  }
  default: break;
}
  }
  else {
  }
  __yo_t10 _file____User_temp_11931 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"@", .len = 1 });
  __yo_t23 _file____User_temp_11932 = yo_id_4283_String_id_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam0_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam1_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam2_usize_ret_enum_yo_id_3135_usize(spec, _file____User_temp_11931, -1ULL);
  __yo_t23 at_idx = _file____User_temp_11932;
  __yo_t10 _file____User_temp_11942;
  switch ((at_idx).tag) {
  case __YO_T23_NONE: {
    __yo_t10 _file____User_temp_11933 = spec;
__yo_t11 temp_dup_enum_yo_id_12336 = _file____User_temp_11933;
switch ((temp_dup_enum_yo_id_12336).tag) {
  case __YO_T11_SOME: {
    (temp_dup_enum_yo_id_12336).data.Some.value = ((__yo_t0*)__yo_incr_rc((void*)((temp_dup_enum_yo_id_12336).data.Some.value)));
    break;
  }
  default: break;
}
    temp_dup_enum_yo_id_12336;
    _file____User_temp_11942 = _file____User_temp_11933;
    break;
  }
  case __YO_T23_SOME: {
    size_t idx = at_idx.data.Some.value;
    __yo_t10 _file____User_temp_11940;
    if (((idx) > (0ULL))) {
      __yo_t10 _file____User_temp_11938 = yo_id_3684(spec, 0ULL, idx);
      _file____User_temp_11940 = _file____User_temp_11938;
    }
    else {
      __yo_t10 _file____User_temp_11939 = spec;
__yo_t11 temp_dup_enum_yo_id_12337 = _file____User_temp_11939;
switch ((temp_dup_enum_yo_id_12337).tag) {
  case __YO_T11_SOME: {
    (temp_dup_enum_yo_id_12337).data.Some.value = ((__yo_t0*)__yo_incr_rc((void*)((temp_dup_enum_yo_id_12337).data.Some.value)));
    break;
  }
  default: break;
}
      temp_dup_enum_yo_id_12337;
      _file____User_temp_11940 = _file____User_temp_11939;
    }
    _file____User_temp_11942 = _file____User_temp_11940;
    break;
  }
  }
  __yo_t10 url_part = _file____User_temp_11942;
  __yo_t9 _file____User_temp_11955;
  switch ((at_idx).tag) {
  case __YO_T23_NONE: {
    _file____User_temp_11955 = (__yo_t9){ .tag = __YO_T9_NONE };
    break;
  }
  case __YO_T23_SOME: {
    size_t idx = at_idx.data.Some.value;
    __yo_t9 _file____User_temp_11953;
    if (((idx) > (0ULL))) {
      size_t _file____User_temp_11948 = yo_id_3414(spec);
      __yo_t10 _file____User_temp_11949 = yo_id_3684(spec, ((idx) + (1ULL)), _file____User_temp_11948);
      __yo_t9 _file____User_temp_11951 = (__yo_t9){ .tag = __YO_T9_SOME, .data = { .Some = { .value = _file____User_temp_11949 } } };
      _file____User_temp_11953 = _file____User_temp_11951;
    }
    else {
      _file____User_temp_11953 = (__yo_t9){ .tag = __YO_T9_NONE };
    }
    _file____User_temp_11955 = _file____User_temp_11953;
    break;
  }
  }
  __yo_t9 pinned_ref = _file____User_temp_11955;
  __yo_t10 _file____User_temp_12018;
  bool __yo_sc_yo_id_12338 = true;
  __yo_t10 _file____User_temp_11956 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"https://", .len = 8 });
  bool _file____User_temp_11957 = yo_id_4277_String_id_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam0_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam1_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam2_usize_ret_bool(url_part, _file____User_temp_11956, 0ULL);
  if (!(_file____User_temp_11957)) {
    __yo_t10 _file____User_temp_11958 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"http://", .len = 7 });
    bool _file____User_temp_11959 = yo_id_4277_String_id_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam0_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam1_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam2_usize_ret_bool(url_part, _file____User_temp_11958, 0ULL);
    __yo_sc_yo_id_12338 = _file____User_temp_11959;
switch ((_file____User_temp_11958).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_11958).data.Some.value));
    break;
  }
  default: break;
}
  }
  if (__yo_sc_yo_id_12338) {
    __yo_t10 _file____User_temp_11972;
    __yo_t10 _file____User_temp_11965 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)".git", .len = 4 });
    bool _file____User_temp_11967 = yo_id_4278_String_id_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam0_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam1_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam2_usize_ret_bool(url_part, _file____User_temp_11965, -1ULL);
switch ((_file____User_temp_11965).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_11965).data.Some.value));
    break;
  }
  default: break;
}
    if (_file____User_temp_11967) {
      __yo_t10 _file____User_temp_11968 = url_part;
__yo_t11 temp_dup_enum_yo_id_12339 = _file____User_temp_11968;
switch ((temp_dup_enum_yo_id_12339).tag) {
  case __YO_T11_SOME: {
    (temp_dup_enum_yo_id_12339).data.Some.value = ((__yo_t0*)__yo_incr_rc((void*)((temp_dup_enum_yo_id_12339).data.Some.value)));
    break;
  }
  default: break;
}
      temp_dup_enum_yo_id_12339;
      _file____User_temp_11972 = _file____User_temp_11968;
    }
    else {
      __yo_t10 _file____User_temp_11969 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)".git", .len = 4 });
      __yo_t10 _file____User_temp_11971 = yo_id_3607(url_part, _file____User_temp_11969);
switch ((_file____User_temp_11969).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_11969).data.Some.value));
    break;
  }
  default: break;
}
      _file____User_temp_11972 = _file____User_temp_11971;
    }
    _file____User_temp_12018 = _file____User_temp_11972;
  }
  else {
    __yo_t10 _file____User_temp_11961 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"github.com/", .len = 11 });
    bool _file____User_temp_11963 = yo_id_4277_String_id_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam0_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam1_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam2_usize_ret_bool(url_part, _file____User_temp_11961, 0ULL);
switch ((_file____User_temp_11961).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_11961).data.Some.value));
    break;
  }
  default: break;
}
    if (_file____User_temp_11963) {
      __yo_t10 _file____User_temp_11975 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"https://", .len = 8 });
      __yo_t10 _file____User_temp_11976 = yo_id_3607(_file____User_temp_11975, url_part);
      __yo_t10 s = _file____User_temp_11976;
      __yo_t10 _file____User_temp_11985;
      __yo_t10 _file____User_temp_11978 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)".git", .len = 4 });
      bool _file____User_temp_11980 = yo_id_4278_String_id_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam0_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam1_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam2_usize_ret_bool(s, _file____User_temp_11978, -1ULL);
switch ((_file____User_temp_11978).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_11978).data.Some.value));
    break;
  }
  default: break;
}
      if (_file____User_temp_11980) {
        __yo_t10 _file____User_temp_11981 = s;
__yo_t11 temp_dup_enum_yo_id_12340 = _file____User_temp_11981;
switch ((temp_dup_enum_yo_id_12340).tag) {
  case __YO_T11_SOME: {
    (temp_dup_enum_yo_id_12340).data.Some.value = ((__yo_t0*)__yo_incr_rc((void*)((temp_dup_enum_yo_id_12340).data.Some.value)));
    break;
  }
  default: break;
}
        temp_dup_enum_yo_id_12340;
        _file____User_temp_11985 = _file____User_temp_11981;
      }
      else {
        __yo_t10 _file____User_temp_11982 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)".git", .len = 4 });
        __yo_t10 _file____User_temp_11984 = yo_id_3607(s, _file____User_temp_11982);
switch ((_file____User_temp_11982).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_11982).data.Some.value));
    break;
  }
  default: break;
}
        _file____User_temp_11985 = _file____User_temp_11984;
      }
      _file____User_temp_12018 = _file____User_temp_11985;
switch ((_file____User_temp_11975).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_11975).data.Some.value));
    break;
  }
  default: break;
}
switch ((s).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((s).data.Some.value));
    break;
  }
  default: break;
}
    }
    else {
      __yo_t10 _file____User_temp_11987 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"/", .len = 1 });
      __yo_t16* _file____User_temp_11988 = yo_id_4285_String_id_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam0_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam1_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_ret_R_gs_yo_id_3109_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8(url_part, _file____User_temp_11987);
      __yo_t16* slash_parts = _file____User_temp_11988;
      __yo_t10 _file____User_temp_12016;
      size_t _file____User_temp_11991 = yo_id_3119_rtparam0_R_gs_yo_id_3109_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_ret_usize(slash_parts);
      if (((_file____User_temp_11991) == (2ULL))) {
        __yo_t10 _file____User_temp_11995 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"https://github.com/", .len = 19 });
        __yo_t10 _file____User_temp_11996 = yo_id_3607(_file____User_temp_11995, url_part);
        __yo_t10 s = _file____User_temp_11996;
        __yo_t10 _file____User_temp_12004;
        __yo_t10 _file____User_temp_11997 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)".git", .len = 4 });
        bool _file____User_temp_11999 = yo_id_4278_String_id_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam0_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam1_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_rtparam2_usize_ret_bool(s, _file____User_temp_11997, -1ULL);
switch ((_file____User_temp_11997).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_11997).data.Some.value));
    break;
  }
  default: break;
}
        if (_file____User_temp_11999) {
          __yo_t10 _file____User_temp_12000 = s;
__yo_t11 temp_dup_enum_yo_id_12341 = _file____User_temp_12000;
switch ((temp_dup_enum_yo_id_12341).tag) {
  case __YO_T11_SOME: {
    (temp_dup_enum_yo_id_12341).data.Some.value = ((__yo_t0*)__yo_incr_rc((void*)((temp_dup_enum_yo_id_12341).data.Some.value)));
    break;
  }
  default: break;
}
          temp_dup_enum_yo_id_12341;
          _file____User_temp_12004 = _file____User_temp_12000;
        }
        else {
          __yo_t10 _file____User_temp_12001 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)".git", .len = 4 });
          __yo_t10 _file____User_temp_12003 = yo_id_3607(s, _file____User_temp_12001);
switch ((_file____User_temp_12001).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_12001).data.Some.value));
    break;
  }
  default: break;
}
          _file____User_temp_12004 = _file____User_temp_12003;
        }
        _file____User_temp_12016 = _file____User_temp_12004;
switch ((_file____User_temp_11995).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_11995).data.Some.value));
    break;
  }
  default: break;
}
switch ((s).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((s).data.Some.value));
    break;
  }
  default: break;
}
      }
      else {
        __yo_t10 _file____User_temp_12010 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"Invalid package specifier: \"", .len = 28 });
        __yo_t10 _file____User_temp_12011 = yo_id_3607(_file____User_temp_12010, spec);
        __yo_t10 _file____User_temp_12012 = yo_id_3356((__yo_str){ .ptr = (const uint8_t*)"\". Use 'user/repo', 'github.com/user/repo', or a full URL.", .len = 58 });
        __yo_t10 _file____User_temp_12013 = yo_id_3607(_file____User_temp_12011, _file____User_temp_12012);
        __yo_t35 _file____User_temp_12014 = (__yo_t35){ .tag = __YO_T35_ERR, .data = { .Err = { .error = _file____User_temp_12013 } } };
        // Drop local variables before early return
switch ((_file____User_temp_12010).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_12010).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_12011).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_12011).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_12012).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_12012).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_11987).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_11987).data.Some.value));
    break;
  }
  default: break;
}
        __yo_decr_rc((void*)(slash_parts));
switch ((spec_str).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((spec_str).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_11931).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_11931).data.Some.value));
    break;
  }
  default: break;
}
switch ((url_part).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((url_part).data.Some.value));
    break;
  }
  default: break;
}
switch ((pinned_ref).tag) {
  case __YO_T9_SOME: {
switch (((pinned_ref).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((pinned_ref).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
        return _file____User_temp_12014;
switch ((_file____User_temp_12010).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_12010).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_12011).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_12011).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_12012).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_12012).data.Some.value));
    break;
  }
  default: break;
}
      }
      _file____User_temp_12018 = _file____User_temp_12016;
switch ((_file____User_temp_11987).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_11987).data.Some.value));
    break;
  }
  default: break;
}
      __yo_decr_rc((void*)(slash_parts));
    }
  }
  __yo_t10 url = _file____User_temp_12018;
  __yo_t10 _file____User_temp_12019 = yo_id_4570((&(url)));
  __yo_effect_escaped = 0;
  __yo_t10 _file____User_temp_12020 = yo_id_9731((__yo_t10)(_file____User_temp_12019));
  if (__yo_effect_escaped) {
    // Drop local variables before early return
switch ((spec_str).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((spec_str).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_11931).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_11931).data.Some.value));
    break;
  }
  default: break;
}
switch ((url_part).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((url_part).data.Some.value));
    break;
  }
  default: break;
}
switch ((pinned_ref).tag) {
  case __YO_T9_SOME: {
switch (((pinned_ref).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((pinned_ref).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
switch ((url).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((url).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_12019).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_12019).data.Some.value));
    break;
  }
  default: break;
}
    return (__yo_t35){0};
  }
  __yo_t10 name = _file____User_temp_12020;
__yo_t11 temp_dup_enum_yo_id_12342 = name;
switch ((temp_dup_enum_yo_id_12342).tag) {
  case __YO_T11_SOME: {
    (temp_dup_enum_yo_id_12342).data.Some.value = ((__yo_t0*)__yo_incr_rc((void*)((temp_dup_enum_yo_id_12342).data.Some.value)));
    break;
  }
  default: break;
}
  temp_dup_enum_yo_id_12342;
__yo_t11 temp_dup_enum_yo_id_12343 = url;
switch ((temp_dup_enum_yo_id_12343).tag) {
  case __YO_T11_SOME: {
    (temp_dup_enum_yo_id_12343).data.Some.value = ((__yo_t0*)__yo_incr_rc((void*)((temp_dup_enum_yo_id_12343).data.Some.value)));
    break;
  }
  default: break;
}
  temp_dup_enum_yo_id_12343;
__yo_t9 temp_dup_enum_yo_id_12344 = pinned_ref;
switch ((temp_dup_enum_yo_id_12344).tag) {
  case __YO_T9_SOME: {
__yo_t11 temp_dup_enum_yo_id_12345 = (temp_dup_enum_yo_id_12344).data.Some.value;
switch ((temp_dup_enum_yo_id_12345).tag) {
  case __YO_T11_SOME: {
    (temp_dup_enum_yo_id_12345).data.Some.value = ((__yo_t0*)__yo_incr_rc((void*)((temp_dup_enum_yo_id_12345).data.Some.value)));
    break;
  }
  default: break;
}
    (temp_dup_enum_yo_id_12344).data.Some.value = temp_dup_enum_yo_id_12345;
    break;
  }
  default: break;
}
  temp_dup_enum_yo_id_12344;
  __yo_t34 _file____User_temp_12021 = (__yo_t34){ .tag = __YO_T34_GIT, .data = { .Git = { .name = name, .url = url, .pinned_ref = pinned_ref } } };
  __yo_t35 _file____User_temp_12022 = (__yo_t35){ .tag = __YO_T35_OK, .data = { .Ok = { .value = _file____User_temp_12021 } } };
  __yo_t35 __yo_scope_ret = _file____User_temp_12022;
switch ((spec_str).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((spec_str).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_11931).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_11931).data.Some.value));
    break;
  }
  default: break;
}
switch ((url_part).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((url_part).data.Some.value));
    break;
  }
  default: break;
}
switch ((pinned_ref).tag) {
  case __YO_T9_SOME: {
switch (((pinned_ref).data.Some.value).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)(((pinned_ref).data.Some.value).data.Some.value));
    break;
  }
  default: break;
}
    break;
  }
  default: break;
}
switch ((url).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((url).data.Some.value));
    break;
  }
  default: break;
}
switch ((_file____User_temp_12019).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((_file____User_temp_12019).data.Some.value));
    break;
  }
  default: break;
}
switch ((name).tag) {
  case __YO_T11_SOME: {
    __yo_decr_rc((void*)((name).data.Some.value));
    break;
  }
  default: break;
}
  return __yo_scope_ret;
}
static inline void yo_id_12142(__yo_t19* self) {
  __yo_t16* __yo_disp_f0 = self->_segments; // Destructuring _segments
  __yo_decr_rc((void*)(__yo_disp_f0));
}
static inline void yo_id_3163_rtparam0_R_gs_yo_id_3109_R_struct_yo_id_9715_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_i32_i32_i32_ret_unit(__yo_t31* self) {
  __yo_t28** _file____User_temp_14264 = self->_ptr;
  if (_file____User_temp_14264 != NULL) {
    __yo_t28** _ptr = _file____User_temp_14264;
    yo_id_3141_rtparam0_R_gs_yo_id_3109_R_struct_yo_id_9715_struct_yo_id_3273_enum_yo_id_3280_R_gs_yo_id_3109_u8_i32_i32_i32_ret_unit((__yo_t31*)(self));
    size_t _file____User_temp_14295 = self->_length; // Save old value for later use
    self->_length = 0ULL;
    _file____User_temp_14295;
    void* _file____User_temp_14296 = ((void*)(_ptr));
    __yo_borrow_assert_unborrowed((void*)self);
    __yo_free(_file____User_temp_14296);
    __yo_t28** _file____User_temp_14298 = self->_ptr; // Save old value for later use
    self->_ptr = NULL;
    _file____User_temp_14298;
  } else {
  }
}
static inline void* yo_id_2456_rtparam0_enum_yo_id_2455___void__ret___void_(void* self) {
  void* _file____User_temp_6378;
  if (self != NULL) {
    void* value = self;
    _file____User_temp_6378 = value;
  } else {
    fprintf(stderr, "%s\n", "\"Called unwrap on a None value\"");
    abort();
    _file____User_temp_6378 = (*((void**)NULL));
  }
  return _file____User_temp_6378;
}

// Program body runs on a large-stack worker thread (see generateMainWrapper).
static void* __yo_main_thread_entry(void* __yo_unused_arg) {
  (void)__yo_unused_arg;
  // Call sync main
  __yo_user_main();
  return NULL;
}

// Main wrapper - runs program body on a worker thread (default 1 GiB stack,
// overridable via the YO_MAIN_STACK_MB env var)
int main(int argc, char** argv) {
  __yo_argc = (int32_t)argc;
  __yo_argv = (uint8_t**)argv;
  __yo_args = (Slice_uint8_t_u42_){ .data = (uint8_t**)argv, .length = (size_t)argc };
  pthread_attr_t __yo_main_attr;
  pthread_t __yo_main_tid;
  size_t __yo_main_stack = (size_t)1024 * 1024 * 1024; // 1 GiB
  {
    const char* __yo_stack_mb = getenv("YO_MAIN_STACK_MB");
    if (__yo_stack_mb != NULL) {
      long __yo_mb = atol(__yo_stack_mb);
      if (__yo_mb > 0) __yo_main_stack = (size_t)__yo_mb * 1024 * 1024;
    }
  }
  if (pthread_attr_init(&__yo_main_attr) == 0
      && pthread_attr_setstacksize(&__yo_main_attr, __yo_main_stack) == 0
      && pthread_create(&__yo_main_tid, &__yo_main_attr, __yo_main_thread_entry, NULL) == 0) {
    pthread_attr_destroy(&__yo_main_attr);
    pthread_join(__yo_main_tid, NULL);
  } else {
    __yo_main_thread_entry(NULL);
  }
  return 0;
}
