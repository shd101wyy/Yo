# Comparing a c_include-typed integer against a Yo int fails to transpile

**Status: OPEN (workaround in place). Found 2026-08-23 while adding
`BufWriter`'s Dispose flush (std S0 C12).**

## Symptom

`yo check` accepts this, but codegen emits a `// Failed to transpile`
comment in condition position, which the C compiler then rejects
(`expected expression`):

```rust
{ write } :: import("std/libc/unistd");   // write : fn(...) -> ssize_t
n := unsafe(write(int(fd), *(void)(p), count));
if(n <= isize(0), { ... });               // FTT: "n <= isize(0)"
```

Emitted C:

```c
ssize_t n = _file..._9037;
if (// Failed to transpile n <= isize(0)) {
```

`ssize_t` here is an opaque `Type` exported from a `c_include(...)` block.
Ordering comparisons between such a value and a Yo integer literal do not
resolve to an emitter. Note this is exactly the class `yo check` cannot see
(evaluator-only); it surfaced as a C compile error in a test batch — and in
a batch context an FTT like this would void the whole batch if the
`__yo_user_main` marker gate did not exist.

`std/env.yo`'s Linux arm compares `readlink`'s result with `n < isize(0)` —
that arm is comptime-pruned on macOS, so it is only ever compiled on Linux
legs and may have the same latent problem (or `<` may work where `<=`
doesn't; not yet isolated).

## Workaround (what std does now)

Cast the C-typed value to a Yo integer at the binding site; casts DO emit
correctly (`((int64_t)(n))`, `((size_t)(n))`):

```rust
n := i64(unsafe(write(int(fd), *(void)(p), count)));
if(n <= i64(0), { ... });
```

## Real fix

Codegen's binary-comparison lowering should treat c_include integer type
aliases as their underlying integer (they are plain C typedefs — the
comparison is directly emittable). Minimal repro: bind any
`ssize_t`-returning libc call and compare `<=` against `isize(0)` in a
compiled (not just checked) program.
