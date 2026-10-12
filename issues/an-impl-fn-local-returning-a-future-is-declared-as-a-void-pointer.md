# A typed `Impl(Fn(...) -> Impl(Future(...)))` local holding a closure is declared `void*`

**Severity:** S2 — a valid program fails in the C compiler
(`initializing 'void *' with an expression of incompatible type`).

Found by the adversarial review of the §3.13 A2 change, 2026-10-12. It
predates A2: develop (`731ddd078`) fails the same way.

## Repro

```yo
{ println } :: import("std/fmt");
{ yield } :: import("std/async");
main :: (fn(io : Io) -> unit)({
  (mk : Impl(Fn(k : i32, io : Io) -> Impl(Future(i32, Io)))) = (
    (k : i32, io : Io) => io.async((io : Io) => {
      io.await(yield(io), io);
      k
    })
  );
  println(&io.await(mk(i32(42), io), io));
});
export(main);
```

```text
error: initializing 'void *' with an expression of incompatible type '__yo_t_3966734227439989520' (aka 'struct __yo_t_3966734227439989520_struct')
```

The C declares the local `void* __yo_v_mk = (__yo_t_…){};` (the closure's
empty capture struct) and then calls it through a function-pointer cast
(`((… (*)(int32_t, …))__yo_v_mk)(…)`) instead of the closure's impl function
with `&(capture)` as its context. The same shape with a non-future result
(`Impl(Fn() -> i32)`) is a capture struct and a static closure call, and
passing the closure to a generic `Impl(Fn(...) -> Impl(Future))` parameter
instead of binding it to a local works (the A2 lent-copy path through a
closure frame prints 42 that way).

## Analysis so far

The local adopts the closure literal's type at its binding
(`src/evaluator/exprs/assignment.yo`, "everything else deliberately adopts
rhs_type"). Codegen then lowers that type to `void*` rather than the capture
struct, and the call site misses `impl_closure_call_map` (keyed by the
callee's concrete struct id, `src/codegen/exprs/other_fn_call.yo`'s "Piece C")
and falls back to the function-pointer cast. The difference from the working
`Impl(Fn() -> i32)` shape is the closure's result, an unresolved
`Impl(Future(...))` SomeT; where the closure-typed local's C type is chosen
has not been pinned down yet.

## Workaround

Pass the closure to a generic `Impl(Fn(...) -> Impl(Future(...)))` parameter,
or name the function (`mk :: (fn(k : i32, io : Io) -> Impl(Future(i32, Io)))(...)`).
