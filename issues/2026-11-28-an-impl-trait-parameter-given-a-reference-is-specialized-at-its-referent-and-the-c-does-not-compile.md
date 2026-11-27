# An `Impl(Trait)` parameter given a reference is specialized at its referent, and the C does not compile

**Severity:** S2 — a valid program is rejected by the C compiler. `show :: (fn(v : Impl(ToString)) -> usize)(...)`
called with a reference (`r := &s; show(r)`, or `show(&s)` once a lend solves the binder) checks clean, but the
specialization's C signature takes the referent by value while its body reads the parameter as a reference.

- Filed: 2026-11-28 by the `v81-infer-first` lane, found by a VERDICTS-90 PR B test row (`bs_show(&i)` with
  `v : Impl(ToString)`).
- Reproduces with the v0.2.80 seed. The same call through a written binder,
  `(fn(generic(T : Type), v : T, where(T <: ToString)) -> usize)`, compiles and runs.

## Reproducer

```yo
{ String } :: import("std/string");
{ ToString } :: import("std/fmt");
{ println } :: import("std/fmt");
show :: (fn(v : Impl(ToString)) -> usize)(v.to_string().len());
main :: (fn() -> unit)({
  s := String.from("abc");
  r := &s;
  println(show(r).to_string());
  ()
});
export(main);
```

`yo check` is clean. `yo compile`:

```text
error: passing '__yo_t_15185865970621801032 *' (aka 'struct __yo_t_7520247465811473439_struct *') to parameter of incompatible type '__yo_t_15185865970621801032' (aka 'struct __yo_t_7520247465811473439_struct'); dereference with *
error: indirection requires pointer operand ('__yo_t_15185865970621801032' (aka 'struct __yo_t_7520247465811473439_struct') invalid)
```

With `i := i32(12); show(&i)` (or `r := &i; show(r)`) the specialization is
`yo_id_…_rtparam0__i32_ret_usize(int32_t __yo_v_v)`, called with `(int32_t)(&__yo_v_i)`, and its body calls
`ToString(&T)`'s `to_string` on `(*__yo_v_v)`.

## Root cause

Not located yet. The specialization's body is evaluated with `v` bound at `&i32` (it dispatches the blanket
`ToString(&T)` and dereferences `v`), but the runtime parameter type that keys and declares the specialization
(`compute_compile_time_signature`'s `rtparam0`, `src/evaluator/calls/helper.yo`) is the referent `i32`. The
written-binder form binds the binder from the argument's type and keys both the same way, so the disagreement is
in how the anonymous binder of an `Impl(Trait)` parameter is resolved for the specialization's runtime parameter.
