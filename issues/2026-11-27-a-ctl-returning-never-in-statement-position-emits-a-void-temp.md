# A `-> never` call through a `ctl` field or a function value, in statement position, emits a `void` temp, and the C does not compile

**Severity:** S2. `yo check` accepts the program, and then the C compiler rejects the emitted code.

- Filed 2026-11-27 from VERDICTS-89 §9 finding 2 (probe p22). Reproduced with a stage 1 of `wip/v0281-dupdrop-r9` merged with develop `bc706b0a3` (v0.2.80).
- It was filed as blocking the `-> never` spelling of a non-resuming operation. That question is retired without adoption (`issues/retired/2026-11-27-a-non-resuming-operation-is-ctl-returning-never.md`): VERDICTS-96 deletes `ctl`.
- The bug is not specific to `ctl`. A plain function value typed `fn(code : i32) -> never`, called in statement position, emits the same `void` temp (second reproducer below, checked 2026-11-28 with a stage 1 of `wip/v0281-ctl-resume` at `e2fecbdcf`). It stays open as a general codegen bug.

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

A plain function value hits the same path:

```yo
{ println } :: import("std/fmt");
{ panic } :: import("std/assert");
die :: (fn(code : i32) -> never)({
  println(`dying with ${code}`);
  panic("die")
});
step :: (fn(c : i32, f : (fn(code : i32) -> never)) -> i32)({
  cond(
    (c != i32(0)) => {
      f(c);
    },
    true => ()
  );
  c
});
main :: (fn() -> unit)({
  println(`${step(i32(0), die)}`);
  println(`${step(i32(3), die)}`);
});
export(main);
```

```text
$ yo compile tmp/never_fn.yo --allocator system -o never_fn
never_fn.c:3047:10: error: variable has incomplete type 'void'
 3047 |     void _eu_174851 = (((void (*)(int32_t __yo_v_code))__yo_v_f)((int32_t)(__yo_v_c)));
yo: error: compile: C compiler failed (exit 1) on never_fn.c
```

## Root cause

A statement that calls a function value binds the call's result to a temp named `_eu_<id>` (`src/codegen/exprs/other-fn-call.yo`, `fp_tv`), with the call's C result type. When the result is `never`, whether the callee is a `ctl` field or an `fn` value, that C type is `void`. A `void` variable is not C. The emitter must emit the call as a bare statement when the result is `never` (or `void`), as it does for a `unit` result.

The fix gets a run test built from the `fn` reproducer, which does not depend on `ctl`. It fails to compile before the fix and passes after.
