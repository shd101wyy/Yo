# safe mode: `usize` `+ - *` overflow is not trapped on 64-bit targets

**Severity:** S1 — a `usize` overflow silently wraps in safe code, the failure mode safe mode's D1 ruling exists to remove.

Found 2026-09-29 while building 5b Phase 2. The C-diff oracle reported an
elided guard that the reference C never had.

## Symptom (measured, seed v0.2.45 and a tree build)

```rust
{ println } :: import("std/fmt");
{ ArrayList } :: import("std/collections/array_list");

main :: (fn() -> unit)({
  xs := ArrayList(i32).new();
  xs.push(i32(1));
  n := xs.len();
  big := (usize(18446744073709551615) - n);
  println(big + (n + n));       // prints 0: wrapped, no trap
  u := (u64(18446744073709551615) - u64(n));
  println(u + (u64(n) + u64(n)));  // traps: integer addition overflow
});
export(main);
```

The `usize` sum prints `0`. The same `u64` sum traps with
`integer addition overflow (at …:11:13)`, rc 134.

## Root cause (read)

`_arith_checked_expr` in `src/codegen/exprs/inline_fns.yo` (safe mode 3a,
#837) routes `usize` to a guarded helper only on wasm (`is_usize_type(ty) &&
wasm`, the 32-bit branch). The 64-bit branch tests `is_u64_type(ty)` alone, so a
64-bit `usize` falls through to the final "non-integer (float): plain op" arm.
`isize` has no such gap: its 64-bit branch is `is_i64_type(ty) || is_isize_type(ty)`.
Neither #837's body nor `plans/SAFE_MODE.md` records `usize` as deliberately
exempt, and the function's own comment says "isize/usize follow the target".

## Why this is not a one-line fix

Adding `|| is_usize_type(ty)` to the `u64` branch guards every `usize`
operation in `src/` and `std/`. Code that relies on `usize` wrap (a `len - 1`
on an empty length, a hash mix) would start trapping. SAFE_MODE 3a-ii did the
same audit for the other widths (wrap-by-design sites move to `wrapping_*`).
It needs:
- a `usize` wrap-by-design audit of `src/` and `std/`;
- the self-emit and memory ratchets (every index computation gains a helper
  call);
- a test that fails before and passes after (the program above, as a
  `tests/` case expecting the trap).
