# Cycle Collector Bugs

## Bug 1 (CRITICAL): Missing recursive liveness propagation in `__yo_gc_collect()`

**File:** `src/codegen/functions/generation.ts` (the `__yo_gc_collect` C code generation, ~line 1390-1410)

**Symptom:** Use-after-free. Objects reachable from live roots but with RC=0 after trial deletion are incorrectly freed.

**Root cause:** After trial deletion, Phase 2 classifies objects by RC: `RC > 0 → LIVE`, `RC == 0 → GARBAGE`. But it does NOT propagate liveness from LIVE objects to their reachable children. A child that is only referenced by tracked objects will have RC=0 after trial deletion even if a LIVE root transitively reaches it.

The restore phase (Phase 3) only traverses LIVE objects and only increments RC for children that are _already_ LIVE. Children marked GARBAGE are skipped by the restore visitor. This means reachable objects that happen to only have internal references are freed.

**Example:**

```
create_chain_with_cycle :: (fn() -> Node) {
  b := Node(2, .None);
  c := Node(3, .Some(b));
  b.child = .Some(c);        // b ↔ c cycle
  return Node(1, .Some(b));  // root → b
};

root := create_chain_with_cycle();
// root: RC=1 (stack)  — external reference
// b:    RC=2 (root.child + c.child)  — only tracked-internal refs
// c:    RC=1 (b.child)  — only tracked-internal refs

Gc.collect();
// Trial deletion: root→b (b.RC=1), b→c (c.RC=0), c→b (b.RC=0)
// Phase 2: root LIVE, b GARBAGE, c GARBAGE   ← BUG: b,c reachable from root
// Phase 3: traverse root → visit b → b is GARBAGE → skip restore
// Phase 4: free b and c → root.child is dangling pointer!
```

**Fix:** Replace the simple restore visitor with a recursive scan visitor that promotes GARBAGE children to LIVE and recursively scans their children:

```c
static void yo_gc_scan_restore(void* ptr) {
  if (ptr == NULL) return;
  yo_ref_header_t* header = (yo_ref_header_t*)ptr;
  if (!(header->gc_flags & YO_GC_TRACKED)) return;

  header->ref_count++;  // Restore trial-deleted edge

  if (header->gc_mark == YO_GC_GARBAGE) {
    header->gc_mark = YO_GC_UNMARKED;  // Promote + mark scanned
    if (header->traverse_fn) {
      header->traverse_fn(ptr, yo_gc_scan_restore);
    }
  }
}
```

And change the Phase 3 loop to only process initially-LIVE roots, marking them UNMARKED after scan to prevent re-processing:

```c
obj = head;
while (obj != NULL) {
  if (obj->gc_mark == YO_GC_LIVE) {
    obj->gc_mark = YO_GC_UNMARKED;  // Mark scanned
    if (obj->traverse_fn) {
      obj->traverse_fn(obj, yo_gc_scan_restore);
    }
  }
  obj = obj->gc_next;
}
```

After this phase, GARBAGE objects are true garbage (unreachable), UNMARKED objects are live.

---

## Bug 2 (CRITICAL): Double RC decrement for garbage→live edges during dispose

**File:** `src/codegen/functions/generation.ts` (the `__yo_gc_collect` C code, Phase 4a ~line 1412-1422)

**Symptom:** Live objects' RC is decremented twice for references from garbage objects — once by trial deletion (not restored) and once by dispose → RC corruption, potential use-after-free.

**Root cause:** Trial deletion in Phase 1 decrements RC for ALL tracked→tracked edges (including garbage→live). Phase 3 only restores LIVE→child edges, so garbage→live edges remain decremented. This is by design — the trial deletion effectively "accounts for" removing the garbage→live reference. But Phase 4a calls dispose on garbage objects, which calls `___drop` on children, which calls `__yo_decr_rc` on live children. This is a second decrement for the same reference.

**Example:**

```
A (LIVE, RC=3: external + X.ref + B.ref)
X (LIVE), B (GARBAGE)
B → A (garbage references live)

Phase 1: A.RC = 3 - 2 (from X and B) = 1
Phase 2: A is LIVE
Phase 3: Restore X→A: A.RC = 1 + 1 = 2  (B→A NOT restored)
Phase 4a: B.dispose → __yo_decr_rc(A) → A.RC = 2 - 1 = 1
Expected: A.RC = 3 - 1 (only B removed) = 2  ← Off by 1!
```

