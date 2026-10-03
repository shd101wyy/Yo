# `collect(String)` leaks the accumulated byte buffer

**Status: FIXED 2026-10-03** (`plans/STRING_VALUE_SEMANTICS.md` S1). `FromIterator.from_iter_add` took its accumulator as a plain, borrowed parameter. `collect(String)` starts from `String.new()`, which has no buffer, so the first `push_string` into the borrowed copy allocated a buffer that copy did not own and nothing released. The trait and its seven implementations now take `own(acc)`: the accumulator is moved in, mutated and returned. Measured with ASan on the reproducer below: develop's `std` leaks 360 bytes in 20 allocations, and the fix leaks none. The extended E0908 now rejects the borrowed write that caused it. Tests: `tests/string/string.test.yo` ("collect(String) builds the string through an owned accumulator") and `tests/iterator_combinators.test.yo`, whose local leak verdict found it.

**Severity:** S1 — every `iter.collect(String)` leaks one `ArrayList(u8)` header and its bytes (36 bytes for `a`, `b`, `c`), so a loop that collects strings grows without bound.
**Found:** 2026-10-01, running `tests/iterator_combinators.test.yo` as a gate for `issues/fixed/method-on-a-phantom-generic-enum-is-not-found-through-a-comptime-type-param.md`. Not caused by that change: the test fails the same way with the installed seed (yo 0.2.47) and with a compiler built from `origin/develop` at `5567a7796`, both against the tree's `std/`.

## Reproducer

```rust
{ assert } :: import("std/assert");
{ String } :: import("std/string");
{ ArrayList, array_list } :: import("std/collections/array_list");
main :: (fn() -> unit)({
  (i : i32) = i32(0);
  while(i < i32(10), {
    parts := array_list(`a`, `b`, `c`);
    joined := parts.into_iter().collect(String);
    assert(joined == `abc`, "strings concatenate in order");
    i = (i + i32(1));
  });
});
export(main);
```

`yo compile leak.yo --sanitize address --allocator system -o leak && ./leak`:

```
SUMMARY: AddressSanitizer: 360 byte(s) leaked in 20 allocation(s).
```

One iteration leaks 36 bytes in 2 allocations (a 32-byte direct leak and a
4-byte indirect one). In the test suite it is the one failure of
`tests/iterator_combinators.test.yo` ("collect into a String concatenates",
49 passed, 1 failed, `Memory leak detected`).

## What is known

Symbolized with `addr2line`, the direct leak is an `ArrayList(u8)` allocated by
`with_capacity` (`__yo_rc_alloc` from `__yo_new_…`) inside the C function that
takes `(String* self, String other)`, which is `push_string`. Its caller is the
`(String acc, String item) -> String` function, which is String's
`FromIterator.from_iter_add` (`std/string/string.yo`):

```rust
from_iter_add : (fn(acc : Self, item : Self.Elem) -> Self)({
  acc.push_string(item);
  acc
})
```

`from_iter_new` is `String.new()`, whose `_bytes` is `.None`, so the first
`push_string` allocates the buffer on the by-value parameter `acc`, which is
then returned. The root cause, whether a missing drop of the parameter's buffer
or a dup that is never balanced, is not yet diagnosed.
