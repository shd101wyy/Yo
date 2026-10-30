# A capture-list entry named with a leading underscore is emitted bare when the body moves it

**Severity:** S2 — a valid program fails to compile: the C compiler rejects the
closure. The workaround is to name the variable without a leading underscore.

**Found:** 2026-10-29, in B13-b (errors by value, `vbd/b13b-errors-by-value`).
Three `src/` handlers kept their error with
`g_errs.with_mut({ _g_err }(xs) => xs.push(_g_err))`, and the v0.2.72 seed's
build of the compiler failed in C. A tree binary has the same bug. The
handlers were renamed (`guard_err`, `derive_err`) to work around it.

## Reproducer

`issues/repros/2026-10-29-a-capture-list-entry-named-with-a-leading-underscore-is-emitted-bare-when-moved.yo`,
built with `yo compile <file> --std-path ./std`:

```yo
{ AnyError } :: import("std/error");
{ RefCell } :: import("std/sync/refcell");
{ ArrayList } :: import("std/collections/array_list");
{ String } :: import("std/string");
{ println } :: import("std/fmt");
(g_errs : RefCell(ArrayList(AnyError))) = RefCell(ArrayList(AnyError)).new(ArrayList(AnyError).new());
keep :: (fn(_g_err : AnyError) -> unit)({
  g_errs.with_mut({ _g_err }(xs) => xs.push(_g_err));
});
main :: (fn() -> unit)({
  keep(dyn(String.from("boom")));
  println(g_errs.with(xs => xs.len()));
});
export(main);
```

```text
error: use of undeclared identifier '_g_err'; did you mean '__erf'?
```

Renaming `_g_err` to `gerr` compiles and prints `1` (ASan-clean).

## The emitted closure

With `gerr`, the `FnOnce` body takes the capture into a local first:

```c
__yo_t_… __yo_v_gerr = ((__yo_t_…*)closure_context)->__yo_v_gerr;
…
__yo_fs_…(__yo_v_xs, __yo_v_gerr);
```

With `_g_err`, that local is never declared, and the move reads the bare name:

```c
__yo_fs_…(__yo_v_xs, _g_err);
```

## Analysis

`sanitize_for_c_identifier` (`src/codegen/utils/index.yo`) leaves a name
that `_is_compiler_shaped_identifier` accepts unprefixed, and every name
starting with `_` counts as compiler-shaped. So a Yo variable `_g_err` keeps
its source spelling in C, the same shape as the compiler's own temps. A
non-moving read of the same capture goes through `closure_context` and
compiles. The site that declares the moving read's local copy has not been
located yet. The likely cause is that it skips a name it takes for an
existing compiler temp. A fix should decide "compiler-generated" from where
the name came from, not from its spelling. A test belongs in `tests/closure_capture_list.test.yo`: a moved
capture-list entry `_x`.
