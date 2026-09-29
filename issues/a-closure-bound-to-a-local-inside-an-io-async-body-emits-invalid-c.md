# A `=>` closure bound to a local inside an `io.async` body emits invalid C

**Severity:** S2 — a valid program is rejected by the C compiler; binding the same closure in a plain `fn` works

**Status:** open
**Found:** 2026-09-30, writing fixture cases for the await-site fusion
verdicts (`plans/backlog/ASYNC_AWAIT_SITE_FUSION.md`, F1).
**Reproducer:** `issues/repros/a-closure-bound-to-a-local-inside-an-io-async-body.yo`

## Symptom

```rust
g :: (fn(io : Io, n : i32) -> Impl(Future(i32)))(
  io.async((e : Io) => {
    (f : Impl(Fn(v : i32) -> i32)) = (v => (v + n));
    f(n)
  })
);
```

`yo compile` (v0.2.45 seed, and a compiler built from the phase-5 branch
#1002) fails in clang:

```
error: use of undeclared identifier 'n'
```

The same body in a plain `fn` (`h` in the repro) compiles and runs.

With an await in the block (`r := e.await(leaf(e, n), e);` before the
binding), the block becomes a state machine and fails differently:

```
error: initializing 'void *' with an expression of incompatible type '__yo_t_…'
error: assigning to 'void *' from incompatible type '__yo_t_…'
```

## What the emitted C shows (measured)

The `io.async` closure's function (no-await variant):

```c
static inline int32_t closure_yo_id_…(void* closure_context, __yo_t_… e) {
  __yo_t_A __capture_closure_…_1 = (__yo_t_A){ .n = n };   // (1) reads `n` before it is declared
  void* f = __capture_closure_…_1;                          // (2) the local is typed void*
  int32_t n = ((__yo_t_B*)closure_context)->n;              //     the capture prologue comes after
  …
  int32_t t = (((int32_t (*)(int32_t))f)((int32_t)(n)));    // (3) called as a bare fn pointer, no context
```

The plain-`fn` twin emits `__yo_t_A f = __capture_closure_…;` and calls the
closure with its context. So three things go wrong inside the `io.async`
body, where the plain `fn` gets all three right:

1. the nested closure's capture-struct initializer is emitted before the
   enclosing closure's capture prologue;
2. the local's C type is `void*` instead of the capture struct;
3. the call is lowered as a call through a function pointer instead of a
   closure call.

(2) and (3) both read the local as an unresolved `Impl(Fn(...))` rather than
the closure type the binding resolves it to, so a single missing resolution
may explain both. That is reasoned, not measured.

## Related

`issues/impl-fn-param-captured-by-an-async-block-is-not-in-the-capture-struct.md`:
also a closure built inside an async block whose capture initializer reads
a bare name. The shape is different: there the captured name is the
`Impl(Fn)` parameter. It may share a root with (1).

## Workaround

Build the closure outside the `io.async` body and capture it, or pass it as
an argument.
