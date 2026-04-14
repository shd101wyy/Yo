# Thread closure `own(self)` capture double-free

## Summary

When a thread closure captures an RC-typed variable (e.g., `Vec(i32)`) and
that variable is consumed by an `own(self)` method call inside the closure
(e.g., `push`), a use-after-free occurs because both the thread and the main
function drop the same RC reference.

## Root cause

The dup/drop optimizer on the **main** side eliminates the dup when constructing
the capture struct:

```c
// Main: NO dup — base goes directly into capture
capture = { .base = base, .ch = ch };
Thread.spawn(capture);  // memcpy to heap → two copies, same pointers, same RC
```

Inside the thread closure:

```c
// Thread: push takes own(self), consumes capture->base → RC decremented → freed
Vec* v1 = push(capture->base, 3);
drop(v1);  // base memory freed
// No destructor call on capture struct fields
```

After thread completes, `__yo_thread_entry` calls `__yo_free(closure)` (no
destructors). The main function then drops its stack copy of the capture
struct → drops `base` → **use-after-free**.

## Reproduction

```rust
{ Thread } :: import "std/thread";
{ Channel } :: import "std/sync/channel";
{ Vec } :: import "std/imm/vec";

main :: (fn() -> unit)({
  base := Vec(i32).new().push(i32(1)).push(i32(2));
  ch := Channel(usize).new(usize(4));

  t1 := Thread.spawn(() => {
    v1 := base.push(i32(3));  // own(self) consumes captured base
    ch.send(v1.len());
  });

  len := ch.recv().unwrap();
  t1.join();
});
export main;
```

Compile with `--sanitize address` to detect:

```
ERROR: AddressSanitizer: heap-use-after-free in __yo_decr_rc_atomic
```

## Impact

Any thread closure that:

1. Captures an RC-typed value (object/atomic object)
2. Passes it to an `own(self)` method

Read-only captures work correctly. Non-own method calls work correctly.

## Potential fixes

1. **Thread entry should call capture struct `___drop` instead of raw `__yo_free`** —
   this way the thread properly drops its copy. Main would need to NOT drop
   the capture (treat it as consumed by spawn).

2. **Thread.spawn should dup the capture contents** — ensures both copies have
   independent RC references. Thread drops its copy via destructor; main drops
   its copy normally.

3. **Mark spawn's closure parameter as `own`** — the main function wouldn't
   drop the capture struct after passing it to spawn.

## Workaround

Avoid `own(self)` operations on captured variables inside thread closures.
Use read-only sharing, or pass data through channels.
