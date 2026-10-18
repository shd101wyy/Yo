# A closure passed to a rejected comptime Copy check is never dropped

**Severity:** S3 — a valid program leaks the closure's capture (and what it owns) under ASan; the existing test that covers the shape fails the language suite on the seed and on develop.

**Status:** fixed by #1459 (comptime-expect-error marks its operands moved);
closed on re-verification 2026-10-19. Found while gating the tree that fixes
`issues/fixed/2026-10-17-a-generic-copy-impl-rejects-a-field-that-is-a-conditional-copy-container-of-its-parameter.md`
(the `tests/copy_trait.test.yo` run went red on LeakSanitizer against a base
without #1459). NOT a regression of that change: the v0.2.65 seed binary
compiled the standalone reproducer below into a binary with the identical
leak (34 bytes in 2 allocations). After rebasing onto #1459, the same
reproducer runs clean (`run rc=0`) and `tests/copy_trait.test.yo` passes
31/31 — the move-marking restore in #1459 was the missing drop.

## Symptom

`tests/copy_trait.test.yo`, "Copy: where(T <: Copy) rejects a closure that owns a String" fails under the test runner's ASan:

```text
✗ Copy: where(T <: Copy) rejects a closure that owns a String
    Memory leak detected:
    Direct leak of 32 byte(s) in 1 object(s) allocated from:
        #3 __yo_new___yo_t_3327584425293373660
        #4 yo_id_5034..._rtparam0_usize_ret_R_gs_..._u8
        #5 yo_id_15939539259736040161000000
        #6 __yo_user_main
    SUMMARY: AddressSanitizer: 34 byte(s) leaked in 2 allocation(s).
```

The 32-byte object is the closure's capture record and the 2-byte indirect leak is the `String.from("hi")` buffer it owns.

## Reproducer (standalone, `tmp/leak-repro.yo`)

```yo
{ String } :: import("std/string");
{ assert } :: import("std/assert");
_ct_need_copy :: (fn(comptime(T) : Type, x : T, where(T <: Copy)) -> T)(x);
_ct_need_copy_g :: (fn(generic(T : Type), x : T, where(T <: Copy)) -> T)(x);
main :: (fn() -> unit)({
  s := String.from("hi");
  (c : Impl(Fn() -> usize)) = ({ s }() => s.len());
  comptime_expect_error(_ct_need_copy(type_of(c), c), "does not implement required trait Copy");
  (c2 : Impl(Fn() -> usize)) = ({ s }() => s.len());
  comptime_expect_error(_ct_need_copy_g(c2), "does not implement required trait Copy");
  n := i32(4);
  (k : Impl(Fn() -> i32)) = (() => (n + i32(1)));
  (kg : Impl(Fn() -> i32)) = (() => (n + i32(1)));
  k2 := _ct_need_copy(type_of(k), k);
  k3 := _ct_need_copy_g(kg);
  assert((k2() + k3()) == i32(10), "a closure of Copy captures passes, through a generic parameter too");
});
export(main);
```

```bash
yo compile tmp/leak-repro.yo --sanitize address --allocator system -o leak-bin
./leak-bin   # LeakSanitizer: 34 byte(s) leaked in 2 allocation(s)
```

Both this and the in-suite failure reproduce identically with the released
v0.2.65 seed, so the defect predates this cycle.

## Post-mortem

`c` and `c2` own `s`; every assertion in the test passes, so the leak was the
missing DROP of the closure locals after their value flows into a
comptime-evaluated call that the `where(T <: Copy)` check rejects inside
`comptime_expect_error` — the comptime call marked its operand moved and the
caller-side drop was suppressed, which is exactly what #1459's move-mark
restore fixed.

## Test

Already present: `tests/copy_trait.test.yo`, "Copy: where(T <: Copy) rejects
a closure that owns a String" — it failed on the seed and on a pre-#1459
base, and passes on develop since #1459.
