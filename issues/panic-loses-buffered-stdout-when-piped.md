# A panic loses everything the program printed to a piped stdout

**Severity:** S2 — output written before a panic silently disappears whenever stdout is a pipe or a file (CI logs, `build run`, test harnesses), which hides exactly the context a failing run needs
**Found:** 2026-09-29, recording `tests/cli-cases/arena-deinit-with-live-blocks-panics` for `plans/EXPLICIT_ALLOCATORS.md` P0.

## Reproducer

```rust
{ println } :: import("std/fmt");
{ panic } :: import("std/assert");
main :: (fn() -> unit)({
  println("before the panic");
  panic("boom");
});
export(main);
```

```
$ ./prog            # a terminal: stdout is line-buffered
before the panic
boom
$ ./prog | cat      # a pipe: stdout is fully buffered
boom
```

The `println` line is gone from the piped run. rc is 134 (SIGABRT) either way.

## Cause

`src/codegen/exprs/panic.yo` lowers `panic(...)` / `__yo_panic(...)` to
`fprintf(stderr, ...)` followed by `abort()`. `println` writes through C
stdio, which fully buffers stdout when it is not a terminal, and `abort()`
does not flush stdio buffers. Whatever `println` had buffered is discarded.

## Expected

The panic path flushes stdout before writing its message and aborting, so a
piped run shows the same lines, in the same order, as a terminal run.
