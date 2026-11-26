# A generic `ctl` handler that resumes with its `&ResumeType` referent loses the value at a non-scalar `ResumeType`

**Severity:** S1 — `yo check` accepts the program and it segfaults (an `Rc` `ResumeType`), or the C compiler rejects the emitted code (a `String` `ResumeType`).

Found 2026-11-25 by the v81-dupdrop lane (VERDICTS-70 row 7) while classifying the census's open-`ResumeType` copies
(`~/Workspace/Yo-wt/v0273/CENSUS-70.md`, class (b), `tests/algebraic-effects.test.yo` tests 42–45). Reproduced
with a stage 1 of develop `8da9761d1` and with the v0.2.79 seed.

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

With `String` in place of `Rc(i32)` (`s := String.from("resumed-string"); exn.throw(&x, &s)`), clang rejects the C:

```text
error: operand of type '__yo_t_…' (aka 'struct __yo_t_…_struct') where arithmetic or pointer type is required
```

`tests/algebraic-effects.test.yo` tests 43–46 pass only because their `ResumeType` is `i32`.

## Root cause

The handler is a closure checked against `ctl(generic(ResumeType), …) -> ResumeType`. It is evaluated once, with
`ResumeType` open, and emitted erased: `void* fn(int32_t val, void* resume_val)`, whose body returns
`resume_val` as is (`src/evaluator/values/anonymous-function.yo`, the `ctl_force` comment: "params bind at their
(erased) declared types — exactly the void* convention the emitted C uses").

At the throw site of `op` (`ResumeType := Rc(i32)`):

```c
_result = (Rc_i32){0};
(((void* (*)(int32_t, void*))__yo_v_exn.__yo_v_throw)((int32_t)(__yo_v_x), (void*)(__yo_v_r)));
return _result;
```

- the `&r` argument is passed as the value `r`, not its address (for a `String` this cast is the invalid C);
- the call's `void*` result is discarded, so `op` returns the zeroed result temp, and `r.*` reads through null.

A second fault sits behind the first: `resume_val.*` is a copy of a value of the open type `ResumeType`. Nothing
can judge it (there is no instantiation: one body serves every throw site), so at `ResumeType := Rc(i32)` or
`String` it would be an implicit copy of a value with drop glue, a second owner of the caller's `r`.

## Options

1. Reject the copy: an open type variable read out of a reference in an erased handler body is E0901, as Rust
   rejects `*r` for `r : &T` without `T : Copy`. A generic `ctl` handler can then diverge or resume with `()`;
   resuming with a value needs a non-generic `ctl` (`ctl(error : &E, resume_value : &i32) -> i32`). Tests 43–46
   are rewritten to that shape.
2. Specialize the handler per throw site's `ResumeType` (the generic closure path), so the copy is judged at
   each instantiation and the call is emitted at its real types.

Recommendation: 1 (explicit, Rust's rule, small), unless the maintainer wants generic resumption as a feature.
