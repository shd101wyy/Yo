# `align_of` of a type holding an extern type never transpiles

**Severity:** S2 (a valid program is rejected with an internal compiler error;
inside a std generic the poisoned body fails the C build of every program that
instantiates it)

**Status:** fixed 2026-10-28 (branch `vbd/alloc-v2-gen-b-r2`, allocator
interface v2 Generation B).
**Found:** 2026-10-28 by allocator v2 Generation B: `Box.new` asked its
allocator for `max(16, align_of(T))`, and `tests/explicit_allocators.test.yo`
stopped compiling under the v0.2.71 seed, because `std/thread.yo` boxes a
`_ThreadState(T)` holding the opaque `__yo_thread_t`.

## The bug

```yo ignore
pragma(Pragma.AllowUnsafe);
{ assert } :: import("std/assert");
{ atomic_int, atomic_llong } :: import("std/libc/stdatomic");
_HoldsExtern :: struct(flag : u8, n : atomic_llong);
main :: (fn() -> unit)({
  assert(align_of(atomic_int) == size_of(atomic_int), "atomic_int");
  assert(align_of(_HoldsExtern) == align_of(atomic_llong), "struct holding one");
});
export(main);
```

```text
error[E1301]: internal compiler error: Failed to transpile part of main's body — the emitted C for "__yo_user_main" contains an untranspiled expression, so the program would run without it
```

Inside a generic std body (`Box(T).new` over `T = _ThreadState(unit)`) the
same failure is swallowed at definition time, and every call of that
specialization becomes a C compile error: `call to '__yo_fs_…' declared with
'error' attribute: yo: the body of __yo_fs_… failed to transpile`.

## Root cause

`evaluate_align_of` (`src/evaluator/builtins/alignof.yo`) folds the call to a
constant when `get_alignment_of_type` knows the layout, and otherwise leaves a
typed unknown `usize`, exactly as `evaluate_size_of` does. For `size_of` the
unknown reaches `generate_sizeof`, which emits C's `sizeof`. `align_of` had no
emitter at all, so the call fell through codegen's dispatch untranspiled. An
`extern` type's layout is known only to the C compiler, so every type holding
one has an unknown alignment.

## Fix

`generate_alignof` (`src/codegen/exprs/sizeof.yo`) emits `_Alignof(<C type>)`
on the measured type, read from the argument the way the evaluator reads it
(the type value, or the argument expression's type), and codegen's dispatch
calls it beside `generate_sizeof`.

**Seed gate.** std is compiled by the seed when the compiler builds itself, so
std must not depend on the fix until `SEED_VERSION` carries it: allocator v2
Generation B keeps `Box`'s placed request at alignment 16 instead of
`max(16, align_of(T))`, and the over-aligned `Box` waits for the next seed
(`plans/backlog/SEED_VERSION_AUTOMATION.md`).

## Test

`tests/allocator.test.yo`, "align_of of an extern C type, and of a struct
holding one, is the C compiler's alignment": the program above, plus a placed
`ArrayList` of the struct. It fails to compile (E1301) before the fix.
