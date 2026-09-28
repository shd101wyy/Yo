# An async closure returning a cond tail drops the awaited value at codegen

Status: OPEN (reproduced on the unmodified v0.2.45 seed, 2026-09-28; found
while building a timing demo during the Windows async-I/O performance pass).

## Reproducer (tmp/min_repro.yo)

```rust
pragma(Pragma.AllowUnsafe);
{ sleep } :: import("std/time/sleep");
{ Duration } :: import("std/time/duration");
{ printf } :: import("std/libc/stdio");

main :: (fn(io : Io) -> unit)({
  task := io.async((io : Io) => {
    io.await(sleep(Duration.from_millis(i64(1)), io), io);
    cond(
      true => i32(7),
      true => i32(0)
    );
  });
  io.spawn(task, io);
  v := io.await(task, io);
  unsafe(printf("v = %d\n", v));
});
export(main);
```

## Verbatim error

```
tmp/min_repro.c:6943:22: error: expected expression
 6943 |   printf("v = %d\n", );
 1 error generated.
yo: error: compile: C compiler failed (exit 1) on tmp/min_repro.c
```

## Root cause (by inspection)

The task's RESULT VALUE never makes it into the await's continuation: the
emitted `printf` receives an EMPTY argument list, so the binding site for the
awaited value is emitted as nothing at all — the state machine's result slot
is read nowhere. Type checking accepts the program (the cond arms agree on
`i32`), and the failure surfaces only in the C compile.

## Trigger boundary

- `return(i32(7));` in place of the cond tail: WORKS (`v = 7`).
- The cond tail after the await: broken — the cond-tail VALUE of an
  `io.async` closure is lost on the await path.
- Likely a variant of the fixed cond-value family
  (`issues/fixed/async-cond-arm-tail-value-lost-after-second-await.md`,
  `issues/fixed/async-branch-value-discarded-cond-match-tail-and-binding.md`):
  those fixed arms with a SECOND await; a single await followed by a plain
  cond tail still loses the value.

## Impact

Any `io.async` task that ends in a value-producing `cond` (a very common
"match on outcome and finish" shape) and whose result is consumed produces
broken C — a hard compile error today (empty argument), so it cannot
silently misbehave, but the program is unbuildable.
