# Returning a local's projection call as the tail of a `-> &[T]` function is E0901, where E0912 is due

**Severity:** S3. A dangling reference is rejected, but with a misleading diagnostic: "cannot copy `(b.view)()`,
whose type `Slice(i32)` is move-only" (E0901) instead of the E0912 text that says the result borrows a local that
dies at the function's end.

Found 2026-11-15 by the VERDICTS-63 probes (p2b vs p3c). Seed `yo` 0.2.77 and develop (`yo-dt6`) behave the same.

## Reproducer

`issues/repros/2026-11-15-returning-a-projection-call-of-a-local-reports-e0901-where-e0912-is-due.yo`:

```yo
pragma(Pragma.AllowUnsafe);
{ assert } :: import("std/assert");

Buf :: struct(items : Array(i32, 4), n : usize);
impl(
  Buf,
  view : (fn(self : &Self) -> &[i32])({
    p := unsafe(__yo_slice_ptr(unsize(&self.items)));
    part := unsafe(__yo_slice_from_raw_parts(p, self.n));
    &part.*
  })
);

leak :: (fn() -> &[i32])({
  b := Buf(items : Array(i32, 4)(1, 2, 3, 4), n : usize(2));
  b.view()
});

main :: (fn() -> unit)({
  assert(leak().len() == usize(2), "dangling");
});
export(main);
```

```text
error[E0901]: use of moved value: cannot copy `(b.view)()`, whose type `Slice(i32)` is move-only (it is neither `Copy` nor `Clone`), and it cannot be moved either: it is borrowed from the value that holds it (an element, or a binding into another value).
   --> .../2026-11-15-returning-a-projection-call-of-a-local-reports-e0901-where-e0912-is-due.yo:18:4
   |
18 |   b.view()
   |    ^
```

The same function with the tail `&b.view().*` reports E0912 (probe p3c).

## Expected

E0912, the escape-of-a-local text, for both spellings: the tail is a `&[i32]` rooted at the local `b` by the
projection-call rule (decision 24, R-CALL), so the escape check applies before the copy check.

The same E0901 text answers a VALID receiver's bare forward (found 2026-11-19 by the `?Sized` lane): `_a :: (fn(x :
&Row) -> &[i32])(x.view())` is E0901 ("cannot copy `(x.view)()`, whose type `Slice(i32)` is move-only"), where the
sized `(fn(x : &Row) -> &i32)(x.num())` gets the projection-forward hint ("write `&x.num()`"). `&x.view()` is the
spelling either way; the unsized case should give the same hint.

Fix: not started (v0.2.79).