**Fix:** Add a thread-local `yo_gc_collecting` flag. During GC collection (Phase 4a/4b), `__yo_decr_rc` skips ALL tracked objects:

```c
static _Thread_local int yo_gc_collecting = 0;

void __yo_decr_rc(void* ptr) {
  ...
  // During GC, skip all tracked objects — GC handles their lifecycle
  if (yo_gc_collecting && (header->gc_flags & YO_GC_TRACKED)) {
    return;
  }
  ...
}
```

Non-tracked RC children are still properly released by dispose (they weren't trial-deleted).

Also add re-entrance protection to `__yo_gc_register` to prevent recursive GC during dispose:

```c
if (!yo_gc_collecting && tracked_count >= threshold) {
  __yo_gc_collect();
}
```

---

## Bug 3 (MEDIUM): Only first RC field per enum variant visited in traversal

**File:** `src/codegen/functions/generation.ts` line 1635

**Symptom:** If an enum variant has multiple reference-counted fields, only the first is visited during GC traversal → incorrect trial deletion/restoration, potential memory leaks or corruption.

**Root cause:** The inner loop over variant fields breaks after finding the first RC field:

```typescript
break; // Only generate one case per variant
```

**Example:**

```yo
Pair :: enum(Both(left: ObjA, right: ObjB));
Container :: object(pair: Pair);
```

Traversal only visits `left`, never `right`.

**Fix:** Restructure to emit case label once, then visit ALL RC fields in the variant before the break.

---

## Bug 4 (LOW): Enum constant name manually constructed instead of using `getEnumVariantCName`

**File:** `src/codegen/functions/generation.ts` line 1625

The traversal function constructs enum tag names as `` `YO_${enumType.id?.toUpperCase()}_${variant.name.toUpperCase()}` `` instead of using the canonical `getEnumVariantCName()` helper. Currently produces correct results but is fragile.

**Fix:** Use `getEnumVariantCName(enumType, variant.name, context)`.

---

## Bug 5 (LOW): No traversal for nested enums or value-type containers holding RC refs

**File:** `src/codegen/functions/generation.ts` lines 1590-1643 and `src/types/utils.ts` `typeCanFormCyclicRcReference`

If a field is a value-type struct/tuple containing RC objects, or an enum variant containing another enum with RC fields, the nested references are not visited during traversal. This is consistent with `canTypeFormRcCycle()` which also doesn't traverse through value-type struct intermediaries, so the affected objects are never tracked → memory leak (not crash).

**Deferred** — requires coordinated changes in both cycle detection and traversal. Low priority since it only causes leaks for rare type patterns.

---

## Status

| Bug   | Severity | Status       | Fix                                                                        |
| ----- | -------- | ------------ | -------------------------------------------------------------------------- |
| Bug 1 | CRITICAL | **FIXED**    | Recursive `yo_gc_scan_restore_visitor` promotes GARBAGE children to LIVE   |
| Bug 2 | CRITICAL | **FIXED**    | `yo_gc_collecting` flag skips `__yo_decr_rc` for tracked objects during GC |
| Bug 3 | MEDIUM   | **FIXED**    | Enum variant traversal visits ALL RC fields, not just the first            |
| Bug 4 | LOW      | **FIXED**    | Uses `getEnumVariantCName()` instead of manual string construction         |
| Bug 5 | LOW      | **DEFERRED** | Requires coordinated changes in cycle detection + traversal                |

All fixes verified with 11 tests (including regression tests for Bugs 1-4) passing with AddressSanitizer.

## Note on GC and ownership semantics

Yo's RC system uses ownership-transfer (move) semantics for `.Some(obj)` and constructor arguments. Field reads (`obj.field`) are non-owning borrows. The compiler generates dups only when a value is used in multiple ownership-transferring positions (e.g., two `.Some(x)` calls, or constructor + return). This means:

- Stack variables that have been "moved" into constructors are borrowed (no RC increment)
- The GC correctly identifies such objects as having only internal references (RC reflects owned references, not borrows)
- Objects in cycles with only internal RC references ARE correctly collected, even if borrowed stack pointers still exist
- Users should not access objects via borrowed stack pointers after GC.collect() if those objects could be part of a cycle
