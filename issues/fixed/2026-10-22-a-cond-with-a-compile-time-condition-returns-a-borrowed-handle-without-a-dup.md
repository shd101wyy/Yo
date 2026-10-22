# A `cond` with a compile-time condition returns a borrowed handle without a dup

**Severity:** S1 — safe code returning a borrowed reference-counted handle
through a `cond` whose first live arm is compile-time true gets no balancing
reference count, so the caller and the original owner both release it: a
heap-use-after-free in generated code, and a glibc abort at `--optimize 2`.

**Status:** fixed (2026-10-23, branch `fix/compile-time-cond-borrowed-handle-dup`). **Found:** 2026-10-22 by the V2b B8 flip probe
(`plans/handover/VBD_B8_PROBE_CENSUS_2026-10-22.md`), while trying a
`cond(Type.impls(T, Copy) => p.*, true => …)` accessor stand-in. The bug is
older than the flip: develop `e30c0d8ed` and the v0.2.68 seed both have it,
and it needs no flipped type.

## Reproducer

`issues/repros/2026-10-22-a-cond-with-a-compile-time-condition-returns-a-borrowed-handle-without-a-dup.yo`:

```yo
{ println } :: import("std/fmt");
R :: ref(struct(n : i32));
rd :: (fn(q : &R) -> R)(
  cond(
    false => q,
    true => q
  )
);
main :: (fn() -> unit)({
  r := R(n : i32(5));
  x := rd(&r);
  println(&x.n);
  println(&r.n);
});
export(main);
```

| Binary | `--sanitize address --allocator system` | `--optimize 2` |
| --- | --- | --- |
| v0.2.68 seed | `heap-use-after-free` | `tcache_thread_shutdown(): unaligned tcache chunk detected`, rc 134 |
| develop `e30c0d8ed` | `heap-use-after-free` | same |

The same function is correct when the condition is a runtime value
(`cond(k => q, true => q)` with `k : bool`) and when the body is a bare `q`.
`cond(true => q)`, `cond(false => q, true => q)` and
`cond((1 == 2) => q, true => q)` all fail. The read need not be through a
borrow: `p.*` with `p : *R` in an `AllowUnsafe` file fails the same way,
including in a generic function whose condition is `Type.impls(T, Copy)`.

The emitted C of `rd` shows that no `__yo_incr_rc` is applied:

```c
static inline R* rd(R* __yo_v_q) {
  R* tmp = __yo_v_q;
  return tmp;
}
```

With `k => q` each arm instead reads
`tmp = q; __yo_incr_rc(tmp); result = tmp;`.

## Root cause

`generate_cond_expression` (`src/codegen/exprs/cond.yo`) has two emission
paths. The full if/else chain goes through `_emit_value_arm`, which applies
the arm's recorded deferred `___dup`s, so a borrowed or shared arm value gets
its balancing count. The collapse path (`can_opt`: the first arm that is not
compile-time false is compile-time true) generates the arm value with
`_call_generate_expr` and assigns it straight to the result temp. It never
applies the arm's deferred dups. Its comment covers drops only ("The collapsed
arm's value node drops").

## Fix direction

Apply the collapsed arm's deferred dups the way `_emit_value_arm` does
(including its stale-temp fallback) before the assignment. A regression test
belongs in `tests/` and should run under ASan: the repro above, a generic
variant whose condition is `Type.impls(T, Copy)`, and a `p.*` variant.

## Fix

The hypothesis held. The evaluator records the arm's `___dup` the same way
for a collapsed and a branching `cond`: the arm is a block whose tail names a
borrowed or outer-frame handle, so the arm's begin-tail pass puts the dup on
the arm value's `ExprInfo`. Only codegen differed. A `cond` that branches
emits each value arm through `_emit_value_arm`, which applies that dup. The
collapse in `generate_cond_expression` generated the value bare. A block arm
was already correct in both paths, because the block's own generator applies
its final expression's dups.

`src/codegen/exprs/cond.yo` now moves the dup-carrying arm generation out of
`_emit_value_arm_body` into `_generate_dup_arm_value`. The helper declares the
arm's eval temp, applies the dup (including the fallback for a stale dup
temp), and returns the C expression that holds the counted value. The
if/else chain and the collapse both call it. In the collapse, the `cond`
adopts the arm's eval temp as its own result name, so the helper has often
declared `tv` already. The collapse then assigns the counted value to `tv`
without declaring it a second time (`tv_declared_by_arm`). For the
reproducer, `rd` is now:

```c
static inline R* rd(R* __yo_v_q) {
  R* tmp = __yo_v_q;
  ((R*)__yo_incr_rc((void*)(tmp)));
  tmp = tmp;
  return tmp;
}
```

(The self-assignment is the collapse path's existing adopted-temp
assignment; it was there before the fix.)

Regression tests are in `tests/rc.test.yo`: "a compile-time-collapsed cond
dups the borrowed handle it returns" and "a compile-time-collapsed cond in a
binding dups the local it names". They cover `false => q, true => q`,
`cond(true => q)`, a folded `(1 == 2)` condition, the runtime control, a
raw-pointer `p.*`, a generic accessor on `Type.impls(T, Copy)` at a `ref`
type and at `i32`, and a `cond` bound to a local. Each asserts `ref_count`,
so the test fails without ASan too. Under the v0.2.68 seed both tests fail
their first `ref_count` assertion.
