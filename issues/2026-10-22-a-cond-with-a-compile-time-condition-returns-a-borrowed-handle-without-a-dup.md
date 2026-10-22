# A `cond` with a compile-time condition returns a borrowed handle without a dup

**Severity:** S1 — safe code returning a borrowed reference-counted handle
through a `cond` whose first live arm is compile-time true gets no balancing
reference count, so the caller and the original owner both release it: a
heap-use-after-free in generated code, and a glibc abort at `--optimize 2`.

**Status:** open. **Found:** 2026-10-22 by the V2b B8 flip probe
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

## Root cause (hypothesis)

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
