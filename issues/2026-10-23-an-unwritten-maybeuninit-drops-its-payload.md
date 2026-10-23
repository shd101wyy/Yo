# An unwritten `MaybeUninit(T)` drops its payload, running `T`'s `Drop` on a value that was never constructed

**Severity:** S2 — a user `Drop` runs on zeroed bytes no constructor produced (a `File` would close fd 0); and because a written but un-`assume_init`ed `MaybeUninit` drops too, it cannot serve as Rust's `ManuallyDrop`/`forget`.

**Status:** OPEN — found 2026-10-23 while looking for a way to forget a value
in std (for `RefCell.into_inner`,
`issues/2026-10-23-a-move-only-payload-cannot-move-out-of-a-box.md`). Not fixed.

## Reproducer

`issues/repros/2026-10-23-an-unwritten-maybeuninit-drops-its-payload.yo`
(seed v0.2.68 and a develop 4b96ec5e9 tree binary):

```
never written
drop 0
end
```

Expected (Rust's `MaybeUninit<T>` never drops its contents):

```
never written
end
```

A second probe writes a `Tok(n : 5)` through `as_ptr()` with
`__yo_ptr_write` and never calls `assume_init`. It prints `drop 5` at scope
end. Rust would print nothing, because `MaybeUninit` is the tool that keeps a
value from being dropped.

## Cause

`MaybeUninit(BaseType)` is a plain `newtype(value : BaseType)`
(`std/prelude.yo`, "=== MaybeUninit ==="), so it gets the ordinary
field-drop glue. `__yo_maybe_uninit_new` zero-fills the slot
(`src/codegen/exprs/inline_fns.yo`, the C11 indeterminate-read fix), which is
why the bogus drop sees `n == 0` rather than garbage. `assume_init`
(`sink(self)`) consumes the wrapper, so the written-then-assumed path in std
(`Array.default`, `Array.clone`, `std/process/command.yo`) never double-drops.
Only an unwritten or un-assumed wrapper is wrong.

## Fix direction

Give `MaybeUninit` no drop glue: the compiler treats it like a `Copy`-less
type with an empty destructor, whatever `BaseType` holds. Codegen's drop and
dup emission skip it. A test asserts that no `drop` runs for an unwritten
wrapper or for a written wrapper that is never assumed.
