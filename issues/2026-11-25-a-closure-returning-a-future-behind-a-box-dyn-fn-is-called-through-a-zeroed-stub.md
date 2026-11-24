# A closure returning a future behind `Box(Dyn(Fn(...) -> Impl(Future(...))))` is called through a zeroed stub and SEGVs

**Severity:** S1 — a program `yo check` accepts compiles cleanly and crashes at run time: the `Dyn`'s `call` slot returns a NULL future, and the await reads `->state` at address 8 (SEGV under ASan and without it).

Filed 2026-11-25 by the dyn-future-reject lane, from probe `j2` of VERDICTS-80. Reproduced with the v0.2.79 seed (tree std at `13af89b04`) and, by the verdict's probe run, with a develop stage 1 (`78a71eae1`).

## Reproducer

```yo
{ println } :: import("std/fmt");
main :: (fn(io : Io) -> unit)({
  (mk : Box(Dyn(Fn(io : Io) -> Impl(Future(i32, Io))))) = dyn(Box.new((io : Io) => io.async((io : Io) => i32(1))));
  v := io.await(mk(io), io);
  println(&v);
});
export(main);
```

`yo check`: evaluator OK. `yo compile repro.yo --cc clang --sanitize address --allocator system -o repro && ./repro`:

```text
==1281923==ERROR: AddressSanitizer: SEGV on unknown address 0x000000000008 (pc 0x5555556cdb23 bp 0x7bfff3ffc9f0 sp 0x7bfff3ffc7c0 T1)
==1281923==The signal is caused by a READ memory access.
==1281923==Hint: address points to the zero page.
```

## Root cause (first pass)

The `call` slot of the `Dyn`'s vtable is the codegen fallback stub, not a call:

```c
static __yo_t_8381625107937523703* __yo_wrap___yo_t_16065164614494844924___yo_t_15567109142766293668_P_call(void* self_ptr, __yo_t_2472863051630647847 arg1) {
  (void)self_ptr; /* Dyn(Fn): expected Rc(...) data */
  (void)arg1;
  __yo_t_8381625107937523703* zero = (__yo_t_8381625107937523703*)0;
  return zero;
}
```

`main` calls `mk.vtable->call(...)`, gets NULL, and the synchronous await reads `->state` off it (offset 8 in `__YO_FUTURE_PREFIX`). The payload's `TypeId` static is `__yo_typeid_unknown_<n>`: codegen does not know the payload's type.

The wrapper is written by the `Fn`-slot pass of `src/codegen/functions/dyn.yo`. For a closure payload it looks up the closure's C function in `impl_closure_call_map` by the capture struct id, taken from the `dyn_impls` entry's `concrete_type` (a `Struct`, or a `SomeT` whose resolution is a `Struct`). Here no arm matches, so the wrapper falls through to the last branch, whose comment assumes "nothing calls it, its callers were dropped by the same eval-side throw". Nothing threw: `check` accepted the program, and the call is live.

The difference from the working shape is the closure's result. The same program with `Box(Dyn(Fn(io : Io) -> i32))` and `(io : Io) => i32(1)` prints `1`. A closure whose result is an `Impl(Future(...))` (an unresolved `SomeT` until codegen picks the state machine) is the same trigger as the open `issues/an-impl-fn-local-returning-a-future-is-declared-as-a-void-pointer.md`, where the closure-typed local is lowered to `void*`. That doc's binding site and this `dyn_impls` entry probably share the cause: the closure's recorded type does not carry its capture struct when its result is a future.

The fallback stub itself is the second defect: a live call slot must never compile to `return 0`. If the payload's type cannot be resolved, codegen should fail loudly (an internal error naming the `Dyn`), not emit a NULL-returning slot.

## Fix direction

Resolve the payload's capture struct for a closure whose result is `Impl(Future(...))` where the `dyn_impls` entry is recorded, and turn the stub branch into a hard codegen error for any `Dyn` whose `call` slot is reachable. The fix needs a running test (ASan) that awaits through the `Box(Dyn(Fn(...)))`.
