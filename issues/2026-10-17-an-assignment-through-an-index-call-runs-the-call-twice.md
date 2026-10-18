# An assignment through an index call runs the call twice

**Severity:** S1 — memory unsafety in generated code: `m(s) = v` on a `HashMap(String, V)` is a heap-use-after-free on develop, because the C calls `index_mut` twice and each call drops its by-value key.

**Status:** open. Found 2026-10-17 while landing #1420 (the review's write
through a move-only key, `issues/fixed/2026-10-17-an-index-call-that-moves-a-named-local-calls-an-unemitted-method.md`).
It reproduces with the develop-built `yo-dev-5425cd7bf` and develop's own std,
with no move-only type involved.

## Symptom

```text
==3144406==ERROR: AddressSanitizer: heap-use-after-free on address 0x701edbae1900
READ of size 4 at 0x701edbae1900 thread T1
```

The emitted C evaluates the place twice: once to save the old value, and
once to store the new one.

```c
int32_t _file____home_temp_120759739997252349010; memcpy(&_file____home_temp_120759739997252349010, &((*__yo_fs_12843966657673006073(&__yo_v_m, __yo_v_s))), sizeof(_file____home_temp_120759739997252349010)); // Save old value by bytes
(*__yo_fs_12843966657673006073(&__yo_v_m, __yo_v_s)) = 5;
```

## Reproducer

```yo
{ HashMap } :: import("std/collections/hash_map");
{ String } :: import("std/string");
{ assert } :: import("std/assert");
main :: (fn() -> unit)({
  m := HashMap(String, i32).new();
  m.insert(String.from("key-long-enough-to-heap"), i32(1));
  s := String.from("key-long-enough-to-heap");
  m(s) = i32(5);
  assert(m(s) == i32(5), "written");
  assert(s.len() == usize(23), "s alive");
});
export(main);
```

`yo compile repro.yo --sanitize address --allocator system` and run it.

The same shape with a `Drop`-counting move-only key (with #1420's std)
shows the count. The write drops the key twice, and a read drops it once:

```yo
pragma(Pragma.AllowUnsafe);
{ printf } :: import("std/libc/stdio");
{ HashMap } :: import("std/collections/hash_map");
(mut(g_d) : i32) = i32(0);
Dk :: struct(n : i32);
derive(Dk, Eq(Dk), Hash);
impl(
  Dk,
  Drop(
    drop : (fn(self : &mut Self) -> unit)({
      g_d = (g_d + i32(1));
    })
  )
);
main :: (fn() -> unit)({
  m := HashMap(Dk, i32).new();
  m.insert(Dk(n : i32(5)), i32(50));
  key := Dk(n : i32(5));
  m(key) = i32(60);
  unsafe(printf("after write %d\n", g_d)); // 2
  k2 := Dk(n : i32(5));
  x := m(k2);
  unsafe(printf("after read %d\n", g_d)); // 3
});
export(main);
```

A temporary key (`m(Dk(n : i32(5))) = i32(60)`) counts 2 as well, on
develop's evaluator and on #1420's. With a `Box(i32)` key the second drop
is a use-after-free under ASan.

## Root cause

`generate_assignment` (`src/codegen/exprs/assignment.yo`) renders the left
side once into the string `lhs_code` and splices it into two statements: the
old-value save (`memcpy(&old, &(<lhs_code>), …)`, emitted before the right
side) and the store (`<lhs_code> = <rhs>;`). When the place is an index call
(`*index_mut(&m, key)`), the C runs the call twice. The index method takes its
key by value and drops it on every exit path, and the caller passed one value
(one share for a counted key), so the key is dropped twice. A `Copy` key is
only hashed and probed twice. The array arm has the same shape.

## Fix direction

Evaluate the place once. One way: hoist `&(<lhs_code>)` into a pointer
temporary and use `(*p)` in both the save and the store. The pointer must be
taken after the right side runs (Rust's order for an `IndexMut` assignment:
the right side first, then one `index_mut` call), because a right side that
grows the container would leave a pointer taken earlier dangling. Every
`x(i) = v` in the tree, the std collections included, goes through this path,
so the fix needs a wide gate.
