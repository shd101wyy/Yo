# A compile-time-collapsed `cond` whose arm returns releases the returned value

**Severity:** S1 — a `return(x)` in the arm of a `cond` whose first live
condition is compile-time true releases the returned reference-counted value
right before returning it: a heap-use-after-free in generated code for a
borrowed and an owned value alike.

**Status:** fixed (2026-10-23, branch `fix/compile-time-cond-borrowed-handle-dup`).
**Found:** 2026-10-23, in the adversarial review of
`issues/fixed/2026-10-22-a-cond-with-a-compile-time-condition-returns-a-borrowed-handle-without-a-dup.md`.
The v0.2.68 seed and develop `265faa941` both have it.

## Reproducer

`issues/repros/2026-10-23-a-compile-time-collapsed-cond-arm-return-releases-the-returned-value.yo`:

```yo
{ println } :: import("std/fmt");
R :: ref(struct(n : i32));
rd :: (fn(q : &R) -> R)({
  cond(true => return(q));
  q
});
main :: (fn() -> unit)({
  r := R(n : i32(5));
  x := rd(&r);
  println(&x.n);
  println(&r.n);
});
export(main);
```

`rd` was emitted as

```c
static inline R* rd(R* __yo_v_q) {
  ((R*)__yo_incr_rc((void*)(__yo_v_q)));
  R* tmp = __yo_v_q;
  // Drop local variables before early return
  __yo_decr_rc((void*)(tmp));
  return tmp;
}
```

The same happens for `cond(true => return(q), k => ())`, for
`if(true, return(q), ())`, and for an owned value
(`cond(true => return(R(n : 1)))` frees the fresh object before returning it).
A runtime condition (`cond(k => return(q), true => ())`) and a `match` arm are
correct. When the collapsed `cond` is the whole function body
(`(fn(q : &R) -> R)(cond(true => return(q)))`), the C did not compile: the
function's tail read the `cond`'s result temp, which nothing declared
(`use of undeclared identifier '_file____home_temp_…'`).

## Root cause

The evaluator (`src/evaluator/exprs/cond.yo`) consumes each runtime arm's
body temp after evaluating it (`consume_case_body_temp_var`): the arm's value
leaves through the arm. The compile-time collapse evaluates only the selected
arm and skipped that call when the arm ends in control flow. The temp that
holds the `return`'s value was therefore still owned by the enclosing block,
whose early-return drop list released it before the `return`.

The undeclared identifier is the codegen side of the same collapse
(`src/codegen/exprs/cond.yo`): the collapse skips the `cond`'s own temp
declaration because a value arm's temp is adopted, but a control-flow arm
declares no temp, and the `cond` still returned that name to its reader.

## Fix

The collapse's control-flow branch now calls `consume_case_body_temp_var`
on the arm body, as the runtime arms do. When the collapsed arm is control
flow, codegen declares the `cond`'s result temp if nothing declared it, as
the if/else chain does (the read is unreachable).

Regression tests in `tests/rc.test.yo`: "a compile-time-collapsed cond's
return arm keeps the returned value alive" (the shapes above, each asserting
`ref_count`); "a compile-time-collapsed cond's return arm in an async body
releases the body's locals" (an `io.async` body after an await: develop
crashes it with an ASan SEGV, and a standalone program leaks the body's
local); and "a compile-time-collapsed cond's break and continue arms after a
collapsed value in a loop body" (`cond(true => break)` in a `while`,
`cond(true => continue)` in a `for`, which develop failed with a
use-after-free). The first only fails to compile on develop; the other two
fail at runtime there.
