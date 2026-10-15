# A thread-local passed as a call argument emits an undeclared C identifier

**Severity:** S2. A valid program fails to compile: passing a `thread_local` binding to a function (`rd(T)` by value, or `rd(&T)` to a `&T` parameter, which is passed by value in C) makes the C compiler reject the generated code.

**Status:** FIXED on `feat/global-lend-to-call-is-an-error` (2026-10-15). Found while writing `tests/global_lend.test.yo` for decision 47.

## Symptom

```yo
{ println } :: import("std/fmt");
(thread_local(T) : i64) = i64(3);
rd :: (fn(v : i64) -> i64)(v);
main :: (fn() -> unit)({
  println(rd(T).to_string());
});
export(main);
```

With the v0.2.62 seed and develop:

```
tlr3.c:2232:97: error: use of undeclared identifier '_u40__u42___yo_v_T_m5009685561650654109__tl_get_u40__u41__u41_'
```

## Root cause

A thread-local's reads are rewritten to its lazy accessor, `(*name__tl_get())` (`get_variable_name_for_codegen`, `src/codegen/utils/index.yo`). The argument loop in `src/codegen/exprs/other_fn_call.yo` treats a by-value variable argument as a name: when the argument's code equals the variable's codegen name it hands that name to `emit_deferred_dup_or_code` through `sanitize_for_c_identifier`, which mangles the accessor call into an identifier (`(` becomes `_u40_`, `*` becomes `_u42_`). The `(*name)` read of a by-`ref` binding was already exempt (`is_deref_read`); the accessor read was not.

## Fix

`is_deref_read` also covers an argument whose code is the variable's own accessor read (a codegen name that starts with `(*`), so the read is emitted in place. Tested in `tests/global_lend.test.yo` ("an immutable global is lent to any call": `_gl_read_i64(&_gl_tl_fixed)`).
