# GC Phase 3 Implementation TODO - Shadow Stack

**Last updated:** 2025-11-16
**Status:** 🚀 Starting (~0% complete)

## Overview

Phase 3 implements **Shadow Stack** for precise root tracking. This enables the GC to find all reachable objects by scanning local variables in function call stacks.

**Why Shadow Stack?**
- ✅ Precise GC (no false positives like conservative scanning)
- ✅ Enables moving/compacting GC in future
- ✅ Works perfectly with C transpilation
- ✅ Achieves <5ms latency goal
- ✅ Static typing makes it efficient (~3-5% overhead)

**Current limitation:** `yo_gc_mark_roots()` is empty, so all objects are unreachable and get collected during GC.

---

## 📋 TODO List

### TODO 1: Shadow Stack Data Structures

**Priority: HIGH** - Foundation for all shadow stack work

**What to implement:**
```c
typedef struct YoShadowFrame {
  struct YoShadowFrame* prev;   // Previous frame (caller)
  void** roots;                 // Array of pointers to GC pointer locals
  size_t num_roots;             // Number of roots in this frame
  const char* function_name;    // For debugging (optional)
} YoShadowFrame;

// Thread-local shadow stack top
__thread YoShadowFrame* yo_shadow_stack_top = NULL;
```

**Files to modify:**
- `src/codegen/types/generation.ts` - add shadow stack type declarations
- `src/codegen/functions/gc_runtime.ts` - add shadow stack scanning function

**Implementation steps:**
1. Add `YoShadowFrame` typedef to type declarations
2. Add `__thread yo_shadow_stack_top` global variable declaration
3. Implement `yo_gc_scan_shadow_stack()` function:
   ```c
   void yo_gc_scan_shadow_stack() {
     for (YoShadowFrame* frame = yo_shadow_stack_top; 
          frame != NULL; 
          frame = frame->prev) {
       for (size_t i = 0; i < frame->num_roots; i++) {
         void* obj = *frame->roots[i];
         if (obj != NULL) {
           yo_gc_mark_object(obj);
         }
       }
     }
   }
   ```
4. Update `yo_gc_mark_roots()` to call `yo_gc_scan_shadow_stack()`

### TODO 2: Identify GC Pointer Locals

**Priority: HIGH** - Need to know which locals to track

**What to implement:**
- Function to determine if a local variable is a GC pointer
- Track GC pointer locals during function code generation

**Files to modify:**
- `src/codegen/functions/generation.ts` - function body generation

**Logic:**
```typescript
function isGcPointerLocal(binding: Binding): boolean {
  // Check if the binding's type is a GC type
  return binding.type && isGcType(binding.type);
}
```

**Data to collect per function:**
```typescript
interface FunctionGcInfo {
  gcPointerLocals: string[];  // Names of GC pointer locals
  needsShadowFrame: boolean;  // True if function has GC locals or calls functions
}
```

### TODO 3: Generate Shadow Frame Setup

**Priority: HIGH** - Core shadow stack functionality

**What to generate at function entry:**
```c
YoNode* process(int32_t x) {
  // Shadow frame setup (if function has GC pointer locals)
  YoShadowFrame __yo_shadow_frame;
  void* __yo_roots[2];  // Size = number of GC pointer locals
  __yo_shadow_frame.prev = yo_shadow_stack_top;
  __yo_shadow_frame.roots = __yo_roots;
  __yo_shadow_frame.num_roots = 2;
  __yo_shadow_frame.function_name = "process";  // Optional: for debugging
  yo_shadow_stack_top = &__yo_shadow_frame;
  
  // Initialize locals to NULL
  YoNode* node = NULL;
  YoNode* result = NULL;
  
  // Register locals in roots array
  __yo_roots[0] = &node;
  __yo_roots[1] = &result;
  
  // ... function body ...
}
```

**Files to modify:**
- `src/codegen/functions/generation.ts` - `generateFunctionBody()`

