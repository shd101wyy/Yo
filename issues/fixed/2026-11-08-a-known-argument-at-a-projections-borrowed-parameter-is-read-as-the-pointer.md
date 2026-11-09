# A known argument at a projection's borrowed parameter is read as the pointer

**Severity:** S2. A valid program is rejected by the C compiler (`-Wint-conversion` / `-Wincompatible-pointer-types`), with no Yo diagnostic.

Filed 2026-11-08 by the G2 lane (`vbd/g2-holders`) on a develop `68d531aec` tree binary. `HashMap.get_or_insert(key : &K, …) -> &mut(V, self)` failed the whole `tests/collections/hash_map.test.yo` batch through one call, `entry_map.get_or_insert(i32(3), i32(30))`.

## Reproducer

```yo
{ assert } :: import("std/assert");
B :: (fn(comptime(K) : Type) -> comptime(Type))(struct(a : i32, b : K));
impl(
  generic(K : Type),
  B(K),
  stash : (fn(self : &Self, k : &K) -> K)(k.*),
  at : (fn(self : &mut Self, k : &K) -> &mut(i32, self))({
    self.b = self.stash(k);
    &mut self.a
  })
);
main :: (fn() -> unit)({
  mut(s) := B(i32)(a : i32(1), b : i32(2));
  s.at(i32(7)).* = i32(5);
  assert(s.b == i32(7), "stashed");
});
export(main);
```

```text
error: incompatible pointer to integer conversion passing 'int32_t *' (aka 'int *') to parameter of type 'int32_t' (aka 'int'); dereference with * [-Wint-conversion]
```

`s.at(&k)` for a local `k`, and `s.at(seven())` for a runtime call, both compile and run. Only an argument whose value is known at compile time fails. Before #1834 the same call was "Failed to evaluate left-hand side of assignment"; `r := s.at(i32(7))` failed in the C compiler on that binary too.

## Root cause

A projection's `&T` parameter is passed by pointer (`fn_param_is_ptr_borrow`). `bind_parameter` (`src/env.yo`) bound it with the argument's compile-time value, `7`. A read of a variable that carries a known value is emitted as that variable's C name with no dereference, so the generic body passed `__yo_v_k`, the pointer, to `stash`'s by-value `int32_t` slot.

## Fix

`bind_parameter` binds a pointer-passed parameter with an unknown value of its type. The pointer carries no compile-time value, so every read dereferences it, as for a runtime argument.

## Test

`tests/ref_return_ban.test.yo`, "A known argument at a projection's borrowed parameter" (the reproducer's shape; fails to compile before the fix). `tests/collections/hash_map.test.yo`'s `get_or_insert(i32(3), i32(30))` covers the std shape.
