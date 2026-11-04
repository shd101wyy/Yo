# Two spellings of one anonymous record type emit two C structs, and a clone between them fails to compile

**Severity:** S3. This is C-compile breakage, not wrong code at runtime. It only appears when the same anonymous `struct(...)` type is written at two sites and a value crosses between them through a generic function.

Found while classifying the B8 flip's Tier 1 failures (2026-11-03). It is **pre-existing on develop**: it reproduces with the v0.2.73 seed over develop's std at dc24349c5 and with the B8/B9 tree binaries alike.

## Reproducer

`issues/repros/2026-11-03-two-spellings-of-one-anonymous-record-type-emit-two-c-structs.yo` (`yo compile` it; the C compile fails):

```yo
{ ArrayList } :: import("std/collections/array_list");
{ println } :: import("std/fmt");
_MoCl :: struct(n : i32);
impl(_MoCl, Clone(clone : (fn(self : &Self) -> Self)(_MoCl(n : self.n))));
impl(_MoCl, Drop(drop : (fn(self : &mut Self) -> unit)(())));
A :: (fn(comptime(T) : Type, xs : &ArrayList(T), i : usize, where(T <: Clone)) -> T)(xs(i).clone());
main :: (fn() -> unit)({
  mut(raw) := ArrayList(struct(b : _MoCl, k : i32)).new();
  raw.push(_(b : _MoCl(n : i32(4)), k : i32(1)));
  a := A(struct(b : _MoCl, k : i32), &raw, usize(0));
  println(`A ${a.b.n} ${a.k}`);
});
export(main);
```

## Verbatim error

```
b_dev.c:2953:10: error: returning '__yo_t_6196753108247280209' (aka 'struct __yo_t_6196753108247280209_struct') from a function with incompatible result type '__yo_t_4221111773259573562' (aka 'struct __yo_t_4221111773259573562_struct')
```

## Root cause

The evaluator accepts the program: the two spellings `struct(b : _MoCl, k : i32)` (main r1c24 in the list's type and r3c9 in `A`'s type argument) unify. Codegen, however, emits one C struct per declaration site:

```c
struct __yo_t_4221111773259573562_struct { // <struct:struct_decl_b_main_r3c9>
struct __yo_t_6196753108247280209_struct { // <struct:struct_decl_b_main_r1c24>
```

The structural clone in `A`'s specialization builds the element's r1c24 type, but the function's C return type is the r3c9 one.

Two possible fixes:
- Key the C type of an anonymous record by its structure, not by its declaration site.
- Emit a field-wise conversion at the return.

Either way, the regression test lands with the fix: the reproducer above as a `tests/` case that compiles and asserts `a.b.n == 4` and `a.k == 1`.
