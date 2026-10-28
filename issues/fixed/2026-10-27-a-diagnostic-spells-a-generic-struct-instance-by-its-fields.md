# A diagnostic spells a generic struct instance by its fields

**Severity:** S3 (diagnostics only: the verdict is right, but the message
names a type the user never wrote)

**Status:** fixed 2026-10-27 (branch `fix/message-type-names-a-generic-instance`).
**Found:** 2026-10-27 by the B8 flip census (`vbd/b8-arraylist-string-flip`):
`check ./src` over the flipped std printed `ArrayList(Rc(Self))` under the
v0.2.70 seed and `struct(_ptr : ?(*(Rc(Self))), _length : usize, _capacity :
usize)` under a develop-built binary for the same E0901.

## The bug

An E0901 (and every other message that names a type through
`type_to_string_for_message`) spells a generic struct's instance by its fields
instead of by the type the user wrote:

```yo ignore
W :: (fn(comptime(T) : Type) -> comptime(Type))(struct(n : usize));
impl(generic(T : Type), W(T), Drop(drop : (fn(self : &mut Self) -> unit)(())));
H :: struct(w : W(i32));
_peek :: (fn(h : &H) -> W(i32))(h.w);
```

```text
develop: error[E0901]: use of moved value: cannot copy `h.w`, whose type `struct(n : usize)` is move-only, ...
v0.2.70: error[E0901]: use of moved value: cannot copy `h.w`, whose type `W(i32)` is move-only, ...
```

## Root cause

#1624 (B6-b) added `type_to_string_for_message` (`src/types/string.yo`) so a
message names an anonymous record (`struct(b : B, k : i32)`) by its fields
instead of its internal declaration id. It treats every nameless,
non-namespace `Struct` as an anonymous record. A generic type's instance is
nameless too, but the type constructor registered a display name for it
(`register_type_display_name`, `W(i32)`), which `type_to_string` prints.

## The fix

`type_to_string_for_message` prints a nameless struct by its fields only when
no display name is registered for its id. Otherwise it defers to
`type_to_string`, as it does for named and namespace structs.

## The test

`tests/move_only.test.yo`, "a copy error names a generic struct instance as
written": a copy of a `_MoGen(i32)` field is E0901 whose message must contain
"whose type `_MoGen(i32)` is move-only". It fails before the fix (the message
says `struct(v : i32)`) and passes after.
