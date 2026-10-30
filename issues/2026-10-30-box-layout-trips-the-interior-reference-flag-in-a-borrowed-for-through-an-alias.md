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

## Status

Open. #1676 is reverted on develop (`fix/develop-revert-box-layout`). Box layout re-lands in the v0.2.74 window with a root-cause fix and this file in its gate.
