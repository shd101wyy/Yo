# An unwind through a method call is not caught by the frame that installed the handler

**Severity:** S1 — a miscompilation of effect control flow: the process
aborts with `unhandled effect unwind escaped to top level` instead of
returning the unwound value from the frame that installed the `ctl` handler.

**Status:** open. **Found:** 2026-10-23 while writing the regression test for
`issues/fixed/2026-10-23-an-early-return-in-a-derive-generated-body-skips-the-drop-of-a-value-local.md`.
Reproduced with the v0.2.68 seed on develop `56dd8253f`.

## Reproducer

`issues/repros/2026-10-23-an-unwind-through-a-method-call-is-not-caught-by-the-frame-that-installed-the-handler.yo`:
a `ctl` handler `raise` that does `unwind(i32(7))` is installed in
`via_trait`, then passed to a method called through its type,
`Q.make(i32(0), raise)`, whose body calls `raise()`. The control,
`via_plain_fn`, passes the same handler to a plain function.

```text
8
unhandled effect unwind escaped to top level
```

Expected: `8`, then `7`. The method can be a trait member (`impl(Q, Make(make : …))`)
or an inherent one (`impl(Q, make2 : …)`); both abort.

## Where it goes wrong

The emitted C of the installing frame shows it. After the plain-function call,
`via_plain_fn` catches the escape: it clears `__yo_effect_escaped` and returns
the value from `__yo_unwind_value`. After the method call, `via_trait` emits
the transitive form, `if (__yo_effect_escaped) { return (int32_t){0}; }`. That
form re-raises without catching, so the escape reaches `main`. The call
site's `is_handler_installation` argument to `emit_effect_unwind_check`
(`src/codegen/exprs/return.yo`) is false on the method-call path. The method
path's `*_is_install` flags are computed in `src/codegen/exprs/other_fn_call.yo`,
but nobody has traced why the type-qualified method call does not see the
installation.
