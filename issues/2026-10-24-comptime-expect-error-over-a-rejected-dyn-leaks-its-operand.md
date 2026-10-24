# `comptime_expect_error` over a rejected `dyn(x)` leaks `x`

**Severity:** S3 — a `ref` local passed to `dyn(...)` inside an expression that `comptime_expect_error` expects to fail, and that fails at the `dyn` itself, is never dropped. The leak is test-only (the expression is never emitted), but it fails the test under the leak verdict.

**Status:** open. Found 2026-10-24 by the leak-verdict run of `tests/io/async_traits.test.yo` ("no reader is a Dyn(Reader): the Reader defaults borrow it") on `feat/v3-std-cell-free-resources`. Reproduced on develop (`f271ed005` binary with develop's std) with the same 52-byte report, so it is not V3's. CI runs that file with `YO_TEST_LEAK_VERDICT=0`. The by-value-argument and closure cases of this family were fixed on 2026-10-17 (`issues/fixed/2026-10-17-comptime-expect-error-marks-its-operands-moved.md`, `issues/fixed/2026-10-17-comptime-expect-error-over-a-moving-call-leaves-the-argument-consumed-so-it-leaks.md`); a `dyn(x)` the evaluator rejects is not covered.

## Reproducer

`issues/repros/2026-10-24-comptime-expect-error-over-a-rejected-dyn-leaks-its-operand.yo`:

```yo
{ ArrayList } :: import("std/collections/array_list");
{ println } :: import("std/fmt");
Src :: trait(get : (fn(self : &Self, io : Io) -> Impl(Future(usize, Io))));
Mem :: ref(struct(data : ArrayList(u8)));
impl(
  Mem,
  Src(
    get : (fn(self : &Self, io : Io) -> Impl(Future(usize, Io)))(
      io.async({ &self }(io : Io) => self.data.len())
    )
  )
);
_take :: (fn(r : Dyn(Src)) -> bool)(true);
main :: (fn() -> unit)({
  data := ArrayList(u8).new();
  data.push(u8(1));
  m := Mem(data : data);
  comptime_expect_error(_take(dyn(m)), "cannot be made a");
  println("done");
});
export(main);
```

```text
$ yo compile repro.yo --sanitize address --allocator system -o repro && ./repro
SUMMARY: AddressSanitizer: 52 byte(s) leaked in 3 allocation(s).
```

Expected: no leak; `m` is dropped at the end of `main`.

## Fix

Restore the operand's ownership state when `comptime_expect_error` swallows a rejection raised inside `dyn(...)`, as the 2026-10-17 fixes do for by-value arguments. Regression test: the async_traits case above under the leak verdict, plus this reproducer as a `pragma(Pragma.NeedsLeakVerdict)` test.
