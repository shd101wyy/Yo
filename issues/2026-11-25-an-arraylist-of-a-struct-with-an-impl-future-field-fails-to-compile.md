# An `ArrayList` of a struct with an `Impl(Future(T, E))` field fails to compile: `with_capacity_in`'s body is swallowed

**Severity:** S2 — a program `yo check` accepts fails at the C compiler (`call to '__yo_fs_…' declared with 'error' attribute: … failed to transpile`); no wrong code reaches a binary.

Filed 2026-11-25 by the dyn-future-reject lane. VERDICTS-80 measured this program running under ASan (`e1`, printing `42` and `1`) on a stage 1 of develop `78a71eae1` with the std of `13af89b04` minus #2072. On develop `b25971e82` it fails with both the tree binary of `fix/dyn-future-reject` and the v0.2.79 seed (tree std), so it is a regression between those std trees, likely #2072's std respelling. VERDICTS-81 (#2074) retracts the `Impl(Future(...))` struct field (AFA-5 rejects it, AFA-7 deletes `_future_field_upcast`), so the fix this program gets is that rejection; the doc records that the field already fails inside a list.

## Reproducer

```yo
{ println } :: import("std/fmt");
{ ArrayList } :: import("std/collections/array-list");
{ yield } :: import("std/async");
one :: (fn(io : Io) -> Impl(Future(i32, Io)))(io.async((io : Io) => i32(1)));
two :: (fn(n : i32, io : Io) -> Impl(Future(i32, Io)))(
  io.async({ n }(io : Io) => {
    io.await(yield(io), io);
    n + i32(1)
  })
);
Job :: struct(fut : Impl(Future(i32, Io)));
run :: (fn(sink(j) : Job, io : Io) -> i32)(match(j, Job(fut : f) => io.await(f, io)));
main :: (fn(io : Io) -> unit)({
  mut(jobs) := ArrayList(Job).new();
  jobs.push(Job(fut : one(io)));
  jobs.push(Job(fut : two(i32(41), io)));
  while(true, {
    match(
      jobs.pop(),
      .Some(j) => {
        v := run(j, io);
        println(&v);
      },
      .None => break
    );
  });
});
export(main);
```

```text
e1s.c:8444:74: error: call to '__yo_fs_7784696260198148062' declared with 'error' attribute: yo: the body of __yo_fs_7784696260198148062 failed to transpile — its definition-time evaluation failed and was swallowed (run yo check with YO_DEBUG_SWALLOW=1); this call would abort at runtime
```

The failing body is `ArrayList(Job).with_capacity_in(a, cap)`, called from `ArrayList(Job).new`'s `.Some(a)` arm. A single `Impl(Future)` field outside a list still works (`tests/async-await.test.yo`, "an Impl(Future) struct field is stored, reassigned and awaited").

## Root cause

Not determined. `YO_DEBUG_SWALLOW=1 yo check` prints several thousand trial-evaluation lines, and the one that kills `with_capacity_in` for `Job` was not isolated. The element type's field is an unresolved `SomeT` (`Impl(Future(i32, Io))`), the same shape that makes `ArrayList(Impl(Future(i32, Io)))` raise E0610 inside `std/collections/array-list.yo` (`issues/retired/2026-11-25-finish-or-retract-the-impl-future-slot-as-the-erased-future.md`).
