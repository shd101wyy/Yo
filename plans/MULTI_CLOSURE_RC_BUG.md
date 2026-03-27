# Multi-Closure Rc Capture Codegen Bug

## Status: Mitigated (Send trait now enforced)

## Summary

When the same `object` (Rc-managed) value is captured by **multiple closures** in the same scope, the generated C code has a use-after-free / double-free bug due to incorrect reference counting.

**Mitigation**: The `Send` trait is now correctly enforced on closures passed to `Thread.spawn` and `Worker.spawn`. Since `object` types do not implement `Send` (they use non-atomic RC), closures capturing objects are rejected at compile time. This prevents the multi-closure RC bug from manifesting in thread contexts. The underlying RC codegen issue still exists for non-thread closures that capture the same object, but this is a less common pattern.

## Fix Details

The fix was applied in two files:

1. `src/evaluator/values/anonymous-function.ts` — validates closure capture struct against required traits before setting `resolvedConcreteType`
2. `src/evaluator/calls/closure-type.ts` — same validation for the alternative closure creation path

Error message: `Closure does not implement 'Send' because captured variable 'ch' has type 'Channel(i32)' which does not implement 'Send'`

## Minimal Reproduction

```rust
open import "std/libc/stdio";
{ Channel } :: import "std/sync/channel";
{ Thread } :: import "std/thread";

main :: (fn() -> unit)({
  ch := Channel(i32).new(usize(20));

  // Closure 1 captures ch
  t1 := Thread.spawn(() => {
    ch.send(i32(1));
  });
  t1.join();

  // Closure 2 captures ch (same scope)
  t2 := Thread.spawn(() => {
    ch.send(i32(2));
  });
  t2.join();

  // Use ch after both closures
  val := ch.try_recv();
  printf("val=%d\n", val.unwrap());
});
export main;
```

Compile and run:

```bash
./yo-cli compile src/tests/fixme.yo --release --sanitize address --allocator libc -o test && ./test
```

**Result**: `AddressSanitizer: heap-use-after-free` in `__yo_decr_rc`

## Root Cause

When a closure captures an `object` value, the codegen:

1. Creates a capture struct `{ .ch = ch }` — does **NOT** increment Rc
2. Passes the capture to `Thread.spawn`, which calls `___dup` (increments Rc)
3. When the thread finishes, the thread's copy is dropped (decrements Rc)
4. At scope exit, the capture struct's `___drop` decrements Rc again

With **one closure**, the compiler correctly transfers ownership — it does NOT emit a separate `drop(ch)` call, so the Rc is balanced:

```
new → Rc=1, dup → Rc=2, thread drop → Rc=1, capture drop → Rc=0 ✓
```

With **two closures**, the compiler emits drops for BOTH capture structs AND a separate `drop(ch)`:

```
new → Rc=1
capture 1 created (no incr) → Rc=1
dup for thread 1 → Rc=2, thread 1 drop → Rc=1
capture 2 created (no incr) → Rc=1
dup for thread 2 → Rc=2, thread 2 drop → Rc=1

Cleanup:
drop(capture2) → Rc=0, ch FREED  ← first free
drop(capture1) → USE-AFTER-FREE  ← bug!
drop(ch)       → DOUBLE FREE     ← bug!
```

## Generated C Code (key section)

```c
void __yo_user_main() {
  // ch created (Rc = 1)
  __yo_struct_*ch = Channel_new(20);

  // Capture 1 — NO __yo_incr_rc
  capture1 = { .ch = ch };
  t1 = Thread_spawn_dup(capture1);  // dup increments
  join(t1);

  // Capture 2 — NO __yo_incr_rc
  capture2 = { .ch = ch };
  t2 = Thread_spawn_dup(capture2);  // dup increments
  join(t2);

  // Cleanup — 3 decrements for only 1 original Rc!
  capture2___drop();  // __yo_decr_rc(ch)
  capture1___drop();  // __yo_decr_rc(ch) — use after free!
  Channel___drop(ch); // __yo_decr_rc(ch) — double free!
}
```

## Expected Fix

When creating a capture struct that references an Rc-managed value, the codegen should emit `__yo_incr_rc` for each captured object field. This ensures the Rc count correctly reflects the number of references.

Alternatively, the ownership analysis should recognize that `ch` is captured by multiple closures and adjust the drop codegen accordingly — either:

1. Increment Rc when creating each capture struct that borrows (not moves) an object reference
2. Or suppress the separate `drop(ch)` when `ch` is captured, and ensure each capture struct correctly manages its own Rc

## Key Files to Investigate

- `src/codegen/exprs/begin.ts` — RC optimization / dup-drop cancellation
- `src/codegen/functions/` — how capture structs are created and dropped
- Related doc: `COMPILE_TIME_RC_WITH_OWNERSHIP_ANALYSIS.md`

## Affected Code

- `tests/sync/channel.test.yo` — Thread/Worker integration tests removed (Channel is not Send)
- Any code that captures the same `object` in multiple closures within one scope (non-thread contexts)

## Future Work

To enable cross-thread Channel usage, one of these approaches is needed:

1. **`Iso(Channel(T))` wrapping** — wrap Channel in Iso for atomic RC
2. **Atomic RC opt-in** — allow certain object types to use atomic RC via a trait/annotation
3. **Channel redesign** — make Channel a value type with internal atomic RC management