**Implementation steps:**
1. Before generating function body, check if function has GC pointer locals
2. If yes, emit shadow frame setup code:
   - Declare `YoShadowFrame __yo_shadow_frame` on stack
   - Declare `void* __yo_roots[N]` array
   - Initialize shadow frame fields
   - Link to previous frame
   - Update `yo_shadow_stack_top`
3. Initialize all GC pointer locals to `NULL`
4. Populate `__yo_roots` array with addresses of locals

### TODO 4: Generate Shadow Frame Teardown

**Priority: HIGH** - Must restore stack on function exit

**What to generate at function exit:**
```c
YoNode* process(int32_t x) {
  // ... shadow frame setup ...
  // ... function body ...
  
  // Shadow frame teardown (before every return)
  yo_shadow_stack_top = __yo_shadow_frame.prev;
  return result;
}
```

**Files to modify:**
- `src/codegen/functions/generation.ts` - return statement generation

**Implementation steps:**
1. Before each `return` statement, emit shadow frame teardown
2. Handle multiple return paths (early returns)
3. Handle implicit returns (last expression)

**Edge cases to handle:**
- Early returns in conditionals
- Returns in nested blocks
- Exception/error handling paths (future)

### TODO 5: Optimization - Skip Shadow Frame for Leaf Functions

**Priority: MEDIUM** - Performance optimization

**What:** Don't generate shadow frame for functions that:
- Have no GC pointer locals, AND
- Don't call other functions (no allocations, no GC triggers)

**Example:**
```yo
// No shadow frame needed
add :: (fn(a: i32, b: i32) -> i32) {
  a + b
}

// Shadow frame needed (has GC pointer local)
make_node :: (fn(x: i32) -> Node) {
  Node(value: x, next: .None)
}
```

**Files to modify:**
- `src/codegen/functions/generation.ts` - add optimization check

**Logic:**
```typescript
function needsShadowFrame(func: FunctionInfo): boolean {
  // Has GC pointer locals?
  if (func.gcPointerLocals.length > 0) {
    return true;
  }
  
  // Calls other functions (potential GC triggers)?
  if (func.hasFunctionCalls) {
    return true;
  }
  
  return false;
}
```

### TODO 6: Handle Nested Scopes

**Priority: MEDIUM** - Support locals in nested blocks

**What:** Track GC pointer locals that are declared in nested scopes

**Example:**
```yo
process :: (fn(x: i32) -> Node) {
  outer := Node(value: x, next: .None);
  {
    inner := Node(value: x + 1, next: .Some(outer));
    // Both 'outer' and 'inner' must be in roots array
  }
  // 'inner' out of scope, but 'outer' still tracked
  outer
}
```

**Challenge:** C has nested scopes, but shadow frame is function-level

**Solution:** Include all GC pointer locals from all scopes in the roots array at function entry

**Files to modify:**
- `src/codegen/functions/generation.ts` - scope tracking

### TODO 7: Testing & Validation

**Priority: HIGH** - Verify shadow stack works correctly

**Tests to create:**

1. **Basic shadow stack test:**
```yo
test_shadow_stack :: (fn() -> unit) {
  node := Node(value: 42, next: .None);
  gc_collect();  // Should NOT collect 'node' (it's on shadow stack)
  printf("Value: %d\n", node.value);  // Should print 42
}
```

2. **Nested function calls:**
```yo
inner :: (fn(x: i32) -> Node) {
  gc_collect();  // GC runs during call
  Node(value: x, next: .None)
}

outer :: (fn() -> Node) {
  node := inner(42);
  node  // Should still be valid
}
```

3. **Multiple GC pointer locals:**
```yo
test_multiple_locals :: (fn() -> unit) {
  a := Node(value: 1, next: .None);
  b := Node(value: 2, next: .None);
  c := Node(value: 3, next: .None);
  gc_collect();  // Should NOT collect a, b, or c
  printf("Values: %d %d %d\n", a.value, b.value, c.value);
}
```

