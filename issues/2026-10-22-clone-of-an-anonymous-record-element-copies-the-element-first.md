# `.clone()` of an anonymous-record element copies the element first

**Severity:** S2 — a valid program is rejected with E0901. For an anonymous
record that is `Clone` but not `Copy` (it holds a move-only or explicit-copy
field), `.clone()` on a collection element of it, `xs(i).clone()`, is
rejected as a copy of the element. The same call on a local, `r.clone()`,
clones field-wise as documented.

**Status:** open. **Found:** 2026-10-22 by the V2b B8 flip probe
(`plans/handover/VBD_B8_PROBE_CENSUS_2026-10-22.md`). Under the flip,
`std/fs/dir.yo` `read_dir` holds an `ArrayList` of
`{ name : String, dt, ino }` records. `r := raw(i)` is E0901 there, and so is
the repair the diagnostic points towards, `raw(i).clone()`. The v0.2.68 seed
and develop `e30c0d8ed` behave the same with develop's std, so the flip is
not required: a move-only field is enough.

## Reproducer

`issues/repros/2026-10-22-clone-of-an-anonymous-record-element-copies-the-element-first.yo`:

```yo
{ println } :: import("std/fmt");
{ ArrayList } :: import("std/collections/array_list");
B :: struct(n : i32);
impl(B, Drop(drop : (fn(self : &mut Self) -> unit)(())));
impl(B, Clone(clone : (fn(self : &Self) -> Self)(B(n : self.n))));
main :: (fn() -> unit)({
  mut(raw) := ArrayList(struct(b : B, k : i32)).new();
  raw.push({ b : B(n : i32(4)), k : i32(1) });
  s := raw(usize(0)).clone();
  println(&s.b.n);
});
export(main);
```

```text
error[E0901]: use of moved value: cannot copy `raw(usize(0))`, whose type `<struct:struct_decl_anonclone2_main_r1c24>` is move-only, and it cannot be moved either: it is borrowed from the value that holds it (an element, or a binding into another value).
```

The local form `r := { b : B(n : i32(4)), k : i32(1) }; s := r.clone();`
compiles and prints `4`. The message also names the type by its internal
declaration id (`<struct:struct_decl_..._r1c24>`) instead of its fields.

## Root cause (hypothesis)

Structural `.clone()` on an anonymous record (and on a tuple or closure, per
the `Copy`/`Clone` rules in `.github/instructions/yo-syntax.instructions.md`)
seems to be resolved as a by-value receiver: the receiver is evaluated as an
rvalue copy before the field-wise clone. On a local, that copy is the last use
or is allowed, but an element projection cannot give up ownership. A named
struct's `Clone.clone(self : &Self)` takes the receiver as `&`, and
`xs(i).clone()` works for it (`ArrayList.clone` relies on that).

## Fix direction

Give the structural clone a `&Self` receiver, so `place.clone()` lends the
place instead of copying it, and render anonymous record types by their
fields in E0901. The regression test is the repro above, which should print
`4`.
