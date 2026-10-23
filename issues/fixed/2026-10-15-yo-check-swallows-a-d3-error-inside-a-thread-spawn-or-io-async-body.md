# `yo check` swallows a D3 error inside a `Thread.spawn` or `io.async` body

**Severity:** S3 — `yo check` passes (thread) or reports an unrelated E0610 (task) for a write through an `Arc` that `yo compile` rejects only as a hollow closure body.

**Status:** FIXED 2026-10-17 (#1425). Found 2026-10-15 while fixing
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

## Cause (suspected at filing; superseded by "Root cause" below)

The same class as `issues/fixed/ftt-stub-in-live-closure-falls-off-non-void-function.md`:
a closure argument to a generic `sink`/`FnOnce` parameter is evaluated by a
definition-time trial whose errors are recorded and swallowed, and nothing
reports them at the end of `check`. That doc covers the `io.async` case for
E0610-style errors; this one adds `Thread.spawn` and safety rules (D3, and by
the same path D1).

## Direction

Report a swallowed trial error once no later evaluation completes the body
(the open half of the doc above), so `check` gives the rule's own message.

## Root cause

Not D3, not `Thread`, not `io.async`: any error in a closure whose parameter
is `Io` was swallowed. `(x : Io) => { y := i64(1); y.no_such_method(); () }`
passed to a plain `Impl(FnOnce(x : Io) -> unit)` parameter made `check` exit
0, while the same body with `(x : i64)` reported the error.

`src/evaluator/values/anonymous_function.yo` re-raises a closure body's
swallowed trial error (Channel 3) only when `body_params_concrete` holds:
no generic binder, no `SomeT` in any parameter type. That test reused the
defer scan, which asks `get_all_some_types`. `_collect_some_types_into` walks
a struct's fields and a `fn` type's binders, and the prelude's `Io` is a
struct of four generic `fn` fields (`async : fn(generic(T, E), …)`), so `Io`
"contained" `SomeT`s and every `(io : Io) =>` closure counted as abstract.
The body was still evaluated (every `=>` closure is forced for codegen), its
error was kept for codegen's hollow-body report, and `check` passed. Inside
`comptime_expect_error` the propagate channel (Channel 2) re-raised it, which
is why the regression tests saw the D3 message.

The named-fn path never had this hole: it defers on
`type_contains_some_type_for_codegen_param` (calls/function_type.yo), which
skips `fn`-typed struct fields, so `main :: (fn(io : Io) -> unit)` bodies
were always checked.

## Fix

`body_params_concrete` now judges each parameter the way the named-fn path
does: a parameter is abstract when its type is an unresolved `SomeT` or
`type_contains_some_type_for_codegen_param` finds one (a resolved `SomeT`,
io.async's `e : E`, is judged by its resolution). `should_defer_body` is
unchanged, so no body is evaluated that was not before; only the re-raise of
an already-swallowed error reaches more closures.

Tests: three cli-cases running `yo check`, each failing under develop's
binary (`yo-dev-5425cd7bf`, measured with the harness):
`check-thread-spawn-body-d3-error-is-reported` (D3 field write in a
`Thread.spawn` body; develop: NO-GOLDEN, rc 0 and no match),
`check-io-async-body-d3-error-is-reported` (D3 `take()` in an annotated
`io.async` block; develop: GOLDEN-DIFF, the cascaded E0610), and
`check-io-parameter-closure-body-error-is-reported` (an E0610 in a closure
with an `Io` parameter, the general case; develop: NO-GOLDEN, rc 0).

`compile` agrees: `compile --skip-c-compiler` on all three repros now stops in
the evaluator with the body's own message (the thread repro used to reach the
C compiler's error-attribute stub). `compile-io-async-body-swallowed-error` was re-recorded:
the same E0601 and span, now raised by the evaluator before main's
unused-variable warning is printed.

Still open at the time (closed 2026-10-23), recorded in `issues/fixed/ftt-stub-in-live-closure-falls-off-non-void-function.md`:
an unannotated `(e) =>` `io.async` closure whose row is not yet resolved when
the closure is evaluated keeps the swallow.

Verification (tree build of this branch): `check ./src` 278/278,
`check ./std` 172/172; `yo check` on all 330 language test files is unchanged
except the intended cases (the one failure, `tests/spec/verify_match_patterns.test.yo`,
fails identically on develop); `parallelism_soundness` 18, `closure_capture_list` 41,
`thread` 23, `thread_safety` 4, `send_sync` 15, `async_mutex` 5,
`cross_thread_wake` 8, `type_soundness` 71, `move_only` 55, `arc` 18,
`atomic_object` 21, `rc` 107, `async_await` 281; cli-diff 400 PASS plus the
re-recorded case.
