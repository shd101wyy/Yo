# A `Box(Dyn(...))` over a `unit` payload emits a `void` field and a `void` argument

**Severity:** S2 (a valid program, a trait object over the zero-sized `unit`, fails in the C compiler)

## Reproducer

```yo
{ println } :: import("std/fmt");
_Sp :: trait(sp : (fn(self : &Self) -> i32));
impl(unit, _Sp(sp : (fn(self : &Self) -> i32)(i32(42))));
main :: (fn() -> unit)({
  (z : Box(Dyn(_Sp))) = dyn(Box.new(()));
  r := z.sp();
  println(&r);
});
export(main);
```

```text
p31.c:998:8: error: field has incomplete type 'void'
p31.c:1001:75: error: argument may not have 'void' type
p31.c:1194:43: error: passing 'void' to parameter of incompatible type 'uint8_t' (aka 'unsigned char')
```

## Root cause

`unit` is zero-sized. Its C type string is `void`. Every storage position erases it, and a by-value
`unit` parameter is spelled `uint8_t` with the argument `0` (`get_storage_type_string`). The dyn
emitters did not apply that rule:

- the dyn box typedef declared a `void value;` member, and its constructor took a `void value`
  parameter (`types/generation.yo` and `functions/dyn.yo`);
- the payload-convention wrapper and the clone slot passed the receiver as `(*(void*)self_ptr)`.

Found by the decision 49 S2 flip's ASan rows (VERDICTS-61 decision 15, "a zero-sized payload").
`unit` is the only zero-sized Yo type: an empty `struct()` has size 1.

## Fix

- The box typedef stores no member for a `unit` payload, and its constructor takes the one-byte
  `uint8_t`.
- The wrappers pass `0` by value, or the data word by pointer (`_dyn_payload_receiver`).

Test: `tests/explicit_allocators.test.yo` "A unit payload in a Box(Dyn): dispatch, size_of_val 0, global and placed". It fails in the C compiler before the fix (yo-iw) and passes after (yo-iy, 25 passed under ASan with `--allocator system`).
