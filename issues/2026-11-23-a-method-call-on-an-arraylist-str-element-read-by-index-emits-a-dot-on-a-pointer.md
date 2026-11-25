# A method call on an `ArrayList(str)` element read by index emits a `.` on a pointer

**Severity:** S2 (a valid program does not compile: the emitted C is rejected by the C compiler; binding the element first works around it).

**Status:** OPEN. Found 2026-11-23 by the P12 lane while gating `tests/unsized-places.test.yo`; present on develop `f06ff5889` (not introduced by P12).

## The repro

```yo
{ ArrayList } :: import("std/collections/array-list");
{ assert } :: import("std/assert");
main :: (fn() -> unit)({
  mut(xs) := ArrayList(str).new();
  xs.push("def");
  assert(xs(usize(0)).len() == usize(3), "element len");
});
export(main);
```

`yo compile` with a build of develop `f06ff5889` (and with the P12 branch's binary; `ArrayList(&(str, static))` in a
pragma'd file gives the same C):

```text
error: member reference type '__yo_str *' is a pointer; did you mean to use '->'?
  ... yo_id_..._rtparam0_gs_..._str_rtparam1_usize_ret__str(&__yo_v_xs, 0ULL).len)) == (3ULL));
```

`yo check` accepts the program. Binding the element first compiles and runs (`e := xs(usize(0)); e.len()`).

## Root cause (not yet traced)

The index projection `xs(i)` on an `ArrayList(str)` returns a pointer to the element (`__yo_str *`). A
method call on that result is resolved as a by-value `str` receiver (`.len` is read as a struct field of
`__yo_str`), so codegen emits the member access with `.` and never dereferences the projection result. A
`str` element is the legacy value-`str` alias of `&(str, static)`, so the receiver probe likely takes the
alias arm and skips the projection's deref step. The `:=` binding goes through the ordinary projection read,
which dereferences.

## Fix and test

Not fixed here: the fix belongs with the value-`str` alias work (S3b-str PR B deletes the alias arms) or with the
receiver probe. The regression test is the repro as a row of `tests/unsized-places.test.yo` (or of
`tests/collections/array-list` tests): `xs(usize(0)).len()` over an `ArrayList(str)` and an
`ArrayList(&(str, static))`.
