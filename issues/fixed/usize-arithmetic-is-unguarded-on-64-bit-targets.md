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

## Fix

`_arith_checked_expr`'s 64-bit branch is now `is_u64_type(ty) || is_usize_type(ty)`.
Turning the guard on needed two more changes.

**1. The compiler relied on `usize` wrap.** The first fixpoint with the guard
on trapped in stage 2 at `src/codegen/exprs/generation.yo:541`:
`vars.get(vars.len() - usize(1))` on an empty list wrapped to `usize.MAX`, so
`get` answered `None`. Right by accident.
- 158 sites of exactly `X.get(X.len() - 1)` in `src/` and `std/` became
  `X.last()`. That is the same `None` on an empty list, by definition.
- The two binder loops `while(bi < (args.len() - 1))` (`contracts.yo`,
  `vc.yo`) became `(bi + 1) < args.len()`.
- The other 96 `len() - 1` sites and the three `len() - 2` `get`s were read
  one by one. Each is behind a length check or safe by construction.
- Discovery run (measured): a stage-2 compiler whose `u64` overflow helpers
  LOG and continue instead of aborting. It ran the whole self-compile and
  the fast suite (4546 tests) with 0 overflow sites logged. The channel is
  live: batch compiles are child processes that inherit stderr.

**2. The guards cost 19%, and outlining the trap recovers it** (measured,
Mac mini M4, `compile src/main.yo --emit-c --skip-c-compiler` of one tree
by three stage-2 builds of that tree, two runs each):

| Stage 2 | Guard sites | Wall time | Peak RSS |
| --- | --- | --- | --- |
| no `usize` guard | 35 `_chk_u64` calls | 173.3 s, 173.2 s | 3.26 GB |
| `usize` guard, inlined `fprintf` + `abort` | 9933 (7938 add, 916 sub, 1078 mul) | 204.7 s, 204.7 s | 3.27 GB |
| `usize` guard, outlined trap | 9933 | 174.5 s, 172.4 s | — |

All three emit byte-identical C. The helpers now call one
`__yo_ovf_trap(what, f, r, c)`. It is C11 `_Noreturn static inline`, with
`noinline, cold` under `__GNUC__`/`__clang__`, and it ends in
`fflush(stdout)` + `__yo_abort()` like every runtime trap (#1023). It serves every
overflow helper, so the existing `i32`/`u64` guards get the same outlining.

Regression test: the cli-case `usize-add-overflow-panics` (`usize.MAX + 1`
aborts with `integer addition overflow`). Before the fix the program
printed `never=0`.
