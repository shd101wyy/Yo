# An effect handler's `unwind` releases a local before its operand reads it

**Severity:** S1 — `unwind(expr)` in an effect handler whose operand reads a
handler local (`x := R(n : k); unwind(x.n + G.n);`) releases `x` first and
then evaluates `x.n`: a heap-use-after-free, so the unwound value is read
from freed memory.

**Found:** 2026-10-23, in the adversarial review of
`issues/fixed/2026-10-23-a-compile-time-collapsed-cond-arm-return-releases-the-returned-value.md`,
while probing collapsed `cond(true => unwind(...))` arms in handlers. No
`cond` is involved: the plain `unwind` has it. develop `6dee22187` and the
review branch both have it. `yo check` reports nothing. Not the same bug as
`issues/an-effect-handler-local-moved-out-after-a-conditional-unwind-leaks.md`
(a leak).

## Reproducer

`issues/repros/2026-10-23-an-effect-handler-unwind-releases-a-local-before-its-operand-reads-it.yo`,
built with `yo compile <file> --optimize 2 --sanitize address --allocator system`:

```yo
{ println } :: import("std/fmt");
R :: ref(struct(n : i32));
Ask :: (ctl(k : i32) -> R);
(G : R) = R(n : i32(5));
use_ask :: (fn(ask : Ask) -> i32)({
  a := ask(i32(1));
  b := ask(i32(2));
  a.n + b.n
});
run :: (fn() -> i32)({
  (ask : Ask) = (
    k -> {
      x := R(n : k);
      unwind(x.n + G.n);
    }
  );
  use_ask(ask)
});
main :: (fn() -> unit)({
  println(run());
  println(`G rc=${ref_count(G)} want 1`);
});
export(main);
```

```text
==…==ERROR: AddressSanitizer: heap-use-after-free on address … READ of size 4
```

The emitted C drops the local before the operand reads it:

```c
__yo_decr_rc((void*)(__yo_v_x));
{ int32_t _unw_val = … __yo_v_x->__yo_v_n …; memcpy(__yo_unwind_value, …); }
```

The control `unwind(k + G.n)`, which reads no local, is clean.

## Analysis

`generate_unwind`'s `.Some(arg)` arm (`src/codegen/exprs/return.yo`) renders
the operand's C expression first, emits the early-exit drop preamble (the
parameter, deferred and consumed-variable drops), and only then writes
`_unw_val = <operand>`. The operand's code is a C expression, not a value, so
any local it names has been released by then. `generate_return` already
evaluates its operand into a temp before its drop preamble; `unwind` needs the
same order: store the operand into `_unw_val` (or a fresh temp) first, then
drop the handler's locals, then copy it into `__yo_unwind_value`. The change
needs the dup/drop emit-diff gate on `src/main.yo` and the algebraic-effects
tests, and a test in `tests/algebraic_effects.test.yo` reading a handler
local in the `unwind` operand under ASan.
