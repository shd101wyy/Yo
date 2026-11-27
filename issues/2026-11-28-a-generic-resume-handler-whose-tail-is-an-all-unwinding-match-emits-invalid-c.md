# A generic-resume handler whose tail is an all-unwinding `match` emits invalid C

**Severity:** S2. `yo check` accepts a valid program, but the C compiler rejects the code `yo compile` emits.

Found 2026-11-28 by the v81-ctl-b lane (VERDICTS-89 PR B probes). It reproduces with the v0.2.80 seed and with the PR B tree. It is not caused by PR B: PR B only checks handler bodies and changes no codegen.

## Reproducer

```yo
{ println } :: import("std/fmt");
Exn :: struct(
  throw : (ctl(generic(ResumeType : Type), code : i32) -> ResumeType)
);
op :: (fn(exn : Exn) -> i32)({
  x := exn.throw(i32(1));
  x
});
run :: (fn() -> i32)({
  exn := Exn(throw : (err -> match(err, i32(1) => unwind(i32(1)), _ => unwind(i32(2)))));
  op(exn)
});
main :: (fn() -> unit)({
  println(`done ${run()}`);
});
export(main);
```

```text
$ yo compile tmp/fixme.yo --allocator system -o fixme
fixme.c:3089:10: error: incompatible integer to pointer conversion returning 'int32_t' (aka 'int') from a function with result type 'void *' [-Wint-conversion]
yo: error: compile: C compiler failed (exit 1)
```

The same handler written as `cond((err == i32(1)) => unwind(i32(1)), true => unwind(i32(2)))` compiles and prints `done 1`.

## Root cause

When every arm of the `match` carries control flow, the evaluator types the `match` with the arms' value type (`_arm_result_type` over the `unwind` operand, `i32`) instead of `never`. Codegen then materializes the handler's tail into an `int32_t` temp. After the `__yo_abort();  // unreachable: every arm of this match diverges` trap, it emits `return <temp>;` in the handler, which is lowered as `void* fn(...)`. The line is dead, but the C is ill-typed:

```c
  __yo_abort();  // unreachable: every arm of this match diverges
  return _file____tmp__temp_45660325246715182010;
  return (void*){0};  // implicit unit resume (ctl handler fall-through)
```

The `cond` path does not emit the temp. A fix should either give the all-diverging `match` the type `never` (as `cond` does for its never arms), or have the handler tail emitter skip the `return <temp>` of a diverging tail in a `ctl_generic_ret` handler. The test that fails before the fix is the reproducer as a run case in `tests/algebraic-effects.test.yo`.
