# A compile-time-collapsed `cond` whose arm is a closure literal emits invalid C

**Severity:** S2 — `cond(true => (() => x.n))` (a `cond` whose first live
condition is compile-time true and whose arm is a capturing closure literal)
does not build: the C compiler rejects the generated program. The same
closure without the `cond` builds and runs. The workaround is to drop the
collapsed `cond`.

**Found:** 2026-10-23, in the adversarial review of
`issues/fixed/2026-10-22-a-cond-with-a-compile-time-condition-returns-a-borrowed-handle-without-a-dup.md`.
develop `6dee22187` and the review branch fail identically. `yo check` reports
nothing.

## Reproducer

`issues/repros/2026-10-23-a-compile-time-collapsed-cond-whose-arm-is-a-closure-literal-emits-invalid-c.yo`:

```yo
{ println } :: import("std/fmt");
R :: ref(struct(n : i32));
f :: (fn(q : &R) -> Impl(Fn() -> i32))({
  x := q;
  cond(true => (() => x.n))
});
main :: (fn() -> unit)({
  r := R(n : i32(5));
  e := f(&r);
  println(e());
});
export(main);
```

```text
error: initializing '__yo_t_…' (aka 'struct __yo_t_…_struct') with an expression of incompatible type 'int32_t (void *)' (aka 'int (void *)')
```

The emitted body assigns the closure's function symbol to the closure-struct
temp:

```c
__yo_t_… __yo_scope_ret = closure_yo_id_…;
```

A binding has it too: `(d : Impl(Fn() -> i32)) = cond(true => (() => r.n));`
fails with the same error. The control `(() => x.n)` as the plain tail of `f`
builds and prints 5.

## Analysis

`generate_cond_expression`'s compile-time collapse (`src/codegen/exprs/cond.yo`)
takes the arm's generated C expression as the cond's value. For a closure
literal that expression is the bare function symbol; the path that builds the
closure value (the struct holding the function pointer and the captures) is
not reached, as it is when the closure is a block's tail. The fix is to build
the closure struct for a closure-literal arm in the collapse, as the tail path
does, with a test in `tests/closure_capture_cond_arm.test.yo`.