4. **Cycles with shadow stack:**
```yo
test_cycle_with_roots :: (fn() -> unit) {
  node1 := Node(value: 1, next: .None);
  node2 := Node(value: 2, next: .Some(node1));
  node1.next = .Some(node2);  // Create cycle
  gc_collect();  // Should NOT collect (both on shadow stack)
  printf("Values: %d %d\n", node1.value, node2.value);
}
```

**Files to create:**
- `src/tests/examples/test_shadow_stack.yo`

**Validation:**
- Compile with `--debug-gc` flag
- Verify shadow stack is scanned during GC
- Verify locals are not collected while in scope
- Verify locals ARE collected when out of scope

### TODO 8: Debug Support

**Priority: LOW** - Helpful for development

**What to add:**
- Debug output for shadow stack operations
- Controlled by `--debug-gc` flag

**Debug output to add:**
```
[GC] Shadow frame setup: function=process, roots=2
[GC] Shadow frame teardown: function=process
[GC] Scanning shadow stack: 3 frames, 7 total roots
[GC]   Frame: process, roots=2
[GC]   Frame: outer, roots=1
[GC]   Frame: main, roots=4
```

**Files to modify:**
- `src/codegen/functions/gc_runtime.ts` - add debug output to shadow stack scanning
- `src/codegen/functions/generation.ts` - add debug output to frame setup/teardown

---

## 📊 Progress Tracking

**Overall Phase 3 Progress:** 🚀 ~25% Complete

**TODO Status:**
- ✅ TODO 1: Shadow stack data structures (100%) - COMPLETE
- ✅ TODO 2: Identify GC pointer locals (100%) - COMPLETE
- ⏳ TODO 3: Generate shadow frame setup (0%)
- ⏳ TODO 4: Generate shadow frame teardown (0%)
- ⏳ TODO 5: Optimization - leaf functions (0%)
- ⏳ TODO 6: Handle nested scopes (0%)
- ⏳ TODO 7: Testing & validation (0%)
- ⏳ TODO 8: Debug support (0%)

---

## 🎯 Implementation Order

**Week 1: Foundation**
1. TODO 1: Shadow stack data structures
2. TODO 2: Identify GC pointer locals
3. Initial testing (verify identification works)

**Week 2: Core Implementation**
4. TODO 3: Generate shadow frame setup
5. TODO 4: Generate shadow frame teardown
6. TODO 7: Basic testing (simple cases)

**Week 3: Optimization & Edge Cases**
7. TODO 5: Leaf function optimization
8. TODO 6: Nested scope handling
9. TODO 7: Advanced testing (cycles, nested calls)

**Week 4: Polish**
10. TODO 8: Debug support
11. TODO 7: Comprehensive testing
12. Performance benchmarking
13. Documentation updates

---

## 🔍 Success Criteria

Phase 3 is complete when:
- ✅ Shadow stack correctly tracks all GC pointer locals
- ✅ GC marks objects reachable from shadow stack
- ✅ Objects in scope are NOT collected
- ✅ Objects out of scope ARE collected
- ✅ Nested function calls work correctly
- ✅ Cycles with roots work correctly
- ✅ All tests pass
- ✅ Performance overhead is <5%

---

## 📝 Notes

**Memory Layout:**
```
Stack grows down ↓

[Caller frame]
  __yo_shadow_frame
  __yo_roots[N]
  local1
  local2
  ...
[Callee frame]
  __yo_shadow_frame  ← yo_shadow_stack_top (current)
  __yo_roots[M]
  local1
  ...
```

**Shadow Stack Invariant:**
- `yo_shadow_stack_top` always points to current function's shadow frame
- Each frame's `prev` points to caller's frame
- GC can walk entire chain to find all roots

**Performance Impact:**
- Shadow frame setup: ~10-20 cycles per function call
- Minimal impact on leaf functions (can be optimized away)
- Expected overall overhead: 3-5%

---

*Last updated: 2025-11-16*
*Next review: After TODO 1-3 completion*
