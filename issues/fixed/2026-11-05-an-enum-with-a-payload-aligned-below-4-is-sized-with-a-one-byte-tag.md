# An enum with a payload aligned below 4 is sized with a one-byte tag

**Severity:** S1. It corrupts the heap in safe code. `size_of(Option(bool))` is 4, while the C struct the compiler emits is 8 bytes. `Box.new(value)` allocates `header + size_of(T)` bytes and then writes the C `T` into that block. For any struct holding such a field, the write runs past the end of the allocation.

> Found 2026-11-05 by V5 part B's fixpoint. Stage 2 of the compiler aborted on any `check` with `free(): invalid pointer`. `ExprInfoRare` holds five `Option(bool)` fields; it became a value held in `Option(Box(ExprInfoRare))`, and `Box.new` started allocating it. Under ASan the stage-2 binary reports `heap-buffer-overflow ... WRITE of size 480` into a `472-byte region`: 8 header bytes plus the evaluator's 464-byte `size_of(ExprInfoRare)`, against C's 480. The seed v0.2.75 and develop `58ec8be03` compute the same wrong sizes.

## Reproducer

```yo
{ println } :: import("std/fmt");
S :: struct(c : Option(bool), d : Option(bool), w : i64);
main :: (fn() -> unit)({
  println(size_of(Option(bool)));
  println(size_of(S));
  b := Box(S).new(S(c : .Some(true), d : .None, w : i64(1)));
  println(b.w);
});
export(main);
```

Before the fix, the program prints `4` and `16`. C's `sizeof` gives 8 and 24, and under `--sanitize address` the `Box.new` write is a heap-buffer-overflow.

## Root cause

`_enum_value_size` (`src/types/utils.yo`) sized the tag from the variant count, `_round_up(_ceil_log2(n_v), 8)`, which is one byte for any enum with up to 256 variants. The codegen emits the tag as a C enum, `__yo_tN_tag tag;`, which is an `int`. A payload aligned below 4 (`bool`, `u8`, `u16`, arrays of them) therefore starts at offset 4 in C, but at offset 1 or 2 in the layout model.

The alignment side was fixed earlier (`issues/fixed/enum-alignment-ignores-tag-heap-corruption.md`): the enum aligns to at least 4. The size side kept the one-byte tag, so the model rounded `1 + 1` up to 4 where C has `4 + 1` rounded up to 8.

## Fix

The tag is 32 bits in `_enum_value_size`, the size of the C `int` the codegen emits. `_ceil_log2`, now unused, is deleted. A test in `tests/basic.test.yo` ("an enum tag is int-sized …") checks `size_of(Option(bool|u8|u16))` = 8, checks a struct of such fields against C's layout, and round-trips a `Box` of that struct. It fails before the fix: the `size_of` asserts fail, and ASan legs also see the overflow.
