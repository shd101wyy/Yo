# A generic function whose tail call forwards `T` does not build for `T = unit`

**Severity:** S2 — a valid generic function whose tail is a call to another
generic function returning `T` fails to build when instantiated with `unit`: its
specialization's body is an abort stub, and the C compiler rejects the call to
it. The same function builds and runs for `i32`, `bool` and `String`. The
workaround is to bind the call first (`{ w := inner(v); w }`).

**Found:** 2026-10-24, writing `std/mem.yo` (V2b B6-0): `take` was first written
as `replace(dst, (T <: Default).default())`, and `take(&mut u)` on a `unit`
place did not build. develop `f1cfa553d` (tree binary) and the v0.2.68 seed fail
identically. `yo check` reports nothing.

## Reproducer

`issues/repros/2026-10-24-a-generic-tail-call-forwarding-t-fails-to-transpile-for-unit.yo`:

```yo
{ assert } :: import("std/assert");
inner :: (fn(generic(T : Type), v : T) -> T)(v);
outer :: (fn(generic(T : Type), v : T) -> T)(inner(v));
main :: (fn() -> unit)({
  a := outer(());
  assert(a == (), "unit forwards");
  b := outer(i32(3));
  assert(b == i32(3), "i32 forwards");
});
export(main);
```

```text
tmp/rp.c:2171:3: error: call to 'yo_id_9790509258933109713000000_unit_id_unit_ret_4230' declared with 'error' attribute: yo: the body of yo_id_9790509258933109713000000_unit_id_unit_ret_4230 failed to transpile — its definition-time evaluation failed and was swallowed (run yo check with YO_DEBUG_SWALLOW=1); this call would abort at runtime
yo: error: compile: C compiler failed (exit 1) on tmp/rp.c
```

Shapes measured (tree binary at `f1cfa553d`):

| `outer`'s body | `T = unit` | `T = i32` / `bool` / `String` |
| --- | --- | --- |
| `inner(v)` | fails | runs |
| `{ w := v; inner(w) }` | fails | runs |
| `{ w := inner(v); w }` | runs | runs |
| `inner` called directly from `main` with `()` | runs | runs |

A block-bodied variant (`{ v := (T <: Default).default(); replace(dst, v) }`)
emits invalid C instead of a stub: the forwarded call's result is declared
`void* tmp = <call returning void>` ("initializing 'void *' with an expression
of incompatible type 'void'").

## Root cause (where to look)

With `YO_DEBUG_SWALLOW=1` the outer `unit` specialization's call to `inner`
mints a specialization keyed on the outer function's ABSTRACT binder, outside
any definition-time trial:

```text
[abstract-spec] fid=yo_id_4921866227656231002000000_T_id_3786_ret_3785 trial=false
[ftt-stub] kind=unit fn=yo_id_13219955038284547467000000_unit_id_unit_ret_3786 site=tmp/probe_tu5.yo:1:45 spec=true recorded=false
```

Only a call in TAIL position fails, so the call's expected type matters: the
tail call is evaluated against the outer function's declared result `T` (a
SomeT), and `_funcval_infer_forall_ty` (`src/evaluator/calls/function.yo`)
binds a `unit`-typed argument to the EXPECTED param type whenever that is a
SomeT:

```yo ignore
((is_function_type(arg_ty) || is_fn_trait_type(arg_ty) || is_unit_type(arg_ty)) && is_some_type(exp_pt)) => exp_pt,
```

Its doc comment says the `unit` case is meant for definition-time evaluation
("or unit under def-eval"), where `unit` stands in for an unknown argument type,
but the arm is not gated on it. In a real specialization a `unit` argument is a
genuine `unit`, and binding `T` to the abstract SomeT instead leaves the callee
specialization abstract, so `should_skip_function_codegen` drops it and the
caller degrades to the `// Failed to transpile` stub. Confirmed by the fix
below.

## Fix

**Status:** FIXED 2026-10-24 (`fix/generic-tail-forward-unit`).

`_funcval_infer_forall_ty` keeps the `unit` → expected-type arm only where
`unit` can be a stand-in: inside the definition-time trial
(`in_def_time_trial()`), or when the expected type is an `Impl(Fn …)` /
`Impl(Future …)` SomeT (`type_mentions_impl_fn_or_future`), the Dyn(Fn) family
the arm was written for. Outside both, a `unit` argument binds the callee's
binder to `unit`, like any other argument type.

Test: `tests/unit_as_value_type.test.yo`, "a generic tail call forwards T =
unit" (an expression body, a block body, and a defaulted value forwarded
through a `&mut` place, each at `unit` and `i32`). It fails to build before the
fix ("initializing 'void *' with an expression of incompatible type 'void'")
and passes after.

`std/mem.yo`'s `take` still spells its two bitwise moves out instead of
forwarding to `replace`, so that the v0.2.68 seed, which lacks this fix, builds
`take(&mut u)` on a `unit` place too.
