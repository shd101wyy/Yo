# A local stored in a temporary passed by value is freed by the callee

**Severity:** S1 (a use-after-free in safe code on a shape users write without thinking:
`log.set_sink(dyn(r))` and then reading `r`; silent at compile time)

Filed 2026-10-28, found by B13 (decision 7 Generation B, branch `vbd/b13-dyn-gen-b`) when
`std/log.set_sink` started taking its sink by value: `tests/log_sink_env.test.yo` failed four
tests with an AddressSanitizer heap-use-after-free. **Pre-existing**: the reproducer below fails
the same way on a compiler built from `c847d0b76` (develop before B13).

## Reproducer

```yo
{ String } :: import("std/string");
{ ArrayList } :: import("std/collections/array_list");
{ println } :: import("std/fmt");
Rec :: ref(struct(lines : ArrayList(String)));
H :: struct(r : Rec);
take_h :: (fn(h : H) -> unit)({
  o := Option(H).Some(h);
});
main :: (fn() -> unit)({
  r := Rec(lines : ArrayList(String).new());
  take_h(H(r : r));
  println(r.lines.len()); // heap-use-after-free: take_h freed r
});
export(main);
```

`yo compile repro.yo --sanitize address --allocator system` and run: ASan reports a
heap-use-after-free in `main`. The `dyn(r)` spelling (`f(dyn(r))` to a `d : Dyn(Trait)`
parameter) fails identically. A `String` field does not (a value type with counted fields is
never a pair candidate), and a `ref` holding a `ref` container hides it behind the cycle
collector's deferred release.

## Root cause

The dup/drop pair optimizer (`_optimize_dup_drop_pairs`, `src/evaluator/exprs/begin.yo`)
cancelled `r`'s dup into the temporary container (`H(r : r)`, `dyn(r)`) against `r`'s scope-end
drop: a move of `r`'s only count into the container. That is sound only while the container
outlives `r`'s uses (the AGENTS.md pitfall). A temporary passed straight to a by-value
parameter is moved into the callee, which drops it at its return, before the caller's later
reads. This is the same hazard as
`issues/fixed/a-local-stored-in-a-struct-field-is-dangling-after-the-container-dies.md` (a
container in a nested block) and as the `FnOnce` capture struct (decision 37), with the call as
the inner scope.

## Fix

The argument-side ownership rule (`calls/helper.yo`) marks the dups taken while building a
temporary argument that a by-value parameter takes (`_mark_moved_temp_container_dups`;
`mark_moved_container_dup`, `src/expr_info.yo`). It marks only the dups taken at the caller's
own depth. The optimizer's nested-container gate refuses to cancel a marked dup, as it refuses
an `FnOnce` capture dup. The local keeps its dup and its drop, and the callee releases what the
container took.

Tests in `tests/rc.test.yo` use the Drop counter as the oracle. A temporary struct and a
temporary `Dyn` passed by value while the local is read again fail before the fix and pass after
it. A temporary `Dyn` taking a local that is not read again is disposed exactly once (no leak,
no double drop). `tests/log_sink_env.test.yo` passes 8/8.
