# A combinator specialized for a first-class future skips the borrow checks of a borrowing one

**Severity:** S1. Once a generic combinator has been specialized for a first-class future operand, a later call that passes it a BORROWING future (§3.13 A2) reuses that specialization and skips every borrow check on the call's future. A later argument of the same call can then move or overwrite the lent place, and the program compiles and runs: it writes through the borrow of a dropped local. The combinator's future can also be bound, although it is second-class.

**Status:** FIXED 2026-10-20 (`fix/combinator-spec-per-operand-future`). **Found:** 2026-10-20, while gating the A4 std half: `tests/async/combinators.test.yo` "A4: select's two operands may not lend overlapping places" stopped firing once an earlier test specialized `timeout` for a first-class operand. Develop `6ccddf25d` and the v0.2.66 seed both accept the reproducer.

## Reproducer

```yo
{ println } :: import("std/fmt");
{ sleep } :: import("std/sys/timer");
C :: struct(n : i32);
bump_after :: (fn(c : &mut C, ms : u64, io : Io) -> Impl(Future(i32, Io)))(
  io.async({ &mut c, ms }(io : Io) => {
    io.await(sleep(ms), io);
    c.n = (c.n + i32(1));
    c.n
  })
);
plain :: (fn(v : i32, io : Io) -> Impl(Future(i32, Io)))(
  io.async({ v }(io : Io) => v)
);
with_k :: (fn(generic(T : Type), op : Impl(Future(T, Io)), k : i32, io : Io) -> Impl(Future(T, Io)))(
  io.async({ op, k }(io : Io) => io.await(op, io))
);
first_use :: (fn(io : Io) -> Impl(Future(i32, Io)))(
  io.async((io : Io) => io.await(with_k(plain(i32(1), io), i32(2), io), io))
);
main :: (fn(io : Io) -> unit)({
  mut(c) := C(n : i32(0));
  r := io.await(
    with_k(bump_after(&mut c, u64(1), io), {
      drop(c);
      i32(5)
    }, io),
    io
  );
  println(`r=${r}`);
});
export(main);
```

On develop this compiles and prints `r=1`: the operand wrote into `c` after `drop(c)`. With `c = C(n : i32(7))` in place of `drop(c)` it prints `r=8 c=8`. Delete `first_use` and both forms are rejected with E0910 ("This argument moves `c`, which an earlier argument of the same call lends to the future the call makes"). That is the correct verdict, and with the fix it is reported whether or not `first_use` exists.

## Cause

The specialization cache (`_find_specialization_cache`, `src/evaluator/calls/helper.yo`) compares runtime parameter types with `are_types_compatible_exact`. Two future wrappers (`Impl(Future(i32, Io))` from `plain` and from `bump_after`) are compatible by their traits, so the second call reused the first call's specialization. A combinator records that its future borrows the operand's places (`_register_borrowing_future`) only when its specialized body is evaluated. A reused specialization never got there, so the call site saw a future that borrows nothing. E0910's "a later argument moves or overwrites a lent place" check, the second-class binding rule and the overlap check between two operands all read that registration, so all of them were skipped.

## Fix

In the specialization cache, two future-wrapper runtime parameter types are one argument type only when their resolution chains end in the same type (`type_key(&resolution_chain_end(...))`, the per-producer future). The futures of one producer still share a specialization, and so do two calls with the same operand producer. Each distinct operand producer gets its own specialization, whose body evaluation registers its own borrows. The compiler's own C is byte-identical to the base (142,824,324 bytes for `yo compile src/main.yo --emit-c --skip-c-compiler`). The compiler has no combinator that is called with two producers' futures.

Regression test: `tests/async/combinators.test.yo`, "A4: a combinator specialized for a first-class operand still checks a borrowing one". It specializes a local combinator for a first-class operand and then expects E0910 for both the overwrite and the move of a lent place, plus the second-class binding error. Its file fails without the fix.
