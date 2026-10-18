# A closure passed to a rejected comptime Copy check is never dropped

**Severity:** S3 — a valid program leaks the closure's capture (and what it owns) under ASan; the existing test that covers the shape fails the language suite on the seed and on develop.

**Status:** open. Found 2026-10-19 while gating the tree that fixes
`issues/fixed/2026-10-17-a-generic-copy-impl-rejects-a-field-that-is-a-conditional-copy-container-of-its-parameter.md`
(the `tests/copy_trait.test.yo` run went red on LeakSanitizer). NOT a
regression of that change: the v0.2.65 seed binary — which carries none of
this cycle's changes — compiles the standalone reproducer below into a binary
with the identical leak (34 bytes in 2 allocations).

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

## Where to look

`c` and `c2` own `s`; every assertion in the test passes, so the leak is the
missing DROP of the closure locals after their value flows into a
comptime-evaluated call that the `where(T <: Copy)` check rejects inside
`comptime_expect_error`. The trace runs through the unspecialized
`yo_id_1593...` (one of the two `_ct_need_copy*` helpers) into a
`_rtparam0_usize_ret_R_gs_...` specialization that constructs the capture
record. Prime suspect is the dup/drop accounting around a comptime call that
receives an Rc argument and throws: the comptime side's share is either never
taken or never returned, and the caller-side drop is suppressed as if the
comptime call had consumed the value.

## Test

Already present: `tests/copy_trait.test.yo`, "Copy: where(T <: Copy) rejects
a closure that owns a String" — it fails before any fix (seed and develop).
