# A `match` body of a `-> &str` projection unifies its arms against `*(str)`

**Severity:** S3. A `-> &str` function whose body is a `match` over `str` values is rejected with an
internal-looking "Cannot unify incompatible types: `&str` and `*(str)`". Binding the `match` first and returning
`&v.*` compiles and runs, so there is a workaround, but the diagnostic names a type the program never spelled.

Found 2026-11-19 by the `?Sized` associated-type lane while rehearsing v0.2.80's `impl(String, Deref(Target :
str))` (the body drafted in the deref-std-impls PR notes is this shape). Seed `yo` 0.2.78 and develop `d8f0d89fa`
behave the same; it is independent of `?Sized` (a plain free function reproduces it).

## Reproducer

`issues/repros/2026-11-19-a-match-body-of-a-str-projection-unifies-its-arms-against-a-pointer-to-str.yo`:

```yo
pragma(Pragma.AllowUnsafe);
{ ArrayList } :: import("std/collections/array_list");
_S :: struct(_bytes : ArrayList(u8));
_peek :: (fn(self : &_S) -> &str)(match(self._bytes.ptr(), .Some(p) => unsafe(__yo_str_from_raw_parts(p, self._bytes.len())), .None => ""));
main :: (fn() -> unit)({});
export(main);
```

```text
error[E0601]: Cannot unify incompatible types: "&str" and "*(str)"
 --> …:6:79
```

With the first arm bound (`.Some(p) => { v := unsafe(…); v }`) the text becomes "Expected: `*(str)`, Actual: `&str`";
with both arms built by `__yo_str_from_raw_parts` it is the unify error again.

## Expected

Either the `match` is accepted as the reference value it is (each arm is a `&(str, static)`, which a `&str` result
admits), or it gets the projection-shape diagnostic ("a place written `&place`, or a reference binding"). It never
names `*(str)`: the projection's expected type seems to reach the arms as the C-level pointer to the pointee.

Workaround (works today): `{ v := match(…); &v.* }`.

Fix: not started.
