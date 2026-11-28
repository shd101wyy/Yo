# A handler of a generic-resume `ctl` cannot resume with a value at any type, and `yo check` accepted it

**Severity:** S1. `yo check` accepted the program. It then segfaulted (an `Rc` resume type), the C compiler rejected it (a `String` resume type), or it silently resumed with 0 (an `i32` resume type).

- Found 2026-11-25 by the v81-dupdrop lane (VERDICTS-70 row 7) while classifying the census's open-`ResumeType` copies (`CENSUS-70.md`, class (b), `tests/algebraic-effects.test.yo` tests 42–45). Reproduced with a stage 1 of develop `8da9761d1` and with the v0.2.79 seed.
- Widened 2026-11-27 by VERDICTS-89 (Fable 5.2, 25 probes with v0.2.80). The first version of this document said the value is lost "at a non-scalar `ResumeType`", and that tests 43–46 "pass only because their `ResumeType` is `i32`". Both claims were wrong. The value never arrives, at any type, `i32` included. Tests 43–46 passed because they resume with `i32(0)`, which is the zero-initialized result the throw site reads anyway.
- Fixed by VERDICTS-89 PR A (`wip/v0281-ctl-resume`): R1, the `return` half of R2, and E0627.

## Reproducer

```yo
{ println } :: import("std/fmt");
MyException :: (fn(comptime(ErrorType) : Type) -> comptime(Type))(
  struct(
    throw : (ctl(generic(ResumeType : Type), error : &ErrorType, resume_value : &ResumeType) -> ResumeType)
  )
);
op :: (fn(x : i32, exn : MyException(i32)) -> Rc(i32))({
  r := Rc(i32).new(i32(7));
  exn.throw(&x, &r)
});
main :: (fn() -> unit)({
  exn := MyException(i32)(throw : ((val, resume_val) -> return(resume_val.*)));
  r := op(i32(1), exn);
  println(&r.*);
});
export(main);
```

```text
AddressSanitizer: SEGV on unknown address 0x000000000008 ... The signal is caused by a READ memory access.
```

The same program at other resume types:

- **`String`** (`s := String.from("resumed-string"); exn.throw(&x, &s)`): clang rejects the C.

  ```text
  error: operand of type '__yo_t_…' (aka 'struct __yo_t_…_struct') where arithmetic or pointer type is required
  ```

- **`i32`**, resuming with 7 or with 9: the program prints `0` both times (VERDICTS-89 probe p2).

Other shapes have the same root, and every one of them was accepted by `check`:

- **By-value parameter.** `fallback : ResumeType` with `return(fallback)` prints 0 at `i32` (p24) and gives invalid C at `String` (p5).
- **`Clone` bound.** `where(ResumeType <: Clone)` with `return(fallback.clone())` gives invalid C (p25).
- **The type parameter elsewhere in the type.** With a handler that only unwinds, the C is still invalid at a `String` argument when the type parameter appears as:
  - a `&R` parameter (p14);
  - a nested result, `-> Option(R)` (p15);
  - a parameter-only `ctl(generic(T : Type), item : T) -> unit` (p16).
- **`return(())`.** In a generic-resume handler it emits `return;` in a `void*` function (p7).

## Root cause

The handler is checked against `ctl(generic(ResumeType), …) -> ResumeType`. It is one function, evaluated once with `ResumeType` open and emitted erased as `void* fn(int32_t val, void* resume_val)`. It is installed as a run-time value, and every throw site calls it whatever `ResumeType` that site picks. Nothing in the body can have the type the throw site picks.

Codegen already relied on this. At the throw site, the result temp is zero-initialized, and the call's `void*` result is discarded (`src/codegen/exprs/other-fn-call.yo`, `ctl_generic_ret`: "a generic-ResumeType handler cannot resume with a value, so the zero-init IS the result"):

```c
_result = (Rc_i32){0};
(((void* (*)(int32_t, void*))__yo_v_exn.__yo_v_throw)((int32_t)(__yo_v_x), (void*)(__yo_v_r)));
return _result;
```

The checker did not agree with codegen. The 2026-10-01 verdict (`issues/fixed/may-a-plain-exception-handler-resume-the-throw-with-a-value.md`, option 1: such a handler "may only diverge") was implemented with two leniencies. A value "typed by that variable" could resume, and so could `return(())`. Separately, nothing restricted where a `ctl` type parameter may appear.

## Fix

VERDICTS-89 (option 1 widened; specializing the handler per throw site was rejected: a handler is a run-time value, so there is nothing to specialize against).

- **R1.** A `ctl` type parameter may appear only as the whole result type: `ctl(generic(R : Type), ps) -> R`, an operation that does not resume. Any other use is E0627 where the type is written (`src/evaluator/types/function.yo`).
- **R2, the `return` half.** In a handler of such a `ctl`, every `return(...)` is E0627, `return(())` included. So is a tail of a concrete type (`src/evaluator/values/anonymous-function.yo`). Falling through with `()` is still accepted. Making it an error is VERDICTS-89 PR B; see `issues/2026-11-27-a-generic-resume-handler-that-falls-through-aborts-the-process-with-no-message.md`.
- **R3.** To resume with a value, the resume type is fixed when the record is built (`comptime(R)` on the type constructor, as `ResumableException(T)` does). There the handler is checked at a concrete type, and `return(fallback.*)` of a value that needs a drop is E0901.
- **Tests** (`tests/algebraic-effects.test.yo`):
  - Tests 43–46 resume through `MyException(i32, i32)` with nonzero resume values.
  - Test 42 drops its `resume_value` parameter.
  - New compile-fail cases cover R1 and R2.
  - New run cases cover R3 at `String`, `Rc(i32)` and `i32`, and the E0901 case.
  - A non-resuming throw in value position is tested at `String`, `Rc(i32)` and `Box(i32)`.
