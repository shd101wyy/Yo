# A local whose address a method takes is a dangling C local across an await

**Severity:** S1 — a pointer into a local taken through a `&self` method (`buf_uninit.as_ptr()`) before an await in an `io.async` body points into a dead stack frame after the resume: stack-use-after-return under ASan, SIGSEGV or garbage at `--optimize 2`

**Found:** 2026-10-15, writing `tests/io/stdio_redirect.test.yo` (stdio Generation B). Its first
read-back helper read a file into a `MaybeUninit(Array(u8, 64))` inside an `io.async` body
and failed all three write tests with ASan `stack-use-after-return`. The test now reads back
through `std/fs/file`'s `read_to_string` (a heap buffer) instead.

## Reproducer

`issues/repros/a-local-whose-address-a-method-takes-is-a-dangling-c-local-across-an-await.yo`:

```yo ignore
first_byte :: (fn(fd : i32, io : Io) -> Impl(Future(u8, IoExn)))(
  io.async(e => {
    buf_uninit := MaybeUninit(Array(u8, usize(64))).new();
    buf := (*u8)(buf_uninit.as_ptr());
    n := IoError.check(e.io.await(file.read(fd, buf, u32(64), u64(0)), e.io), e.exn);
    buf.*
  })
);
```

```
$ yo compile issues/repros/a-local-whose-address-a-method-takes-is-a-dangling-c-local-across-an-await.yo --std-path ./std --sanitize address --allocator system -o /tmp/r && /tmp/r
==155246==ERROR: AddressSanitizer: stack-use-after-return on address 0x783714bff0a0 ...
READ of size 1 at 0x783714bff0a0 thread T1
$ yo compile ... --optimize 2 -o /tmp/r2 && /tmp/r2; echo rc=$?
rc=139
```

Spelling the pointer `(*u8)(addr_of(buf_uninit))` instead prints `47` as expected. (Measured
with v0.2.63, which is develop 0684c9c40's compiler.)

## Root cause

The emitted C keeps `buf_uninit` an ordinary C local of the first poll, while `buf` (read
after the await) gets a state-machine field:

```c
__yo_t_5000472626592739492 __yo_v_buf_uninit = ...;
sm->var_buf_11312044459651359041 = ((uint8_t*)(((Array_uint8_t_64*)((&(__yo_v_buf_uninit))))));
```

`compute_cross_boundary_variables`' live-range walk (`src/codegen/async/state_machine.yo`)
gives a local scope-end liveness when its address is taken, but it recognizes only the
syntactic forms (`ast_expr_is_address_of_call`: `&x`, `&mut x`, `addr_of(x)`). A method call
whose receiver is borrowed (`x.m()` with `self : &Self` / `&mut Self`) lends `x`'s address
just the same, and when the method returns a pointer derived from it (`MaybeUninit.as_ptr`,
`as_mut_ptr`, any `-> *T` accessor), that pointer outlives every later use of the name `x`.
The walk sees `buf_uninit` last read on line 2, so it never crosses the await.

## Fix direction

Treat a borrowed method receiver like `&x` in the walk when the call's result can carry the
address: at least when the callee returns a raw pointer (or a `&T`), the receiver local lives
to the end of its scope (`_lv_mark_scope`). The evaluator's `ExprInfo` for the call knows the
receiver mode and the result type. A blanket "every borrowed receiver lives to scope end" is
sound too, at the cost of more state-machine fields.

Test to add with the fix: the reproducer's shape in `tests/async_await.test.yo` (an
`io.async` body reading into a `MaybeUninit` array through `as_ptr()` across a real
suspension, asserting the bytes).
