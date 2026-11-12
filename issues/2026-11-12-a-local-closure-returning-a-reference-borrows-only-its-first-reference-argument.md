# A local closure returning a reference borrows only its first reference argument

**Severity:** S1 — use-after-free in safe code: `picked := pick(rx, ry)` through a local closure `(fn(a : &i32, b : &i32) -> &i32)(&b.*)` freezes only `rx`'s list, so `ys.push(...)` reallocates the buffer `picked` points into and the read after it is an ASan heap-use-after-free.

- Filed: 2026-11-12 (smpick lane, while probing the shapes of the generic by-value result hole, `issues/fixed/2026-11-12-a-generic-by-value-result-at-a-reference-type-drops-its-second-arguments-origin.md`).
- Not new since v0.2.76: the v0.2.76 seed accepts the program too and the binary it builds reports the same heap-use-after-free. It is a separate path from the generic one: the callee is a closure value, not a specialized generic function.

## Reproducer

```yo ignore
{ ArrayList } :: import("std/collections/array_list");
{ println } :: import("std/fmt");
main :: (fn() -> unit)({
  mut(xs) := ArrayList(i32).new();
  mut(ys) := ArrayList(i32).new();
  xs.push(i32(1));
  ys.push(i32(2));
  rx := xs.index(usize(0));
  ry := ys.index(usize(0));
  pick := (fn(a : &i32, b : &i32) -> &i32)(&b.*);
  picked := pick(rx, ry);
  mut(i) := i32(0);
  while(i < i32(1000), {
    ys.push(i);
    i = (i + i32(1));
  });
  (v : i32) = picked.*;
  println(&v);
});
export(main);
```

`yo check` accepts it; `yo compile --sanitize address --allocator system` and a run report
`heap-use-after-free ... READ of size 4`. Swapping the arguments (`pick(ry, rx)` with the body `&a.*`) is rejected
with E0911 at the push: the call's result is rooted at the FIRST reference argument only, where O2's elided result
origin is the union of every reference parameter.

## Expected

E0911 at `ys.push(i)`: the closure's elided result origin is the union of `a` and `b` (O2), so `picked` borrows both
lists.

## Status

Open. Not fixed by the smpick PR (which fixes the generic-function path only). A test: the program above as a G-B pair
in `tests/origins/unsound/` once fixed.
