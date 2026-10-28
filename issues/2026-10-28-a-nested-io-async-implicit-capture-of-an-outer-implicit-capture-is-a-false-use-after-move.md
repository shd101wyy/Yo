# A nested `io.async`'s implicit capture of a move-only value the outer `io.async` captures implicitly is a false E0901

**Severity:** S3: a valid program is rejected. The workaround is a capture
list on the outer future (`io.async({ b }(io : Io) => …)`).

> Found 2026-10-28 while reducing
> `issues/fixed/2026-10-28-a-nested-io-async-implicitly-capturing-a-moved-capture-is-dropped-twice.md`.
> Pre-existing on develop `c847d0b76`.

## Reproducer

```yo
{ assert } :: import("std/assert");
{ sleep } :: import("std/sys/timer");
main :: (fn(io : Io) -> unit)({
  b := box(u64(5));
  outer := io.async((io : Io) => {
    inner := io.async((io : Io) => {
      io.await(sleep(u64(1)), io);
      b.* + u64(1)
    });
    io.await(inner, io) + u64(1)
  });
  assert(io.await(outer, io) == u64(7), "both state machines ran");
});
export(main);
```

```
error[E0901]: use of moved value: `b`
  --> repro.yo:5:31     (the outer closure's `=>`)
note: value moved here
  --> repro.yo:6:33     (the inner closure's `=>`)
```

## Suspected cause (not verified)

The error positions suggest that the outer closure's body is evaluated before its captures are moved, and
the body's inner closure moves the outer scope's `b` directly (the body reads
the enclosing scope's binding, not a capture yet). When the outer closure's
capture of `b` is then taken, `b` is already consumed at the inner site. The
one move is counted twice. The place to look is
`generate_captured_variable_dup_expressions` (`src/evaluator/utils/closure.yo`):
a capture whose `consumed_at_token` lies inside the closure's own body is the
same move.
