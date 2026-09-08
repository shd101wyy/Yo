# Copying an RC value into a local, taking its address, and returning it DOUBLE-DROPS

**Status:** OPEN
**Found:** 2026-09-08 by CI's `test (ubuntu-24.04-arm)` ASan leg, on the first
cut of `std/testing/bench.yo`'s `black_box`.

## The shape

```rust
_bb :: (fn(generic(T : Type), v : T) -> T)({
  (local : T) = v;
  (p : *(T)) = &local;     // address taken
  local                    // and then returned
});
...
(s : String) = runtime(`hello`);
assert(_bb(s) == `hello`, "...");
```

## Symptom

`yo check` passes, the macOS suite passes, and the Linux ASan leg reports:

```
ERROR: AddressSanitizer: heap-use-after-free on address 0x503000001930
READ of size 4 at 0x503000001930 thread T1
    #0 __yo_decr_rc
    #1 __yo_user_main
freed by thread T1 here:
    #0 free
    #1 __yo_decr_rc
    #2 __yo_user_main
previously allocated by thread T1 here:
    #1 __yo_new___yo_t0
    #2 yo_id_4401_rtparam0_usize_ret_R_gs_yo_id_4325_u8   ← ArrayList(u8), the String's buffer
SUMMARY: AddressSanitizer: heap-use-after-free in __yo_decr_rc
```

Two `__yo_decr_rc` calls from the CALLER's frame hit the same 32-byte region:
the returned copy never got its dup, so the temporary's drop and `s`'s
scope-end drop both take the count to zero.

## What is and is not affected

| `T` | result |
| --- | --- |
| `ArrayList(i32)` — a true `ref` type | **correct**: `rc` is 2 after the call, verified with `rc()` |
| `String` — a VALUE struct wrapping an RC field | **double drop** |
| the same body without the address-of | correct for both |

So it needs all three of: a generic fn, an RC value reached through a
non-`ref` struct field, and the local's address being taken. Taking the
address is what defeats the dup/drop pair optimizer
(`_optimize_dup_drop_pairs`, `src/evaluator/exprs/begin.yo`) — it can no longer
prove the local dead, so the cancellation that should have removed the
scope-end drop is what goes wrong instead. AGENTS.md's note that "a missing
drop in the C is an optimizer bug, not a consumption-marking bug" points at the
same pass from the other direction.

## Reproducing it

Not reproducible on macOS: ASan is non-functional there ("AddressSanitizer is
not functional with this compiler setup"), and a 20 000-iteration stress loop
survives because the freed buffer is not reused in a way that faults. `rc()` is
the local instrument — but it reports 1/1 for `String` because `rc` of a
value struct is not the inner buffer's count, which is exactly why this hid.
Use `ArrayList(u8)` directly, or read the Linux ASan leg.

## Consequence, and what shipped instead

`black_box` now takes the value in a REGISTER instead of by address, which
needs no copy and no address and so cannot hit this. That restricts it to
primitive numeric / pointer / bool — enforced by the compiler — and the doc
says so. Supporting aggregates needs this bug AND
`issues/address-of-a-parameter-in-a-generic-fn-emits-a-placeholder.md` fixed.
