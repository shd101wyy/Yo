# A `=>` closure bound to a local inside an `io.async` body emits invalid C

**Severity:** S2 — a valid program is rejected by the C compiler; binding the same closure in a plain `fn` works

**Status:** fixed 2026-09-30
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

## Root cause

Three causes. The first two were measured; the third was read off the code
and confirmed by the fix.

- **(2) and (3): the io.async-argument flag leaked into the closure's body.**
  `ctx.is_inside_io_async_call` is set around `io.async(...)`'s argument
  (`calls/function.yo`, `calls/helper.yo` Step 7) to mark that closure LITERAL.
  `create_function_body_evaluation_context` copied it into the closure's BODY
  context, so every closure written inside the body also read as "the io.async
  closure". Such a closure skips binding its `Impl(Fn)` to the capture type
  (`values/anonymous_function.yo`, the `final_lambda_ty` wrapper resolution),
  which is the step that makes `f` the capture struct, and a call to it a
  closure call. It also skips the owning temp for a reference-typed capture.
  Unresolved, `f` lowered to `void*` and was called as a function pointer.
  (Reasoned from the three flag readers; confirmed by the fix.)
- **(1), part a: capture initializers did not read through the enclosing
  closure.** `closures.yo` initialized a capture field through the state-machine
  mapping, and otherwise from the bare C name. It never read through the
  enclosing closure's `closure_context`. `async.yo` had two more copies of this
  resolution, each in a different order. (Measured: in a plain closure,
  `{ .n = n }` with `n` a capture of the enclosing closure.)
- **(1), part b: captures did not propagate outward.** A name read only inside
  the nested closure was tracked in that closure's body context alone. The
  enclosing closure never captured it, and its own capture struct was empty
  (`(__yo_t_…){}`). (Measured with `YO_DEBUG_CAPTURE=1`.)

The late `int32_t n = ((cap*)closure_context)->n;` line came from the
function-pointer call path (3), which materializes its argument. Once the call
goes through the closure path, the line is gone.

## Fix

- `src/evaluator/context.yo`: a function body's evaluation context starts with
  `is_inside_io_async_call` false. A nested `io.async(...)` call sets it again
  for its own argument.
- `src/evaluator/values/anonymous_function.yo`: after a closure's body is
  evaluated, its captures are tracked again against the defining context. The
  tracker's own filters drop the enclosing body's locals and parameters.
- `src/codegen/exprs/atom.yo`: `captured_value_source_code` is the one rule for
  reading a captured name where a capture struct is built. In order: an in-scope
  C local, a state-machine field, the enclosing closure's `closure_context`,
  then the C name. `closures.yo` (through its resolver hook) and both capture
  sites in `async.yo` use it.

## Verification

- The repro prints `result: 2 6` with a tree-built compiler, and fails on the
  v0.2.46 seed.
- `tests/closure_inside_io_async.test.yo`: 7/7 pass after the fix. On the
  v0.2.46 seed the batch fails to compile, and 0 of 7 tests run. The cases:
  - a sync-future closure local capturing a parameter, and one that is
    capture-free;
  - a state machine capturing a parameter and a local;
  - a capture-free closure across two awaits;
  - a `String` capture;
  - a closure nested in a plain closure;
  - the `Impl(Fn)` parameter shape of
    `issues/fixed/impl-fn-param-captured-by-an-async-block-is-not-in-the-capture-struct.md`,
    which this also fixes.
- Probes where `n` is read only in the nested closure: a plain closure (10),
  a sync io.async (6), a state machine (6), and three-deep nesting (10). All
  print the expected value.

## Related

`issues/fixed/impl-fn-param-captured-by-an-async-block-is-not-in-the-capture-struct.md`:
the same root as (1), part b. The io.async block read an `Impl(Fn)` parameter
only through an inner closure, so it never captured it. Fixed by the same
change.

