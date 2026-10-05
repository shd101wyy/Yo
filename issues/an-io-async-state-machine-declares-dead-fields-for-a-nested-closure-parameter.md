# An `io.async` state machine declares dead fields for a nested closure's parameter

**Severity:** S3: every state-machine instance carries one unused field and
move flag per nested closure parameter (16 B for a `usize` parameter). Nothing
reads or writes them, so no value is wrong.

Found 2026-10-05 by the A/B emission diff of the capture-identity fix
(`issues/fixed/the-io-async-capture-re-kind-pass-matches-captures-by-name.md`).
**Measured on:** a stage-1 of develop `17e494faa`, `YO_STD` pinned to the
tree's `std/`. The fix did not cause this. It made a parameter that shares a
captured variable's name behave like one that does not, and both now show it.

## Reproducer

```rust
mk :: (fn(io : Io) -> Impl(Future(usize, IoExn)))({
  x := usize(7);
  io.async(e => {
    a := x;
    e.io.await(sleep(u64(1)), e.io);
    (f : Impl(Fn(y : usize) -> usize)) = (y => (y + usize(100)));
    return(a + f(usize(1)));
  })
});
```

The state-machine struct gets two fields that no state stores into:

```c
size_t var_y_12887276773564562936;  // y
uint8_t __yo_mv_var_y_12887276773564562936;  // y was moved out
size_t var_y_12882468609215342358;  // y
uint8_t __yo_mv_var_y_12882468609215342358;  // y was moved out
```

## Cause

The body's suspension analysis lists the nested closure's parameter twice:
once at the `y : usize` of the slot's `Impl(Fn(...))` type and once at the
closure literal's `y`. The live-range walk (`compute_cross_boundary_variables`,
`src/codegen/async/state_machine.yo`) never declares either one, because a
nested closure's parameters belong to that closure's own C function. An entry
the walk did not declare keeps its field ("a minted temp, a binding it cannot
place"). So both get fields that the nested function never touches.

## Fix direction

Leave a nested closure's parameters out of the enclosing body's analysis, or
have the walk declare them with a range that ends inside the closure literal.
Test: a nested closure parameter in an awaiting `io.async` body declares no
`var_<param>` field.
