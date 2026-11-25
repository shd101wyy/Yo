# The `Dyn(Fn(...))` call-slot fallback compiles a live slot to `return 0`

**Severity:** S3 — no known program reaches it since the fix of `issues/fixed/2026-11-25-a-closure-returning-a-future-behind-a-box-dyn-fn-is-called-through-a-zeroed-stub.md`; when one does, the failure is a NULL result at run time instead of a compile error.

Filed 2026-11-25 by the dyn-future-reject lane, split from that S1.

## The code

The last arm of the `Fn`-slot pass in `src/codegen/functions/dyn.yo` writes, when no other arm can call the payload:

```c
static R __yo_wrap_<key>_call(void* self_ptr, ...) {
  (void)self_ptr; /* Dyn(Fn): expected Rc(...) data */
  R zero = (R)0;
  return zero;
}
```

Its comment assumes "nothing calls it, its callers were dropped by the same eval-side throw". In the S1 nothing threw: `check` accepted the program, the slot was live, and the caller dereferenced the NULL future (SEGV at address 8).

## Direction

A wrapper whose payload type codegen cannot resolve should fail the compile (an internal error naming the `Dyn` and the payload type) unless the evaluator has recorded that its callers were dropped. A regression test needs a program that still reaches the arm; none is known after the S1 fix, so the change should come with an internal-error test or an assertion that the arm is only reached for dropped callers.
