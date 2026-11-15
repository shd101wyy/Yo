# A `Box(Dyn(Fn(...)))` over a named function calls a stub that returns zero

**Severity:** S1 (silent wrong result: `dyn(Box.new(f))` of a named `fn` compiles, and every call
through the `Dyn` returns a zeroed value without running `f`; a non-scalar result is invalid C)

## Symptom

```yo
_dnf_len :: (fn(s : &String) -> usize)(s.len());
(a : Box(Dyn(Fn(s : &String) -> usize))) = dyn(Box.new(_dnf_len));
a(&s) // 0
```

The emitted call slot is the fallback stub:

```c
static size_t __yo_wrap___yo_fn_…_P_call(void* self_ptr, …) {
  (void)self_ptr; /* Dyn(Fn): expected Rc(...) data */
  size_t zero = (size_t)0;
  return zero;
}
```

A `String` result makes it invalid C (`(String)0`), which is how `tests/dyn.test.yo` surfaced it.

## Root cause

`generate_dyn_wrapper_functions` (`src/codegen/functions/dyn.yo`) had a payload-convention (`_P`) arm
for a closure payload only. A named function's payload (its code pointer) had an arm only under the
legacy boxed convention, so under the flip every such instance fell through to the stub.

## Fix

The `_P` arm also takes a code-pointer payload: it reads the pointer through the data word and calls it
through the function's own prototype, each argument at the pointer level that prototype takes.

## Test

`tests/dyn.test.yo` "dyn of a named function calls the function" and its neighbours (the batch failed
to compile before; pass after).
