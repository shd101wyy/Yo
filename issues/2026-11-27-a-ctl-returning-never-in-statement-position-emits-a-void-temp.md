# A `ctl(...) -> never` call in statement position emits a `void` temp, and the C does not compile

**Severity:** S2. `yo check` accepts the program, and then the C compiler rejects the emitted code.

- Filed 2026-11-27 from VERDICTS-89 §9 finding 2 (probe p22). Reproduced with a stage 1 of `wip/v0281-dupdrop-r9` merged with develop `bc706b0a3` (v0.2.80).
- It blocks the `-> never` spelling of a non-resuming operation (`issues/questions/2026-11-27-a-non-resuming-operation-is-ctl-returning-never.md`).

## Reproducer

```yo
{ println } :: import("std/fmt");
{ String } :: import("std/string");
Exn :: struct(
  throw : (ctl(code : i32) -> never)
);
opr :: (fn(c : i32, exn : Exn) -> Rc(i32))({
  r := Rc(i32).new(i32(7));
  s := String.from("a-string-long-enough-to-be-on-the-heap");
  cond(
    (c != i32(0)) => {
      exn.throw(c);
    },
    true => ()
  );
  println(&s);
  r
});
run :: (fn(c : i32) -> i32)({
  exn := Exn(throw : (code -> unwind(i32(100) + code)));
  r := opr(c, exn);
  println(&r.*);
  i32(0)
});
main :: (fn() -> unit)({
  println(&run(i32(0)));
  println(&run(i32(3)));
});
export(main);
```

```text
$ yo compile tmp/fixme.yo --allocator system --optimize 2
p22.c:2996:10: error: variable has incomplete type 'void'
 2996 |     void _eu_173735 = (((void (*)(int32_t))__yo_v_exn.__yo_v_throw)((int32_t)(__yo_v_c)));
yo: error: compile: C compiler failed (exit 1) on p22.c
```

## Root cause

An effect-call statement binds the call's result to a temp named `_eu_<id>` (`src/codegen/exprs/other-fn-call.yo`, `fp_tv`), with the call's C result type. For a `ctl` whose result is `never`, that C type is `void`. A `void` variable is not C. The emitter must emit the call as a bare statement when the result is `never` (or `void`), as it does for a `unit` result.

The fix gets a run test in `tests/algebraic-effects.test.yo` built from this reproducer. It fails to compile before the fix and passes after.
