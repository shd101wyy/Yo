# A generic method returning `Rc` of its parameter over a recursive struct gets a second C type

**Severity:** S1. A generic impl method whose declared result builds `Rc(T)` (`-> Option(Rc(T))`), called on a receiver whose `T` reaches a recursive struct (`RefCell(N)` with `N :: struct(next : Option(Rc(RefCell(Self))), …)`), gets a second C struct for `Rc(RefCell(N))`. Develop rejects the reproducer at the C compiler (incompatible pointer types). When no conversion is emitted between the two, as through `Weak.upgrade`, the program compiles and reads the payload at the wrong header offset (an ASan SEGV in `tests/cycle_collector.test.yo`'s Weak tree row).

**Status:** FIXED 2026-10-27 (`feat/w3-weak`). **Found:** 2026-10-27, while gating decision 48 W3: the parent-pointer tree row (`Weak(RefCell(_WeakTree))`) crashed under ASan.

## Reproducer

```yo
{ RefCell } :: import("std/sync/refcell");
{ assert } :: import("std/assert");
Holder :: (fn(comptime(V) : Type) -> comptime(Type))(
  struct(_h : Option(Rc(V)))
);
impl(
  generic(T : Type),
  Holder(T),
  get : (fn(self : &Self) -> Option(Rc(T)))(
    match(self._h, .Some(h) => .Some(h), .None => .None)
  )
);
N :: struct(next : Option(Rc(RefCell(Self))), tag : i32);
main :: (fn() -> unit)({
  a := rc(RefCell(N).new(N(next : .None, tag : i32(7))));
  w := Holder(RefCell(N))(_h : .Some(a));
  t := match(w.get(), .Some(p) => p.with(v => v.tag), .None => i32(0));
  assert(t == i32(7), "t");
});
export(main);
```

Develop `476cfb700`:

```text
error: incompatible pointer types initializing '__yo_t_10559752589175263929 *' … with an expression of type '__yo_t_17378809879332847015 *'
```

The emitted C holds two structs for one type, `// Rc(RefCell(<struct:…N…>))` with the full RC header and `// Rc(T)` with the small one.

## Root cause

Each call of a generic constructor stamps a fresh struct id, and substitution keeps an instance's def-era id. The method's result `Rc(T)`, substituted at `T := RefCell(N)`, is `Rc(RefCell(N))` under the id `Rc(T)` got at the definition; the `Rc(RefCell(N))` inside `N`'s field carries the id of its own call. `type_key` keys both by `(constructor, type arguments)`, which agree, but its cycle guard (`g_tk_visited`) headed each node by its id. Walking the substituted instance, the guard did not recognise the inner `Rc(RefCell(N))` as the instance already being keyed, so it cut the cycle one level deeper, at `RefCell(N)`. The two key strings differed, and so did the C types: the substituted copy was emitted under its def-era display name `Rc(T)` and with the small RC header, where `Rc(RefCell(N))` has the full one.

## Fix

`_type_key_at` (src/types/type_key.yo) heads a generic instance's cycle-guard node by its constructor id, as its key is, so every copy of one instance is one node on the path and the guard cuts at the same place. An argument list holding a value-erased `Type`/`unit` slot keeps the id head, because its key also reads the fields, which the argument identities do not cover.

## Tests

- `tests/rc.test.yo` "a generic method returning Rc of its parameter over a recursive struct": the reproducer above as a test row; a C compile error before the fix.
- `tests/rc.test.yo` "Weak.upgrade over a recursive payload reads the cell", and `tests/cycle_collector.test.yo` "a tree with Weak parent pointers frees itself without the collector": the ASan SEGV before the fix.
