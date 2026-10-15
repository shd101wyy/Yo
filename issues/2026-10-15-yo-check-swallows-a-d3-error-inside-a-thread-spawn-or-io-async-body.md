# `yo check` swallows a D3 error inside a `Thread.spawn` or `io.async` body

**Severity:** S3 — `yo check` passes (thread) or reports an unrelated E0610 (task) for a write through an `Arc` that `yo compile` rejects only as a hollow closure body.

**Status:** open. Found 2026-10-15 while fixing
`issues/fixed/2026-10-15-d3-trusts-every-mutator-defined-in-a-pragma-file-so-std-writes-through-an-arc.md`.

## Symptom

Measured with the tree-built compiler of `fix/d3-trust-by-mutation-mask`
(develop `31ef8d7a3` plus that fix). In a file without a pragma:

```yo
{ Thread } :: import("std/thread");
W :: struct(o : Option(i64));
main :: (fn() -> unit)({
  a := arc(W(o : Option(i64).Some(i64(1))));
  b := a;
  t := Thread(unit).spawn((io : Io) => {
    b.*.o = .None; // D3: a write through an Arc
    ()
  });
  t.join();
});
export(main);
```

- `yo check` exits 0. The same write in a closure bound to an
  `Impl(Fn() -> unit)` local, or in `main` itself, is the D3 error.
- `yo compile` fails in the C compiler: `call to 'closure_yo_id_…' declared
  with 'error' attribute: … its definition-time evaluation failed and was
  swallowed`. The D3 message never appears.
- The `io.async` spelling (`task := io.async({ b }(io : Io) => { _t :=
  b.*.o.take(); () }); h := io.spawn(task, io); _x := h.await(io);`) makes
  both `check` and `compile` report `E0610: No method "await" on
  JoinHandle(T)`, a cascade of the swallowed body, again without the D3
  message. The body's error is the real one.

Inside `comptime_expect_error` (the regression tests in
`tests/parallelism_soundness.test.yo`) the D3 message IS reported, so the
rule fires; only the definition-time trial of the spawn/async closure argument
loses it.

## Cause (suspected)

The same class as `issues/ftt-stub-in-live-closure-falls-off-non-void-function.md`:
a closure argument to a generic `sink`/`FnOnce` parameter is evaluated by a
definition-time trial whose errors are recorded and swallowed, and nothing
reports them at the end of `check`. That doc covers the `io.async` case for
E0610-style errors; this one adds `Thread.spawn` and safety rules (D3, and by
the same path D1).

## Direction

Report a swallowed trial error once no later evaluation completes the body
(the open half of the doc above), so `check` gives the rule's own message.
