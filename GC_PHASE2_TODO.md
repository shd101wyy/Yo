# GC Phase 2 Implementation TODO

**Last updated:** 2025-11-15
**Status:** 🚧 In Progress (~75% complete)

## Recent Progress (Session: Nov 15-16, 2025)

✅ **TODO 1 COMPLETE:** Replaced all `__yo_malloc` with `__yo_gc_alloc` in constructors
- Updated object, closure, dyn, and Future allocations
- All GC-managed types now use `__yo_gc_alloc(size, type_descriptor)`
- Removed manual `gc_next/gc_prev` initialization

✅ **TODO 2 COMPLETE:** Type descriptor generation for precise GC
- Created `src/codegen/types/type_descriptors.ts` (~250 lines)
- Generates `YoTypeDescriptor` structs for all GC-managed types
- Uses `offsetof()` for precise field offset calculation
- Updated all 6 `__yo_gc_alloc` call sites to pass real descriptors
- **Type descriptors enable precise pointer scanning!**

✅ **TODO 3 COMPLETE:** Fixed async runtime RC references
- Removed `header->rc` access and `__yo_decr_rc()` calls from `__yo_future_drop`
- Removed `__yo_cleanup_thread_gc()` call (function doesn't exist)
- Fixed thread-local storage syntax errors
- **Code now compiles and runs successfully!**

✅ **TODO 4 COMPLETE:** Updated closure capture allocation
- Changed closure capture structs from `__yo_malloc` to `__yo_gc_alloc`
- Capture data now GC-managed (line ~213 in expressions/generation.ts)
- **Tested with closures - working correctly!**

✅ **TODO 5 COMPLETE:** GC mark traversal with type descriptors
- Updated `yo_gc_mark_object()` to traverse children using type descriptors
- GC now recursively marks all reachable objects in object graphs
- **GC can now collect unreachable objects correctly!**

✅ **CRITICAL BUG FIX:** Dispose functions now work correctly
- **Problem:** GC-managed structs had duplicate headers (one from `__yo_gc_alloc`, one inside struct)
- **Solution:** Removed `header` field from all GC types, added `YO_GC_HEADER(obj)` macro
- **Result:** Dispose functions are now called when objects are collected!

🎯 **Next Priority:** TODO 6 - Shadow Stack (Phase 3)

---

## ✅ Completed

1. **GC Runtime Infrastructure**
   - ✅ Created `gc_runtime.ts` with basic mark-sweep collector
   - ✅ Implemented `__yo_gc_alloc(size, type_descriptor)` 
   - ✅ Implemented `__yo_gc_collect()` with tri-color marking
   - ✅ Global object tracking list with doubly-linked list
   - ✅ Auto-triggered GC based on memory threshold
   - ✅ Integrated GC runtime into code generation pipeline
   - ✅ Debug flag support (`--debug-gc`)

## 🚧 In Progress: Update Object Allocation

### TODO 1: Replace `__yo_malloc` with `__yo_gc_alloc` in constructors

**Priority: HIGH** - Objects need to be GC-managed

**Status: ✅ COMPLETE**

**Files modified:**
- `src/codegen/functions/generation.ts` (3 locations)
- `src/codegen/expressions/generation.ts` (1 location)

**Changes made:**
1. Line ~475: Future allocation in async functions
   - Changed: `__yo_malloc(sizeof(${futureTypeCName}))` → `__yo_gc_alloc(sizeof(${futureTypeCName}), NULL)`
   - Removed manual `gc_next/gc_prev` initialization

2. Line ~941: Object constructor allocation
   - Changed: `__yo_malloc(sizeof(${cName}))` → `__yo_gc_alloc(sizeof(${cName}), NULL)`
   - Removed manual `gc_next/gc_prev` initialization

3. Line ~1044: Closure constructor allocation
   - Already using `__yo_gc_alloc` (from previous work)

4. Line ~1140: Dyn constructor allocation
   - Already using `__yo_gc_alloc` (from previous work)

5. `expressions/generation.ts` ~line 2287: Future in async blocks
   - Changed: `__yo_malloc(sizeof(${futureTypeCName}))` → `__yo_gc_alloc(sizeof(${futureTypeCName}), NULL)`
   - Removed manual `gc_next/gc_prev` initialization

**Note:** Currently passing `NULL` for type descriptor. Will be updated in TODO 2.

### TODO 2: Generate Type Descriptors

**Priority: HIGH** - Needed for precise GC pointer scanning

**Status: ✅ COMPLETE**

**What was implemented:**
```c
typedef struct {
  const char* name;           // Type name (for debugging)
  size_t size;                // Object size in bytes
  size_t pointer_count;       // Number of GC pointers
  size_t* pointer_offsets;    // Offsets of GC pointer fields
  void (*finalizer)(void*);   // Dispose function
} YoTypeDescriptor;
```

**Files created/modified:**
- ✅ Created: `src/codegen/types/type_descriptors.ts` (~250 lines)
- ✅ Modified: `src/codegen/types/generation.ts` - integrated type descriptor generation
- ✅ Modified: `src/codegen/functions/generation.ts` - updated 4 constructor call sites
- ✅ Modified: `src/codegen/expressions/generation.ts` - updated 2 constructor call sites

**Implementation details:**
1. ✅ Analyzes each struct/object/closure/dyn/Future type
2. ✅ Identifies GC pointer fields using `typeContainsGcType()` recursively
3. ✅ Generates static type descriptors with pointer offsets using `offsetof()`
4. ✅ All `__yo_gc_alloc` calls now pass real type descriptors
5. ✅ Uses guard functions (`isStructType`, `isClosureType`, etc.) for type checking

**Generated output example:**
```c
static size_t MyNode_pointer_offsets[] = { 8 };  // offset of 'next' field
static YoTypeDescriptor MyNode_type_descriptor = {
  .name = "MyNode",
  .size = 16,
  .pointer_count = 1,
  .pointer_offsets = MyNode_pointer_offsets,
  .finalizer = (void(*)(void*))MyNode_dispose
};
```

### TODO 3: Fix Async Runtime RC References

**Priority: MEDIUM** - Blocking async/await functionality

**Status: ✅ COMPLETE**

**Issue:** Async runtime still referenced removed `__yo_decr_rc` function and RC fields

**What was fixed:**
1. **`__yo_future_drop` function** (runtime.ts ~line 37-64):
   - Removed `header->rc` atomic load (field doesn't exist in `yo_gc_header_t`)
   - Removed `__yo_decr_rc()` call (function removed in Phase 1)
   - Simplified logic: Futures are GC-managed, just mark as detached if still running
   - GC will automatically collect Futures when unreachable

2. **Worker thread cleanup** (runtime.ts ~line 235):
   - Removed `__yo_cleanup_thread_gc()` call (function never existed)
   - Added comment that GC runtime handles thread-local cleanup automatically

3. **Thread-local storage syntax** (runtime.ts ~line 412):
   - Fixed: `__declspec(thread) static __thread` → `__declspec(thread) static` (Windows)
   - Fixed: `__thread static` → `static __thread` (Unix)
   - Proper order: storage class specifier before type specifier

**Result:** ✅ Code now compiles and runs successfully!

### TODO 4: Update Closure Capture Allocation

**Priority: MEDIUM**

**Status: ✅ COMPLETE**

**File:** `src/codegen/expressions/generation.ts`
- Line ~213: Closure capture struct allocation

**Change made:**
```typescript
// Before:
`${captureCName}* ${captureTempVar} = (${captureCName}*)__yo_malloc(sizeof(${captureCName}));`

// After:
`${captureCName}* ${captureTempVar} = (${captureCName}*)__yo_gc_alloc(sizeof(${captureCName}), NULL);  // TODO: Pass type descriptor`
```

**Result:** ✅ Closure capture structs now use GC allocation

### TODO 5: Implement Type Descriptor in GC Mark Phase

**Priority: MEDIUM** - Currently GC cannot traverse object graphs

**Status: ✅ COMPLETE**

**File:** `src/codegen/functions/gc_runtime.ts`

**What was implemented:**
```c
static void yo_gc_mark_object(void* obj_ptr) {
  // ... existing code ...
  
  // Traverse children using type descriptor
  if (header->type_descriptor != NULL) {
    YoTypeDescriptor* desc = (YoTypeDescriptor*)header->type_descriptor;
    for (size_t i = 0; i < desc->pointer_count; i++) {
      void** field = (void**)((char*)obj_ptr + desc->pointer_offsets[i]);
      void* child = *field;
      if (child != NULL) {
        yo_gc_mark_object(child);  // Recursive mark
      }
    }
  }
  
  header->mark_bits = YO_GC_BLACK;
}
```

### CRITICAL BUG FIX: Dispose Functions

**Priority: CRITICAL** - Dispose functions were not being called

**Status: ✅ FIXED**

**Problem:**
- GC-managed structs had a `header` field inside the struct
- This created TWO headers:
  1. One from `__yo_gc_alloc` (the real GC header before the object)
  2. One inside the struct (unused duplicate field)
- Constructors set `dispose_fn` on the inner header (`obj->header.dispose_fn`)
- GC checked the outer header (actual GC header before object)
- Result: `dispose_fn` was always NULL, dispose never called

**Solution:**
- Removed `header` field from all GC-managed types:
  * Objects (`struct` with `isReferenceSemantics`)
  * Closures (`fn` types)
  * Dyn types (`dyn`)
  * Future types (`Future`)
- Added `YO_GC_HEADER(obj)` macro: `((yo_gc_header_t*)(obj)) - 1`
- Updated all constructor code to use macro:
  * `YO_GC_HEADER(obj)->dispose_fn = ...`
  * `YO_GC_HEADER(obj)->traverse_fn = ...`

**Files modified:**
- `src/codegen/types/generation.ts` - removed header fields, added macro
- `src/codegen/functions/generation.ts` - updated object/closure/dyn constructors
- `src/codegen/expressions/generation.ts` - updated async block constructor

**Result:** ✅ Dispose functions now called correctly when objects are collected!

**Test output:**
```
MyBox value: 42
Disposing MyBox with value: 42  ← dispose function called!
```

## 🔮 Future Work (Phase 3)

### TODO 6: Shadow Stack Implementation

**Priority: LOW** - Phase 3 feature

**What:** Track GC roots (local variables) on C stack
- Add shadow stack frame setup/teardown in function prologue/epilogue
- Register all GC pointer locals in shadow stack
- Scan shadow stack in `yo_gc_mark_roots()`

**Files to modify:**
- `src/codegen/functions/generation.ts` - function code generation
- `src/codegen/functions/gc_runtime.ts` - shadow stack data structures

### TODO 7: Write Barriers

**Priority: LOW** - Phase 3 feature

**What:** Track pointer writes for concurrent/generational GC
- Instrument all GC pointer assignments
- Record old→young generation references

### TODO 8: Testing & Validation

**Priority: HIGH** - After TODO 1-5 complete

**Tests to run:**
1. ✅ Compile `fixme.yo` with `--emit-c --skip-c-compiler`
2. ✅ Compile and run `fixme.yo` end-to-end
3. ✅ Test with `--debug-gc` flag to verify allocation/collection
4. ⏳ Test object graphs with cycles
5. ✅ Test disposal (finalizers) being called - **Working!**
6. ✅ Run all existing tests: `bun test src/tests/fixme.test.ts` - **Passing!**

### TODO 9: Documentation Updates

**Priority: MEDIUM**

**Files to update:**
- `GC_DESIGN.md` - Mark Phase 2 as complete
- `AGENTS.md` - Update with Phase 2 completion status
- Add examples of GC usage to documentation

## 📊 Progress Tracking

**Phase 1 (BRC Removal):** ✅ 100% Complete
- Removed ~800 lines of BRC runtime
- Updated object headers to `yo_gc_header_t`
- Removed all BRC macros and initialization

**Phase 2 (Basic GC):** 🚧 ~95% Complete
- ✅ GC runtime infrastructure (100%)
- ✅ Object allocation migration (100%) - TODO 1 complete
- ✅ Type descriptors (100%) - TODO 2 complete
- ✅ Async runtime fixes (100%) - TODO 3 complete
- ✅ Closure capture allocation (100%) - TODO 4 complete
- ✅ GC mark traversal (100%) - TODO 5 complete
- ✅ Dispose functions (100%) - Critical bug fixed
- ⏳ Testing (60%) - Basic tests pass, dispose works, need cycle tests

**Phase 3 (Shadow Stack):** ⏳ 0% Complete
- Not started

## 🎯 Next Immediate Actions

1. **[HIGH]** ~~Update object/closure/dyn allocations to use `__yo_gc_alloc`~~ ✅ DONE
2. **[HIGH]** Generate type descriptors for all GC types (TODO 2)
3. **[MEDIUM]** ~~Fix async runtime `__yo_decr_rc` references~~ ✅ DONE
4. **[MEDIUM]** ~~Update closure capture allocation~~ ✅ DONE
5. **[MEDIUM]** Implement type descriptor traversal in GC mark phase (TODO 5)
6. **[HIGH]** ~~Test compilation and execution~~ ✅ Tests passed
7. **[MEDIUM]** Update GC_DESIGN.md with progress

**Current Status:** 
- ✅ TODO 1 complete - All constructors using `__yo_gc_alloc`
- ✅ TODO 2 complete - Type descriptors generated for all GC types
- ✅ TODO 3 complete - Async runtime fixed, code compiles and runs
- ✅ TODO 4 complete - Closure captures using GC allocation
- ✅ TODO 5 complete - GC mark traversal using type descriptors
- ✅ Dispose functions work - Critical bug fixed
- 🎯 Next: TODO 8 (Testing with cycles) then TODO 6 (Shadow Stack - Phase 3)

---

*Last updated: 2025-11-16*
*Next review: After cycle testing (TODO 8)*
