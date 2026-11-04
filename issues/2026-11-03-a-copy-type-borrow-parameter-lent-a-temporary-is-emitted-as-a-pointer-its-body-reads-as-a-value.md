# A copy-type borrow parameter lent a temporary is emitted as a pointer that its body reads as a value

**Severity:** S3: the call fails to C-compile (no wrong code reaches a binary), and binding the argument to a named local first is a one-line workaround.

Found by the B8 flip's implicit-copy fixture move (2026-11-03). It is **pre-existing on develop**: it reproduces with a develop-based tree binary (`4af1ebd87` on develop `ce827ae52`) over develop's std, and with the B8/B9 tree binaries alike.

## Reproducer

`issues/repros/2026-11-03-a-copy-type-borrow-parameter-lent-a-temporary-is-emitted-as-a-pointer-its-body-reads-as-a-value.yo` (`yo compile` it):

```yo
{ ArrayList } :: import("std/collections/array_list");
{ println } :: import("std/fmt");
main :: (fn() -> unit)({
  mut(xs) := ArrayList(i32).new();
  xs.push(i32(7));
  p := xs.walk_elem(&usize(0));
  v := p;
  println(`${v}`);
});
export(main);
```

## Verbatim error

```
wed.c:2931:51: error: invalid operands to binary expression ('int32_t *' (aka 'int *') and 'size_t *' (aka 'unsigned long *'))
```

## Root cause

`ArrayList.walk_elem` takes `cur : &usize`. Lent a TEMPORARY (`&usize(0)`), the call's specialization takes the parameter as `size_t* __yo_v_cur`. The body, however, is emitted with the parameter read as its value (decision 42: a borrow reads as its value), with no dereference. It compares `__yo_v_cur >= _length` and returns `_ptr + __yo_v_cur`, which is pointer arithmetic on two pointers:

```c
static inline int32_t* yo_id_…(__yo_t_…** __yo_v_self, size_t* __yo_v_cur) {
  if (((__yo_v_cur) >= ((*__yo_v_self)->_length))) {
  …
  return (_file____tmp__temp_… + __yo_v_cur);
}
```

The same call with a named local (`c := usize(0); xs.walk_elem(&c)`) compiles and prints `7`. The temporary-argument path chooses a by-pointer parameter representation that the body emission does not know about. Either the body has to deref a by-pointer copy-type borrow, or the temporary has to be lent the way a local is.

## Fix and test

The fix lands with a `tests/` case: the reproducer as a test that walks a list with `&usize(0)` and asserts the element.
