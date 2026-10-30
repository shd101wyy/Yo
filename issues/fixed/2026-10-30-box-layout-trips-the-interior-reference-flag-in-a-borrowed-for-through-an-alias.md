# Box layout (#1676) trips the interior-reference flag in a borrowed `for` through an alias

**Severity:** S2. With #1676's `Box` layout, two valid programs in `tests/for_macro_borrow_user_collection.test.yo` panic at run time with a false borrow violation. There is no workaround short of not boxing the object. #1676 was reverted before the v0.2.73 cut, so no release carries the bug.

**Found:** 2026-10-30, develop battery 40992831109 on `92efeee86` (#1676). The file failed on test-wasm32_wasi and on test suite shard 1/4 on ubuntu-latest and ubuntu-24.04-arm.

## Symptom

```text
✗ borrowed for: read-only methods iterating a value field by value, through an alias, do not trip the flag
  Test failed with exit code 134
  panic: container operation while an interior reference (a 'ref' into an element/field) borrows from it
✗ borrowed for: boxing the object through an alias does not trip the flag
```

## Bisection

`tests/for_macro_borrow_user_collection.test.yo`, run locally one file at a time:

| Tree | Binary | Result |
|---|---|---|
| allocator v2 top (`5d9832ca2`, no Box layout) | allocator v2 build | 10 passed |
| allocator v2 top | Box layout build | 10 passed |
| Box layout top (`e77ab66a7`) | allocator v2 build | 8 passed, 2 failed |
| Box layout top | Box layout build | 8 passed, 2 failed |

The failure follows the TREE, not the binary. Box layout changes `std/` (the prelude's `Box` cell: an 8-byte flags word, an owner prefix only on a placed cell). The interaction is in `std`'s Box code as the borrowed-`for` mutation mask and the entry asserts see it. #1665 changed that mask's treatment of the allocation-scope externs that `box`/`Box.new` call, and #1675 made an `Allocator` value root nothing. Box layout's own gate list did not include this file.

## Root cause

The mutation summary's path-insensitive walk of `Box(T).new`. #1676's global arm takes its block from

```yo ignore
match(
  cond(
    (al > _BOX_MALLOC_ALIGN) => __yo_aligned_alloc(al, rounded),
    true => __yo_malloc(h + size_of(T))
  ),
  .Some(b) => b,
  .None => __yo_panic("Box.new: out of memory")
)
```

`_msp_extern_returns_fresh` (`src/evaluator/effects/mutation_summary.yo`) listed `__yo_malloc` and `__yo_calloc` but not `__yo_aligned_alloc`, so `extern_result_root` gave that call `MSP_ROOTED` (unknown storage). The join of the two `cond` arms made `b` rooted, and `raw`, `hdr` and `cell` with it. The flags-word store and the payload store `cell.* = value` then read as stores through rooted storage, which marks the summary `all`: `Box.new` "mutates every argument". The arm is dead for every payload aligned to 16 or less, but the summary does not know `al`. Every function moving a `ref` parameter into `box(b)` or `Box.new(b)`, or into `RefCell.new(b)` (which boxes its slot), then got the borrowed-`for` entry assert on that parameter, and a call through a second handle of the iterated object panicked.

`YO_DEBUG_BORROW_MASK=1` shows it on the minimized case (a `ref` bag walked by `for(&mut bag, …)`, `keep_boxed(other)` in the body): with the old std `Box.new`'s roots are `b=shell block=shell cell=shell`, `all=false`; with #1676's std they are `b=rooted raw=rooted hdr=rooted cell=rooted`, `all=true`, preceded by four `store-through-rooted` lines. Replacing the `__yo_aligned_alloc` call with `__yo_malloc` in a scratch std makes the mask `all=false` again, which isolates the cause. Neither #1665's scope-slot rule nor #1675's `Allocator` rule was involved: the placed arm's `a.vtable.*.alloc(…)` is an allocator vtable slot and was already fresh.

## Fix

`_msp_extern_returns_fresh` lists the aligned family: `__yo_aligned_alloc`, and libc's `aligned_alloc` beside `malloc`/`calloc`. An aligned allocation hands back storage nothing else references, exactly as `__yo_malloc` does. The borrow flag itself is unchanged. `Box`'s layout (#1676) re-lands with the fix (`fix/box-layout-reland`).

**Regression tests:** the two tests above, in `tests/for_macro_borrow_user_collection.test.yo`. With the re-landed std and the pre-fix compiler they fail (8 passed, 2 failed, exit 134 on the panic); with the fix the file passes 10/10.
