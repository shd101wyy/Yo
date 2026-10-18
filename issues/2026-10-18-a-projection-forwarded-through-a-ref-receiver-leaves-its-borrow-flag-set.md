# A projection forwarded through a `ref` receiver leaves its borrow flag set, so the next container call panics

**Severity:** S2. A correct program panics at run time. A plain value container works, and `ref(...)` goes away at V5.

Filed 2026-10-18 while deciding `issues/retired/borrowed-for-over-user-defined-collections.md`. Found with a develop-built compiler (`29ceb209d` plus #1440's branch).

## Symptom

The repro is `issues/repros/2026-10-18-projection-forwarding-through-a-ref-receiver.yo`. A user collection `Bag :: ref(struct(items : ArrayList(i32)))` implements `BorrowedWalk`. Its `walk_elem` forwards the list's own projection:

```yo ignore
walk_elem : (fn(self : &mut Self, cur : &usize) -> &mut i32)(&mut self.items(cur)),
```

`for(&mut bag, x => { x = (x * i32(10)); })` compiles. At run time it aborts:

```
panic: container operation while an interior reference (a 'ref' into an element/field) borrows from it
```

The same code with `Bag :: struct(items : ArrayList(i32))`, a plain value, compiles and runs correctly: it prints `10`.

## Likely cause (not yet traced)

Lending `&mut self.items(cur)` through a `ref` object raises `items`' runtime interior-borrow flag. Returned as `walk_elem`'s projection, the borrow outlives the projection body, so the flag is still set when the loop's next `walk_valid` calls `self.items.len()`. On a value receiver the borrow is static and the flag lowers to nothing (V2b A1, #1384).

## Impact

`tests/for_macro_borrow_user_collection.test.yo` works around it: a `ref` `Bag` hands out a raw pointer into the buffer under `pragma(Pragma.AllowUnsafe)`. Any user collection that is a `ref` type needs the same workaround to implement `BorrowedWalk`.

## Direction

- Release the interior-borrow flag when the projection that took it is returned (it is re-derived at each step), or fold it into the outer borrow the `for` holds.
- After V5, user collections are values, and the plain-value path already works. So the fix may be to land this test's conversion to a value `Bag` at V5, if the flag logic is not worth fixing before then.
- A fix needs a test that panics before it: this repro as a `tests/` case.
